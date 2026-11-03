import { z } from "zod";
import type { Score } from "@/domain/contracts/company";

// Mirrors the pipeline_settings rows seeded by supabase/migrations/202610120001_ingestion_foundation.sql.
// The database is the source of truth; these defaults apply only to keys missing from it.
export const settingsSchema = z.object({
  scoring_scope: z.enum(["pipeline_only", "all"]),
  ready_for_contacts_threshold: z.number().min(0).max(50),
  signal_fresh_days: z.number().int().positive(),
  min_request_delay_ms: z.number().int().min(0),
  max_requests_per_run: z.number().int().positive(),
  max_llm_spend_usd_per_run: z.number().min(0),
  max_new_companies_per_run: z.number().int().min(0),
}).strict();

export type PipelineSettings = z.infer<typeof settingsSchema>;

export const defaultSettings: PipelineSettings = {
  scoring_scope: "pipeline_only",
  ready_for_contacts_threshold: 25,
  signal_fresh_days: 14,
  min_request_delay_ms: 1000,
  max_requests_per_run: 2000,
  max_llm_spend_usd_per_run: 1,
  max_new_companies_per_run: 50,
};

// Builds settings from pipeline_settings rows. Unknown keys and invalid values throw rather than run uncapped.
export function parseSettings(rows: { key: string; value: unknown }[]): PipelineSettings {
  return settingsSchema.parse({ ...defaultSettings, ...Object.fromEntries(rows.map(row => [row.key, row.value])) });
}

// While scope is pipeline_only, a matched existing company only receives signals; its scores are left alone.
export function mayScore(settings: PipelineSettings, pipelineCreated: boolean): boolean {
  return settings.scoring_scope === "all" || pipelineCreated;
}

// Same rule as the company_contact_readiness view.
export function readyForContacts(score: Pick<Score, "budget_score" | "release_score" | "timing_score">, settings: PipelineSettings): boolean {
  return score.budget_score + score.release_score + score.timing_score >= settings.ready_for_contacts_threshold;
}

// Every signal type expires signal_fresh_days after it was last seen, unless a collector sees it again.
// Go-live is the exception: its score follows the go-live date bands instead.
export const expiringSignalTypes = ["hiring", "release_planning", "known_customer", "budget_clue", "event"] as const;

export function isSignalFresh(signal: { type: string; last_seen_at: string }, settings: PipelineSettings, now: Date = new Date()): boolean {
  if (!(expiringSignalTypes as readonly string[]).includes(signal.type)) return true;
  return now.getTime() - Date.parse(signal.last_seen_at) <= settings.signal_fresh_days * 86400000;
}
