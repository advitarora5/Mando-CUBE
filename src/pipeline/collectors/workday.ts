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
import { corporateCandidates, corporateWorkdayLinks, discoverCorporateCareers } from "./corporate-careers.ts";
import type { Collector, CollectLimits, CollectResult, PipelineContext, RawItem, SourceRow } from "../types.ts";

export const WORKDAY_PAGE_SIZE = 20;
export const WORKDAY_OFFSET_CAP = 2000;
export const RESOLVER_REFRESH_DAYS = 7;
export const RESOLVER_MISS_RETRY_DAYS = 30;
// Pods seen most often first. Each probe is one robots.txt request.
export const WORKDAY_PODS = ["wd5", "wd1", "wd3", "wd12", "wd103", "wd501", "wd503", "wd10", "wd108"];
// Volatile fields that change daily without the posting changing ("Posted 5 Days Ago").
export const WORKDAY_VOLATILE_KEYS = ["postedOn", "similarJobs", "userAuthenticated"];

export const origin = (tenant: string, pod: string) => `https://${tenant}.${pod}.myworkdayjobs.com`;

export function sitesFromRobots(body: string, tenant: string, pod: string): string[] {
  const sites: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const value = line.match(/^\s*Sitemap:\s*(\S+)\s*$/i)?.[1];
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) continue;
      if (url.hostname === `${tenant}.${pod}.myworkdayjobs.com`) {
        const match = url.pathname.match(/^\/([A-Za-z0-9_-]+)\/siteMap\.xml$/i);
        if (match) sites.push(match[1]);
      } else if (url.hostname === `${pod}.myworkdaysite.com`) {
        const match = url.pathname.match(/^\/recruiting\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)\/siteMap\.xml$/i);
        if (match && match[1].toLowerCase() === tenant.toLowerCase()) sites.push(match[2]);
      }
    } catch { /* A malformed sitemap is not a discovered site. */ }
  }
  return [...new Set(sites)];
}

// Career-site name words that mean "not the main external site" (seen live: agency, University, ContractorConversion,
// Fasttrack, Emerging-Talent). The main site usually says career/external/jobs/search.
const NON_PRIMARY = /intern|early.?career|executive|confidential|internal|alumni|talent.?community|research|campus|futureforce|agency|contractor|universit|fast.?track|emerging|graduate|student|apprentic|university/i;
const PRIMARY_HINT = /career|external|jobs|search/i;

export function tenantBrandedSite(site: string, tenant: string): boolean {
  const brand = tenant.toLowerCase().replace(/-/g, "");
  const name = site.toLowerCase().replace(/[_-]/g, "");
  return !!brand && (name === brand || name.startsWith(brand) && /^(careers?|jobs?|external|search)/.test(name.slice(brand.length)));
}

// One site per tenant: the main external one.
export function rankedSites(sites: string[], tenant = ""): string[] {
  const brand = tenant.toLowerCase().replace(/-/g, "");
  const compact = (site: string) => site.toLowerCase().replace(/[_-]/g, "");
  const branded = (site: string) => tenantBrandedSite(site, tenant);
  const unique = [...new Set(sites)].filter(site => /^[A-Za-z0-9_-]+$/.test(site));
  const main = unique.filter(site => !NON_PRIMARY.test(branded(site) ? compact(site).slice(brand.length) : site));
  const pool = main.length ? main : unique;

  // A site whose name starts every other site name is the base site ("Workday" vs "Workday_Jobs").
  const base = pool.find(site => pool.every(other => other.toLowerCase().startsWith(site.toLowerCase())));
  const score = (site: string) => site === base && pool.length > 1 ? 0 : branded(site) ? 1 : PRIMARY_HINT.test(site) ? 2 : 3;
  return [...pool].sort((a, b) => score(a) - score(b) || a.length - b.length);
}

export function primarySites(sites: string[], tenant = ""): string[] {
  return rankedSites(sites, tenant).slice(0, 1);
}

export function item(source: string, url: string, status: number, contentType: string | null, raw: string, now: Date, meta: Record<string, unknown>, volatile: string[] = []): RawItem {
  return { source, url, fetched_at: now.toISOString(), http_status: status, content_type: contentType, raw, fingerprint: contentFingerprint(raw, volatile), meta };
}

