// The pipeline stages. Each one reads from and writes to the store only, so any stage can run on its own.
// Failures are counted and logged per item; a stage never throws out of a run.
import { companyAliases } from "../data/company-aliases.ts";
import { decideMatch, TRUSTED_CONFIDENCE } from "../domain/ingestion/matching.ts";
import { isSimilarName, nameSimilarity, normalizeDomain, normalizeName } from "../domain/ingestion/normalize.ts";
import { scoreCompany, type ScoringSignal } from "../domain/ingestion/pipeline-score.ts";
import { mayScore } from "../domain/ingestion/settings.ts";
import { categories } from "../domain/contracts/company.ts";
import { collectors } from "./collectors/sources.ts";
import { extractCapture, loadPrompt, PROMPT_VERSION } from "./extract.ts";
import type { CollectLimits, PipelineContext, RunCounts, SignalRow, SourceRow, StoredScore } from "./types.ts";

export type StageResult = { counts: RunCounts; errors: string[]; blocked: string | null; requests: number; llm_spend_usd: number; treg_spend_usd: number };
const result = (): StageResult => ({ counts: {}, errors: [], blocked: null, requests: 0, llm_spend_usd: 0, treg_spend_usd: 0 });
const bump = (r: StageResult, key: string, n = 1) => { r.counts[key] = (r.counts[key] ?? 0) + n; };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------- collect ----------

export async function collectStage(ctx: PipelineContext, source: SourceRow, opts: { limit: number; dryRun: boolean }): Promise<StageResult> {
  const r = result();
  const collector = collectors[source.type];
  if (!collector) { r.errors.push(`no collector for source type ${source.type}`); return r; }
  const limits: CollectLimits = { maxRequests: source.max_requests_per_run, maxItems: opts.limit, minDelayMs: Math.max(source.min_delay_ms, 1000), dryRun: opts.dryRun };
  let collected;
  try { collected = await collector.collect(source, limits, ctx); }
  catch (error) { r.errors.push(`collector crashed: ${message(error)}`); return r; }
  r.requests = collected.requests;
  r.treg_spend_usd = collected.spend_usd;
  r.blocked = collected.blocked;
  for (const e of collected.errors) { bump(r, `error_${e.kind}`); if (r.errors.length < 20) r.errors.push(`${e.kind} ${e.url}: ${e.message}`); }
  bump(r, "items", collected.items.length);
  for (const item of collected.items) {
    try {
      const saved = await ctx.store.saveCapture(item, ctx.runId);
      ctx.collected = { ...ctx.collected, [source.id]: saved.id };
      if (saved.inserted) bump(r, "new_captures");
      else { bump(r, "unchanged_captures"); bump(r, "signals_refreshed", await ctx.store.touchSignals(saved.id, ctx.now().toISOString())); }
    } catch (error) { bump(r, "error_store"); r.errors.push(`save capture ${item.url}: ${message(error)}`); }
  }
  return r;
}

// ---------- extract ----------

