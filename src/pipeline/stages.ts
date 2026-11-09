// The pipeline stages. Each one reads from and writes to the store only, so any stage can run on its own.
// Failures are counted and logged per item; a stage never throws out of a run.
import { createHash } from "node:crypto";
import { companyAliases } from "../data/company-aliases.ts";
import { decideMatch } from "../domain/ingestion/matching.ts";
import { isSimilarName, normalizeName } from "../domain/ingestion/normalize.ts";
import { scoreCompany, type ScoringSignal } from "../domain/ingestion/pipeline-score.ts";
import { lookupEmployeeWebsite } from "./employee-web-research.ts";
import { savedSecEmployeeEvidence } from "./sec-employee-evidence.ts";
import { employeeEvidenceForCompany } from "./employee-evidence.ts";
import { financialsUnavailable, lookupFinancials } from "./financials.ts";
import { isSignalFresh, mayScore } from "../domain/ingestion/settings.ts";
import { categories } from "../domain/contracts/company.ts";
import { resolveWebsite, WebsiteHttp, WEBSITE_LIMIT, websiteSignature, loadEmployerLinks, confirmedName } from "./website.ts";
import { collectors } from "./collectors/sources.ts";
import { extractCapture, loadPrompt, PROMPT_VERSION } from "./extract.ts";
import { assertIdentityAdmissionContext, type LocalIdentityAdmission } from "./local-identity-admission.ts";
import type { CollectLimits, PipelineContext, RunCounts, SignalRow, SourceRow, StoredScore } from "./types.ts";

// candidate_keys: short hashes of the names a match pass checked, so a batch can count unique candidates without listing them.
export type StageResult = { cache_hit?: boolean; candidate_keys?: string[]; counts: RunCounts; errors: string[]; blocked: string | null; requests: number; llm_spend_usd: number; treg_spend_usd: number };
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
  r.cache_hit = collected.cache_hit;
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

// Display name: SEC titles arrive in capitals ("MARSH & MCLENNAN COMPANIES, INC."); prefer the resolver's spelling.
export function displayName(name: string, resolved: string | null): string {
  if (resolved && normalizeName(resolved) && isSimilarName(resolved, name)) return resolved;
  const trimmed = name.replace(/\s*\/[a-z]{2,3}\/?\s*$/i, "").trim();
  if (trimmed !== trimmed.toUpperCase()) return trimmed;
  // All capitals (SEC style): title-case each word, but keep a short leading acronym (KLA, 3M, ASML) and legal forms.
  // Four-letter leading words are almost always ordinary ones (BANK, HOME, FORD), so only known acronyms stay capitalized.
  const keepUpper = new Set(["NV", "SA", "AG", "SE", "LP", "LLC", "PLC", "ASA"]);
  const plainWords = new Set(["THE", "NEW", "OLD", "AIR", "BIG", "ALL", "ONE", "TWO", "TOP", "SUN", "RED", "OAK"]);
  const lowerWords = new Set(["OF", "AND", "FOR", "THE"]);
  return trimmed.split(/(\s+)/).map((word, i) => {
    const bare = word.replace(/[^A-Z0-9]/g, "");
    if (keepUpper.has(bare) || (i === 0 && ((bare.length > 0 && bare.length <= 3 && !plainWords.has(bare)) || bare === "ASML"))) return word;
    if (i > 0 && lowerWords.has(bare)) return word.toLowerCase();
    return word.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  }).join("");
}

