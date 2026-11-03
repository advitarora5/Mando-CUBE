import { z } from "zod";
import { htmlToText } from "../domain/ingestion/quote.ts";
import { normalizeName } from "../domain/ingestion/normalize.ts";
import { WebsiteHttp } from "./website.ts";
import { digest, EMPLOYER_CONTEXT, identityCaseSchema, MAX_IDENTITY_AGE_MS, type IdentityCase, type IdentitySource, type IdentityGroup } from "./identity.ts";
import type { PipelineContext, WebsiteCapture } from "./types.ts";

export const identityTargetSchema = identityCaseSchema.pick({ id: true, target_name: true, corporate_url: true, site: true, review_id: true });
export type IdentityTarget = z.infer<typeof identityTargetSchema>;
// Preserve introduction, employer/business context in the middle, and footer boilerplate.
// This only selects already collected text; it neither classifies businesses nor fetches more pages.
export function boundedIdentityText(text: string): string {
  const clean = text.replace(/\r/g, "").trim();
  if (clean.length <= 5000) return clean;
  const context = clean.slice(1800, -1800).split(/\n+/).filter(line => EMPLOYER_CONTEXT.test(line)).join("\n").slice(0, 1200);
  return `${clean.slice(0, 1800)}\n[...truncated...]\n${context}\n[...truncated...]\n${clean.slice(-1800)}`;
}
function corporateEvidence(html: string): { text: string; identity_groups: IdentityGroup[] } {
  const structured: string[] = [];
  const identity_groups: IdentityGroup[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (value: unknown, depth = 0) => {
        if (depth > 8 || !value || typeof value !== "object") return;
        if (Array.isArray(value)) { value.forEach(v => walk(v, depth + 1)); return; }
        const row = value as Record<string, unknown>;
        if ([row["@type"]].flat().some(t => t === "Organization" || t === "Corporation")) {
          const names: IdentityGroup["names"] = [];
          for (const field of ["name", "legalName", "alternateName"] as const) {
            for (const value of [row[field]].flat()) if (typeof value === "string" && value.trim() && value.length <= 200) names.push({ field, value });
          }
          if (names.length && identity_groups.length < 8) identity_groups.push({ kind: "corporate_organization", names: names.slice(0, 8) });
          for (const key of ["name", "legalName", "alternateName", "description", "industry", "slogan"]) {
            for (const value of [row[key]].flat()) if (typeof value === "string") structured.push(`${key}: ${value}`);
          }
        }
        if (row["@graph"]) walk(row["@graph"], depth + 1);
      };
      walk(JSON.parse(match[1]));
    } catch { /* malformed structured data is not identity evidence */ }
  }
  const metadata = [...html.matchAll(/<meta\b[^>]*(?:property|name)=["'](?:og:site_name|og:title|og:description|description)["'][^>]*>/gi)]
    .map(m => m[0].match(/content=["']([^"']*)["']/i)?.[1] ?? "");
  return { text: boundedIdentityText([...metadata, ...structured, htmlToText(html)].join("\n")), identity_groups };
}
export function jobIdentityText(raw: string): string {
  const data = JSON.parse(raw);
  if (!data?.jobPostingInfo || typeof data.jobPostingInfo.jobDescription !== "string") throw Error("job response lacks readable job description");
  // Only fields actually returned by Workday. Never inject capture.meta.company_name (our guess).
  return boundedIdentityText([data.jobPostingInfo.title, data.hiringOrganization ? JSON.stringify(data.hiringOrganization) : "",
    htmlToText(data.jobPostingInfo.jobDescription)].filter(Boolean).join("\n"));
}
function source(side: IdentitySource["side"], url: string, raw: string, text: string, fetched: string, captureId: string | null): IdentitySource {
  const identity_groups: IdentityGroup[] = [];
  if (side === "workday") {
    const name = JSON.parse(raw)?.hiringOrganization?.name;
    if (typeof name === "string" && name.trim() && name.length <= 200) identity_groups.push({ kind: "workday_employer", names: [{ field: "hiringOrganization.name", value: name }] });
  }
  return { id: `${side}-${digest(url + raw).slice(0, 16)}`, side, url, fetched_at: fetched, content_hash: digest(raw), text, capture_id: captureId, identity_groups };
}
export function exactSiteCapture(capture: WebsiteCapture, target: IdentityTarget): boolean {
  try {
    const url = new URL(capture.url);
    return capture.http_status === 200 && capture.meta.kind === "workday_job" && url.protocol === "https:"
      && url.hostname === `${target.site.tenant}.${target.site.pod}.myworkdayjobs.com`
      && url.pathname.startsWith(`/wday/cxs/${target.site.tenant}/${target.site.site}/job/`);
  } catch { return false; }
}

// Read-only with respect to PipelineStore. Live evidence is frozen in the returned packet.
export async function prepareIdentityCase(ctx: PipelineContext, input: unknown, http: WebsiteHttp, opts: { refreshJobs?: boolean } = {}): Promise<IdentityCase> {
  const target = identityTargetSchema.parse(input);
  const packet: IdentityCase = { ...target, prepared_at: ctx.now().toISOString(), sources: [], errors: [] };
  try {
    const home = await http.page(target.corporate_url);
    // Record the final corporate URL after guarded redirects for subsequent provenance checks.
    packet.corporate_url = home.url;
    const evidence = corporateEvidence(home.html);
    packet.sources.push({ ...source("corporate", home.url, home.html, evidence.text, packet.prepared_at, null), identity_groups: evidence.identity_groups });
  } catch (error) { packet.errors.push(`corporate: ${(error as Error).message}`); }
  if (!opts.refreshJobs) {
    const captures = await ctx.store.websiteEvidenceCaptures(normalizeName(target.target_name), 20);
    for (const capture of captures.filter(c => {
      const age = +ctx.now() - Date.parse(c.fetched_at);
      return exactSiteCapture(c, target) && age >= -300000 && age <= MAX_IDENTITY_AGE_MS;
    }).slice(0, 3)) {
      try { packet.sources.push(source("workday", capture.url, capture.body, jobIdentityText(capture.body), capture.fetched_at, capture.id)); }
      catch (error) { packet.errors.push(`saved job: ${(error as Error).message}`); }
    }
  }
  // Unlike signal collection, identity sampling must not filter jobs by the word Workday.
  if (!packet.sources.some(s => s.side === "workday")) {
    try {
      const { tenant, pod, site } = target.site;
      const base = `https://${tenant}.${pod}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
      const list = await http.json(`${base}/jobs`, { appliedFacets: {}, limit: 3, offset: 0, searchText: "" });
      const parsed = z.object({ jobPostings: z.array(z.object({ externalPath: z.string() })) }).parse(list.data);
      for (const job of parsed.jobPostings.slice(0, 3)) {
        // The API's externalPath is untrusted; keep it inside the exact site's job endpoint.
        if (!/^\/job\/[^?#\\]+$/.test(job.externalPath) || /%2f|%5c|%2e|(?:^|\/)\.{1,2}(?:\/|$)/i.test(job.externalPath)) throw Error("invalid Workday job path");
        const detail = await http.json(base + job.externalPath);
        packet.sources.push(source("workday", detail.url, detail.raw, jobIdentityText(detail.raw), ctx.now().toISOString(), null));
      }
      if (!parsed.jobPostings.length) packet.errors.push("Workday site has no available jobs");
    } catch (error) { packet.errors.push(`live Workday: ${(error as Error).message}`); }
  }
  return identityCaseSchema.parse(packet);
}