export async function extractStage(ctx: PipelineContext, opts: { limit: number; sourceIds?: string[] }): Promise<StageResult> {
  const r = result();
  const prompt = loadPrompt();
  let llm = ctx.llm;
  const pending = await ctx.store.pendingCaptures(opts.limit, opts.sourceIds);
  bump(r, "pending", pending.length);
  for (const capture of pending) {
    try {
      if (llm && !(await ctx.spend.allow("llm", llm.worstCaseUsd, `extract ${capture.url}`))) llm = null;
      const out = await extractCapture(capture, llm, prompt);
      if (out.model) {
        r.llm_spend_usd += out.model.cost_usd;
        if (llm && llm.worstCaseUsd > 0) await ctx.spend.record({ provider: "llm", endpoint: llm.model, step: "extract", subject: capture.id, idempotency_key: "", worst_case_usd: llm.worstCaseUsd, cost_usd: out.model.cost_usd, outcome: out.model.ok ? "ok" : out.model.error });
      }
      const m = out.model;
      const modelDown = !!m && !m.ok && m.retryable;
      // The model is down: keep the capture queued for the next run and stop calling it.
      if (modelDown) {
        bump(r, "llm_unavailable");
        r.errors.push(`model unavailable: ${m.ok ? "" : m.error}`);
        llm = null;
      }
      let modelExtractionId: string | null = null;
      if (m && !modelDown) {
        modelExtractionId = await ctx.store.saveExtraction({
          capture_id: capture.id, run_id: ctx.runId, method: "llm", model: ctx.llm?.model ?? "unknown", prompt_version: PROMPT_VERSION,
          status: m.ok ? "done" : "dead_letter", output: m.ok ? { ...m.checked.output, kept_signals: m.checked.signals, dropped: m.checked.dropped } : null,
          error: m.ok ? null : m.error, attempts: m.attempts, cost_usd: m.cost_usd,
        });
        bump(r, m.ok ? "llm_done" : "dead_letter");
        if (m.ok) bump(r, "llm_dropped_fields", m.checked.dropped.length);
      }
      for (const site of out.sites ?? []) {
        const saved = await ctx.store.upsertWorkdaySite({ ...site, discovered_from: capture.source_id, capture_id: capture.id });
        if (saved.inserted) bump(r, "new_workday_sites");
      }
      for (const signal of out.signals) {
        const saved = await ctx.store.upsertSignal({ ...signal, capture_id: capture.id, extraction_id: signal.method === "llm" ? modelExtractionId : null, seen_at: ctx.now().toISOString() });
        bump(r, saved.inserted ? "new_signals" : "seen_signals");
      }
      // Structured reading closes the capture, unless it needs the configured model and the model is down or
      // out of budget: then it stays queued and is retried next run. With no model configured it is closed.
      const keepQueued = modelDown || (!!out.needsModel && !!ctx.llm && !m);
      if (keepQueued) bump(r, "queued_for_model");
      else {
        await ctx.store.saveExtraction({ capture_id: capture.id, run_id: ctx.runId, method: "structured", model: "", prompt_version: "", status: "done", output: out.structured ?? {}, error: null, attempts: 1, cost_usd: 0 });
        bump(r, "extracted");
      }
    } catch (error) {
      bump(r, "error_extract");
      r.errors.push(`extract ${capture.url}: ${message(error)}`);
      // A capture its reader cannot read would fail on every run: dead-letter it once, with the reason.
      try { await ctx.store.saveExtraction({ capture_id: capture.id, run_id: ctx.runId, method: "structured", model: "", prompt_version: "", status: "dead_letter", output: null, error: message(error).slice(0, 500), attempts: 1, cost_usd: 0 }); }
      catch { /* the store is failing too; the capture stays queued */ }
    }
  }
  return r;
}

// ---------- match ----------

type DomainLookup = { domain: string | null; confirmed: boolean; name: string | null };

// Name -> website through treg's free domain finder. Confirmed only when the returned company name matches.
export async function resolveDomain(ctx: PipelineContext, name: string): Promise<DomainLookup> {
  if (!ctx.treg) return { domain: null, confirmed: false, name: null };
  const query = name.replace(/\s*\/[A-Z]{2}\/?\s*$/, "").trim();
  const res = await ctx.treg.call("hunter.x.domain-finder", { query: { company: query, limit: 3 }, headers: { "X-Treg-Route-Max-Cost": "0" } });
  if (res.cost_usd > 0) await ctx.spend.record({ provider: "treg", endpoint: "hunter.x.domain-finder", step: "domain", subject: name, idempotency_key: "", worst_case_usd: 0, cost_usd: res.cost_usd, outcome: "unexpected charge on a free endpoint" });
  if (!res.ok) return { domain: null, confirmed: false, name: null };
  const rows = ((res.body as { data?: { domain?: string; company_name?: string }[] })?.data ?? []).filter(r => r.domain);
  const target = normalizeName(name);
  const best = rows.find(r => normalizeName(r.company_name) === target) ?? rows.find(r => nameSimilarity(r.company_name ?? "", name) >= 0.85);
  if (best) return { domain: normalizeDomain(best.domain), confirmed: true, name: best.company_name ?? null };
  return { domain: normalizeDomain(rows[0]?.domain), confirmed: false, name: rows[0]?.company_name ?? null };
}

