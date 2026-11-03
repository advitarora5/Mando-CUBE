import { requirePageSession } from "@/server/auth/session";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getCompanyDetail } from "@/server/repositories/company-detail";
import { getCompanies } from "@/server/repositories/companies";
import { getSnapshots } from "@/server/repositories/rank-history";
import { getDrafts } from "@/server/repositories/outreach-drafts";
import { getDeltaExplanations } from "@/server/repositories/delta-explanations";
import { Detail } from "@/features/company-detail/detail";
import { AppShell, paletteCompanies } from "@/components/app-shell";
import { companyRanks } from "@/features/company-list/query";
import { baselineWeek, chicagoWeekStart, rankMovement } from "@/domain/history";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // AI draft generation runs as a server action on this page
export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageSession();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [company, snapshots, drafts, list] = await Promise.all([getCompanyDetail(id), getSnapshots(id), getDrafts(id), getCompanies()]);
  if (!company) notFound();
  const rank = companyRanks(list.companies).get(id);
  const week = baselineWeek(snapshots, chicagoWeekStart());
  const movement = week ? rankMovement(rank, snapshots.find(s => s.week_start === week)?.rank) : null;
  const explanation = (await getDeltaExplanations({ companies: list.companies, snapshots, week, only: id }))[id];
  return <AppShell active="record" companies={paletteCompanies(list.companies)}>
    <Detail company={company} snapshots={snapshots} drafts={drafts} rank={rank} movement={movement} explanation={explanation} />
  </AppShell>;
}
