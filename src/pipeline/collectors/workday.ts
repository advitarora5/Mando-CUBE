// Workday career sites (company.wdN.myworkdayjobs.com) through the JSON endpoints the career site itself uses.
// Verified live on 2026-10-13 (see docs/ingestion-runbook.md):
//   POST /wday/cxs/{tenant}/{site}/jobs  {appliedFacets:{}, limit<=20, offset, searchText}  -> {total, jobPostings[]}
//   GET  /wday/cxs/{tenant}/{site}{externalPath}                                            -> {jobPostingInfo, hiringOrganization}
// limit above 20 returns HTTP 400; `total` is capped at 2000 and offsets past 2000 repeat the same page;
// a wrong site name returns HTTP 422. robots.txt allows these paths and lists each tenant's site names.
import { contentFingerprint } from "../../domain/ingestion/fingerprint.ts";
import { normalizeName, tenantCandidates } from "../../domain/ingestion/normalize.ts";
import { isExcludedCompany } from "../../domain/ingestion/matching.ts";
import { PoliteHttp, STOPPING_FAILURES, type HttpFail } from "../http.ts";
import type { Collector, CollectLimits, CollectResult, PipelineContext, RawItem, SourceRow } from "../types.ts";

export const WORKDAY_PAGE_SIZE = 20;
export const WORKDAY_OFFSET_CAP = 2000;
// Pods seen most often first. Each probe is one robots.txt request.
export const WORKDAY_PODS = ["wd5", "wd1", "wd3", "wd12", "wd103", "wd501", "wd10", "wd108"];
// Volatile fields that change daily without the posting changing ("Posted 5 Days Ago").
export const WORKDAY_VOLATILE_KEYS = ["postedOn", "similarJobs", "userAuthenticated"];

export const origin = (tenant: string, pod: string) => `https://${tenant}.${pod}.myworkdayjobs.com`;

export function sitesFromRobots(body: string, tenant: string, pod: string): string[] {
  const host = `${tenant}.${pod}.myworkdayjobs.com`.replace(/\./g, "\\.");
  const sites = [...body.matchAll(new RegExp(`${host}/([^/\\s]+)/siteMap\\.xml`, "gi"))].map(m => m[1]);
  return [...new Set(sites)];
}

// Career-site name words that mean "not the main external site" (seen live: agency, University, ContractorConversion,
// Fasttrack, Emerging-Talent). The main site usually says career/external/jobs/search.
const NON_PRIMARY = /intern|early.?career|executive|confidential|internal|alumni|talent.?community|research|campus|futureforce|agency|contractor|universit|fast.?track|emerging|graduate|student|apprentic|university/i;
const PRIMARY_HINT = /career|external|jobs|search/i;

// One site per tenant: the main external one.
export function primarySites(sites: string[], tenant?: string): string[] {
  const main = sites.filter(site => !NON_PRIMARY.test(site));
  const eligible = main.length ? main : sites;
  const tenantKey = tenant?.toLowerCase().replace(/[^a-z0-9]/g, "");
  const branded = tenantKey ? eligible.filter(site => {
    const siteKey = site.toLowerCase().replace(/[^a-z0-9]/g, "");
    return siteKey === tenantKey || (siteKey.startsWith(tenantKey) && /^(careers?|external|jobs?|search)/.test(siteKey.slice(tenantKey.length)));
  }) : [];
  const pool = branded.length ? branded : eligible;
  // A site whose name starts every other site name is the base site ("Workday" vs "Workday_Jobs").
  const base = pool.find(site => pool.every(other => other.toLowerCase().startsWith(site.toLowerCase())));
  if (base && pool.length > 1) return [base];
  const hinted = pool.filter(site => PRIMARY_HINT.test(site));
  // Among hinted sites, the shortest name is the general one ("Careers" over "SwissRAVSwitzerlandCareerSite").
  return [(hinted.length ? hinted.sort((a, b) => a.length - b.length) : pool)[0]].filter(Boolean);
}

function item(source: string, url: string, status: number, contentType: string | null, raw: string, now: Date, meta: Record<string, unknown>, volatile: string[] = []): RawItem {
  return { source, url, fetched_at: now.toISOString(), http_status: status, content_type: contentType, raw, fingerprint: contentFingerprint(raw, volatile), meta };
}

