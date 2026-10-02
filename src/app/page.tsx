import { getCompanies } from "@/server/repositories/companies";
import Link from "next/link";
import { categories, type Score } from "@/domain/contracts/company";

function safeUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function ScoreCells({ score }: { score: Score | null }) {
  return categories.map(category => {
    const evidence = score?.[`${category}_evidence`] ?? "";
    const separator = evidence.indexOf(" | ");
    const url = safeUrl(separator >= 0 ? evidence.slice(0, separator) : null);
    const reason = separator >= 0 ? evidence.slice(separator + 3) : evidence;
    return <td key={category} className="category-score">
      <strong>{score?.[`${category}_score`] ?? "Unscored"}</strong>
      {reason && <small>{reason}</small>}
      {url && <a className="source-link" href={url} target="_blank" rel="noopener noreferrer">Source ↗</a>}
    </td>;
  });
}
export const dynamic = "force-dynamic";
export default async function Home() {
 const { companies, mode, error } = await getCompanies();
 return <main>
  <header><Link href="/">mando <span>/ prospect intelligence</span></Link><small>Local development</small></header>
  <section className="intro"><p className="eyebrow">ENTERPRISE QUALIFICATION</p><h1>Your next qualified conversation.</h1><p>Research, evidence, and prospect priorities in one shared workspace.</p></section>
  <aside>{mode === "sample" ? "Sample data: fictional, unscored examples. Configure Supabase credentials to connect." : "Supabase configured: live database mode."} Access control is deferred; keep this app local.</aside>
  {error && <p role="alert" className="error">{error}</p>}
  <section className="stats"><article><span>Companies</span><strong>{companies.length}</strong></article><article><span>Scored companies</span><strong>{companies.filter(c=>c.score).length}</strong></article><article><span>Qualified</span><strong>{companies.filter(c=>c.score?.tier === "Qualified").length}</strong></article></section>
  <section className="panel"><div className="panel-heading"><h2>Company priorities</h2><p>Highest scores first. Unscored companies appear last.</p></div><div className="scroll"><table><thead><tr><th>Company</th><th>Employees</th><th>Authority</th><th>Reachability</th><th>Budget</th><th>Release alignment</th><th>Timing trigger</th><th>Total</th><th>Tier</th><th>Why now</th><th>Contacts</th></tr></thead><tbody>{companies.map(c=><tr key={c.id}><td><strong>{c.name}</strong><small>{c.industry ?? "Industry pending"}</small></td><td>{c.employee_count?.toLocaleString() ?? "—"}</td><ScoreCells score={c.score} /><td>{c.score?.total ?? "—"}</td><td>{c.score?.tier ?? "Pending"}</td><td>{c.why_now ?? "Research pending"}</td><td>{c.contacts.length ? c.contacts.map(contact => <div key={contact.id}>{safeUrl(contact.linkedin_url) ? <a className="source-link" href={safeUrl(contact.linkedin_url)!} target="_blank" rel="noopener noreferrer">{contact.name} ↗</a> : contact.name}<small>{contact.title}</small></div>) : "Contacts pending"}</td></tr>)}</tbody></table></div>{!companies.length && !error && <p className="empty">No companies yet. Load verified company data to begin.</p>}</section>
  <footer>Initial scaffold · Editing, CSV import, scoring, and weekly history are next.</footer>
 </main>;
}
