// Orchestration and run logging. Every stage execution is one pipeline_runs row (what ran, items, new companies,
// errors, cost). A run always finishes: stage failures are logged and the next stage still runs.
import { collectStage, extractStage, matchStage, scoreStage, type StageResult } from "./stages.ts";
import { enrichStage } from "./enrich.ts";
import type { PipelineContext, RunStatus, SourceRow } from "./types.ts";
import { assertIdentityAdmissionContext, type LocalIdentityAdmission } from "./local-identity-admission.ts";
import { discoveryBatch, sectionNames } from "./section-scope.ts";
import { normalizeName } from "../domain/ingestion/normalize.ts";

export type Plan = "daily" | "weekly" | "rescore" | "all" | "collect" | "extract" | "match" | "score" | "enrich" | "section";
export type RunOptions = { plan: Plan; source?: string; limit: number; dryRun: boolean; trigger: "schedule" | "manual" | "import_button"; enrichCompanies?: number; freeEnrichOnly?: boolean; localIdentity?: LocalIdentityAdmission };
export type JobReport = { job: string; source_id: string | null; status: RunStatus; ms: number } & StageResult;
export type RunReport = { jobs: JobReport[]; alerts: string[]; ms: number; treg_spend_usd: number; llm_spend_usd: number; section?: { version: string; number: number; assigned: number; held_ambiguous: number; pending: number; found: number; miss: number; retry: number } };

export function statusOf(r: StageResult): RunStatus {
  if (r.blocked) return "blocked";
  const errors = Object.entries(r.counts).filter(([k]) => k.startsWith("error_")).reduce((n, [, v]) => n + v, 0) + (r.errors.length && !Object.keys(r.counts).some(k => k.startsWith("error_")) ? r.errors.length : 0);
  const work = Object.entries(r.counts).filter(([k]) => !k.startsWith("error_")).reduce((n, [, v]) => n + v, 0);
  if (errors && !work) return "failed";
  return errors ? "partial" : "succeeded";
}

async function job(ctx: PipelineContext, report: RunReport, name: string, sourceId: string | null, trigger: RunOptions["trigger"], fn: () => Promise<StageResult>) {
  const started = Date.now();
  let runId: string | null = null;
  try { runId = await ctx.store.startRun({ job: name, source_id: sourceId, trigger }); }
  catch (error) { ctx.log.error(`could not open run log for ${name}: ${(error as Error).message}`); }
  ctx.runId = runId;
  let r: StageResult;
  try { r = await fn(); }
  catch (error) { r = { counts: { error_stage: 1 }, errors: [`${name} crashed: ${(error as Error).message}`], blocked: null, requests: 0, llm_spend_usd: 0, treg_spend_usd: 0 }; }
  const status = statusOf(r);
  const entry: JobReport = { job: name, source_id: sourceId, status, ms: Date.now() - started, ...r };
  report.jobs.push(entry);
  report.treg_spend_usd += r.treg_spend_usd; report.llm_spend_usd += r.llm_spend_usd;
  ctx.log.info(`${name}${sourceId ? ` [${sourceId}]` : ""}: ${status} ${JSON.stringify(r.counts)}`);
  for (const e of r.errors.slice(0, 5)) ctx.log.warn(`  ${e}`);
  if (runId) {
    try { await ctx.store.finishRun(runId, { status, counts: r.counts, requests: r.requests, llm_spend_usd: r.llm_spend_usd, treg_spend_usd: r.treg_spend_usd, error: r.blocked ?? (r.errors.slice(0, 3).join(" | ") || null) }); }
    catch (error) { ctx.log.error(`could not close run log for ${name}: ${(error as Error).message}`); }
  }
  ctx.runId = null;
  return entry;
}

// Alert (a logged flag) when a source returns nothing or errors three runs in a row.
async function checkAlerts(ctx: PipelineContext, report: RunReport, sourceId: string) {
  try {
    const recent = await ctx.store.recentRuns(sourceId, 3);
    if (recent.length === 3 && recent.every(r => r.status === "failed" || r.status === "blocked" || r.items === 0)) {
      const msg = `ALERT: source ${sourceId} returned nothing or failed in each of its last 3 runs`;
      report.alerts.push(msg); ctx.log.warn(msg);
    }
  } catch { /* alerts never fail a run */ }
}