function empty(): CollectResult { return { items: [], requests: 0, blocked: null, errors: [], spend_usd: 0 }; }

function fail(result: CollectResult, failure: HttpFail): boolean {
  result.errors.push({ url: failure.url, kind: failure.kind, message: failure.message });
  if (STOPPING_FAILURES.includes(failure.kind)) { result.blocked = `${failure.kind}: ${failure.message}`; return true; }
  return false;
}

type SecEntry = { title: string; ticker?: string; cik_str?: number };

// Names for the resolver, in SEC list order (roughly largest first), from the latest SEC capture.
export async function resolverNames(ctx: PipelineContext, max: number): Promise<{ name: string; normalized: string }[]> {
  // Prefer the list collected in this run: an unchanged list reuses an older row, so "latest" can be stale.
  const collectedId = ctx.collected?.["sec-company-list"];
  const capture = (collectedId ? await ctx.store.captureById(collectedId) : null) ?? await ctx.store.latestCapture("sec-company-list");
  if (!capture) return [];
  let entries: SecEntry[] = [];
  try { entries = Object.values(JSON.parse(capture.body) as Record<string, SecEntry>); } catch { return []; }
  // Names of companies already in the database are probed too: matching attaches their signals without touching scores.
  const seen = new Set<string>();
  const candidates: { name: string; normalized: string }[] = [];
  for (const entry of entries) {
    const normalized = normalizeName(entry?.title);
    if (!normalized || seen.has(normalized) || isExcludedCompany(entry.title)) continue;
    seen.add(normalized);
    candidates.push({ name: entry.title, normalized });
  }
  const tried = await ctx.store.resolverAttempts(candidates.slice(0, max * 5).map(c => c.normalized));
  return candidates.filter(c => !tried.has(c.normalized)).slice(0, max);
}

// Name -> Workday career site. Probes {tenant}.{pod}.myworkdayjobs.com/robots.txt; a hit lists the site names.
export class WorkdayResolver implements Collector {
  readonly type = "workday_site_resolver";
  async collect(source: SourceRow, limits: CollectLimits, ctx: PipelineContext): Promise<CollectResult> {
    const result = empty();
    const http = new PoliteHttp(ctx, { maxRequests: limits.maxRequests, minDelayMs: limits.minDelayMs, maxRetries: 1, timeoutMs: 10000 });
    // The full-name guess tries the six most common pods; the weaker first-word guess only the top three.
    const podsFor = (kind: string) => WORKDAY_PODS.slice(0, kind === "full_name" ? Number(source.config.full_name_pods ?? 6) : Number(source.config.first_word_pods ?? 3));
    // limit = sites to find; about one name in four has a guessable tenant, so up to six names per wanted site are tried.
    const names = await resolverNames(ctx, limits.maxItems * Number(source.config.names_per_site ?? 6));
    ctx.log.info(`resolver: up to ${names.length} names for ${limits.maxItems} sites`);
    let consecutiveBlocked = 0;
    for (const { name, normalized } of names) {
      if (result.blocked || http.remaining < 1 || result.items.length >= limits.maxItems) break;
      let probes = 0, found = false;
      outer: for (const candidate of tenantCandidates(name)) {
        for (const pod of podsFor(candidate.kind)) {
          if (http.remaining < 1) break outer;
          probes++;
          const got = await http.robotsTxt(origin(candidate.tenant, pod));
          if (!got.ok) {
            // A 401/403 on a guessed tenant is a miss (that host is private or unused), not a block of the whole site.
            // Ten in a row, or any rate limit or CAPTCHA, does stop the source.
            if (got.kind === "blocked" && ++consecutiveBlocked < 10) continue;
            if (got.kind !== "http" && fail(result, got)) break outer;
            continue;
          }
          consecutiveBlocked = 0;
          const sites = sitesFromRobots(got.body, candidate.tenant, pod);
          if (!sites.length) continue;
          result.items.push(item(source.id, got.url, got.status, got.contentType, got.body, ctx.now(),
            { kind: "workday_robots", tenant: candidate.tenant, pod, sites, primary_sites: primarySites(sites, candidate.tenant), company_name: name, normalized_name: normalized, match_kind: candidate.kind }));
          found = true;
          break outer;
        }
      }
      if (!limits.dryRun && !result.blocked) await ctx.store.saveResolverAttempt({ normalized_name: normalized, company_name: name, found, probes });
    }
    result.requests = http.requests;
    return result;
  }
}

