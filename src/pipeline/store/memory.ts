// In-memory PipelineStore with the same dedupe and atomicity rules as the database.
// Used by unit tests, failure-injection tests and --dry-run. `failAfter` makes a named method throw.
import type { EmployeeResearchRecord, EmployeeResearchStatus } from "../employee-research-record.ts";
import type { WebEmployeeEvidence } from "../employee-document-evidence.ts";
import { randomUUID } from "node:crypto";
import { defaultSettings, parseSettings, type PipelineSettings } from "../../domain/ingestion/settings.ts";
import { normalizeName } from "../../domain/ingestion/normalize.ts";
import type { ScoreRow } from "../../domain/scoring/assessment.ts";
import type { ScoreChange } from "../../domain/ingestion/score-change.ts";
import type {
  CaptureRow, CompanyRow, ContactRow, ExtractionRecord, PipelineStore, RawItem, ReviewItem, RunCounts, RunStatus,
  SignalInput, SignalRow, SourceRow, StoredScore, WorkdaySite, ResolverAttempt, ResolverCutoffs, WebsiteResolution, WebsiteCapture,
} from "../types.ts";

export const DEFAULT_SOURCES: SourceRow[] = [
  { id: "workday-career-sites", type: "workday_career_site", name: "Workday career sites", config: {}, frequency: "daily", max_requests_per_run: 1500, min_delay_ms: 1000, enabled: true },
  { id: "workday-site-resolver", type: "workday_site_resolver", name: "Workday site resolver", config: {}, frequency: "weekly", max_requests_per_run: 500, min_delay_ms: 1000, enabled: true },
  { id: "workday-tenant-crawl", type: "workday_tenant_crawl", name: "Workday tenants from Common Crawl", config: {}, frequency: "weekly", max_requests_per_run: 500, min_delay_ms: 1000, enabled: true },
  { id: "workday-tenant-wayback", type: "workday_tenant_wayback", name: "Workday tenants from the Wayback Machine", config: {}, frequency: "weekly", max_requests_per_run: 500, min_delay_ms: 1000, enabled: true },
  { id: "sec-company-list", type: "sec_company_list", name: "SEC company list", config: { url: "https://www.sec.gov/files/company_tickers.json" }, frequency: "weekly", max_requests_per_run: 2, min_delay_ms: 1000, enabled: true },
  { id: "treg-reddit-workday", type: "treg_reddit", name: "r/workday via treg", config: { subreddit: "workday" }, frequency: "weekly", max_requests_per_run: 2, min_delay_ms: 1000, enabled: false },
  { id: "treg-workday-users", type: "treg_tech_lookup", name: "Workday users via treg", config: {}, frequency: "weekly", max_requests_per_run: 1, min_delay_ms: 1000, enabled: false },
  { id: "csv-import", type: "csv_import", name: "Import button CSV rows", config: {}, frequency: "manual", max_requests_per_run: 1, min_delay_ms: 0, enabled: true },
  { id: "partner-client-lists", type: "partner_client_list", name: "Partner client lists", config: {}, frequency: "weekly", max_requests_per_run: 200, min_delay_ms: 1000, enabled: false },
];

type Run = { id: string; job: string; source_id: string | null; trigger: string; started_at: string; finished_at: string | null; status: RunStatus; counts: RunCounts; requests: number; llm_spend_usd: number; treg_spend_usd: number; error: string | null };

