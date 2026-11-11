import { normalizeDomain, normalizeName } from "../domain/ingestion/normalize.ts";
import { htmlToText } from "../domain/ingestion/quote.ts";
import { daysSince } from "../domain/scoring/go-live.ts";
import { links, pageIdentity, WebsiteHttp } from "./website.ts";
import { employeePdfText } from "./employee-pdf.ts";
import { employeeEvidenceFromDocument, employeeEvidenceFromHtml, webEmployeeEvidenceSchema, type WebEmployeeEvidence } from "./employee-document-evidence.ts";
import type { EmployeeResearchRecord, EmployeeResearchStatus } from "./employee-research-record.ts";
import type { CompanyRow, PipelineContext } from "./types.ts";

import { employeeResearchEnabled, ensureEmployeeResearchReady, employeeDeadline, EMPLOYEE_SETUP_WARNING } from "./employee-research-setup.ts";

const SEARCH = "tinyfish.web.search";
const searchDisabled = new WeakSet<PipelineContext>();
const limits = new WeakMap<PipelineContext, { used: number; disabled: boolean }>();
type Company = Pick<CompanyRow, "id" | "name" | "domain">;
type ResearchActivity = "disabled" | "skipped_setup" | "skipped_limit" | "skipped_lease" | "skipped_domain" | "cached" | "ran" | "failed";
type ResearchResult = { activity: ResearchActivity; attempted: boolean; evidence: WebEmployeeEvidence | null; status: EmployeeResearchStatus; reason: string; requests: number; spend: number; documents?: { url: string; outcome: string }[] };
const owned = (url: string, domain: string) => {
  try {
    const parsed = new URL(url);
    const host = normalizeDomain(parsed.hostname);
    if (/^(community|forums?|support|help|developers?|docs|status|marketplace)\./i.test(host ?? "") || /\/(community|forums?)\//i.test(parsed.pathname)) return false;
    return host === domain || !!host?.endsWith(`.${domain}`);
  }
  catch { return false; }
};

function documentLinks(html: string, base: string, domain: string) {
  // Download links often inherit their meaning from an immediately preceding
  // report heading. Preserve that association, never a distant page title.
  const contextual = html.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (tag, offset: number) => {
    const before = html.slice(Math.max(0, offset - 1200), offset);
    const heading = htmlToText([...before.matchAll(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi)].at(-1)?.[0] ?? "");
    if (/annual|sustainability|integrated|financial.*report/i.test(heading)
      && /^(?:download|pdf|read|view)(?:\s+(?:report|pdf))?$/i.test(htmlToText(tag).trim())) {
      return tag.replace(/<a\b[^>]*>/i, (opening: string) => `${opening}${heading} `);
    }
    return tag;
  });
  return links(contextual, base).flatMap(({ url, label }) => {
    if (url.href === base) return [];
    if (/login|privacy|cookie|terms|job-search|vacanc|suppliers?|customers?|partners?|case-stud/i.test(`${url.pathname} ${label}`)) return [];
    const isPdf = /\.pdf$/i.test(url.pathname);
    const report = /annual|(?:sustainability|integrated|impact|financial)[^/]{0,40}report/i.test(`${label} ${url.pathname}`);
    if (!owned(url.href, domain) && !(isPdf && report)) return [];
    const score = report ? 120 : /about|at.a.glance|facts|company.overview|our.people/i.test(`${label} ${url.pathname}`) ? 100
      : /investor|reports/i.test(`${label} ${url.pathname}`) ? 110 : /press|news/i.test(`${label} ${url.pathname}`) ? 30 : 0;
    if (!score) return [];
    url.hash = "";
    return [{ url: url.href, externalPdf: !owned(url.href, domain), score: score - url.pathname.split("/").filter(Boolean).length }];
  }).sort((a, b) => b.score - a.score || b.url.localeCompare(a.url));
}