// Display name: SEC titles arrive in capitals ("MARSH & MCLENNAN COMPANIES, INC."); prefer the resolver's spelling.
export function displayName(name: string, resolved: string | null): string {
  if (resolved && normalizeName(resolved) && isSimilarName(resolved, name)) return resolved;
  const trimmed = name.replace(/\s*\/[A-Z]{2}\/?\s*$/, "").trim();
  if (trimmed !== trimmed.toUpperCase()) return trimmed;
  // All capitals (SEC style): title-case each word, but keep a short leading acronym (ASML, KLA, 3M) and NV/SA/AG/SE.
  const keepUpper = new Set(["NV", "SA", "AG", "SE", "LP", "LLC"]);
  return trimmed.split(/(\s+)/).map((word, i) => {
    const bare = word.replace(/[^A-Z0-9]/g, "");
    if (keepUpper.has(bare) || (i === 0 && bare.length > 0 && bare.length <= 4 && bare !== "THE")) return word;
    return word.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  }).join("");
}

export async function matchStage(ctx: PipelineContext, opts: { dryRun?: boolean } = {}): Promise<StageResult> {
  const r = result();
  const settings = await ctx.store.settings();
  const unassigned = (await ctx.store.unassignedSignals()).filter(s => s.company_name);
  const groups = new Map<string, SignalRow[]>();
  for (const s of unassigned) {
    const key = normalizeName(s.company_name);
    if (key) groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  bump(r, "candidates", groups.size);
  let created = 0;
  const known = await ctx.store.companies();
  const pending = new Map((await ctx.store.reviewItems("pending")).map(item => [item.normalized_name, item.id]));
  for (const [normalized, signals] of groups) {
    try {
      const name = signals[0].company_name!;
      // A person is already deciding about this name: new evidence joins that review item instead of a new decision.
      const waiting = pending.get(normalized);
      if (waiting && !opts.dryRun) {
        await ctx.store.assignSignals(signals.map(s => s.id), { review_item_id: waiting });
        bump(r, "joined_pending_review");
        continue;
      }
      const lookup = await resolveDomain(ctx, name);
      const best = Math.max(...signals.map(s => s.confidence));
      const decision = decideMatch({ name, domain: lookup.domain, domain_confirmed: lookup.confirmed, best_confidence: best }, known, { canCreate: created < settings.max_new_companies_per_run }, companyAliases);
      const ids = signals.map(s => s.id);
      if (opts.dryRun) { bump(r, `would_${decision.action}`); continue; }
      if (decision.action === "skip") { bump(r, "excluded"); continue; }
      if (decision.action === "attach") {
        await ctx.store.assignSignals(ids, { company_id: decision.company_id });
        await ctx.store.linkWorkdaySites(normalized, { company_id: decision.company_id });
        bump(r, "attached_existing");
      } else if (decision.action === "create") {
        const companyName = displayName(name, lookup.name);
        const id = await ctx.store.createPipelineCompany({ name: companyName, domain: lookup.domain, employee_count: null, source: signals.find(s => s.type === "known_customer")?.source_url ?? signals[0].source_url }, ctx.runId, { signal_ids: ids, normalized_name: normalized });
        known.push({ id, name: companyName, domain: lookup.domain, employee_count: null, pipeline: true });
        created++;
        bump(r, "new_companies");
      } else {
        // Only a confirmed website is stored: approving an item must never create a company with a wrong guess.
        const item = await ctx.store.addReviewItem({ candidate_name: displayName(name, lookup.name), normalized_name: normalized, candidate_domain: lookup.confirmed ? lookup.domain : null, employee_count: null, suggested_company_id: decision.suggested_company_id, reason: decision.reason });
        await ctx.store.assignSignals(ids, { review_item_id: item.id });
        await ctx.store.linkWorkdaySites(normalized, { review_item_id: item.id });
        bump(r, item.inserted ? `review_${decision.reason}` : "review_existing");
      }
      if (lookup.domain) bump(r, "with_website");
      if (best >= TRUSTED_CONFIDENCE) bump(r, "trusted_candidates");
    } catch (error) {
      bump(r, "error_match");
      r.errors.push(`match ${normalized}: ${message(error)}`);
    }
  }
  return r;
}

// ---------- score ----------

const RESCORE_DAYS = 14;

// Same numbers, tier and source links. Reason wording alone ("41 days away" -> "40 days away") is not a change.
const evidenceLink = (value: unknown) => String(value ?? "").split(" | ")[0];
export function sameScore(a: StoredScore | null, b: Record<string, unknown>): boolean {
  if (!a) return false;
  return categories.every(c => Number(a[`${c}_score`]) === Number(b[`${c}_score`]) && evidenceLink(a[`${c}_evidence`]) === evidenceLink(b[`${c}_evidence`])) && a.tier === b.tier;
}

import { buildScoreChange, type ScoreTrigger } from "../domain/ingestion/score-change.ts";

// Scores every in-scope company. A new row is appended only when something changed, or every 14 days.
// Out-of-scope companies (existing companies while scope is pipeline_only) are never touched.
export async function scoreStage(ctx: PipelineContext, opts: { companyIds?: string[]; trigger?: ScoreTrigger } = {}): Promise<StageResult> {
  const r = result();
  const settings = await ctx.store.settings();
  const now = ctx.now();
  const companies = (await ctx.store.companies()).filter(c => !opts.companyIds || opts.companyIds.includes(c.id));
  for (const company of companies) {
    if (!mayScore(settings, company.pipeline)) { bump(r, "out_of_scope"); continue; }
    try {
      const signals = await ctx.store.signalsForCompany(company.id);
      const contacts = await ctx.store.contactsForCompany(company.id);
      // A company with no evidence yet still gets a row, so the dashboard shows "Needs evidence" instead of nothing.
      if (!signals.length && !contacts.length) bump(r, "no_evidence");
      // The employee count has no source link on the company row, so the +3 size bonus is not awarded automatically.
      const assessment = scoreCompany(company.id, signals as ScoringSignal[], contacts, settings, now, { employee_count: company.employee_count, employee_source: null });
      if (!assessment.result.ok) { bump(r, "error_score"); r.errors.push(`${company.name}: ${assessment.result.errors.join(" ")}`); continue; }
      const latest = await ctx.store.latestScore(company.id);
      const due = !latest || now.getTime() - Date.parse(latest.assessed_at) >= RESCORE_DAYS * 86400000;
      if (sameScore(latest, assessment.result.row) && !due) bump(r, "unchanged");
      else {
        // An unchanged score that is only re-saved because it is due is a refresh; anything else was started by the caller.
        const trigger: ScoreTrigger = sameScore(latest, assessment.result.row) ? "periodic_refresh" : opts.trigger ?? "pipeline_run";
        await ctx.store.insertScore(assessment.result.row, now.toISOString(), buildScoreChange({ previous: latest, row: assessment.result.row, trigger, runId: ctx.runId }));
        bump(r, latest ? "rescored" : "scored");
      }
      if (assessment.ready_for_contacts && !(await ctx.store.enrichmentStatus(company.id)) && !contacts.length) {
        await ctx.store.setEnrichment(company.id, "pending", "Budget + Release + Timing reached the ready-for-contacts threshold.");
        bump(r, "ready_for_contacts");
      }
    } catch (error) {
      bump(r, "error_score");
      r.errors.push(`score ${company.name}: ${message(error)}`);
    }
  }
  return r;
}
