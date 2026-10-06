import "server-only";
import { database } from "@/server/db";
import { requirePageSession } from "@/server/auth/session";
import type { Snapshot } from "@/domain/history";

// Weekly snapshots are optional context: a failure here must not hide the dashboard.
export async function getSnapshots(companyId?: string): Promise<Snapshot[]> {
  await requirePageSession();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return [];
  try {
    const db = database();
    const rows: Snapshot[] = [];
    for (let from = 0; ; from += 1000) {
      let query = db.from("weekly_snapshots").select("week_start, company_id, rank, scores(total)").order("week_start").order("rank").range(from, from + 999);
      if (companyId) query = query.eq("company_id", companyId);
      const { data, error } = await query;
      if (error) throw error;
      for (const row of data ?? []) {
        const score = Array.isArray(row.scores) ? row.scores[0] : row.scores;
        rows.push({ week_start: row.week_start, company_id: row.company_id, rank: row.rank, total: score?.total ?? null });
      }
      if ((data?.length ?? 0) < 1000) return rows;
    }
  } catch {
    return [];
  }
}