// The same bounded crawler is used by normal scoring and the read-only benchmark.
export async function researchEmployeeWebsite(ctx: PipelineContext, company: Company): Promise<ResearchResult> {
  const domain = normalizeDomain(company.domain);
  const documents: { url: string; outcome: string }[] = [];
  const empty = (status: EmployeeResearchStatus, reason: string, requests: number, spend = 0): ResearchResult => ({ evidence: null, status, reason, requests, spend, documents, activity: status === "unavailable" ? "failed" : "ran", attempted: true });
  if (!employeeResearchEnabled(ctx.employeeWebResearch)) return { ...empty("unavailable", "Employee research is disabled explicitly.", 0), activity: "disabled", attempted: false };
  if (!domain) return { ...empty("needs_review", "Company has no verified domain.", 0), activity: "skipped_domain", attempted: false };
  const deadline = AbortSignal.timeout(45000);
  const scoped = { ...ctx, fetch: ((url, init) => ctx.fetch(url, { ...init,
    signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : []), ...(ctx.signal ? [ctx.signal] : [])]) })) as typeof fetch };
  // Some corporate robots endpoints traverse locale + error-page redirects.
  // Keep the same total request/deadline caps and all DNS/robots protections.
  const http = new WebsiteHttp(scoped, 18, 6);
  const queue = [{ url: `https://${domain}/`, externalPdf: false, score: 100 }];
  const seen = new Set<string>();
  const found: WebEmployeeEvidence[] = [];
  let readable = 0, searches = 0, spend = 0;
  let sourceFailed = false;
  let homeIdentity = false;
  let conflict = false;
  while (queue.length && seen.size < 6 && !deadline.aborted && !ctx.signal?.aborted) {
    const candidate = queue.shift()!;
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    try {
      const document = await http.document(candidate.url);
      if (!owned(document.url, domain) && !(candidate.externalPdf && document.pdf)) continue;
      readable++;
      if (document.html) {
        const brand = normalizeName(company.name).replace(/ pharmaceuticals$/, "");
        const identified = !!pageIdentity(document.html, company.name)
          || (brand !== normalizeName(company.name) && !!pageIdentity(document.html, `${brand} Global`));
        if (seen.size === 1) homeIdentity = identified;
        const more = documentLinks(document.html, document.url, domain);
        queue.push(...more.filter(row => !seen.has(row.url) && !queue.some(existing => existing.url === row.url)));
        queue.sort((a, b) => b.score - a.score || b.url.localeCompare(a.url));
        if (identified || homeIdentity) {
          const result = employeeEvidenceFromHtml(document.html, company.name, document.url, ctx.now());
          documents.push({ url: document.url, outcome: result.reason });
          if (result.evidence) found.push(result.evidence);
          if (/Conflicting/.test(result.reason)) conflict = true;
        } else documents.push({ url: document.url, outcome: "Employer identity was not established on the page." });
      } else if (document.pdf) {
        const text = await employeePdfText(document.pdf);
        const identity = ` ${normalizeName(text.slice(0, 40000))} `.includes(` ${normalizeName(company.name)} `);
        if (identity) {
          const result = employeeEvidenceFromDocument({ text, companyName: company.name, source: document.url }, ctx.now());
          documents.push({ url: document.url, outcome: result.reason });
          if (result.evidence) found.push(result.evidence);
          if (/Conflicting/.test(result.reason)) conflict = true;
        } else documents.push({ url: document.url, outcome: "Employer identity was not established in the PDF." });
      }
    } catch (error) { sourceFailed = true; documents.push({ url: candidate.url, outcome: error instanceof Error ? error.message : "Source could not be read." }); }
    // Search discovers URLs only. Claims in snippets never earn score credit.
    if (seen.size === 1 && ctx.treg && !searchDisabled.has(ctx) && !deadline.aborted) {
      searches++;
      try {
        const result = await ctx.treg.call(SEARCH, { query: { query: `site:${domain} "${company.name}" employees workforce annual report`, domain_type: "web" },
          headers: { "X-Treg-Route-Max-Cost": "0", "X-Treg-Route-Waterfall": "0" }, timeoutMs: 8000 });
        if (!Number.isFinite(result.cost_usd) || result.cost_usd !== 0) {
          searchDisabled.add(ctx);
          if (result.cost_usd > 0) {
            spend += result.cost_usd;
            await ctx.spend.record({ provider: "treg", endpoint: SEARCH, step: "employee_evidence", subject: domain,
              idempotency_key: "", worst_case_usd: 0, cost_usd: result.cost_usd, outcome: "Unexpected charge on free employee research" });
          }
          return empty("unavailable", "Search did not confirm zero cost.", http.requests + searches, spend);
        }
        if (!result.ok && [401, 402, 403, 429].includes(result.status)) searchDisabled.add(ctx);
        if (result.ok) {
          const results = (result.body as { results?: { url?: unknown }[] } | null)?.results;
          if (Array.isArray(results)) for (const row of results.slice(0, 6)) {
            if (typeof row?.url !== "string" || !row.url.startsWith("https://") || !owned(row.url, domain) || seen.has(row.url)) continue;
            queue.unshift({ url: row.url, externalPdf: false, score: 110 });
          }
        }
      } catch { /* direct employer-site reading remains available */ }
    }
  }
  found.sort((a, b) => b.as_of.localeCompare(a.as_of));
  const best = found[0];
  const requests = http.requests + searches;
  if (conflict || (best && found.some(row => row.as_of === best.as_of && row.employee_count !== best.employee_count))) {
    return empty("needs_review", "Conflicting dated workforce evidence requires review.", requests, spend);
  }
  if (best?.basis === "approximate" && best.employee_count >= 3000) return empty("needs_review", "Approximate workforce count cannot establish a guaranteed 3,000-employee minimum.", requests, spend);
  if (best) return { evidence: best, status: "found", reason: "Official workforce evidence found with its date basis recorded.", requests, spend, documents, activity: "ran", attempted: true };
  return empty(readable && !sourceFailed && !deadline.aborted && !ctx.signal?.aborted ? "needs_review" : "unavailable", readable ? "No current dated employer-wide headcount was established." : "Official sources could not be read.", requests, spend);
}

