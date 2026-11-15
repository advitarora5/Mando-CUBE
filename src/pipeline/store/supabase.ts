// PipelineStore on Supabase. Refuses any non-local database unless PIPELINE_ALLOW_REMOTE names that project's ref,
// so a teammate's .env.local pointing at production can never receive test or experimental data by accident.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseSettings } from "../../domain/ingestion/settings.ts";
import { normalizeName } from "../../domain/ingestion/normalize.ts";
import { sectionNames, type SectionScope, type SectionProgress } from "../section-scope.ts";
import type { ScoringClaim, ScoringQueueStatus } from "../scoring-queue.ts";
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
  async ensureSection(scope: SectionScope) {
    this.check(await this.db.from("pipeline_section_manifests").upsert({ version: scope.version, snapshot_sha256: scope.snapshotSha256 }, { onConflict: "version", ignoreDuplicates: true }), "register section manifest");
    const manifest = this.check(await this.db.from("pipeline_section_manifests").select("snapshot_sha256").eq("version", scope.version).single(), "verify section manifest");
    if (manifest?.snapshot_sha256 !== scope.snapshotSha256) throw Error("Stored section manifest differs from this snapshot.");
    const rows = scope.issuers.map(i => ({ version: scope.version, cik: i.cik, section: scope.section, snapshot_sha256: scope.snapshotSha256, company_name: i.name, normalized_name: normalizeName(i.name) }));
    for (let offset = 0; offset < rows.length; offset += 200) this.check(await this.db.from("pipeline_section_issuers").upsert(rows.slice(offset, offset + 200), { onConflict: "version,cik", ignoreDuplicates: true }), "register section");
    const saved = await this.all<typeof rows[number]>(() => this.db.from("pipeline_section_issuers").select("version,cik,section,snapshot_sha256,company_name,normalized_name").eq("version", scope.version).eq("section", scope.section).order("cik"), "verify section assignments");
    const expected = new Map(rows.map(row => [row.cik, row]));
    if (saved.length !== rows.length || saved.some(row => {
      const e = expected.get(row.cik);
      return !e || row.section !== e.section || row.snapshot_sha256 !== e.snapshot_sha256 || row.company_name !== e.company_name || row.normalized_name !== e.normalized_name;
    })) throw Error("Stored section assignment differs from this manifest.");
  }
  async sectionProgress(scope: SectionScope) {
    return this.all<SectionProgress>(() => this.db.from("pipeline_section_issuers").select("cik,status,probes,attempted_at,next_attempt_at").eq("version", scope.version).eq("section", scope.section).order("cik"), "section progress");
  }
  async saveSectionProgress(scope: SectionScope, cik: number, outcome: { status: "found" | "miss" | "retry"; probes: number }, at: string) {
    const rows = this.check(await this.db.from("pipeline_section_issuers").update({ ...outcome, attempted_at: at, next_attempt_at: outcome.status === "retry" ? new Date(Date.parse(at) + 15 * 60000).toISOString() : null })
      .eq("version", scope.version).eq("section", scope.section).eq("cik", cik).select("cik"), "save section progress");
    if (!rows?.length) throw Error("Issuer is outside this section.");
  }
  async linkSectionCapture(scope: SectionScope, cik: number, captureId: string) {
    this.check(await this.db.from("pipeline_section_captures").upsert({ version: scope.version, section: scope.section, cik, capture_id: captureId }, { onConflict: "version,cik,capture_id", ignoreDuplicates: true }), "link section capture");
  }
  async sectionCaptureIds(scope: SectionScope) {
    const rows = await this.all<{ capture_id: string }>(() => this.db.from("pipeline_section_captures").select("capture_id").eq("version", scope.version).eq("section", scope.section).order("capture_id").order("cik"), "section captures");
    return [...new Set(rows.map(row => row.capture_id))];
  }
  private async scopedRows<T>(scope: SectionScope, make: (ids: string[]) => { range(from: number, to: number): PromiseLike<{ data: unknown; error: { message: string } | null }> }, what: string): Promise<T[]> {
    const ids = await this.sectionCaptureIds(scope), out: T[] = [];
    for (let offset = 0; offset < ids.length; offset += 200) out.push(...await this.all<T>(() => make(ids.slice(offset, offset + 200)), what));
    return out;
  }
  async pendingCaptures(limit: number, sourceIds?: string[], scope?: SectionScope) {
    if (scope) {
      const names = sectionNames(scope);
      const rows = await this.scopedRows<CaptureRow>(scope, ids => {
        let q = this.db.from("pipeline_section_pending_captures").select("*").in("id", ids).order("fetched_at").order("id");
        if (sourceIds) q = q.in("source_id", sourceIds);
        return q;
      }, "section pending captures");
      return rows.filter(c => names.has(String(c.meta?.normalized_name ?? ""))).sort((a, b) => a.fetched_at.localeCompare(b.fetched_at) || a.id.localeCompare(b.id)).slice(0, limit);
    }
    let query = this.db.from("pending_captures").select("*").order("fetched_at", { ascending: true }).limit(limit);
    if (sourceIds) query = query.in("source_id", sourceIds);
    return this.check(await query, "pending captures") as CaptureRow[];
  }
  async saveExtraction(r: ExtractionRecord) {
    const row = { capture_id: r.capture_id, run_id: r.run_id, method: r.method, model: r.model, status: r.status, output: r.output, error: r.error, cost_usd: r.cost_usd, attempts: r.attempts, prompt_version: r.prompt_version };
    return (this.check(await this.db.from("extractions").upsert(row, { onConflict: "capture_id,method,model" }).select("id").single(), "save extraction") as { id: string }).id;
  }

  async upsertSignal(signal: SignalInput, scope?: SectionScope): Promise<{ id: string; inserted: boolean }> {
    const found = this.check(await this.db.from("signals").select("id, last_seen_at, company_name, capture_id").eq("type", signal.type).eq("source_url", signal.source_url).eq("quote", signal.quote).maybeSingle(), "find signal") as { id: string; last_seen_at: string; company_name: string | null; capture_id: string } | null;
    if (found) {
      if (scope) {
        const issuer = scope.issuers.find(i => normalizeName(i.name) === normalizeName(signal.company_name));
        if (!issuer || normalizeName(found.company_name) !== normalizeName(signal.company_name)) throw Error("Shared signal has a different company context; manual review required.");
        await this.linkSectionCapture(scope, issuer.cik, found.capture_id);
      }
      if (Date.parse(signal.seen_at) > Date.parse(found.last_seen_at)) this.check(await this.db.from("signals").update({ last_seen_at: signal.seen_at }).eq("id", found.id), "touch signal");
      return { id: found.id, inserted: false };
    }
    const { seen_at, ...rest } = signal;
    const res = await this.db.from("signals").insert({ ...rest, first_seen_at: seen_at, last_seen_at: seen_at }).select("id").single();
    if (res.error?.code === "23505") return this.upsertSignal(signal, scope);
    return { id: (this.check(res, "insert signal") as { id: string }).id, inserted: true };
  }
  async touchSignals(captureId: string, seenAt: string) {
    const rows = this.check(await this.db.from("signals").update({ last_seen_at: seenAt }).eq("capture_id", captureId).lt("last_seen_at", seenAt).select("id"), "touch signals") as { id: string }[];
    return rows.length;
  }
  async unassignedSignals(scope?: SectionScope) {
    if (scope) {
      const names = sectionNames(scope);
      return (await this.scopedRows<SignalRow>(scope, ids => this.db.from("signals").select("*").in("capture_id", ids).is("company_id", null).is("review_item_id", null).order("id"), "section unassigned signals")).filter(s => names.has(normalizeName(s.company_name)));
    }
    return this.all<SignalRow>(() => this.db.from("signals").select("*").is("company_id", null).is("review_item_id", null).order("id"), "unassigned signals");
  }
  async assignSignals(ids: string[], target: { company_id: string } | { review_item_id: string }) {
    if (ids.length) this.check(await this.db.rpc("pipeline_assign_signals", { p_ids: ids, p_company: "company_id" in target ? target.company_id : null, p_review: "review_item_id" in target ? target.review_item_id : null }), "assign signals");
  }
  async signalsForCompany(companyId: string) {
    return this.all<SignalRow>(() => this.db.from("signals").select("*").eq("company_id", companyId).order("id"), "company signals");
  }

  async companies(): Promise<CompanyRow[]> {
    const rows = await this.all<{ id: string; name: string; domain: string | null; employee_count: number | null; company_origins: unknown }>(() => this.db.from("companies").select("id, name, domain, employee_count, company_origins(origin)").order("id"), "companies");
    return rows.map(r => ({ id: r.id, name: r.name, domain: r.domain, employee_count: r.employee_count, pipeline: Array.isArray(r.company_origins) ? r.company_origins.length > 0 : !!r.company_origins }));
  }
  async companyCreatedInRun(companyId: string, runId: string | null) {
    const row = this.check(await this.db.from("company_origins").select("run_id").eq("company_id", companyId).maybeSingle(), "company admission origin");
    return !!row && row.run_id === runId;
  }
  async companyById(id: string): Promise<CompanyRow | null> {
    const row = this.check(await this.db.from("companies").select("id,name,domain,employee_count,company_origins(origin)").eq("id", id).maybeSingle(), "scoring company");
    return row ? { id: row.id, name: row.name, domain: row.domain, employee_count: row.employee_count, pipeline: Array.isArray(row.company_origins) ? row.company_origins.length > 0 : !!row.company_origins } : null;
  }
  async enqueueScoring(companyId: string) { this.check(await this.db.rpc("enqueue_company_scoring", { p_company: companyId }), "enqueue scoring"); }
  async claimScoring(companyId?: string) { return this.check(await this.db.rpc("claim_company_scoring", { p_company: companyId ?? null }), "claim scoring") as ScoringClaim | null; }
  async finishScoring(claim: ScoringClaim, score: ScoreRow | null, assessedAt: string, change?: ScoreChange) {
    this.check(await this.db.rpc("finish_company_scoring", { p_company: claim.company_id, p_token: claim.token, p_version: claim.version, p_score: score, p_assessed_at: assessedAt, p_change: change ?? null }), "finish scoring");
  }
  async failScoring(claim: ScoringClaim, reason: "score_failed" | "financials_deferred") {
    this.check(await this.db.rpc("fail_company_scoring", { p_company: claim.company_id, p_token: claim.token, p_version: claim.version, p_reason: reason }), "retry scoring");
  }
  async scoringQueueStatus(): Promise<ScoringQueueStatus> {
    const rows = await this.all<{ status: keyof ScoringQueueStatus }>(() => this.db.from("company_scoring_jobs").select("status").order("company_id"), "scoring queue status");
    const counts: ScoringQueueStatus = { pending: 0, running: 0, retry: 0, done: 0 };
    for (const row of rows) counts[row.status]++;
    return counts;
  }
  async createPipelineCompany(c: { name: string; domain: string | null; employee_count: number | null; source: string }, runId: string | null, attach: { signal_ids: string[]; normalized_name: string | null; scope?: SectionScope }) {
    if (attach.scope) return this.check(await this.db.rpc("pipeline_create_section_company", { p_name: c.name, p_domain: c.domain ?? "", p_employee_count: c.employee_count, p_source: c.source, p_run_id: runId, p_signal_ids: attach.signal_ids, p_normalized_name: attach.normalized_name, p_version: attach.scope.version, p_section: attach.scope.section }), "create section company") as string;
    return this.check(await this.db.rpc("pipeline_create_company", { p_name: c.name, p_domain: c.domain ?? "", p_employee_count: c.employee_count, p_source: c.source, p_run_id: runId, p_signal_ids: attach.signal_ids, p_normalized_name: attach.normalized_name }), "create company") as string;
  }
  async addReviewItem(item: Omit<ReviewItem, "id" | "status" | "resolved_company_id" | "created_at">): Promise<{ id: string; inserted: boolean }> {
    const found = this.check(await this.db.from("review_queue").select("id").eq("normalized_name", item.normalized_name).eq("status", "pending").maybeSingle(), "find review item") as { id: string } | null;
    if (found) return { id: found.id, inserted: false };
    const res = await this.db.from("review_queue").insert(item).select("id").single();
    if (res.error?.code === "23505") return this.addReviewItem(item);
    return { id: (this.check(res, "add review item") as { id: string }).id, inserted: true };
  }
  async signalsForReview(itemId: string, scope?: SectionScope) {
    if (scope) {
      const names = sectionNames(scope);
      return (await this.scopedRows<SignalRow>(scope, ids => this.db.from("signals").select("*").in("capture_id", ids).eq("review_item_id", itemId).is("company_id", null).order("id"), "section review signals")).filter(s => names.has(normalizeName(s.company_name)));
    }
    return this.all<SignalRow>(() => this.db.from("signals").select("*").eq("review_item_id", itemId).is("company_id", null).order("id"), "review signals");
  }
  async websiteEvidenceCaptures(name: string, limit: number, scope?: SectionScope): Promise<WebsiteCapture[]> {
    if (scope) {
      const rows = await this.scopedRows<WebsiteCapture & { signals: { last_seen_at: string }[] }>(scope, ids => this.db.from("raw_captures").select("*, signals(last_seen_at)").in("id", ids)
        .eq("source_id", "workday-career-sites").eq("meta->>kind", "workday_job").eq("meta->>normalized_name", name).eq("http_status", 200).order("fetched_at", { ascending: false }).order("id"), "section website evidence");
      return rows.sort((a, b) => b.fetched_at.localeCompare(a.fetched_at) || a.id.localeCompare(b.id)).slice(0, limit).map(({ signals, ...c }) => ({ ...c, last_seen_at: signals.reduce((latest, s) => s.last_seen_at > latest ? s.last_seen_at : latest, c.fetched_at) }));
    }
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
  async admitReview(id: string, domain: string, source: string, existingCompanyId: string | null, runId: string | null, scope?: SectionScope) {
    if (scope) return this.check(await this.db.rpc("pipeline_admit_section_review", { p_item: id, p_domain: domain, p_source: source, p_existing_company: existingCompanyId, p_run_id: runId, p_version: scope.version, p_section: scope.section, p_signal_ids: (await this.signalsForReview(id, scope)).map(s => s.id) }), "admit section review") as string;
    return this.check(await this.db.rpc("pipeline_admit_review", { p_item: id, p_domain: domain, p_source: source, p_existing_company: existingCompanyId, p_run_id: runId }), "admit review") as string;
  }
  async reviewItems(status?: ReviewItem["status"], scope?: SectionScope) {
    if (scope) {
      const names = [...sectionNames(scope)], rows: ReviewItem[] = [];
      for (let offset = 0; offset < names.length; offset += 200) rows.push(...await this.all<ReviewItem>(() => {
        const q = this.db.from("review_queue").select("*").in("normalized_name", names.slice(offset, offset + 200)).order("created_at", { ascending: false }).order("id");
        return status ? q.eq("status", status) : q;
      }, "section reviews"));
      return rows;
    }
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

  async workdaySites(onlyEnabled: boolean, scope?: SectionScope) {
    if (scope) {
      const names = sectionNames(scope);
      return (await this.scopedRows<WorkdaySite>(scope, ids => {
        const q = this.db.from("workday_sites").select("*").in("capture_id", ids).order("created_at").order("id");
        return onlyEnabled ? q.eq("enabled", true) : q;
      }, "section sites")).filter(s => names.has(s.normalized_name));
    }
    return this.all<WorkdaySite>(() => {
      const query = this.db.from("workday_sites").select("*").order("created_at").order("id");
      return onlyEnabled ? query.eq("enabled", true) : query;
    }, "workday sites");
  }
  async upsertWorkdaySite(site: Omit<WorkdaySite, "id" | "company_id" | "review_item_id" | "enabled"> & { discovered_from: string }, scope?: SectionScope): Promise<{ id: string; inserted: boolean }> {
    const found = this.check(await this.db.from("workday_sites").select("id, normalized_name, capture_id").eq("tenant", site.tenant).eq("pod", site.pod).eq("site", site.site).maybeSingle(), "find site") as { id: string; normalized_name: string; capture_id: string | null } | null;
    if (found) {
      if (scope) {
        const issuer = scope.issuers.find(i => normalizeName(i.name) === site.normalized_name);
        if (!issuer || found.normalized_name !== site.normalized_name) throw Error("Shared site has a different company context; manual review required.");
        if (!found.capture_id && site.capture_id) {
          this.check(await this.db.from("workday_sites").update({ capture_id: site.capture_id }).eq("id", found.id).is("capture_id", null), "fill site provenance");
          const saved = this.check(await this.db.from("workday_sites").select("capture_id").eq("id", found.id).single(), "site provenance");
          found.capture_id = saved?.capture_id ?? null;
        }
        if (found.capture_id) await this.linkSectionCapture(scope, issuer.cik, found.capture_id);
      }
      return { id: found.id, inserted: false };
    }
    const inserted = await this.db.from("workday_sites").insert(site).select("id").single();
    if (inserted.error?.code === "23505") return this.upsertWorkdaySite(site, scope);
    return { id: (this.check(inserted, "add site") as { id: string }).id, inserted: true };
  }
  async markSiteChecked(id: string, status: string, at: string) {
    this.check(await this.db.from("workday_sites").update({ last_checked_at: at, last_status: status }).eq("id", id), "mark site");
  }
  async linkWorkdaySites(normalizedName: string, target: { company_id: string } | { review_item_id: string }, scope?: SectionScope) {
    if (scope) {
      const sites = (await this.workdaySites(false, scope)).filter(s => s.normalized_name === normalizedName);
      for (let offset = 0; offset < sites.length; offset += 200) this.check(await this.db.from("workday_sites").update(target).in("id", sites.slice(offset, offset + 200).map(s => s.id)).is("company_id", null), "link section sites");
      return;
    }
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