export class MemoryStore implements PipelineStore {
  readonly kind = "memory" as const;
  employeeResearchRows = new Map<string, EmployeeResearchRecord>();
  async checkEmployeeResearchStorage() { /* In-memory table and RPC equivalents are always available. */ }
  async employeeResearch(id: string) { return structuredClone(this.employeeResearchRows.get(id) ?? null); }
  async claimEmployeeResearch(id: string, domain: string, name: string) {
    const previous = this.employeeResearchRows.get(id);
    const now = this.now();
    if (previous?.lease_until && Date.parse(previous.lease_until) > now.getTime()) return null;
    const same = previous?.company_domain === domain && previous?.company_name === name;
    if (same && Date.parse(previous!.next_check_at) > now.getTime()) return null;
    const row: EmployeeResearchRecord = { company_id: id, company_domain: domain, company_name: name,
      status: "running", evidence: same ? previous!.evidence : null, checked_at: previous?.checked_at ?? null,
      next_check_at: previous?.next_check_at ?? now.toISOString(), lease_token: randomUUID(),
      lease_until: new Date(now.getTime() + 120000).toISOString(), reason: "" };
    this.employeeResearchRows.set(id, row);
    return structuredClone(row);
  }
  async finishEmployeeResearch(id: string, token: string, status: EmployeeResearchStatus, evidence: WebEmployeeEvidence | null, reason: string) {
    const row = this.employeeResearchRows.get(id);
    if (!row || row.lease_token !== token || !row.lease_until || Date.parse(row.lease_until) <= this.now().getTime()) return false;
    const days = status === "found" ? 30 : status === "needs_review" ? 7 : 1;
    this.employeeResearchRows.set(id, { ...row, status, evidence: status === "unavailable" ? row.evidence : evidence,
      checked_at: this.now().toISOString(), next_check_at: new Date(this.now().getTime() + days * 86400000).toISOString(),
      lease_token: null, lease_until: null, reason });
    return true;
  }
  settingsRows: { key: string; value: unknown }[] = [];
  sourceRows: SourceRow[] = DEFAULT_SOURCES.map(s => ({ ...s, config: { ...s.config } }));
  runs: Run[] = [];
  captures: (CaptureRow & { meta: Record<string, unknown> })[] = [];
  extractions: (ExtractionRecord & { id: string })[] = [];
  signals: SignalRow[] = [];
  companyRows: (CompanyRow & { source: string | null; created_at: string })[] = [];
  reviews: ReviewItem[] = [];
  sites: WorkdaySite[] = [];
  websites = new Map<string, WebsiteResolution>();
  attempts = new Map<string, ResolverAttempt>();
  contacts: (ContactRow & { contact_sources?: unknown; enriched_at?: string })[] = [];
  scores: StoredScore[] = [];
  enrichment = new Map<string, { status: string; reason: string }>();
  paid = new Map<string, { outcome: string; response: unknown; cost_usd: number }>();
  now: () => Date;
  // Failure injection: { method: remaining successful calls before it throws }.
  failAfter: Record<string, number> = {};

  constructor(opts: { now?: () => Date } = {}) { this.now = opts.now ?? (() => new Date()); }

  private trip(method: string) {
    if (method in this.failAfter) {
      if (this.failAfter[method] <= 0) throw new Error(`injected database error in ${method}`);
      this.failAfter[method]--;
    }
  }

  async settings(): Promise<PipelineSettings> { return this.settingsRows.length ? parseSettings(this.settingsRows) : { ...defaultSettings }; }
  async sources() { return this.sourceRows; }

  async startRun(run: { job: string; source_id: string | null; trigger: "schedule" | "manual" | "import_button" }) {
    this.trip("startRun");
    const id = randomUUID();
    this.runs.push({ id, ...run, started_at: this.now().toISOString(), finished_at: null, status: "running", counts: {}, requests: 0, llm_spend_usd: 0, treg_spend_usd: 0, error: null });
    return id;
  }
  async finishRun(id: string, result: { status: RunStatus; counts: RunCounts; requests: number; llm_spend_usd: number; treg_spend_usd: number; error: string | null }) {
    const run = this.runs.find(r => r.id === id);
    if (run) Object.assign(run, result, { finished_at: this.now().toISOString() });
  }
  async closeStaleRuns(startedBefore: string) {
    const stale = this.runs.filter(r => r.status === "running" && r.started_at < startedBefore);
    for (const r of stale) Object.assign(r, { status: "failed", finished_at: this.now().toISOString(), error: "run did not finish (closed at a later start)" });
    return stale.length;
  }
  async recentRuns(sourceId: string, n: number) {
    return this.runs.filter(r => r.source_id === sourceId && r.finished_at).slice(-n).reverse().map(r => ({ status: r.status, items: Number(r.counts.items ?? 0), error: r.error }));
  }