export function empty(): CollectResult { return { items: [], requests: 0, blocked: null, errors: [], spend_usd: 0 }; }

export function fail(result: CollectResult, failure: HttpFail): boolean {
  result.errors.push({ url: failure.url, kind: failure.kind, message: failure.message });
  if (STOPPING_FAILURES.includes(failure.kind)) { result.blocked = `${failure.kind}: ${failure.message}`; return true; }
  return false;
}

type SecEntry = { title: string; ticker?: string; cik_str?: number };

// Prefer the list collected in this run: an unchanged list reuses an older row, so "latest" can be stale.
export async function secListCapture(ctx: PipelineContext) {
  const collectedId = ctx.collected?.["sec-company-list"];
  return (collectedId ? await ctx.store.captureById(collectedId) : null) ?? await ctx.store.latestCapture("sec-company-list");
}

// Names for the resolver, in SEC list order (roughly largest first), from the latest SEC capture.
export async function resolverNames(ctx: PipelineContext, max: number, excluded: ReadonlySet<string> = new Set()): Promise<{ name: string; normalized: string }[]> {
  const capture = await secListCapture(ctx);
  if (!capture) return [];
  let entries: SecEntry[] = [];
  try { entries = Object.values(JSON.parse(capture.body) as Record<string, SecEntry>); } catch { return []; }
  // Names of companies already in the database are probed too: matching attaches their signals without touching scores.
  const seen = new Set<string>();
  const candidates: { name: string; normalized: string }[] = [];
  for (const entry of entries) {
    const normalized = normalizeName(entry?.title);
    if (!normalized || seen.has(normalized) || excluded.has(normalized) || isExcludedCompany(entry.title)) continue;
    seen.add(normalized);
    candidates.push({ name: entry.title, normalized });
  }
  // Look up attempts for every candidate considered, not just an initial window:
  // later names would otherwise be selected again even after being probed.
  const pending: typeof candidates = [];
  const pageSize = 200;
  for (let offset = 0; offset < candidates.length && pending.length < max; offset += pageSize) {
    const page = candidates.slice(offset, offset + pageSize);
    const tried = await ctx.store.resolverAttempts(page.map(c => c.normalized));
    pending.push(...page.filter(c => !tried.has(c.normalized)).slice(0, max - pending.length));
  }
  return pending;
}

// Interleave new names with the oldest due attempts. Rechecks must not consume
// the whole candidate batch and prevent discovery from moving through the SEC list.
export async function resolverCandidates(ctx: PipelineContext, max: number, discoveryOnly = false) {
  if (max <= 0) return [];
  const day = 86400000, now = ctx.now().getTime();
  const excluded = new Set<string>();
  if (discoveryOnly) {
    const [companies, sites, reviews] = await Promise.all([ctx.store.companies(), ctx.store.workdaySites(false), ctx.store.reviewItems()]);
    for (const c of companies) excluded.add(normalizeName(c.name));
    for (const s of sites) excluded.add(s.normalized_name);
    for (const r of reviews) excluded.add(r.normalized_name);
  }
  const fresh = await resolverNames(ctx, max, excluded);
  const due = (await ctx.store.dueResolverAttempts({
    foundBefore: new Date(now - RESOLVER_REFRESH_DAYS * day).toISOString(),
    missBefore: new Date(now - RESOLVER_MISS_RETRY_DAYS * day).toISOString(),
  }, max + excluded.size)).filter(a => !excluded.has(a.normalized_name) && !isExcludedCompany(a.company_name))
    .map(a => ({ name: a.company_name, normalized: a.normalized_name }));
  const selected: typeof fresh = [];
  for (let i = 0; selected.length < max && (i < fresh.length || i < due.length); i++) {
    if (fresh[i]) selected.push(fresh[i]);
    if (due[i] && selected.length < max) selected.push(due[i]);
  }
  return selected;
}

