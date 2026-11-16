import { scoreStage, type StageResult } from "./stages.ts";
import type { PipelineContext } from "./types.ts";

export type ScoringClaim = { company_id: string; version: number; token: string };
export type ScoringQueueStatus = { pending: number; running: number; retry: number; done: number };
export type ScoringWorkReport = { attempted: number; completed: number; retry: number; counts: Record<string, number>; errors: string[] };

export async function workScoringQueue(ctx: PipelineContext, opts: { limit: number; companyId?: string }): Promise<ScoringWorkReport> {
  if (ctx.sectionScope) throw Error("Scoring worker needs a global context, separate from section discovery.");
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 100) throw Error("Scoring limit must be an integer from 1 to 100.");
  const report: ScoringWorkReport = { attempted: 0, completed: 0, retry: 0, counts: {}, errors: [] };
  const batchCtx = { ...ctx }; // Do not carry a failed financial-provider cache into a later retry pass.
  for (let i = 0; i < opts.limit && !ctx.signal?.aborted; i++) {
    const claim = await ctx.store.claimScoring(opts.companyId);
    if (!claim) break;
    report.attempted++;
    let result: StageResult;
    try {
      result = await scoreStage(batchCtx, { companyIds: [claim.company_id], queued: claim });
    } catch {
      result = { counts: { error_score: 1 }, errors: ["Scoring failed; evidence retained for retry."], requests: 0, treg_spend_usd: 0, llm_spend_usd: 0, blocked: null };
    }
    for (const [key, value] of Object.entries(result.counts)) report.counts[key] = (report.counts[key] ?? 0) + value;
    if (result.counts.queue_completed) report.completed++;
    else {
      await ctx.store.failScoring(claim, result.counts.financials_deferred ? "financials_deferred" : "score_failed");
      report.retry++;
      report.errors.push(`Company ${claim.company_id}: ${result.counts.financials_deferred ? "financials deferred" : "scoring failed"}; queued for retry.`);
    }
  }
  return report;
}