function cachedEvidence(record: EmployeeResearchRecord | null, company: Company, now: Date) {
  if (!record || record.company_domain !== normalizeDomain(company.domain) || record.company_name !== normalizeName(company.name)) return null;
  const parsed = webEmployeeEvidenceSchema.safeParse(record.evidence);
  if (!parsed.success || (parsed.data.basis === "approximate" && parsed.data.employee_count >= 3000)) return null;
  const age = daysSince(parsed.data.as_of, now);
  return age !== null && age >= 0 && age <= (parsed.data.date_basis === "observed" ? 30 : 548) ? parsed.data : null;
}

export async function lookupEmployeeWebsite(ctx: PipelineContext, company: Company): Promise<ResearchResult> {
  const empty: ResearchResult = { evidence: null, status: "unavailable", reason: "Employee research is disabled explicitly.", requests: 0, spend: 0, activity: "disabled", attempted: false };
  if (!employeeResearchEnabled(ctx.employeeWebResearch)) return empty;
  const readiness = await ensureEmployeeResearchReady(ctx);
  if (readiness.status !== "ready") return { ...empty, reason: EMPLOYEE_SETUP_WARNING, activity: "skipped_setup" };
  let state = limits.get(ctx);
  if (!state) { state = { used: 0, disabled: false }; limits.set(ctx, state); }
  if (state.disabled) return { ...empty, reason: EMPLOYEE_SETUP_WARNING, activity: "skipped_setup" };
  let cached: WebEmployeeEvidence | null = null;
  let result: ResearchResult | null = null;
  const failureEvidence = () => result?.status === "needs_review" ? null
    : result?.evidence && result.evidence.employee_count < 3000 ? result.evidence : cached;
  try {
    const previous = await employeeDeadline(() => ctx.store.employeeResearch(company.id), 5000, ctx.signal);
    cached = cachedEvidence(previous, company, ctx.now());
    const same = previous?.company_domain === normalizeDomain(company.domain) && previous?.company_name === normalizeName(company.name);
    if (same && Date.parse(previous!.next_check_at) > ctx.now().getTime()) return { ...empty, evidence: cached, status: cached ? "found" : "needs_review", reason: "Saved employee research is not due.", activity: "cached" };
    if (state.used >= (ctx.employeeWebMaxCompanies ?? 5)) return { ...empty, evidence: cached, reason: "Employee research batch limit reached.", activity: "skipped_limit" };
    const domain = normalizeDomain(company.domain);
    if (!domain) return { ...empty, status: "needs_review", reason: "Company domain is missing.", activity: "skipped_domain" };
    const claim = await employeeDeadline(() => ctx.store.claimEmployeeResearch(company.id, domain, normalizeName(company.name)), 5000, ctx.signal);
    if (!claim?.lease_token) return { ...empty, evidence: cached, reason: "Another run owns this company's research.", activity: "skipped_lease" };
    state.used++;
    try {
      result = await employeeDeadline(signal => researchEmployeeWebsite({ ...ctx, signal }, company), 45000, ctx.signal);
    } catch {
      result = { ...empty, reason: "Employee source lookup failed, timed out or was cancelled.", activity: "failed", attempted: true };
    }
    if (result.status === "unavailable") ctx.log.warn(`Employee website research failed or timed out for ${company.name}; retaining only still-valid saved evidence and continuing scoring.`);
    const saved = await employeeDeadline(() => ctx.store.finishEmployeeResearch(company.id, claim.lease_token!, result!.status, result!.evidence, result!.reason), 5000, ctx.signal);
    if (!saved) {
      ctx.log.warn(`Employee website research lease changed for ${company.name}; ignoring uncommitted size increases and continuing scoring.`);
      return { ...result, evidence: failureEvidence(), status: result.status === "needs_review" ? "needs_review" : "unavailable", activity: "failed", reason: "Research lease changed; result was not saved." };
    }
    return { ...result, evidence: result.evidence ?? (result.status === "unavailable" ? cached : null) };
  } catch {
    state.disabled = true;
    ctx.log.warn(EMPLOYEE_SETUP_WARNING);
    return { ...empty, ...result, evidence: failureEvidence(), status: result?.status === "needs_review" ? "needs_review" : "unavailable", activity: result?.attempted ? "failed" : "skipped_setup", reason: EMPLOYEE_SETUP_WARNING };
  }
}