  async saveCapture(item: RawItem, runId: string | null) {
    this.trip("saveCapture");
    const existing = this.captures.find(c => c.url === item.url && c.content_hash === item.fingerprint);
    if (existing) return { id: existing.id, inserted: false };
    const id = randomUUID();
    this.captures.push({ id, source_id: item.source, url: item.url, fetched_at: item.fetched_at, http_status: item.http_status, content_type: item.content_type, content_hash: item.fingerprint, body: item.raw, run_id: runId, meta: item.meta ?? {} });
    return { id, inserted: true };
  }
  async latestCapture(sourceId: string) {
    return [...this.captures].reverse().find(c => c.source_id === sourceId) ?? null;
  }
  async captureById(id: string) { return this.captures.find(c => c.id === id) ?? null; }
  async tenantIndexCache(sourceId: string) {
    return [...this.captures].reverse().find(c => c.source_id === sourceId && c.meta.kind === "workday_index_cache") ?? null;
  }
  async pendingCaptures(limit: number, sourceIds?: string[]) {
    const finished = new Set(this.extractions.filter(e => e.status === "done" || e.status === "dead_letter").map(e => e.capture_id));
    return this.captures.filter(c => !finished.has(c.id) && (!sourceIds || sourceIds.includes(c.source_id))).slice(0, limit);
  }
  async saveExtraction(record: ExtractionRecord) {
    this.trip("saveExtraction");
    const existing = this.extractions.find(e => e.capture_id === record.capture_id && e.method === record.method && e.model === record.model);
    if (existing) { Object.assign(existing, record); return existing.id; }
    const id = randomUUID();
    this.extractions.push({ id, ...record });
    return id;
  }

  async upsertSignal(signal: SignalInput) {
    this.trip("upsertSignal");
    const existing = this.signals.find(s => s.type === signal.type && s.source_url === signal.source_url && s.quote === signal.quote);
    if (existing) {
      if (signal.seen_at > existing.last_seen_at) existing.last_seen_at = signal.seen_at;
      return { id: existing.id, inserted: false };
    }
    const { seen_at, ...rest } = signal;
    const id = randomUUID();
    this.signals.push({ id, ...rest, first_seen_at: seen_at, last_seen_at: seen_at });
    return { id, inserted: true };
  }
  async touchSignals(captureId: string, seenAt: string) {
    let n = 0;
    for (const s of this.signals) if (s.capture_id === captureId && seenAt > s.last_seen_at) { s.last_seen_at = seenAt; n++; }
    return n;
  }
  async unassignedSignals() { return this.signals.filter(s => !s.company_id && !s.review_item_id); }
  async assignSignals(ids: string[], target: { company_id: string } | { review_item_id: string }) {
    this.trip("assignSignals");
    for (const s of this.signals) if (ids.includes(s.id)) Object.assign(s, target);
  }
  async signalsForCompany(companyId: string) { return this.signals.filter(s => s.company_id === companyId); }

