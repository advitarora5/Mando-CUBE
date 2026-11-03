// Non-Workday collectors: SEC company list (free, names only), r/workday through treg (insight feed),
// and companies-using-Workday through treg (PredictLeads, paid, off by default).
import { readFileSync } from "node:fs";
import { contentFingerprint } from "../../domain/ingestion/fingerprint.ts";
import { PoliteHttp, STOPPING_FAILURES } from "../http.ts";
import type { Collector, CollectLimits, CollectResult, PipelineContext, RawItem, SourceRow } from "../types.ts";
import { WorkdayTenantCrawl, WorkdayTenantWayback } from "./crawl.ts";
import { WorkdayJobs, WorkdayResolver } from "./workday.ts";

const empty = (): CollectResult => ({ items: [], requests: 0, blocked: null, errors: [], spend_usd: 0 });
const raw = (source: string, url: string, status: number, contentType: string | null, body: string, now: Date, meta: Record<string, unknown>): RawItem =>
  ({ source, url, fetched_at: now.toISOString(), http_status: status, content_type: contentType, raw: body, fingerprint: contentFingerprint(body), meta });

// SEC EDGAR company_tickers.json: ~10,000 public company names, documented, robots-allowed. Feeds the Workday resolver.
export class SecCompanyList implements Collector {
  readonly type = "sec_company_list";
  async collect(source: SourceRow, limits: CollectLimits, ctx: PipelineContext): Promise<CollectResult> {
    const result = empty();
    const http = new PoliteHttp(ctx, { maxRequests: limits.maxRequests, minDelayMs: Math.max(limits.minDelayMs, 1000), maxRetries: 1, timeoutMs: 60000 });
    const url = String(source.config.url ?? "https://www.sec.gov/files/company_tickers.json");
    // SEC's fair-access policy requires a contact email in the User-Agent (it answers 403 without one).
    // Without PIPELINE_CONTACT, a copy of the same file can be supplied with PIPELINE_SEC_FILE.
    const file = process.env.PIPELINE_SEC_FILE;
    if (file && !ctx.contact) {
      const body = readFileSync(file, "utf8");
      let rows = 0;
      try { rows = Object.keys(JSON.parse(body)).length; } catch { /* checked below */ }
      if (rows < 100) { result.errors.push({ url, kind: "malformed", message: `${file} is not the SEC company list` }); return result; }
      result.items.push(raw(source.id, url, 200, "application/json", body, ctx.now(), { kind: "sec_company_list", rows, from_file: true }));
      return result;
    }
    if (!ctx.contact) { result.errors.push({ url, kind: "skipped", message: "SEC requires a contact email in the User-Agent: set PIPELINE_CONTACT (or PIPELINE_SEC_FILE)" }); return result; }
    const got = await http.request(url, { expect: "json" });
    result.requests = http.requests;
    if (!got.ok) {
      result.errors.push({ url, kind: got.kind, message: got.message });
      if (STOPPING_FAILURES.includes(got.kind)) result.blocked = `${got.kind}: ${got.message}`;
      return result;
    }
    const values = got.json && typeof got.json === "object" ? Object.values(got.json as Record<string, { title?: string }>) : [];
    if (values.length < 100 || !values.every(v => typeof v?.title === "string")) {
      result.errors.push({ url, kind: "unavailable", message: `expected a company list, got ${values.length} rows` });
      return result;
    }
    result.items.push(raw(source.id, url, got.status, got.contentType, got.body, ctx.now(), { kind: "sec_company_list", rows: values.length }));
    return result;
  }
}

// Paid treg call wrapped in the spend guard. A 402 stops paid treg work for the run; other failures fail this source only.
export async function paidTregCall(ctx: PipelineContext, endpoint: string, worstCaseUsd: number, label: string, opts: { query?: Record<string, string | number>; body?: unknown; headers?: Record<string, string>; idempotencyKey?: string }) {
  if (!ctx.treg) return { skipped: "treg is not configured" as const };
  if (!(await ctx.spend.allow("treg", worstCaseUsd, label))) return { skipped: "budget" as const };
  const res = await ctx.treg.call(endpoint, { ...opts, headers: { "X-Treg-Route-Max-Cost": worstCaseUsd.toFixed(4), ...opts.headers } });
  await ctx.spend.record({ provider: "treg", endpoint, step: label, subject: opts.idempotencyKey ?? label, idempotency_key: opts.idempotencyKey ?? "", worst_case_usd: worstCaseUsd, cost_usd: res.cost_usd, outcome: res.ok ? "ok" : res.error });
  if (!res.ok && res.status === 402) (ctx.spend as { stop?: (p: string, r: string) => void }).stop?.("treg", "treg returned 402 (balance exhausted)");
  return { res };
}

