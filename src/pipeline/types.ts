// Swappable module boundaries for the ingestion pipeline. Each stage depends on these types only,
// so a teammate's collector, model provider or database writer plugs in without touching the others.
import type { PipelineSettings } from "../domain/ingestion/settings.ts";
import type { SignalType, ProjectType, ScoringContact } from "../domain/ingestion/pipeline-score.ts";
import type { ScoreRow } from "../domain/scoring/assessment.ts";
import type { ScoreChange } from "../domain/ingestion/score-change.ts";
import type { LedgerEntry } from "../domain/ingestion/budget.ts";

// ---------- Sources and collectors ----------

export type SourceRow = {
  id: string;
  type: string;
  name: string;
  config: Record<string, unknown>;
  frequency: "daily" | "weekly" | "biweekly" | "manual";
  max_requests_per_run: number;
  min_delay_ms: number;
  enabled: boolean;
};

// One item exactly as received. `raw` is the response body (JSON or text), never edited.
export type RawItem = {
  source: string;
  url: string;
  fetched_at: string;
  http_status: number;
  content_type: string | null;
  raw: string;
  fingerprint: string;
  // Collector context needed to read the item later (e.g. which Workday site a job belongs to). Not evidence.
  meta?: Record<string, unknown>;
};

export type CollectLimits = { maxRequests: number; maxItems: number; minDelayMs: number; dryRun: boolean };

export type CollectResult = {
  items: RawItem[];
  requests: number;
  // A source stopped early because it blocked us, showed a CAPTCHA or an "unavailable" page.
  blocked: string | null;
  errors: { url: string; kind: string; message: string }[];
  spend_usd: number;
};

export interface Collector {
  readonly type: string;
  collect(source: SourceRow, limits: CollectLimits, ctx: PipelineContext): Promise<CollectResult>;
}

// ---------- Model provider ----------

export type LLMRequest = { system: string; user: string; schema: Record<string, unknown>; seed?: number };
export type LLMResponse = { ok: true; json: unknown; raw: string; cost_usd: number; ms: number } | { ok: false; error: string; raw?: string; cost_usd: number; ms: number };

export interface LLMProvider {
  readonly name: string; // "ollama" | "openai" | "gemini"
  readonly model: string;
  // Upper bound for one call, checked against the run's model-spend cap before calling. 0 for local models.
  readonly worstCaseUsd: number;
  complete(request: LLMRequest): Promise<LLMResponse>;
}

// ---------- treg ----------

export type TregResult = { ok: true; status: number; body: unknown; cost_usd: number; call_id: string | null } | { ok: false; status: number; error: string; cost_usd: number; body?: unknown };

export interface TregTransport {
  call(endpoint: string, opts: { query?: Record<string, string | number>; body?: unknown; headers?: Record<string, string>; idempotencyKey?: string; timeoutMs?: number }): Promise<TregResult>;
}

// ---------- Store ----------

export type CaptureRow = { id: string; source_id: string; url: string; fetched_at: string; http_status: number; content_type: string | null; content_hash: string; body: string; run_id: string | null };

export type SignalInput = {
  company_id: string | null;
  review_item_id: string | null;
  capture_id: string;
  extraction_id: string | null;
  type: SignalType;
  signal_date: string | null;
  source_url: string;
  quote: string;
  confidence: number;
  company_name: string | null;
  products: string[] | null;
  project_type: ProjectType | null;
  role_seniority: string | null;
  timing_words: string[] | null;
  method: "structured" | "llm";
  seen_at: string;
};

export type SignalRow = Omit<SignalInput, "seen_at"> & { id: string; first_seen_at: string; last_seen_at: string };

export type ReviewItem = {
  id: string;
  candidate_name: string;
  normalized_name: string;
  candidate_domain: string | null;
  employee_count: number | null;
  suggested_company_id: string | null;
  reason: "similar_name" | "no_website" | "untrusted_signal" | "over_run_cap";
  status: "pending" | "approved" | "merged" | "rejected";
  resolved_company_id: string | null;
  created_at: string;
};

export type WorkdaySite = {
  id: string;
  tenant: string;
  pod: string;
  site: string;
  company_name: string;
  normalized_name: string;
  match_kind: "full_name" | "first_word" | "careers_link" | "manual";
  company_id: string | null;
  review_item_id: string | null;
  enabled: boolean;
  capture_id: string | null;
  last_checked_at?: string | null;
};

export type CompanyRow = { id: string; name: string; domain: string | null; employee_count: number | null; pipeline: boolean };
export type ContactRow = ScoringContact & { id: string; company_id: string };
export type StoredScore = ScoreRow & { id: string; assessed_at: string };

export type RunCounts = Record<string, number>;
export type RunStatus = "running" | "succeeded" | "partial" | "blocked" | "failed";

export type ExtractionRecord = {
  capture_id: string;
  method: "structured" | "llm";
  model: string;
  status: "done" | "failed" | "dead_letter";
  output: unknown;
  error: string | null;
  attempts: number;
  prompt_version: string;
  cost_usd: number;
  run_id: string | null;
};

