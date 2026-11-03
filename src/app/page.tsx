import { getCompanies } from "@/server/repositories/companies";
import { getSnapshots } from "@/server/repositories/rank-history";
import { baselineWeek, chicagoWeekStart, previousRanks } from "@/domain/history";
import { getDeltaExplanations } from "@/server/repositories/delta-explanations";
import { Pipeline } from "@/features/pipeline/pipeline";
import { AppShell, paletteCompanies } from "@/components/app-shell";

export const dynamic = "force-dynamic";
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ companies, mode, error }, snapshots, params] = await Promise.all([getCompanies(), getSnapshots(), searchParams]);
  const week = baselineWeek(snapshots, chicagoWeekStart());
  const explanations = await getDeltaExplanations({ companies, snapshots, week });
  const previousCount = week ? new Set(snapshots.filter(s => s.week_start === week).map(s => s.company_id)).size : null;
  const query = new URLSearchParams(Object.entries(params).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : [])).toString();
  return <AppShell active="pipeline" companies={paletteCompanies(companies)}>
    {mode === "sample" && <p className="active-filters" role="note">Sample data: fictional, unscored examples. Connect the database to see real companies.</p>}
    {error ? <div className="empty-state" role="alert"><strong>Could not load companies</strong><span>{error}</span></div>
      : <Pipeline key={query} companies={companies} mode={mode} previousWeek={week} previousRanks={previousRanks(snapshots, week)} previousCompanyCount={previousCount} initialQuery={query} explanations={explanations} />}
  </AppShell>;
}