// r/workday newest posts through treg. Insight feed (release-planning discussion), not a company list.
export class TregReddit implements Collector {
  readonly type = "treg_reddit";
  async collect(source: SourceRow, _limits: CollectLimits, ctx: PipelineContext): Promise<CollectResult> {
    const result = empty();
    const subreddit = String(source.config.subreddit ?? "workday");
    const endpoint = String(source.config.endpoint ?? "tikhub.x.reddit-app-fetch-subreddit-feed");
    const worst = Number(source.config.max_cost_usd ?? 0.002);
    const day = ctx.now().toISOString().slice(0, 10);
    const call = await paidTregCall(ctx, endpoint, worst, `reddit r/${subreddit}`, { query: { subreddit_name: subreddit, sort: "NEW", need_format: "true" }, idempotencyKey: `reddit:${subreddit}:${day}` });
    if ("skipped" in call) { result.errors.push({ url: `treg:${endpoint}`, kind: "skipped", message: String(call.skipped) }); return result; }
    result.requests = 1;
    result.spend_usd = call.res.cost_usd;
    if (!call.res.ok) {
      result.errors.push({ url: `treg:${endpoint}`, kind: call.res.status === 402 ? "budget" : "http", message: call.res.error });
      if (call.res.status === 402) result.blocked = "treg 402";
      return result;
    }
    const body = JSON.stringify(call.res.body);
    result.items.push(raw(source.id, `https://www.reddit.com/r/${subreddit}/new/`, call.res.status, "application/json", body, ctx.now(), { kind: "reddit_feed", subreddit, endpoint, treg_call_id: call.res.call_id }));
    return result;
  }
}

// Companies whose websites show Workday, through treg (PredictLeads). $0.04 per returned record: off unless enabled and budgeted.
export class TregWorkdayUsers implements Collector {
  readonly type = "treg_tech_lookup";
  async collect(source: SourceRow, limits: CollectLimits, ctx: PipelineContext): Promise<CollectResult> {
    const result = empty();
    const limit = Math.min(Number(source.config.limit ?? 10), limits.maxItems);
    const endpoint = String(source.config.endpoint ?? "predictleads.technologies.users");
    const since = new Date(ctx.now().getTime() - 90 * 86400000).toISOString().slice(0, 10);
    const call = await paidTregCall(ctx, endpoint, 0.04 * limit, `workday users x${limit}`, { query: { technology_id_or_fuzzy_name: String(source.config.technology ?? "workday"), limit, first_seen_at_from: since }, idempotencyKey: `predictleads:workday:${since}:${limit}` });
    if ("skipped" in call) { result.errors.push({ url: `treg:${endpoint}`, kind: "skipped", message: String(call.skipped) }); return result; }
    result.requests = 1;
    result.spend_usd = call.res.cost_usd;
    if (!call.res.ok) { result.errors.push({ url: `treg:${endpoint}`, kind: "http", message: call.res.error }); return result; }
    result.items.push(raw(source.id, `https://predictleads.com/technologies/workday`, call.res.status, "application/json", JSON.stringify(call.res.body), ctx.now(), { kind: "predictleads_detections", endpoint }));
    return result;
  }
}

export const collectors: Record<string, Collector> = {
  sec_company_list: new SecCompanyList(),
  workday_site_resolver: new WorkdayResolver(),
  workday_tenant_crawl: new WorkdayTenantCrawl(),
  workday_tenant_wayback: new WorkdayTenantWayback(),
  workday_career_site: new WorkdayJobs(),
  treg_reddit: new TregReddit(),
  treg_tech_lookup: new TregWorkdayUsers(),
};
