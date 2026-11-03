// Workday career-site tenants from the Common Crawl URL index (free, public, no key). Every crawled
// {tenant}.{pod}.myworkdayjobs.com host is a candidate; robots.txt on that host is the deterministic check
// (the resolver reads the same file), and only a host that lists career sites becomes a raw item.
// Verified live 2026-10-26: *.wd5.myworkdayjobs.com is 2 index pages in one crawl, about 300 distinct tenants.
import { isExcludedCompany } from "../../domain/ingestion/matching.ts";
import { normalizeName } from "../../domain/ingestion/normalize.ts";
import { PoliteHttp, type HttpResult } from "../http.ts";
import type { Collector, CollectLimits, CollectResult, PipelineContext, SourceRow } from "../types.ts";
import { empty, fail, item, origin, primarySites, sitesFromRobots, WORKDAY_PODS } from "./workday.ts";

const COLLINFO = "https://index.commoncrawl.org/collinfo.json";
const HOST = /^https?:\/\/([a-z0-9][a-z0-9-]*)\.(wd\d+)\.myworkdayjobs\.com/i;
// Implementation, test and staging tenants are not customers' live career sites.
const NON_LIVE = /(^|-)(impl|sandbox|preview|test|uat|dev|stage|staging|demo)(-|\d*$)/;

export const tenantName = (tenant: string) => tenant.split("-").filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");