  async companies() { return this.companyRows.map(({ id, name, domain, employee_count, pipeline }) => ({ id, name, domain, employee_count, pipeline })); }
  addExistingCompany(company: { id?: string; name: string; domain: string | null; employee_count?: number | null }) {
    const id = company.id ?? randomUUID();
    this.companyRows.push({ id, name: company.name, domain: company.domain, employee_count: company.employee_count ?? null, pipeline: false, source: null, created_at: this.now().toISOString() });
    return id;
  }
  async createPipelineCompany(company: { name: string; domain: string | null; employee_count: number | null; source: string }, _runId: string | null, attach: { signal_ids: string[]; normalized_name: string | null }) {
    this.trip("createPipelineCompany");
    if (company.domain && this.companyRows.some(c => c.domain === company.domain)) throw new Error(`duplicate key value violates unique constraint "companies_domain_key"`);
    const id = randomUUID();
    this.companyRows.push({ id, ...company, pipeline: true, created_at: this.now().toISOString() });
    for (const s of this.signals) if (attach.signal_ids.includes(s.id) && !s.company_id) s.company_id = id;
    if (attach.normalized_name) for (const site of this.sites) if (site.normalized_name === attach.normalized_name && !site.company_id) site.company_id = id;
    return id;
  }
  async addReviewItem(item: Omit<ReviewItem, "id" | "status" | "resolved_company_id" | "created_at">) {
    this.trip("addReviewItem");
    const existing = this.reviews.find(r => r.status === "pending" && r.normalized_name === item.normalized_name);
    if (existing) return { id: existing.id, inserted: false };
    const id = randomUUID();
    this.reviews.push({ id, ...item, status: "pending", resolved_company_id: null, created_at: this.now().toISOString() });
    return { id, inserted: true };
  }
  async signalsForReview(itemId: string) { return this.signals.filter(s => s.review_item_id === itemId && !s.company_id); }
  async websiteEvidenceCaptures(name: string, limit: number): Promise<WebsiteCapture[]> {
    return this.captures.filter(c => c.source_id === "workday-career-sites" && c.meta.kind === "workday_job" && c.meta.normalized_name === name && c.http_status === 200)
      .sort((a, b) => b.fetched_at.localeCompare(a.fetched_at) || a.id.localeCompare(b.id)).slice(0, limit)
      .map(c => ({ ...c, last_seen_at: this.signals.filter(s => s.capture_id === c.id).reduce((latest, s) => s.last_seen_at > latest ? s.last_seen_at : latest, c.fetched_at) }));
  }
  async fillReviewWebsite(id: string, domain: string) {
    const item = this.reviews.find(r => r.id === id && r.status === "pending" && r.candidate_domain === null);
    if (!item) return false;
    item.candidate_domain = domain; return true;
  }
  async websiteResolution(name: string) { return this.websites.get(name) ?? null; }
  async saveWebsiteResolution(value: WebsiteResolution) { this.trip("saveWebsiteResolution"); this.websites.set(value.normalized_name, value); }
  async updatePendingReview(id: string, patch: { candidate_domain: string | null; reason: ReviewItem["reason"]; suggested_company_id: string | null; candidate_name?: string }) {
    const item = this.reviews.find(r => r.id === id && r.status === "pending" && r.reason !== "similar_name");
    if (!item) throw Error("review is no longer eligible");
    Object.assign(item, patch);
  }
  async admitReview(id: string, domain: string, source: string, existingCompanyId: string | null, runId: string | null) {
    this.trip("admitReview");
    const item = this.reviews.find(r => r.id === id && r.status === "pending" && r.reason !== "similar_name");
    if (!item) throw Error("review is no longer eligible");
    const company = existingCompanyId ?? await this.createPipelineCompany({ name: item.candidate_name, domain, employee_count: item.employee_count, source }, runId, { signal_ids: [], normalized_name: null });
    await this.resolveReview(id, { action: "merge", company_id: company }, "Automatic website confirmation", runId);
    item.status = existingCompanyId ? "merged" : "approved";
    item.candidate_domain = domain;
    return company;
  }
  async reviewItems(status?: ReviewItem["status"]) { return this.reviews.filter(r => !status || r.status === status); }
  async resolveReview(itemId: string, decision: { action: "approve"; domain?: string | null } | { action: "merge"; company_id: string } | { action: "reject" }, _note: string, runId: string | null) {
    const item = this.reviews.find(r => r.id === itemId && r.status === "pending");
    if (!item) throw new Error(`review item ${itemId} is not pending`);
    let companyId: string | null = null;
    if (decision.action === "approve") companyId = await this.createPipelineCompany({ name: item.candidate_name, domain: decision.domain ?? item.candidate_domain, employee_count: item.employee_count, source: "review_queue" }, runId, { signal_ids: [], normalized_name: null });
    if (decision.action === "merge") {
      if (!this.companyRows.some(company => company.id === decision.company_id)) throw new Error(`company ${decision.company_id} does not exist`);
      companyId = decision.company_id;
    }
    item.status = decision.action === "approve" ? "approved" : decision.action === "merge" ? "merged" : "rejected";
    item.resolved_company_id = companyId;
    if (companyId) {
      for (const s of this.signals) if (s.review_item_id === itemId && !s.company_id) s.company_id = companyId;
      for (const site of this.sites) if (site.review_item_id === itemId && !site.company_id) site.company_id = companyId;
    } else {
      for (const site of this.sites) if (site.review_item_id === itemId && !site.company_id) site.enabled = false;
    }
    return companyId;
  }