// Name -> Workday career site. Probes {tenant}.{pod}.myworkdayjobs.com/robots.txt; a hit lists the site names.
export class WorkdayResolver implements Collector {
  readonly type = "workday_site_resolver";
  async collect(source: SourceRow, limits: CollectLimits, ctx: PipelineContext): Promise<CollectResult> {
    const result = empty();
    const http = new PoliteHttp(ctx, { maxRequests: limits.maxRequests, minDelayMs: limits.minDelayMs, maxRetries: 1, timeoutMs: 10000 });
    // Full-name guesses include the observed wd503 pod; weaker first-word guesses stay bounded to three.
    const podsFor = (kind: string) => WORKDAY_PODS.slice(0, kind === "full_name" ? Number(source.config.full_name_pods ?? 7) : Number(source.config.first_word_pods ?? 3));
    // limit = sites to find; about one name in four has a guessable tenant, so up to six names per wanted site are tried.
    const names = await resolverCandidates(ctx, limits.maxItems * Number(source.config.names_per_site ?? 6), source.config.discovery_only === true);
    const knownSites = await ctx.store.workdaySites(true);
    const corporateEnabled = source.config.corporate_discovery === true;
    const companies = corporateEnabled ? await ctx.store.companies() : [];
    const reviews = corporateEnabled ? await ctx.store.reviewItems("pending") : [];
    let corporateRequests = 0, foundNames = 0;
    ctx.log.info(`resolver: up to ${names.length} names for ${limits.maxItems} sites`);
    let consecutiveBlocked = 0;
    for (const { name, normalized } of names) {
      if (result.blocked || http.remaining - corporateRequests < 1 || foundNames >= limits.maxItems) break;
      let probes = 0, found = false, incomplete = false, transient = false;
      // Revalidate known hosts directly, including pods outside the guessing list.
      const guesses = tenantCandidates(name);
      const targets = [
        ...knownSites.filter(s => s.normalized_name === normalized).map(s => ({ tenant: s.tenant, pod: s.pod, kind: s.match_kind, known: true })),
        ...guesses.flatMap(c => podsFor(c.kind).map(pod => ({ ...c, pod, known: false }))),
      ];
      const visited = new Set<string>();
      for (const candidate of targets) {
        const { pod } = candidate;
        const host = origin(candidate.tenant, pod);
        if (visited.has(host)) continue;
        visited.add(host);
        if (http.remaining - corporateRequests < 1) { incomplete = true; break; }
        probes++;
        const got = await http.robotsTxt(host);
        if (!got.ok) {
          // A private guessed tenant is a miss. A known host blocking us, ten
          // blocked guesses, any rate limit, or a CAPTCHA stops the source.
          if (got.kind === "blocked" && !candidate.known && ++consecutiveBlocked < 10) continue;
          const miss = got.kind === "http" && [404, 410, 422].includes(got.status);
          if (!miss) {
            transient = true;
            if (fail(result, got)) break;
          }
          continue;
        }
        consecutiveBlocked = 0;
        const sites = sitesFromRobots(got.body, candidate.tenant, pod);
        if (!sites.length) continue;
        result.items.push(item(source.id, got.url, got.status, got.contentType, got.body, ctx.now(),
          { kind: "workday_robots", tenant: candidate.tenant, pod, sites, primary_sites: primarySites(sites, candidate.tenant), company_name: name, normalized_name: normalized, match_kind: candidate.kind }));
        found = true;
        break;
      }
      if (!found && !result.blocked && corporateEnabled && http.remaining - corporateRequests >= 2) {
        const domains = [...companies.filter(c => normalizeName(c.name) === normalized).map(c => c.domain), ...reviews.filter(r => r.normalized_name === normalized).map(r => r.candidate_domain)].filter((d): d is string => !!d);
        const configured = (source.config.corporate_websites as Record<string, unknown> | undefined)?.[normalized];
        const brand = guesses.find(candidate => candidate.kind === "first_word")?.tenant;
        const candidates = corporateCandidates(name, domains, configured);
        if (brand) candidates.push(`https://${brand}.com/`);
        const discovered = await discoverCorporateCareers(ctx, name, candidates, http.remaining - corporateRequests);
        corporateRequests += discovered.requests;
        for (const page of discovered.pages) result.items.push(item(source.id, page.url, 200, "text/html", page.html, ctx.now(), { kind: "corporate_careers", company_name: name, normalized_name: normalized }));
        found = discovered.pages.length > 0;
        if (!found && discovered.incomplete) {
          transient = true;
          result.errors.push({ url: discovered.errors[0]?.url ?? "corporate-discovery", kind: "corporate_access", message: discovered.errors.map(e => e.error).slice(0, 3).join("; ") || "corporate request budget exhausted" });

        }
      }
      if (found) foundNames++;
      // A temporary error or an interrupted search is not evidence of absence.
      // Leave it eligible for the next run; HTTP already bounds retries within this run.
      if (!limits.dryRun && !result.blocked && (found || (!transient && !incomplete))) {
        await ctx.store.saveResolverAttempt({ normalized_name: normalized, company_name: name, found, probes, tried_at: ctx.now().toISOString() });
      }
    }
    result.requests = http.requests + corporateRequests;
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
    const allSites = await ctx.store.workdaySites(false);
    const enabled = allSites.filter(site => site.enabled && (site.company_id || site.review_item_id || source.config.include_unmatched !== false));
    // Sites saved before the primary-site rule existed: still only the main site per tenant is collected.
    const byTenant = new Map<string, typeof enabled>();
    for (const site of enabled) byTenant.set(`${site.tenant}.${site.pod}`, [...(byTenant.get(`${site.tenant}.${site.pod}`) ?? []), site]);
    // --limit counts sites (companies); the ones checked longest ago (or never) go first, so every company is covered over time.
    const checked = (group: typeof enabled) => group.map(s => s.last_checked_at ?? "").sort().at(-1) ?? "";
    const groups = [...byTenant.values()].sort((a, b) => checked(a).localeCompare(checked(b))).slice(0, limits.maxItems);
    ctx.log.info(`workday jobs: ${groups.length} tenants`);
    for (const group of groups) {
      // Recover alternatives from the original response, including databases that only saved
      // an old primary choice. Never invent a site or fall through an access failure.
      const seed = group[0];
      const observed = group.map(s => s.site);
      if (seed.capture_id) {
        const capture = await ctx.store.captureById(seed.capture_id);
        if (capture?.url === `${origin(seed.tenant, seed.pod)}/robots.txt` && capture.http_status === 200) observed.push(...sitesFromRobots(capture.body, seed.tenant, seed.pod));
        else if (capture?.http_status === 200 && /text\/html|application\/xhtml\+xml/i.test(capture.content_type ?? "")) observed.push(...corporateWorkdayLinks(capture.body, capture.url, seed.company_name).filter(link => link.tenant === seed.tenant && link.pod === seed.pod).map(link => link.site));

      }
      const disabled = new Set(allSites.filter(s => !s.enabled && s.tenant === seed.tenant && s.pod === seed.pod).map(s => s.site));
      const ranked = rankedSites(observed.filter(s => !disabled.has(s)), seed.tenant);
      // When the tenant has a site carrying its own name, an empty one never falls back to a differently named
      // sibling: a shared tenant can host another brand (AccentureCareers and AvanadeCareers).
      const brandedSites = ranked.filter(site => tenantBrandedSite(site, seed.tenant));
      const candidates = brandedSites.length ? brandedSites : ranked;
      for (const siteName of candidates.slice(0, 3)) {
        let site = group.find(s => s.site === siteName) ?? { ...seed, id: "", site: siteName };
        if (result.blocked || http.remaining < 2) break;
        const before = result.items.length, errorsBefore = result.errors.length;
        const base = `${origin(site.tenant, site.pod)}/wday/cxs/${site.tenant}/${site.site}`;
        const postings: Posting[] = [];
        let listFailed = false;
        for (let offset = 0; offset < WORKDAY_OFFSET_CAP && postings.length < perSite; offset += WORKDAY_PAGE_SIZE) {
          const page = await http.request(`${base}/jobs`, { method: "POST", expect: "json", json: { appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset, searchText } });
          if (!page.ok) { fail(result, page); listFailed = true; break; }
          const list = (page.json as { jobPostings?: Posting[]; total?: number })?.jobPostings;
          // A 200 that is not a job list is an "unavailable" page in disguise.
          if (!Array.isArray(list)) { fail(result, { ok: false, kind: "unavailable", status: page.status, message: "jobs response has no jobPostings array", url: page.url }); listFailed = true; break; }
          postings.push(...list.filter(p => typeof p?.externalPath === "string"));
          const total = (page.json as { total?: number }).total ?? 0;
          if (list.length < WORKDAY_PAGE_SIZE || offset + WORKDAY_PAGE_SIZE >= Math.min(total || 0, WORKDAY_OFFSET_CAP)) break;
        }
        if (listFailed) {
          // Record the attempted check so one failing tenant cannot monopolize later batches.
          // This is not a successful check or an admission/identity decision.
          if (!limits.dryRun && site.id) await ctx.store.markSiteChecked(site.id, "errors", ctx.now().toISOString());
          break;
        }
        if (!postings.length) {
          // No keyword hits does not mean the site is empty. Only a successful unfiltered
          // empty response allows trying the next observed site.
          if (searchText) {
            const available = await http.request(`${base}/jobs`, { method: "POST", expect: "json", json: { appliedFacets: {}, limit: 1, offset: 0, searchText: "" } });
            if (!available.ok) {
              fail(result, available);
              if (!limits.dryRun && site.id) await ctx.store.markSiteChecked(site.id, "errors", ctx.now().toISOString());
              break;
            }
            const jobs = (available.json as { jobPostings?: unknown }).jobPostings;
            if (!Array.isArray(jobs)) {
              fail(result, { ok: false, kind: "unavailable", status: available.status, message: "jobs response has no jobPostings array", url: available.url });
              if (!limits.dryRun && site.id) await ctx.store.markSiteChecked(site.id, "errors", ctx.now().toISOString());
              break;
            }
            if (jobs.length) {
              if (!limits.dryRun && site.id) await ctx.store.markSiteChecked(site.id, "0 matching postings; site has jobs", ctx.now().toISOString());
              break;
            }
          }
          if (!limits.dryRun && site.id) await ctx.store.markSiteChecked(site.id, "empty site", ctx.now().toISOString());
          // An empty branded site does not authorize collecting an unrelated sibling employer.
          if (tenantBrandedSite(site.site, site.tenant)) break;
          continue;
        }
        if (!site.id && !limits.dryRun) {
          const saved = await ctx.store.upsertWorkdaySite({ tenant: site.tenant, pod: site.pod, site: site.site, company_name: site.company_name, normalized_name: site.normalized_name, match_kind: site.match_kind, discovered_from: source.id, capture_id: site.capture_id });
          site = { ...site, id: saved.id };
          if (site.company_id || site.review_item_id) await ctx.store.linkWorkdaySites(site.normalized_name, site.company_id ? { company_id: site.company_id } : { review_item_id: site.review_item_id! });
        }
        for (const posting of postings.slice(0, perSite)) {
          if (result.blocked || http.remaining < 1) break;
          if (!/^\/job\/[^?#\\]+$/.test(posting.externalPath!) || /%2f|%5c|%2e|(?:^|\/)\.{1,2}(?:\/|$)/i.test(posting.externalPath!)) { fail(result, { ok: false, kind: "malformed", status: 200, message: "invalid Workday job path", url: base }); break; }
          const detail = await http.request(`${base}${posting.externalPath}`, { expect: "json" });
          if (!detail.ok) { if (fail(result, detail)) break; continue; }
          const info = (detail.json as { jobPostingInfo?: { jobDescription?: string } })?.jobPostingInfo;
          if (!info || typeof info.jobDescription !== "string") { fail(result, { ok: false, kind: "unavailable", status: detail.status, message: "job detail has no jobPostingInfo.jobDescription", url: detail.url }); continue; }
          result.items.push(item(source.id, detail.url, detail.status, detail.contentType, detail.body, ctx.now(),
            { kind: "workday_job", site_id: site.id || null, tenant: site.tenant, pod: site.pod, site: site.site, company_name: site.company_name, normalized_name: site.normalized_name, company_id: site.company_id, review_item_id: site.review_item_id }, WORKDAY_VOLATILE_KEYS));
        }
        if (!limits.dryRun && !result.blocked && site.id) await ctx.store.markSiteChecked(site.id, result.errors.length > errorsBefore ? "errors" : `${result.items.length - before} postings`, ctx.now().toISOString());
        break;
      }
    }
    result.requests = http.requests;
    if (ctx.signal?.aborted) result.blocked = "source time budget reached";
    return result;
  }
}