// Distinct tenants in the CDX output (one JSON object per line); a tenant has thousands of job URLs.
export function tenantsFromIndex(body: string): { tenant: string; pod: string }[] {
  const seen = new Map<string, { tenant: string; pod: string }>();
  for (const line of body.split("\n")) {
    let url = "";
    try { url = String((JSON.parse(line) as { url?: string }).url ?? ""); } catch { continue; }
    const m = HOST.exec(url);
    if (m) seen.set(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`, { tenant: m[1].toLowerCase(), pod: m[2].toLowerCase() });
  }
  return [...seen.values()];
}

type Tenant = { tenant: string; pod: string };
type IndexGet = (url: string, expect: "json" | "text") => Promise<HttpResult>;

export class WorkdayTenantCrawl implements Collector {
  readonly type: string = "workday_tenant_crawl";
  // Where the candidate tenants come from. Wayback overrides this; everything after it is shared.
  protected async listTenants(source: SourceRow, ctx: PipelineContext, result: CollectResult, indexGet: IndexGet, pods: string[]): Promise<Tenant[]> {
    const info = await indexGet(COLLINFO, "json");
    if (!info.ok) { fail(result, info); return []; }
    const apis = (info.json as { "cdx-api"?: string }[]).slice(0, Number(source.config.crawls ?? 1)).map(c => c["cdx-api"]).filter((u): u is string => !!u);
    // 1. Candidate tenants from the index. A page that keeps failing costs that page, not the run.
    const found = new Map<string, Tenant>();
    for (const api of apis) for (const pod of pods) {
      const base = `${api}?url=*.${pod}.myworkdayjobs.com&output=json&fl=url`;
      const count = await indexGet(`${base}&showNumPages=true`, "json");
      if (!count.ok) { fail(result, count); continue; }
      const pages = Number((count.json as { pages?: number }).pages ?? 0);
      for (let page = 0; page < pages; page++) {
        const got = await indexGet(`${base}&page=${page}`, "text");
        if (!got.ok) { fail(result, got); continue; }
        for (const t of tenantsFromIndex(got.body)) found.set(`${t.tenant}.${t.pod}`, t);
      }
    }
    return [...found.values()];
  }

  async collect(source: SourceRow, limits: CollectLimits, ctx: PipelineContext): Promise<CollectResult> {
    const result = empty();
    // The index answers 502/504 under load: more retries and a longer timeout than the Workday hosts need.
    const http = new PoliteHttp(ctx, { maxRequests: limits.maxRequests, minDelayMs: limits.minDelayMs, maxRetries: 2, timeoutMs: 120000 });
    const pods = (source.config.pods as string[] | undefined) ?? WORKDAY_PODS;

    // The index answers 502/504 when busy and succeeds moments later; PoliteHttp only retries 429, 503 and timeouts.
    const indexGet: IndexGet = async (url, expect) => {
      for (let attempt = 0; ; attempt++) {
        const got = await http.request(url, { expect, checkRobots: false });
        if (got.ok || attempt >= 3 || ![502, 504].includes(got.status)) return got;
        await ctx.sleep(5000);
      }
    };

    const found = await this.listTenants(source, ctx, result, indexGet, pods);
    ctx.log.info(`${this.type}: ${found.length} tenants in the index`);

    // 2. Drop tenants we already have, and names already probed (by this source or the SEC resolver).
    const known = new Set((await ctx.store.workdaySites(false)).map(s => `${s.tenant}.${s.pod}`));
    const fresh = found.filter(t => !known.has(`${t.tenant}.${t.pod}`) && !NON_LIVE.test(t.tenant) && !isExcludedCompany(tenantName(t.tenant)));
    const tried = await ctx.store.resolverAttempts(fresh.map(t => normalizeName(tenantName(t.tenant))));
    const todo = fresh.filter(t => !tried.has(normalizeName(tenantName(t.tenant))));

    // 3. robots.txt is the check: it exists and names career sites only for a live Workday tenant.
    for (const { tenant, pod } of todo) {
      if (result.blocked || http.remaining < 1 || result.items.length >= limits.maxItems) break;
      const name = tenantName(tenant), normalized = normalizeName(name);
      const got = await http.robotsTxt(origin(tenant, pod));
      let hit = false;
      if (got.ok) {
        const sites = sitesFromRobots(got.body, tenant, pod);
        if (sites.length) {
          hit = true;
          // match_kind first_word: the name is the tenant slug, a guess. It is admitted only with a confirmed website and a strong posting.
          result.items.push(item(source.id, got.url, got.status, got.contentType, got.body, ctx.now(),
            { kind: "workday_robots", tenant, pod, sites, primary_sites: primarySites(sites, tenant), company_name: name, normalized_name: normalized, match_kind: "first_word", discovered_via: "commoncrawl" }));
        }
      } else if (!(got.kind === "http" && [404, 410, 422].includes(got.status))) {
        // Anything but a plain miss may be temporary: leave it eligible next run.
        if (fail(result, got)) break;
        continue;
      }
      if (!limits.dryRun) await ctx.store.saveResolverAttempt({ normalized_name: normalized, company_name: name, found: hit, probes: 1, tried_at: ctx.now().toISOString() });
    }
    result.requests = http.requests;
    return result;
  }
}

// Wayback Machine CDX: robots.txt captures of *.{pod}.myworkdayjobs.com, about one line per tenant. The index sometimes holds a
// URL-encoding artifact in the host ("2fbrown" for "brown", "2525252foregon"): the prefix is stripped and the live robots check decides.
export const waybackTenants = (body: string): Tenant[] => {
  const seen = new Map<string, Tenant>();
  for (const url of body.split(/\s+/)) {
    const m = HOST.exec(url);
    if (!m) continue;
    const tenant = m[1].toLowerCase().replace(/^(?:25)*2f(?=[a-z0-9])/, ""), pod = m[2].toLowerCase();
    seen.set(`${tenant}.${pod}`, { tenant, pod });
  }
  return [...seen.values()];
};

export class WorkdayTenantWayback extends WorkdayTenantCrawl {
  readonly type = "workday_tenant_wayback";
  protected async listTenants(source: SourceRow, _ctx: PipelineContext, result: CollectResult, indexGet: IndexGet, pods: string[]): Promise<Tenant[]> {
    const found = new Map<string, Tenant>();
    for (const pod of pods) {
      const url = `https://web.archive.org/cdx/search/cdx?url=*.${pod}.myworkdayjobs.com/robots.txt&fl=original&collapse=urlkey&limit=${Number(source.config.limit ?? 2000)}`;
      const got = await indexGet(url, "text");
      if (!got.ok) { fail(result, got); continue; }
      for (const t of waybackTenants(got.body)) found.set(`${t.tenant}.${t.pod}`, t);
    }
    return [...found.values()];
  }
}
