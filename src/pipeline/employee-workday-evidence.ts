import { normalizeName } from "../domain/ingestion/normalize.ts";
import { chicagoToday } from "../domain/scoring/go-live.ts";
import { htmlToText } from "../domain/ingestion/quote.ts";
import { employeeEvidenceFromDocument, type WebEmployeeEvidence } from "./employee-document-evidence.ts";
import type { CompanyRow, PipelineContext } from "./types.ts";
import { employeeResearchEnabled } from "./employee-research-setup.ts";

// Reuse employer-authored descriptions already collected by the Workday pipeline.
// A Workday hostname alone does not establish which company owns a statement.
export async function lookupEmployeeWorkday(ctx: PipelineContext, company: Pick<CompanyRow, "id" | "name">): Promise<WebEmployeeEvidence | null> {
  if (!employeeResearchEnabled(ctx.employeeWebResearch)) return null;
  const name = normalizeName(company.name);
  const sites = (await ctx.store.workdaySites(true)).filter(site => site.company_id === company.id && site.normalized_name === name);
  ctx.signal?.throwIfAborted();
  if (!sites.length) return null;
  const found: WebEmployeeEvidence[] = [];
  for (const capture of await ctx.store.websiteEvidenceCaptures(name, 20)) {
    ctx.signal?.throwIfAborted();
    const observed = new Date(capture.last_seen_at);
    const age = ctx.now().getTime() - observed.getTime();
    if (!Number.isFinite(age) || age < 0 || age > 30 * 86400000 || (capture.meta.company_id != null && capture.meta.company_id !== company.id) || capture.meta.kind !== "workday_job") continue;
    try {
      const url = new URL(capture.url);
      if (url.protocol !== "https:" || url.username || url.password || url.port || !sites.some(site =>
        url.hostname === `${site.tenant}.${site.pod}.myworkdayjobs.com` && url.pathname.startsWith(`/wday/cxs/${site.tenant}/${site.site}/job/`))) continue;
      const body = JSON.parse(capture.body);
      const description = body?.jobPostingInfo?.jobDescription;
      if (typeof description !== "string") continue;
      const text = htmlToText(description);
      // A shared tenant can host subsidiaries. Require an explicit employer name
      // in the description; an email/URL mentioning the parent is insufficient.
      const employer = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`(?<![a-z0-9@./-])${employer}(?![a-z0-9@./-])`, "i").test(text)) continue;
      const result = employeeEvidenceFromDocument({ text, companyName: company.name, source: capture.url, allowObserved: true }, ctx.now());
      if (/Conflicting/.test(result.reason)) return null;
      if (!result.evidence || (result.evidence.basis === "approximate" && result.evidence.employee_count >= 3000)) continue;
      found.push({ ...result.evidence, observed_on: chicagoToday(observed),
        ...(result.evidence.date_basis === "observed" ? { as_of: chicagoToday(observed) } : {}) });
    } catch { /* malformed or unbound captures provide no headcount evidence */ }
  }
  found.sort((a, b) => b.as_of.localeCompare(a.as_of));
  const latest = found[0];
  return latest && !found.some(row => row.as_of === latest.as_of && row.employee_count !== latest.employee_count) ? latest : null;
}