export async function matchStage(ctx: PipelineContext, opts: { dryRun?: boolean; localIdentity?: LocalIdentityAdmission } = {}): Promise<StageResult> {
  if (opts.localIdentity) assertIdentityAdmissionContext(ctx, opts.localIdentity);
  const r = result();
  const settings = await ctx.store.settings();
  const allReviews = await ctx.store.reviewItems();
  const reviews = new Map(allReviews.filter(item => item.status === "pending").map(item => [item.normalized_name, item]));
  const resolved = new Map(allReviews.filter(item => item.status !== "pending").map(item => [item.normalized_name, item]));
  const groups = new Map<string, SignalRow[]>();
  for (const signal of (await ctx.store.unassignedSignals()).filter(s => s.company_name)) {
    const key = normalizeName(signal.company_name);
    if (key) groups.set(key, [...(groups.get(key) ?? []), signal]);
  }
  // Reviews own their signals, so unassignedSignals alone cannot discover recoverable candidates.
  for (const item of reviews.values()) {
    const signals = await ctx.store.signalsForReview(item.id);
    groups.set(item.normalized_name, [...(groups.get(item.normalized_name) ?? []), ...signals]);
  }
  if (opts.localIdentity) for (const name of groups.keys()) if (!opts.localIdentity.names.has(name)) groups.delete(name);
  bump(r, "candidates", groups.size);
  r.candidate_keys = [...groups.keys()].map(name => createHash("sha256").update(name).digest("hex").slice(0, 16));
  let created = 0, lookups = 0;
  const deadline = Date.now() + (opts.localIdentity ? 30 : 5) * 60 * 1000;
  const initialSpend = ctx.spend.spent("treg");
  const known = await ctx.store.companies();
  const sites = await ctx.store.workdaySites(true);
  const http = new WebsiteHttp(ctx);
  for (const [normalized, signals] of groups) {
    if (!signals.length) continue;
    if (Date.now() >= deadline) { bump(r, "website_deferred_time_cap"); break; }
    try {
      const name = signals[0].company_name!;
      const waiting = reviews.get(normalized);
      const done = resolved.get(normalized);
      const ids = signals.map(s => s.id);
      if (done && !waiting) {
        if (!opts.dryRun) {
          const target = done.resolved_company_id ? { company_id: done.resolved_company_id } : { review_item_id: done.id };
          await ctx.store.assignSignals(ids, target);
          await ctx.store.linkWorkdaySites(normalized, target);
        }
        bump(r, done.status === "rejected" ? "kept_rejected" : "joined_resolved_review");
        continue;
      }
      const candidateSites = sites.filter(site => site.normalized_name === normalized);
      const employerLinks = await loadEmployerLinks(ctx, name, candidateSites);
      const cached = await ctx.store.websiteResolution(normalized);
      const due = !!opts.localIdentity || !cached || cached.input_signature !== websiteSignature(candidateSites, employerLinks) || Date.parse(cached.next_check_at) <= ctx.now().getTime();
      if (due && lookups >= WEBSITE_LIMIT) { bump(r, "website_deferred_run_cap"); continue; }
      if (due) lookups++;
      const lookup = opts.localIdentity
        ? await opts.localIdentity.resolve(ctx, name, candidateSites, http, employerLinks)
        : await resolveWebsite(ctx, name, candidateSites, http, !!opts.dryRun, employerLinks);
      if (opts.localIdentity) bump(r, lookup.status === "confirmed" ? "identity_confirmed" : "identity_held");
      bump(r, due ? "website_checked" : "website_cached");
      if (lookup.status === "error") {
        bump(r, "error_website"); r.errors.push(`website ${normalized}: ${lookup.reason}`);
        if (/treg HTTP (401|402|403|429)|zero charge/i.test(lookup.reason)) { r.blocked = lookup.reason; break; }
      }
      // Verification can fill an empty website on human-only reviews, but never resolve them or
      // overwrite a person's website choice. Rejected/resolved reviews were handled above.
      if (waiting?.reason === "similar_name") {
        if (!opts.dryRun) {
          await ctx.store.assignSignals(ids, { review_item_id: waiting.id });
          await ctx.store.linkWorkdaySites(normalized, { review_item_id: waiting.id });
          if (lookup.status === "confirmed" && await ctx.store.fillReviewWebsite(waiting.id, lookup.domain!)) bump(r, "review_websites_confirmed");
        }
        bump(r, "pending_reason_similar_name");
        bump(r, "joined_pending_review"); continue;
      }
      // A slug-derived name (Common Crawl tenant) is replaced by the name the confirmed website uses.
      const nameIsGuess = candidateSites.some(s => s.match_kind === "first_word");
      const pageName = nameIsGuess ? confirmedName(lookup) : null;
      const freshEvidence = signals.some(s => isSignalFresh(s, settings, ctx.now()));
      // AI confirmation already read current postings and checked a guessed name against them.
      // Direct-link confirmation needs fresh evidence and, for a guessed tenant, the company's name on its
      // website: emerson.edu linking the "emerson" tenant says nothing about Emerson Electric.
      const workdayVerified = opts.localIdentity ? lookup.status === "confirmed" : freshEvidence && (!nameIsGuess || !!pageName);
      const decision = decideMatch({ name, domain: lookup.domain, domain_confirmed: lookup.status === "confirmed", workday_verified: workdayVerified }, known,
        { canCreate: created < settings.max_new_companies_per_run }, companyAliases);

      if (opts.dryRun) { bump(r, `would_${decision.action}`); continue; }
      if (decision.action === "skip") { bump(r, "excluded"); continue; }
      const source = signals.find(s => s.type === "known_customer" && /^https:\/\//.test(s.source_url))?.source_url ?? signals.find(s => /^https:\/\//.test(s.source_url))?.source_url;
      if ((decision.action === "create" || decision.action === "attach") && !source) throw Error("company admission requires an HTTPS evidence source");
      if (waiting) {
        // New signals join before the RPC; on failure the pending review retains them for retry.
        await ctx.store.assignSignals(ids, { review_item_id: waiting.id });
        await ctx.store.linkWorkdaySites(normalized, { review_item_id: waiting.id });
        if (decision.action === "create" || decision.action === "attach") {
          if (pageName && decision.action === "create") await ctx.store.updatePendingReview(waiting.id, { candidate_name: pageName, candidate_domain: waiting.candidate_domain, reason: waiting.reason, suggested_company_id: waiting.suggested_company_id });
          const id = await ctx.store.admitReview(waiting.id, lookup.domain!, source!, decision.action === "attach" ? decision.company_id : null, ctx.runId);
          if (decision.action === "create") { known.push({ id, name: pageName ?? waiting.candidate_name, domain: lookup.domain, employee_count: waiting.employee_count, pipeline: true }); created++; }
          bump(r, decision.action === "create" ? "new_companies" : "attached_existing");
          bump(r, "recovered_reviews");
        } else {
          await ctx.store.updatePendingReview(waiting.id, { candidate_domain: lookup.status === "confirmed" ? lookup.domain : null, reason: decision.reason, suggested_company_id: decision.suggested_company_id });
          bump(r, `pending_reason_${decision.reason}`);
          bump(r, "joined_pending_review");
        }
      } else if (decision.action === "attach") {
        await ctx.store.assignSignals(ids, { company_id: decision.company_id });
        await ctx.store.linkWorkdaySites(normalized, { company_id: decision.company_id });
        bump(r, "attached_existing");
      } else if (decision.action === "create") {
        const companyName = pageName ?? displayName(name, null);
        const id = await ctx.store.createPipelineCompany({ name: companyName, domain: lookup.domain, employee_count: null, source: source! }, ctx.runId, { signal_ids: ids, normalized_name: normalized });
        known.push({ id, name: companyName, domain: lookup.domain, employee_count: null, pipeline: true });
        created++; bump(r, "new_companies");
      } else {
        const item = await ctx.store.addReviewItem({ candidate_name: pageName ?? displayName(name, null), normalized_name: normalized, candidate_domain: lookup.status === "confirmed" ? lookup.domain : null, employee_count: null, suggested_company_id: decision.suggested_company_id, reason: decision.reason });
        await ctx.store.assignSignals(ids, { review_item_id: item.id });
        await ctx.store.linkWorkdaySites(normalized, { review_item_id: item.id });
        bump(r, item.inserted ? `review_${decision.reason}` : "review_existing");
      }
      if (lookup.domain) bump(r, "with_website");
    } catch (error) { bump(r, "error_match"); r.errors.push(`match ${normalized}: ${message(error)}`); }
  }
  r.requests = http.requests;
  r.treg_spend_usd = ctx.spend.spent("treg") - initialSpend;
  return r;
}

// ---------- score ----------

const RESCORE_DAYS = 14;

// Same numbers, tier and source links. Reason wording alone ("41 days away" -> "40 days away") is not a change.
const evidenceLink = (value: unknown) => String(value ?? "").split(" | ")[0];
export function sameScore(a: StoredScore | null, b: Record<string, unknown>): boolean {
  if (!a) return false;
  return categories.every(c => Number(a[`${c}_score`]) === Number(b[`${c}_score`]) && evidenceLink(a[`${c}_evidence`]) === evidenceLink(b[`${c}_evidence`])) && a.tier === b.tier
    && String(a.authority_evidence ?? "").split(" Headcount ")[1] === String(b.authority_evidence ?? "").split(" Headcount ")[1];
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
      const reviewedEmployees = employeeEvidenceForCompany(ctx.employeeEvidence ?? [], company.domain, now);
      // ponytail: SEC facts are refetched on every score pass (once per company per run); cache them in a table if that gets slow.
      const lookup = await lookupFinancials(ctx, company.name);
      r.requests += lookup.requests;
      const latest = await ctx.store.latestScore(company.id);
      const savedEmployees = financialsUnavailable(lookup.status)
        ? savedSecEmployeeEvidence(latest?.authority_evidence, now) : null;
      const web = !reviewedEmployees && !lookup.employeeEvidence && !savedEmployees && ctx.employeeWebResearch
        ? await lookupEmployeeWebsite(ctx, company) : null;
      r.requests += web?.requests ?? 0;
      r.treg_spend_usd += web?.spend ?? 0;
      const employees = reviewedEmployees ?? lookup.employeeEvidence ?? savedEmployees ?? web?.evidence;
      const assessment = scoreCompany(company.id, signals as ScoringSignal[], contacts, settings, now, { employee_count: employees?.employee_count ?? null, employee_source: employees?.source ?? null, employee_as_of: employees?.as_of ?? null, employee_basis: employees?.basis ?? "exact", employee_date_basis: employees?.date_basis ?? "effective", financials: lookup.financials });
      if (!assessment.result.ok) { bump(r, "error_score"); r.errors.push(`${company.name}: ${assessment.result.errors.join(" ")}`); continue; }
      const due = !latest || now.getTime() - Date.parse(latest.assessed_at) >= RESCORE_DAYS * 86400000;
      // A lookup that could not run is not evidence that capacity disappeared: keep the saved assessment until it can.
      const deferred = financialsUnavailable(lookup.status) && !!latest && Number(assessment.result.row.budget_score) < Number(latest.budget_score);
      if (deferred) bump(r, "financials_deferred");
      else if (sameScore(latest, assessment.result.row) && !due) bump(r, "unchanged");
      else {
        // An unchanged score that is only re-saved because it is due is a refresh; anything else was started by the caller.
        const trigger: ScoreTrigger = sameScore(latest, assessment.result.row) ? "periodic_refresh" : opts.trigger ?? "pipeline_run";
        await ctx.store.insertScore(assessment.result.row, now.toISOString(), buildScoreChange({ previous: latest, row: assessment.result.row, trigger, runId: ctx.runId }));
        bump(r, latest ? "rescored" : "scored");
      }
      if (!deferred && assessment.ready_for_contacts && !(await ctx.store.enrichmentStatus(company.id)) && !contacts.length) {
        await ctx.store.setEnrichment(company.id, "pending", "Budget + Release + Timing reached the ready-for-contacts threshold.");
        bump(r, "ready_for_contacts");
      }
      // Coverage comes after the writes, so a failing store still leaves this stage with no work and a failed status.
      bump(r, reviewedEmployees ? "employee_evidence_reviewed" : lookup.employeeEvidence ? "employee_evidence_sec" : savedEmployees ? "employee_evidence_retained" : web?.evidence ? "employee_evidence_web" : "employee_evidence_missing");
      if (web && !web.evidence) bump(r, `employee_web_${web.status}`);
      bump(r, `financials_${lookup.status}`);
      bump(r, contacts.length ? "with_contacts" : "without_contacts");
      if (!deferred) for (const category of categories) if (assessment.categories[category].score === 0) bump(r, `zero_${category}`);
    } catch (error) {
      bump(r, "error_score");
      r.errors.push(`score ${company.name}: ${message(error)}`);
    }
  }
  return r;
}
