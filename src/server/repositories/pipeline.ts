import { requirePageSession } from "@/server/auth/session";
import "server-only";
import { database } from "@/server/db";

// Read-only queries for the ingestion pipeline, for whichever dashboard view shows them (no UI here).
// Each returns data plus an error message instead of throwing, so a page still renders.

export type PipelineHealth = {
  last_run_at: string | null;
  last_run_status: string | null;
  new_companies_7d: number;
  review_queue_pending: number;
  dead_letters: number;
  spend_usd_7d: number;
  alerts: { source_id: string; failed_runs: number; empty_runs: number }[];
};

export async function getPipelineHealth(): Promise<{ health: PipelineHealth | null; error?: string }> {
  await requirePageSession();
  try {
    const db = database();
    const [health, alerts] = await Promise.all([db.from("pipeline_health").select("*").single(), db.from("source_alerts").select("*")]);
    if (health.error) throw health.error;
    if (alerts.error) throw alerts.error;
    return { health: { ...(health.data as Omit<PipelineHealth, "alerts">), alerts: alerts.data ?? [] } };
  } catch (error) {
    return { health: null, error: error instanceof Error ? error.message : "Could not load pipeline health." };
  }
}

export type ReviewQueueItem = {
  id: string;
  candidate_name: string;
  candidate_domain: string | null;
  reason: "similar_name" | "no_website" | "untrusted_signal" | "over_run_cap";
  suggested_company_id: string | null;
  created_at: string;
  signals: { type: string; source_url: string; quote: string; signal_date: string | null }[];
};

export async function getReviewQueue(): Promise<{ items: ReviewQueueItem[]; error?: string }> {
  await requirePageSession();
  try {
    const { data, error } = await database().from("review_queue")
      .select("id, candidate_name, candidate_domain, reason, suggested_company_id, created_at, signals(type, source_url, quote, signal_date)")
      .eq("status", "pending").order("created_at", { ascending: false });
    if (error) throw error;
    return { items: (data ?? []) as ReviewQueueItem[] };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : "Could not load the review queue." };
  }
}

// Ready-for-contacts flag per company (Budget + Release + Timing at or above the configured threshold).
export async function getContactReadiness(): Promise<{ ready: Record<string, boolean>; error?: string }> {
  await requirePageSession();
  try {
    const { data, error } = await database().from("company_contact_readiness").select("company_id, ready_for_contacts");
    if (error) throw error;
    return { ready: Object.fromEntries((data ?? []).map(r => [r.company_id as string, !!r.ready_for_contacts])) };
  } catch (error) {
    return { ready: {}, error: error instanceof Error ? error.message : "Could not load contact readiness." };
  }
}
