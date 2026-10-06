import { LogoutButton } from "@/features/login/logout";
import { getCompanies } from "@/server/repositories/companies";
import Link from "next/link";
import { getSnapshots } from "@/server/repositories/rank-history";
import { baselineWeek, chicagoWeekStart, previousRanks } from "@/domain/history";
import { CompanyList } from "@/features/company-list/company-list";

export const dynamic = "force-dynamic";
export default async function Home() {
 const { companies, mode, error } = await getCompanies();
 const snapshots = await getSnapshots();
 const week = baselineWeek(snapshots, chicagoWeekStart());
 return <main>
  <header><Link href="/">mando <span>/ prospect intelligence</span></Link><LogoutButton /></header>
  <section className="intro"><p className="eyebrow">ENTERPRISE QUALIFICATION</p><h1>Your next qualified conversation.</h1><p>Research, evidence, and prospect priorities in one shared workspace.</p></section>
  {mode === "sample" && <aside>Sample data: fictional, unscored examples.</aside>}
  {error && <p role="alert" className="error">{error}</p>}
  <section className="stats"><article><span>Companies</span><strong>{companies.length}</strong></article><article><span>Scored companies</span><strong>{companies.filter(c=>c.score).length}</strong></article><article><span>Qualified</span><strong>{companies.filter(c=>c.score?.tier === "Qualified").length}</strong></article></section>
  {!error && <CompanyList companies={companies} mode={mode} previousWeek={week} previousRanks={previousRanks(snapshots, week)} />}
  <footer>Click a company to view its evidence, contacts, and editable insights. <Link href="/methodology">Company research and methodology</Link></footer>
 </main>;
}