type Posting = { title?: string; externalPath?: string; postedOn?: string };

// Job postings that mention Workday, from every enabled career site. Each posting's detail JSON is one raw item.
export class WorkdayJobs implements Collector {
  readonly type = "workday_career_site";
  async collect(source: SourceRow, limits: CollectLimits, ctx: PipelineContext): Promise<CollectResult> {
    const result = empty();
    const http = new PoliteHttp(ctx, { maxRequests: limits.maxRequests, minDelayMs: limits.minDelayMs, maxRetries: 2 });
    const searchText = String(source.config.search_text ?? "Workday");
    const perSite = Number(source.config.max_jobs_per_site ?? 8);
    const enabled = (await ctx.store.workdaySites(true)).filter(site => site.company_id || site.review_item_id || source.config.include_unmatched !== false);
    // Sites saved before the primary-site rule existed: still only the main site per tenant is collected.
    const byTenant = new Map<string, typeof enabled>();
    for (const site of enabled) byTenant.set(`${site.tenant}.${site.pod}`, [...(byTenant.get(`${site.tenant}.${site.pod}`) ?? []), site]);
    // --limit counts sites (companies); the ones checked longest ago (or never) go first, so every company is covered over time.
    const sites = [...byTenant.values()].map(group => group.find(s => s.site === primarySites(group.map(g => g.site), group[0].tenant)[0])!).filter(Boolean)
      .sort((a, b) => (a.last_checked_at ?? "").localeCompare(b.last_checked_at ?? "")).slice(0, limits.maxItems);
    ctx.log.info(`workday jobs: ${sites.length} sites`);
    for (const site of sites) {
      if (result.blocked || http.remaining < 2) break;
      const before = result.items.length, errorsBefore = result.errors.length;
      const base = `${origin(site.tenant, site.pod)}/wday/cxs/${site.tenant}/${site.site}`;
      const postings: Posting[] = [];
      for (let offset = 0; offset < WORKDAY_OFFSET_CAP && postings.length < perSite; offset += WORKDAY_PAGE_SIZE) {
        const page = await http.request(`${base}/jobs`, { method: "POST", expect: "json", json: { appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset, searchText } });
        if (!page.ok) { fail(result, page); break; }
        const list = (page.json as { jobPostings?: Posting[]; total?: number })?.jobPostings;
        // A 200 that is not a job list is an "unavailable" page in disguise.
        if (!Array.isArray(list)) { fail(result, { ok: false, kind: "unavailable", status: page.status, message: "jobs response has no jobPostings array", url: page.url }); break; }
        postings.push(...list.filter(p => typeof p?.externalPath === "string"));
        const total = (page.json as { total?: number }).total ?? 0;
        if (list.length < WORKDAY_PAGE_SIZE || offset + WORKDAY_PAGE_SIZE >= Math.min(total || 0, WORKDAY_OFFSET_CAP)) break;
      }
      for (const posting of postings.slice(0, perSite)) {
        if (result.blocked || http.remaining < 1) break;
        const detail = await http.request(`${base}${posting.externalPath}`, { expect: "json" });
        if (!detail.ok) { if (fail(result, detail)) break; continue; }
        const info = (detail.json as { jobPostingInfo?: { jobDescription?: string } })?.jobPostingInfo;
        if (!info || typeof info.jobDescription !== "string") { fail(result, { ok: false, kind: "unavailable", status: detail.status, message: "job detail has no jobPostingInfo.jobDescription", url: detail.url }); continue; }
        result.items.push(item(source.id, detail.url, detail.status, detail.contentType, detail.body, ctx.now(),
          { kind: "workday_job", site_id: site.id, tenant: site.tenant, pod: site.pod, site: site.site, company_name: site.company_name, normalized_name: site.normalized_name, company_id: site.company_id, review_item_id: site.review_item_id }, WORKDAY_VOLATILE_KEYS));
      }
      if (!limits.dryRun && !result.blocked) await ctx.store.markSiteChecked(site.id, result.errors.length > errorsBefore ? "errors" : `${result.items.length - before} postings`, ctx.now().toISOString());
    }
    result.requests = http.requests;
    return result;
  }
}
