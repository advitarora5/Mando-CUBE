import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Company, CompanyListItem, Score } from "@/domain/contracts/company";

export async function getCompanies(): Promise<{ companies: CompanyListItem[]; mode: "sample" | "database"; error?: string }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    return { mode: "sample", companies: [
      { id: "sample-a", name: "Example Enterprise A", domain: null, industry: "Manufacturing", headquarters: "Chicago, IL", employee_count: 5200, workday_signal_date: "2026-08-01", source: null, score: null, contacts: [], why_now: "Sample record. Add verified company data and scoring evidence to begin qualification." },
      { id: "sample-b", name: "Example Enterprise B", domain: null, industry: "Professional services", headquarters: "New York, NY", employee_count: 3800, workday_signal_date: null, source: null, score: null, contacts: [], why_now: "Sample record. Workday signal date and buyer contacts still need research." },
    ] };
  }
  try {
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await db.from("companies").select("*, scores(*), company_insights(*), contacts(id, name, title, linkedin_url)");
    if (error) throw error;
    const companies = (data ?? []).map((row) => {
      const scores = row.scores as Score[];
      const latest = scores.sort((a,b) => b.assessed_at.localeCompare(a.assessed_at))[0] ?? null;
      const insight = row.company_insights?.[0];
      return { ...(row as Company), contacts: row.contacts ?? [], score: latest, why_now: insight?.why_now_override ?? insight?.why_now_generated ?? null };
    }).sort((a,b) => (b.score?.total ?? -1) - (a.score?.total ?? -1));
    return { companies, mode: "database" };
  } catch {
    return { companies: [], mode: "database", error: "Database connection failed. Check the server credentials and apply the SQL migration. No sample data is substituted for database errors." };
  }
}
