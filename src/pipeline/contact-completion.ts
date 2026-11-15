import { createHash } from "node:crypto";
import { contactCallKey } from "../../scripts/contact-completion.mjs";
import type { PipelineContext, ContactCall, TregResult } from "./types.ts";
import type { StageResult } from "./stages.ts";

export class ContactBudgetReached extends Error {}
export function completionClient(ctx: PipelineContext, worst: number, result: StageResult) {
  const lookups = new Map<string, number>();
  return async (companyId: string, endpoint: string, body: Record<string, string>) => {
    const key = contactCallKey(endpoint, body)!;
    const legacy = createHash("sha256").update(JSON.stringify({ endpoint, body })).digest("hex");
    const cached = await ctx.store.contactCall(companyId, key) ?? await ctx.store.contactCall(companyId, legacy);
    if (cached) {
      if (cached.status !== "succeeded") throw new Error("Prior contact call is unresolved; reconcile before retrying.");
      return cached;
    }
    if (endpoint.endsWith(".find") && (lookups.get(companyId) ?? 0) >= 2) throw new ContactBudgetReached("Company lookup limit reached");
    if (!(await ctx.spend.allow("treg", worst, endpoint))) throw new ContactBudgetReached("Contact completion waits for budget.");
    await ctx.store.startContactCall(companyId, key, endpoint);
    if (endpoint.endsWith(".find")) lookups.set(companyId, (lookups.get(companyId) ?? 0) + 1);
    result.requests++;
    let res: TregResult;
    try {
      res = await ctx.treg!.call(endpoint, {
        body, headers: { "X-Treg-Route-Max-Cost": worst.toFixed(6), "X-Treg-Route-Strict-Filters": "1", "X-Treg-Route-Verify": "false" },
        idempotencyKey: `${companyId}:${key}`,
      });
    } catch (error) {
      (ctx.spend as { stop?: (p: string, reason: string) => void }).stop?.("treg", "Lost contact call response");
      await ctx.spend.record({ provider: "treg", endpoint, step: "contact_completion", subject: companyId, idempotency_key: key,
        worst_case_usd: worst, cost_usd: worst, outcome: "unknown charge; reconcile running checkpoint" });
      throw error;
    }
    const payload = res.body as { output?: unknown; _treg?: { outcome?: string; served_by?: string } } | undefined;
    const safe = res.ok && res.status !== 202 && Number.isFinite(res.cost_usd) && res.cost_usd >= 0 && res.cost_usd <= worst &&
      payload?.output && typeof payload.output === "object" && !Array.isArray(payload.output) &&
      !["pending", "error", "failed"].includes(payload._treg?.outcome ?? "");
    const cost = Number.isFinite(res.cost_usd) && res.cost_usd >= 0 ? res.cost_usd : worst;
    const checkpoint: ContactCall = { status: safe ? "succeeded" : "blocked", response: res.body,
      provider: payload?._treg?.served_by ?? null, call_id: res.call_id ?? null,
      cost_micro: Number.isFinite(res.cost_usd) ? Math.round(res.cost_usd * 1e6) : null };
    await ctx.store.finishContactCall(companyId, key, checkpoint);
    result.treg_spend_usd += cost;
    await ctx.spend.record({ provider: "treg", endpoint, step: "contact_completion", subject: companyId, idempotency_key: key,
      worst_case_usd: worst, cost_usd: safe ? cost : Math.max(cost, worst), outcome: checkpoint.status });
    if (!safe) {
      (ctx.spend as { stop?: (p: string, reason: string) => void }).stop?.("treg", "Contact call requires reconciliation");
      throw new Error("Contact call requires review; no automatic retry.");
    }
    return checkpoint;
  };
}
