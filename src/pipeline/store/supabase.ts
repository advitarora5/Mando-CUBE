// PipelineStore on Supabase. Refuses any non-local database unless PIPELINE_ALLOW_REMOTE names that project's ref,
// so a teammate's .env.local pointing at production can never receive test or experimental data by accident.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseSettings } from "../../domain/ingestion/settings.ts";
import type { ScoreRow } from "../../domain/scoring/assessment.ts";
import type { ScoreChange } from "../../domain/ingestion/score-change.ts";
import type {
  CaptureRow, CompanyRow, ContactRow, ExtractionRecord, PipelineStore, RawItem, ReviewItem, RunCounts, RunStatus,
  SignalInput, SignalRow, SourceRow, StoredScore, WorkdaySite, ResolverAttempt, ResolverCutoffs, WebsiteResolution, WebsiteCapture,
} from "../types.ts";

export function assertAllowedTarget(url: string, allowRemote: string | undefined): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Pipeline database URL is not a valid URL."); }
  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return parsed.origin;
  const ref = parsed.hostname.split(".")[0];
  if (allowRemote && allowRemote === ref) return parsed.origin;
  throw new Error(`Refusing to write to remote Supabase project "${ref}". The pipeline targets a local or test database; set PIPELINE_ALLOW_REMOTE=${ref} only for an approved test project.`);
}

const CONTACT_FIELDS = "id, company_id, name, title, source, linkedin_url, linkedin_status, email, email_verified, email_status, email_source, phone, phone_status, phone_source, mutual_connection, contact_sources";
const PAGE = 1000;
const SCORE_FIELDS = "id, company_id, assessed_at, rubric_version, tier, authority_score, authority_evidence, reachability_score, reachability_evidence, budget_score, budget_evidence, release_score, release_evidence, timing_score, timing_evidence";

export class SupabaseStore implements PipelineStore {
  readonly kind = "supabase" as const;
  readonly db: SupabaseClient;
  readonly databaseUrl: string;
  constructor(url: string, key: string, allowRemote?: string) {
    assertAllowedTarget(url, allowRemote);
    this.databaseUrl = new URL(url).origin;
    this.db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  // The API returns at most max_rows (1,000 by default) per request, silently. Every list read pages through all rows
  // in a stable order, so matching and scoring never miss companies past the first page.
  private async all<T>(make: () => { range(from: number, to: number): PromiseLike<{ data: unknown; error: { message: string } | null }> }, what: string): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const page = this.check(await make().range(from, from + PAGE - 1), what) as T[];
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }

  private check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
    if (result.error) throw new Error(`${what}: ${result.error.message}`);
    return result.data;
  }

  async settings() { return parseSettings(this.check(await this.db.from("pipeline_settings").select("key, value"), "settings") ?? []); }
  async sources() { return this.check(await this.db.from("sources").select("id, type, name, config, frequency, max_requests_per_run, min_delay_ms, enabled"), "sources") as SourceRow[]; }

  async startRun(run: { job: string; source_id: string | null; trigger: "schedule" | "manual" | "import_button" }) {
    // started_at and finished_at come from the same (host) clock, so a run never appears to end before it began.
    return (this.check(await this.db.from("pipeline_runs").insert({ ...run, started_at: new Date().toISOString() }).select("id").single(), "start run") as { id: string }).id;
  }
  async finishRun(id: string, r: { status: RunStatus; counts: RunCounts; requests: number; llm_spend_usd: number; treg_spend_usd: number; error: string | null }) {
    this.check(await this.db.from("pipeline_runs").update({ status: r.status, counts: r.counts, requests_made: r.requests, llm_spend_usd: r.llm_spend_usd, treg_spend_usd: r.treg_spend_usd, error: r.error, finished_at: new Date().toISOString() }).eq("id", id), "finish run");
  }
  async closeStaleRuns(startedBefore: string) {
    const rows = this.check(await this.db.from("pipeline_runs").update({ status: "failed", finished_at: new Date().toISOString(), error: "run did not finish (closed at a later start)" }).eq("status", "running").lt("started_at", startedBefore).select("id"), "close stale runs") as { id: string }[];
    return rows.length;
  }
  async recentRuns(sourceId: string, n: number) {
    const rows = this.check(await this.db.from("pipeline_runs").select("status, counts, error").eq("source_id", sourceId).not("finished_at", "is", null).order("started_at", { ascending: false }).limit(n), "recent runs") as { status: RunStatus; counts: RunCounts; error: string | null }[];
    return rows.map(r => ({ status: r.status, items: Number(r.counts?.items ?? 0), error: r.error }));
  }

  async saveCapture(item: RawItem, runId: string | null): Promise<{ id: string; inserted: boolean }> {
    const found = this.check(await this.db.from("raw_captures").select("id").eq("url", item.url).eq("content_hash", item.fingerprint).maybeSingle(), "find capture") as { id: string } | null;
    if (found) return { id: found.id, inserted: false };
    const res = await this.db.from("raw_captures").insert({ source_id: item.source, run_id: runId, url: item.url, fetched_at: item.fetched_at, http_status: item.http_status, content_type: item.content_type, content_hash: item.fingerprint, body: item.raw, meta: item.meta ?? {} }).select("id").single();
    if (res.error?.code === "23505") return this.saveCapture(item, runId);
    return { id: (this.check(res, "save capture") as { id: string }).id, inserted: true };
  }
  async latestCapture(sourceId: string) {
    return this.check(await this.db.from("raw_captures").select("*").eq("source_id", sourceId).order("fetched_at", { ascending: false }).limit(1).maybeSingle(), "latest capture") as CaptureRow | null;
  }
  async captureById(id: string) {
    return this.check(await this.db.from("raw_captures").select("*").eq("id", id).maybeSingle(), "capture") as CaptureRow | null;
  }
  async tenantIndexCache(sourceId: string) {
    return this.check(await this.db.from("raw_captures").select("*").eq("source_id", sourceId)
      .eq("meta->>kind", "workday_index_cache").order("fetched_at", { ascending: false }).limit(1).maybeSingle(), "tenant index cache") as CaptureRow | null;
  }
  async pendingCaptures(limit: number, sourceIds?: string[]) {
    let query = this.db.from("pending_captures").select("*").order("fetched_at", { ascending: true }).limit(limit);
    if (sourceIds) query = query.in("source_id", sourceIds);
    return this.check(await query, "pending captures") as CaptureRow[];
  }
  async saveExtraction(r: ExtractionRecord) {
    const row = { capture_id: r.capture_id, run_id: r.run_id, method: r.method, model: r.model, status: r.status, output: r.output, error: r.error, cost_usd: r.cost_usd, attempts: r.attempts, prompt_version: r.prompt_version };
    return (this.check(await this.db.from("extractions").upsert(row, { onConflict: "capture_id,method,model" }).select("id").single(), "save extraction") as { id: string }).id;
  }

  async upsertSignal(signal: SignalInput): Promise<{ id: string; inserted: boolean }> {
    const found = this.check(await this.db.from("signals").select("id, last_seen_at").eq("type", signal.type).eq("source_url", signal.source_url).eq("quote", signal.quote).maybeSingle(), "find signal") as { id: string; last_seen_at: string } | null;
    if (found) {
      if (Date.parse(signal.seen_at) > Date.parse(found.last_seen_at)) this.check(await this.db.from("signals").update({ last_seen_at: signal.seen_at }).eq("id", found.id), "touch signal");
      return { id: found.id, inserted: false };
    }
    const { seen_at, ...rest } = signal;
    const res = await this.db.from("signals").insert({ ...rest, first_seen_at: seen_at, last_seen_at: seen_at }).select("id").single();
    if (res.error?.code === "23505") return this.upsertSignal(signal);
    return { id: (this.check(res, "insert signal") as { id: string }).id, inserted: true };
  }
  async touchSignals(captureId: string, seenAt: string) {
    const rows = this.check(await this.db.from("signals").update({ last_seen_at: seenAt }).eq("capture_id", captureId).lt("last_seen_at", seenAt).select("id"), "touch signals") as { id: string }[];
    return rows.length;
  }
  async unassignedSignals() {
    return this.all<SignalRow>(() => this.db.from("signals").select("*").is("company_id", null).is("review_item_id", null).order("id"), "unassigned signals");
  }
  async assignSignals(ids: string[], target: { company_id: string } | { review_item_id: string }) {
    if (ids.length) this.check(await this.db.from("signals").update(target).in("id", ids), "assign signals");
  }
  async signalsForCompany(companyId: string) {
    return this.all<SignalRow>(() => this.db.from("signals").select("*").eq("company_id", companyId).order("id"), "company signals");
  }

  async companies(): Promise<CompanyRow[]> {
    const rows = await this.all<{ id: string; name: string; domain: string | null; employee_count: number | null; company_origins: unknown }>(() => this.db.from("companies").select("id, name, domain, employee_count, company_origins(origin)").order("id"), "companies");
    return rows.map(r => ({ id: r.id, name: r.name, domain: r.domain, employee_count: r.employee_count, pipeline: Array.isArray(r.company_origins) ? r.company_origins.length > 0 : !!r.company_origins }));
  }
  async createPipelineCompany(c: { name: string; domain: string | null; employee_count: number | null; source: string }, runId: string | null, attach: { signal_ids: string[]; normalized_name: string | null }) {
    return this.check(await this.db.rpc("pipeline_create_company", { p_name: c.name, p_domain: c.domain ?? "", p_employee_count: c.employee_count, p_source: c.source, p_run_id: runId, p_signal_ids: attach.signal_ids, p_normalized_name: attach.normalized_name }), "create company") as string;
  }
  async addReviewItem(item: Omit<ReviewItem, "id" | "status" | "resolved_company_id" | "created_at">): Promise<{ id: string; inserted: boolean }> {
    const found = this.check(await this.db.from("review_queue").select("id").eq("normalized_name", item.normalized_name).eq("status", "pending").maybeSingle(), "find review item") as { id: string } | null;
    if (found) return { id: found.id, inserted: false };
    const res = await this.db.from("review_queue").insert(item).select("id").single();
    if (res.error?.code === "23505") return this.addReviewItem(item);
    return { id: (this.check(res, "add review item") as { id: string }).id, inserted: true };
  }
  async signalsForReview(itemId: string) {
    return this.all<SignalRow>(() => this.db.from("signals").select("*").eq("review_item_id", itemId).is("company_id", null).order("id"), "review signals");
  }
  async websiteEvidenceCaptures(name: string, limit: number): Promise<WebsiteCapture[]> {
    const rows = this.check(await this.db.from("raw_captures").select("*, signals(last_seen_at)")
      .eq("source_id", "workday-career-sites").eq("meta->>kind", "workday_job").eq("meta->>normalized_name", name).eq("http_status", 200)
      .order("fetched_at", { ascending: false }).order("id").limit(limit), "website evidence captures") as (WebsiteCapture & { signals: { last_seen_at: string }[] })[];
    return rows.map(({ signals, ...capture }) => ({ ...capture, last_seen_at: signals.reduce((latest, s) => s.last_seen_at > latest ? s.last_seen_at : latest, capture.fetched_at) }));
  }
  async fillReviewWebsite(id: string, domain: string) {
    const rows = this.check(await this.db.from("review_queue").update({ candidate_domain: domain }).eq("id", id).eq("status", "pending").is("candidate_domain", null).select("id"), "fill review website") as { id: string }[];
    return rows.length > 0;
  }
  async websiteResolution(name: string) {
    return this.check(await this.db.from("website_resolutions").select("*").eq("normalized_name", name).maybeSingle(), "website resolution") as WebsiteResolution | null;
  }
  async saveWebsiteResolution(value: WebsiteResolution) { this.check(await this.db.from("website_resolutions").upsert(value), "save website resolution"); }
  async updatePendingReview(id: string, patch: { candidate_domain: string | null; reason: ReviewItem["reason"]; suggested_company_id: string | null; candidate_name?: string }) {
    const rows = this.check(await this.db.from("review_queue").update(patch).eq("id", id).eq("status", "pending").neq("reason", "similar_name").select("id"), "update pending review") as { id: string }[];
    if (!rows.length) throw Error("review is no longer eligible");
  }
  async admitReview(id: string, domain: string, source: string, existingCompanyId: string | null, runId: string | null) {
    return this.check(await this.db.rpc("pipeline_admit_review", { p_item: id, p_domain: domain, p_source: source, p_existing_company: existingCompanyId, p_run_id: runId }), "admit review") as string;
  }
  async reviewItems(status?: ReviewItem["status"]) {
    return this.all<ReviewItem>(() => {
      const query = this.db.from("review_queue").select("*").order("created_at", { ascending: false }).order("id");
      return status ? query.eq("status", status) : query;
    }, "review items");
  }
  async resolveReview(itemId: string, decision: { action: "approve"; domain?: string | null } | { action: "merge"; company_id: string } | { action: "reject" }, note: string, runId: string | null) {
    if (decision.action === "approve") return this.check(await this.db.rpc("review_approve", { p_item: itemId, p_domain: decision.domain ?? "", p_note: note, p_run_id: runId }), "approve") as string;
    const company = decision.action === "merge" ? decision.company_id : null;
    this.check(await this.db.rpc("review_resolve", { p_item: itemId, p_company: company, p_status: decision.action === "merge" ? "merged" : "rejected", p_note: note }), decision.action);
    return company;
  }

  async workdaySites(onlyEnabled: boolean) {
    return this.all<WorkdaySite>(() => {
      const query = this.db.from("workday_sites").select("*").order("created_at").order("id");
      return onlyEnabled ? query.eq("enabled", true) : query;
    }, "workday sites");
  }
  async upsertWorkdaySite(site: Omit<WorkdaySite, "id" | "company_id" | "review_item_id" | "enabled"> & { discovered_from: string }) {
    const found = this.check(await this.db.from("workday_sites").select("id").eq("tenant", site.tenant).eq("pod", site.pod).eq("site", site.site).maybeSingle(), "find site") as { id: string } | null;
    if (found) return { id: found.id, inserted: false };
    return { id: (this.check(await this.db.from("workday_sites").insert(site).select("id").single(), "add site") as { id: string }).id, inserted: true };
  }
  async markSiteChecked(id: string, status: string, at: string) {
    this.check(await this.db.from("workday_sites").update({ last_checked_at: at, last_status: status }).eq("id", id), "mark site");
  }
  async linkWorkdaySites(normalizedName: string, target: { company_id: string } | { review_item_id: string }) {
    this.check(await this.db.from("workday_sites").update(target).eq("normalized_name", normalizedName).is("company_id", null), "link sites");
  }
  async resolverAttempts(names: string[]) {
    if (!names.length) return new Set<string>();
    const rows: { normalized_name: string }[] = [];
    for (let i = 0; i < names.length; i += 200) rows.push(...(this.check(await this.db.from("workday_resolver_attempts").select("normalized_name").in("normalized_name", names.slice(i, i + 200)), "resolver attempts") as { normalized_name: string }[]));
    return new Set(rows.map(r => r.normalized_name));
  }
  async dueResolverAttempts(cutoffs: ResolverCutoffs, limit: number) {
    if (limit <= 0) return [];
    const results = await Promise.all([true, false].map(found => this.db.from("workday_resolver_attempts")
      .select("normalized_name, company_name, found, probes, tried_at").eq("found", found)
      .lte("tried_at", found ? cutoffs.foundBefore : cutoffs.missBefore)
      .order("tried_at").order("normalized_name").limit(limit)));
    return results.flatMap(r => this.check(r, "due resolver attempts") as ResolverAttempt[])
      .sort((a, b) => Number(b.found) - Number(a.found) || a.tried_at.localeCompare(b.tried_at) || a.normalized_name.localeCompare(b.normalized_name))
      .slice(0, limit);
  }
  async saveResolverAttempt(a: Omit<ResolverAttempt, "tried_at"> & { tried_at?: string }) {
    this.check(await this.db.from("workday_resolver_attempts").upsert({ ...a, tried_at: a.tried_at ?? new Date().toISOString() }), "save attempt");
  }

  async contactsForCompany(companyId: string) {
    return this.check(await this.db.from("contacts").select(CONTACT_FIELDS).eq("company_id", companyId), "contacts") as unknown as ContactRow[];
  }
  async latestScore(companyId: string) {
    return this.check(await this.db.from("scores").select(SCORE_FIELDS).eq("company_id", companyId).order("assessed_at", { ascending: false }).limit(1).maybeSingle(), "latest score") as StoredScore | null;
  }
  async insertScore(row: ScoreRow, assessedAt: string, change?: ScoreChange) {
    const base = { ...row, assessed_at: assessedAt };
    if (change) {
      const saved = await this.db.from("scores").insert({ ...base, ...change }).select("id").single();
      if (!saved.error) return (saved.data as { id: string }).id;
      // Until the score-change migration is applied those columns do not exist; keep scoring without them.
      if (!/column|schema cache/i.test(saved.error.message)) this.check(saved, "insert score");
    }
    return (this.check(await this.db.from("scores").insert(base).select("id").single(), "insert score") as { id: string }).id;
  }
  async setEnrichment(companyId: string, status: string, reason: string) {
    this.check(await this.db.from("enrichment_requests").upsert({ company_id: companyId, status, reason }), "set enrichment");
  }
  async enrichmentStatus(companyId: string) {
    return (this.check(await this.db.from("enrichment_requests").select("status").eq("company_id", companyId).maybeSingle(), "enrichment status") as { status: string } | null)?.status ?? null;
  }
  async updateContact(contactId: string, patch: Record<string, unknown>) {
    this.check(await this.db.from("contacts").update(patch).eq("id", contactId), "update contact");
  }
  async insertContact(contact: Omit<ContactRow, "id"> & { contact_sources?: unknown }) {
    return this.check(await this.db.rpc("insert_contact_if_absent", { p_company_id: contact.company_id, p_contact: contact }), "insert contact") as string;
  }

  async claimContactResearch(companyId: string, owner: string) {
    return this.check(await this.db.rpc("lock_contact_completion", { p_company_id: companyId, p_owner: owner }), "lock contact research") as boolean;
  }
  async releaseContactResearch(companyId: string, owner: string) {
    this.check(await this.db.from("contact_completion_locks").delete().eq("company_id", companyId).eq("owner", owner), "release contact research");
  }
  async contactCall(companyId: string, key: string) {
    return this.check(await this.db.from("contact_completion_calls").select("*").eq("company_id", companyId).eq("request_key", key).maybeSingle(), "contact checkpoint") ?? this.check(await this.db.from("contact_research_calls").select("*").eq("company_id", companyId).eq("request_key", key).maybeSingle(), "legacy contact checkpoint");
  }
  async startContactCall(companyId: string, key: string, endpoint: string) {
    this.check(await this.db.from("contact_completion_calls").insert({ company_id: companyId, request_key: key, endpoint, status: "running" }), "claim contact call");
  }
  async finishContactCall(companyId: string, key: string, result: import("../types.ts").ContactCall) {
    this.check(await this.db.from("contact_completion_calls").update(result).eq("company_id", companyId).eq("request_key", key), "finish contact call");
  }
  async completeContact(contact: ContactRow, patch: Record<string, unknown>) {
    return this.check(await this.db.rpc("complete_contact_if_unchanged", { p_id: contact.id, p_expected: contact, p_patch: patch }), "complete contact") as boolean;
  }
  async paidCall(key: string) {
    return this.check(await this.db.from("paid_calls").select("outcome, response, cost_usd").eq("idempotency_key", key).maybeSingle(), "paid call") as { outcome: string; response: unknown; cost_usd: number } | null;
  }
  async recordPaidCall(call: { idempotency_key: string; provider: string; endpoint: string; subject: string; step: string; run_id: string | null; cost_usd: number; outcome: string; response: unknown }) {
    this.check(await this.db.from("paid_calls").upsert(call), "record paid call");
  }

  async health() {
    return this.check(await this.db.from("pipeline_health").select("*").single(), "health") as Record<string, unknown>;
  }
  async sourceAlerts() {
    return this.check(await this.db.from("source_alerts").select("*"), "source alerts") as { source_id: string; failed_runs: number; empty_runs: number }[];
  }
}
