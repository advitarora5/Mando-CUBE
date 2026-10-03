import { getCompanies } from "@/server/repositories/companies";
import Link from "next/link";
import { CompanyList } from "@/features/company-list/company-list";

export const dynamic = "force-dynamic";
export default async function Home() {
 const { companies, mode, error } = await getCompanies();
 return <main>
  <header><Link href="/">mando <span>/ prospect intelligence</span></Link></header>
  <section className="intro"><p className="eyebrow">ENTERPRISE QUALIFICATION</p><h1>Your next qualified conversation.</h1><p>Research, evidence, and prospect priorities in one shared workspace.</p></section>
  {mode === "sample" && <aside>Sample data: fictional, unscored examples.</aside>}
  {error && <p role="alert" className="error">{error}</p>}
  <section className="stats"><article><span>Companies</span><strong>{companies.length}</strong></article><article><span>Scored companies</span><strong>{companies.filter(c=>c.score).length}</strong></article><article><span>Qualified</span><strong>{companies.filter(c=>c.score?.tier === "Qualified").length}</strong></article></section>
  {!error && <CompanyList companies={companies} mode={mode} />}
  <footer>Click a company to view its evidence, contacts, and editable insights.</footer>
 </main>;
}
