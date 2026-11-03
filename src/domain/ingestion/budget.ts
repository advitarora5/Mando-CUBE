// Spend ledger math. Pure: the ledger file and balance lookups live in src/pipeline/ledger.ts.

export type LedgerEntry = {
  at: string;
  session: string;
  provider: string;
  endpoint: string;
  step: string;
  subject: string;
  idempotency_key: string;
  worst_case_usd: number;
  cost_usd: number;
  outcome: string;
};

const cents = (usd: number) => Math.round(usd * 1e6) / 1e6;

export function sessionSpend(entries: LedgerEntry[], session: string): number {
  return cents(entries.filter(e => e.session === session).reduce((sum, e) => sum + (Number.isFinite(e.cost_usd) ? e.cost_usd : 0), 0));
}

export type SpendDecision = { ok: true; remaining: number } | { ok: false; reason: string };

// A paid call may go ahead only if what this session already spent plus the call's worst case stays within
// the cap, and within the provider balance when it is known. A cap of 0 turns paid work off.
export function canSpend(opts: { spent: number; capUsd: number; worstCaseUsd: number; balanceUsd?: number | null }): SpendDecision {
  const { spent, capUsd, worstCaseUsd, balanceUsd } = opts;
  if (!(worstCaseUsd >= 0) || !Number.isFinite(worstCaseUsd)) return { ok: false, reason: "worst-case cost is unknown" };
  if (worstCaseUsd === 0) return { ok: true, remaining: Math.max(0, cents(capUsd - spent)) }; // free calls (local model, free endpoints)
  if (!(capUsd > 0)) return { ok: false, reason: "spending cap is 0" };
  const limit = balanceUsd == null ? capUsd : Math.min(capUsd, spent + balanceUsd);
  if (cents(spent + worstCaseUsd) > cents(limit)) {
    return { ok: false, reason: `spent $${spent.toFixed(4)} + worst case $${worstCaseUsd.toFixed(4)} exceeds ${balanceUsd != null && spent + balanceUsd < capUsd ? "the provider balance" : `the $${capUsd.toFixed(2)} cap`}` };
  }
  return { ok: true, remaining: cents(limit - spent - worstCaseUsd) };
}