  async workdaySites(onlyEnabled: boolean) { return this.sites.filter(s => !onlyEnabled || s.enabled); }
  async upsertWorkdaySite(site: Omit<WorkdaySite, "id" | "company_id" | "review_item_id" | "enabled"> & { discovered_from: string }) {
    const existing = this.sites.find(s => s.tenant === site.tenant && s.pod === site.pod && s.site === site.site);
    if (existing) return { id: existing.id, inserted: false };
    const rest = { ...site } as Partial<typeof site>;
    delete rest.discovered_from;
    const id = randomUUID();
    this.sites.push({ id, ...(rest as Omit<WorkdaySite, "id" | "company_id" | "review_item_id" | "enabled">), company_id: null, review_item_id: null, enabled: true });
    return { id, inserted: true };
  }
  async markSiteChecked(id: string, status: string, at: string) {
    const site = this.sites.find(s => s.id === id);
    if (site) Object.assign(site, { last_checked_at: at, last_status: status });
  }
  async linkWorkdaySites(normalizedName: string, target: { company_id: string } | { review_item_id: string }) {
    for (const s of this.sites) if (s.normalized_name === normalizedName && !s.company_id) Object.assign(s, target);
  }
  async resolverAttempts(names: string[]) { return new Set(names.filter(n => this.attempts.has(n))); }
  async dueResolverAttempts(cutoffs: ResolverCutoffs, limit: number) {
    return [...this.attempts.values()]
      .filter(a => a.tried_at <= (a.found ? cutoffs.foundBefore : cutoffs.missBefore))
      .sort((a, b) => Number(b.found) - Number(a.found) || a.tried_at.localeCompare(b.tried_at) || a.normalized_name.localeCompare(b.normalized_name))
      .slice(0, limit);
  }
  async saveResolverAttempt(a: Omit<ResolverAttempt, "tried_at"> & { tried_at?: string }) {
    this.attempts.set(a.normalized_name, { ...a, tried_at: a.tried_at ?? this.now().toISOString() });
  }

  async contactsForCompany(companyId: string) { return this.contacts.filter(c => c.company_id === companyId); }
  async latestScore(companyId: string) {
    // The later insert wins if the test clock gives two assessments the same timestamp.
    return this.scores.filter(s => s.company_id === companyId).reverse().sort((a, b) => b.assessed_at.localeCompare(a.assessed_at))[0] ?? null;
  }
  scoreChanges = new Map<string, ScoreChange>();
  async insertScore(row: ScoreRow, assessedAt: string, change?: ScoreChange) {
    this.trip("insertScore");
    const id = randomUUID();
    this.scores.push({ id, ...row, assessed_at: assessedAt });
    if (change) this.scoreChanges.set(id, change);
    return id;
  }
  async setEnrichment(companyId: string, status: string, reason: string) { this.enrichment.set(companyId, { status, reason }); }
  async enrichmentStatus(companyId: string) { return this.enrichment.get(companyId)?.status ?? null; }
  async updateContact(contactId: string, patch: Record<string, unknown>) {
    const c = this.contacts.find(x => x.id === contactId);
    if (c) Object.assign(c, patch);
  }
  async insertContact(contact: Omit<ContactRow, "id"> & { contact_sources?: unknown }) {
    const id = randomUUID();
    this.contacts.push({ id, ...contact });
    return id;
  }

  async paidCall(key: string) { return this.paid.get(key) ?? null; }
  async recordPaidCall(call: { idempotency_key: string; cost_usd: number; outcome: string; response: unknown }) {
    this.paid.set(call.idempotency_key, { outcome: call.outcome, response: call.response, cost_usd: call.cost_usd });
  }

  async health() {
    const week = this.now().getTime() - 7 * 86400000;
    const last = this.runs[this.runs.length - 1];
    return {
      last_run_at: last?.started_at ?? null, last_run_status: last?.status ?? null,
      new_companies_7d: this.companyRows.filter(c => c.pipeline && Date.parse(c.created_at) >= week).length,
      review_queue_pending: this.reviews.filter(r => r.status === "pending").length,
      dead_letters: this.extractions.filter(e => e.status === "dead_letter").length,
    };
  }
  async sourceAlerts() {
    const out: { source_id: string; failed_runs: number; empty_runs: number }[] = [];
    for (const id of new Set(this.runs.map(r => r.source_id).filter(Boolean) as string[])) {
      const recent = await this.recentRuns(id, 3);
      if (recent.length === 3 && recent.every(r => r.status === "failed" || r.status === "blocked" || r.items === 0)) {
        out.push({ source_id: id, failed_runs: recent.filter(r => r.status === "failed" || r.status === "blocked").length, empty_runs: recent.filter(r => r.items === 0).length });
      }
    }
    return out;
  }

  // Test helper: the same normalized name never appears twice among companies.
  duplicateCompanies(): string[] {
    const seen = new Map<string, number>();
    for (const c of this.companyRows) seen.set(normalizeName(c.name), (seen.get(normalizeName(c.name)) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([name]) => name);
  }
}
