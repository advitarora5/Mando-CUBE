import "server-only";
import { database } from "@/server/db";
import type { CompanyDetail } from "@/domain/contracts/detail";
import type { Score } from "@/domain/contracts/company";
import { applyTierRules } from "@/domain/scoring/tier-rules";

export async function getCompanyDetail(id: string): Promise<CompanyDetail | null> {
  const { data, error } = await database().from("companies")
    .select("*, contacts(*), scores(*), company_insights(*)").eq("id", id).maybeSingle();
  if (error) throw new Error("Could not load this company. Check the database connection and try again.");
  if (!data) return null;
  const saved = (data.scores as Score[]).sort((a, b) => b.assessed_at.localeCompare(a.assessed_at))[0];
  return {
    ...data,
    days_since_signal: data.workday_signal_date ? Math.floor((Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())) - Date.parse(data.workday_signal_date)) / 86400000) : null,
    contacts: data.contacts.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
    score: saved ? applyTierRules(saved) : null,
    insights: (Array.isArray(data.company_insights) ? data.company_insights[0] : data.company_insights) ?? null,
  };
}