export interface PipelineStore {
  readonly kind: "supabase" | "memory";
  settings(): Promise<PipelineSettings>;
  sources(): Promise<SourceRow[]>;
  startRun(run: { job: string; source_id: string | null; trigger: "schedule" | "manual" | "import_button" }): Promise<string>;
  finishRun(id: string, result: { status: RunStatus; counts: RunCounts; requests: number; llm_spend_usd: number; treg_spend_usd: number; error: string | null }): Promise<void>;
  closeStaleRuns(startedBefore: string): Promise<number>;
  recentRuns(sourceId: string, n: number): Promise<{ status: RunStatus; items: number; error: string | null }[]>;

  saveCapture(item: RawItem, runId: string | null): Promise<{ id: string; inserted: boolean }>;
  latestCapture(sourceId: string): Promise<CaptureRow | null>;
  captureById(id: string): Promise<CaptureRow | null>;
  pendingCaptures(limit: number, sourceIds?: string[]): Promise<CaptureRow[]>;
  saveExtraction(record: ExtractionRecord): Promise<string>;

  upsertSignal(signal: SignalInput): Promise<{ id: string; inserted: boolean }>;
  unassignedSignals(): Promise<SignalRow[]>;
  assignSignals(ids: string[], target: { company_id: string } | { review_item_id: string }): Promise<void>;
  signalsForCompany(companyId: string): Promise<SignalRow[]>;

  companies(): Promise<CompanyRow[]>;
  // Atomic: company + origin row + its waiting signals and Workday sites, or nothing.
  createPipelineCompany(company: { name: string; domain: string | null; employee_count: number | null; source: string }, runId: string | null, attach: { signal_ids: string[]; normalized_name: string | null }): Promise<string>;
  // An unchanged capture was seen again: its signals stay fresh.
  touchSignals(captureId: string, seenAt: string): Promise<number>;
  addReviewItem(item: Omit<ReviewItem, "id" | "status" | "resolved_company_id" | "created_at">): Promise<{ id: string; inserted: boolean }>;
  reviewItems(status?: ReviewItem["status"]): Promise<ReviewItem[]>;
  resolveReview(itemId: string, decision: { action: "approve"; domain?: string | null } | { action: "merge"; company_id: string } | { action: "reject" }, note: string, runId: string | null): Promise<string | null>;

  workdaySites(onlyEnabled: boolean): Promise<WorkdaySite[]>;
  upsertWorkdaySite(site: Omit<WorkdaySite, "id" | "company_id" | "review_item_id" | "enabled"> & { discovered_from: string }): Promise<{ id: string; inserted: boolean }>;
  markSiteChecked(id: string, status: string, at: string): Promise<void>;
  linkWorkdaySites(normalizedName: string, target: { company_id: string } | { review_item_id: string }): Promise<void>;
  resolverAttempts(names: string[]): Promise<Set<string>>;
  saveResolverAttempt(attempt: { normalized_name: string; company_name: string; found: boolean; probes: number }): Promise<void>;

  contactsForCompany(companyId: string): Promise<ContactRow[]>;
  latestScore(companyId: string): Promise<StoredScore | null>;
  insertScore(row: ScoreRow, assessedAt: string, change?: ScoreChange): Promise<string>;
  setEnrichment(companyId: string, status: "pending" | "skipped_budget" | "searching" | "done" | "no_contacts_found", reason: string): Promise<void>;
  enrichmentStatus(companyId: string): Promise<string | null>;
  updateContact(contactId: string, patch: Partial<ContactRow> & { contact_sources?: unknown; enriched_at?: string }): Promise<void>;
  insertContact(contact: Omit<ContactRow, "id"> & { contact_sources?: unknown }): Promise<string>;

  paidCall(key: string): Promise<{ outcome: string; response: unknown; cost_usd: number } | null>;
  recordPaidCall(call: { idempotency_key: string; provider: string; endpoint: string; subject: string; step: string; run_id: string | null; cost_usd: number; outcome: string; response: unknown }): Promise<void>;

  health(): Promise<Record<string, unknown>>;
  sourceAlerts(): Promise<{ source_id: string; failed_runs: number; empty_runs: number }[]>;
}

// ---------- Run context ----------

export type Logger = { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void };

export interface SpendGuard {
  // Reserve a paid call's worst case; returns false (and logs) when it would exceed the cap. Never throws.
  allow(provider: string, worstCaseUsd: number, label: string): Promise<boolean>;
  record(entry: Omit<LedgerEntry, "at" | "session">): Promise<void>;
  spent(provider?: string): number;
}

export type PipelineContext = {
  store: PipelineStore;
  now: () => Date;
  log: Logger;
  fetch: typeof fetch;
  treg: TregTransport | null;
  llm: LLMProvider | null;
  spend: SpendGuard;
  contact: string; // sent in every collector User-Agent
  sleep: (ms: number) => Promise<void>;
  runId: string | null;
  // Capture each source produced (new or reused unchanged) in this run, so later stages read today's data.
  collected?: Record<string, string>;
};
