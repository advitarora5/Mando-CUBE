// Builds a PipelineContext from environment variables. Secrets are read from the environment only and never printed.
import { LedgerSpendGuard } from "./ledger.ts";
import { llmFromEnv } from "./llm.ts";
import { MemoryStore } from "./store/memory.ts";
import { SupabaseStore } from "./store/supabase.ts";
import { tregFromEnv } from "./treg.ts";
import type { Logger, PipelineContext, PipelineStore } from "./types.ts";

export const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(`! ${msg}`),
  error: (msg) => console.error(`x ${msg}`),
};

export function databaseFromEnv(env: NodeJS.ProcessEnv): PipelineStore {
  const url = env.PIPELINE_SUPABASE_URL;
  const key = env.PIPELINE_SUPABASE_KEY;
  if (!url || !key) throw new Error("Set PIPELINE_SUPABASE_URL and PIPELINE_SUPABASE_KEY (a local or test database), or use --dry-run.");
  return new SupabaseStore(url, key, env.PIPELINE_ALLOW_REMOTE);
}

// --max-spend can only lower the session cap from TREG_BUDGET_USD; raising a cap is a deliberate env change.
export function tregCap(env: NodeJS.ProcessEnv, maxSpend?: number): number {
  const configured = Number(env.TREG_BUDGET_USD ?? 0.5);
  const base = Number.isFinite(configured) && configured >= 0 ? configured : 0.5;
  return maxSpend != null && Number.isFinite(maxSpend) && maxSpend >= 0 ? Math.min(base, maxSpend) : base;
}

export async function contextFromEnv(env: NodeJS.ProcessEnv, opts: { dryRun: boolean; maxSpend?: number; store?: PipelineStore; noLlm?: boolean; noTreg?: boolean }): Promise<PipelineContext> {
  const now = () => new Date();
  const store = opts.store ?? (opts.dryRun ? new MemoryStore() : databaseFromEnv(env));
  const llm = opts.noLlm ? null : llmFromEnv(env);
  const settings = await store.settings();
  const spend = new LedgerSpendGuard({
    path: opts.dryRun ? null : (env.PIPELINE_LEDGER ?? "var/spend-ledger.jsonl"),
    session: env.TREG_SESSION ?? now().toISOString().slice(0, 10),
    caps: { treg: tregCap(env, opts.maxSpend), llm: llm && llm.worstCaseUsd > 0 ? Math.min(Number(env.PIPELINE_LLM_BUDGET_USD ?? 0), settings.max_llm_spend_usd_per_run) : 0 },
    log: consoleLogger, now,
  });
  return {
    store, now, log: consoleLogger, fetch: globalThis.fetch.bind(globalThis),
    treg: opts.noTreg ? null : await tregFromEnv(env), llm, spend,
    contact: env.PIPELINE_CONTACT ?? "", sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)), runId: null,
  };
}
