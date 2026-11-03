// Spend guard backed by a gitignored JSONL ledger. Before every paid call: spent + worst case must stay under the cap.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canSpend, sessionSpend, type LedgerEntry } from "../domain/ingestion/budget.ts";
import type { Logger, SpendGuard } from "./types.ts";

export type Caps = Record<string, number>; // provider -> USD cap for the session ("treg", "llm")

export class LedgerSpendGuard implements SpendGuard {
  private entries: LedgerEntry[] = [];
  private path: string | null;
  private session: string;
  private caps: Caps;
  private log: Logger;
  private balance: Record<string, number | null>;
  private now: () => Date;
  // Reserved worst cases for calls in flight, so parallel callers cannot overshoot.
  private reserved: Record<string, number> = {};
  stopped: Record<string, string> = {};

  constructor(opts: { path: string | null; session: string; caps: Caps; log: Logger; now: () => Date; balance?: Record<string, number | null> }) {
    this.path = opts.path; this.session = opts.session; this.caps = opts.caps; this.log = opts.log; this.now = opts.now;
    this.balance = opts.balance ?? {};
    if (this.path && existsSync(this.path)) {
      this.entries = readFileSync(this.path, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as LedgerEntry]; } catch { return []; } });
    }
  }

  spent(provider?: string): number {
    return sessionSpend(this.entries.filter(e => !provider || e.provider === provider), this.session);
  }

  // A 402 or exhausted balance stops paid work for that provider for the rest of the run.
  stop(provider: string, reason: string) {
    if (!this.stopped[provider]) this.log.warn(`paid ${provider} work stopped: ${reason}`);
    this.stopped[provider] = reason;
  }

  async allow(provider: string, worstCaseUsd: number, label: string): Promise<boolean> {
    if (this.stopped[provider]) return false;
    const decision = canSpend({ spent: this.spent(provider) + (this.reserved[provider] ?? 0), capUsd: this.caps[provider] ?? 0, worstCaseUsd, balanceUsd: this.balance[provider] ?? null });
    if (!decision.ok) { this.log.info(`skip paid ${provider} call (${label}): ${decision.reason}`); return false; }
    this.reserved[provider] = (this.reserved[provider] ?? 0) + worstCaseUsd;
    return true;
  }

  async record(entry: Omit<LedgerEntry, "at" | "session">): Promise<void> {
    this.reserved[entry.provider] = Math.max(0, (this.reserved[entry.provider] ?? 0) - entry.worst_case_usd);
    const full: LedgerEntry = { at: this.now().toISOString(), session: this.session, ...entry };
    this.entries.push(full);
    if (this.balance[entry.provider] != null) this.balance[entry.provider] = Math.max(0, (this.balance[entry.provider] ?? 0) - entry.cost_usd);
    if (this.path) { mkdirSync(dirname(this.path), { recursive: true }); appendFileSync(this.path, JSON.stringify(full) + "\n"); }
  }
}