export async function runPipeline(ctx: PipelineContext, opts: RunOptions): Promise<RunReport> {
  if (!!ctx.sectionScope !== (opts.plan === "section")) throw Error("Section scope requires the section plan; global plans cannot use a section context.");
  if (opts.plan === "section" && (opts.dryRun || !Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 100)) throw Error("Section execution requires a limit from 1 to 100; use --preview for an offline preview.");
  if (opts.localIdentity) assertIdentityAdmissionContext(ctx, opts.localIdentity);
  const report: RunReport = { jobs: [], alerts: [], ms: 0, treg_spend_usd: 0, llm_spend_usd: 0 };
  const started = Date.now();
  // A run that crashed stays "running" forever; close those (older than 6 hours) so health shows the truth.
  try { const closed = ctx.sectionScope ? 0 : await ctx.store.closeStaleRuns(new Date(ctx.now().getTime() - 6 * 3600000).toISOString()); if (closed) ctx.log.warn(`closed ${closed} stale run(s) as failed`); }
  catch (error) { ctx.log.error(`could not close stale runs: ${(error as Error).message}`); }
  const sources = await ctx.store.sources();
  const byId = (id: string) => sources.find(s => s.id === id);
  if (ctx.sectionScope) {
    const scope = ctx.sectionScope;
    const resolver = byId("workday-site-resolver"), postings = byId("workday-career-sites");
    if (!resolver?.enabled || resolver.type !== "workday_site_resolver" || !postings?.enabled || postings.type !== "workday_career_site") throw Error("Section execution requires enabled Workday resolver and career-site sources.");
    await ctx.store.ensureSection(scope); // Fails before any provider call if the migration is missing or assignments differ.
    const batch = discoveryBatch(scope, await ctx.store.sectionProgress(scope), opts.limit, ctx.now());
    const settings = await ctx.store.settings();
    let remaining = Math.min(resolver.max_requests_per_run, settings.max_requests_per_run);
    for (const issuer of batch) {
      if (remaining < 1 || ctx.signal?.aborted) break;
      ctx.sectionIssuer = issuer;
      let entry: JobReport;
      try {
        entry = await job(ctx, report, `section:${scope.section}:discover:${issuer.cik}`, resolver.id, opts.trigger,
          () => collectStage(ctx, { ...resolver, max_requests_per_run: remaining }, { limit: 1, dryRun: false }));
      } finally { delete ctx.sectionIssuer; }
      remaining -= entry.requests;
      if (entry.status !== "succeeded") break;
    }
    const extractOwn = () => job(ctx, report, `section:${scope.section}:extract`, null, opts.trigger,
      () => extractStage(ctx, { limit: Math.max(opts.limit * 10, 200), sourceIds: [resolver.id, postings.id] }));
    await extractOwn();
    const requestBudget = Math.max(0, settings.max_requests_per_run - report.jobs.reduce((n, j) => n + j.requests, 0));
    if (requestBudget > 0 && !ctx.signal?.aborted) await job(ctx, report, `section:${scope.section}:postings`, postings.id, opts.trigger,
      () => collectStage(ctx, { ...postings, max_requests_per_run: Math.min(postings.max_requests_per_run, requestBudget) }, { limit: opts.limit, dryRun: false }));
    await extractOwn();
    if (!ctx.signal?.aborted) await job(ctx, report, `section:${scope.section}:match`, null, opts.trigger, () => matchStage(ctx));
    const progress = await ctx.store.sectionProgress(scope);
    const allowed = sectionNames(scope);
    report.section = { version: scope.version, number: scope.section, assigned: scope.issuers.length,
      held_ambiguous: scope.issuers.filter(i => !allowed.has(normalizeName(i.name))).length,
      pending: progress.filter(p => p.status === "pending").length, found: progress.filter(p => p.status === "found").length,
      miss: progress.filter(p => p.status === "miss").length, retry: progress.filter(p => p.status === "retry").length };
    report.ms = Date.now() - started;
    return report; // No global collectors, score pass, or contact enrichment in a section run.
  }
  const collect = async (source: SourceRow | undefined) => {
    if (!source) return;
    if (!source.enabled && opts.source !== source.id) { ctx.log.info(`skip disabled source ${source.id}`); return; }
    await job(ctx, report, "collect", source.id, opts.trigger, () => collectStage(ctx, source, { limit: opts.limit, dryRun: opts.dryRun }));
    if (!opts.dryRun) await checkAlerts(ctx, report, source.id);
  };
  const extract = () => job(ctx, report, "extract", null, opts.trigger, () => extractStage(ctx, { limit: Math.max(opts.limit * 10, 200) }));
  const match = () => job(ctx, report, "match", null, opts.trigger, () => matchStage(ctx, { dryRun: opts.dryRun, localIdentity: opts.localIdentity }));
  const score = () => job(ctx, report, "score", null, opts.trigger, () => scoreStage(ctx));
  const enrich = () => job(ctx, report, "enrich", null, opts.trigger, () => enrichStage(ctx, {
    maxCompanies: opts.enrichCompanies ?? opts.limit, dryRun: opts.dryRun, freeOnly: opts.freeEnrichOnly,
  }));
  // Each plan collects only sources of its frequency, so a weekly paid feed never runs daily.
  const discoveryIds = ["sec-company-list", "workday-site-resolver", "workday-tenant-crawl", "workday-tenant-wayback"];
  const discovery = async () => {
    for (const id of discoveryIds) await collect(byId(id));
    for (const s of sources.filter(s => s.frequency === "weekly" && !discoveryIds.includes(s.id))) await collect(s);
    await extract(); await match();
  };
  const daily = async () => {
    await collect(byId("workday-career-sites"));
    for (const s of sources.filter(s => s.frequency === "daily" && s.id !== "workday-career-sites")) await collect(s);
    await extract(); await match(); await score(); await enrich();
  };

  switch (opts.plan) {
    case "collect": await collect(opts.source ? byId(opts.source) : undefined); if (!opts.source) ctx.log.warn("collect needs --source"); break;
    case "extract": await extract(); break;
    case "match": await match(); break;
    case "score": await score(); break;
    case "rescore": await score(); break;
    case "enrich": await enrich(); break;
    case "weekly": await discovery(); await score(); break;
    case "daily": await daily(); break;
    case "all": await discovery(); await daily(); break;
  }
  report.ms = Date.now() - started;
  return report;
}
