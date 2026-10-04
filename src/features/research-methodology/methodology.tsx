import Link from "next/link";
import data from "@/data/research/workday-companies.json";
import methodology from "@/data/research/methodology.json";
import priorTracker from "@/data/research/prior-tracker-leads.json";

export function ResearchMethodology() {
  const sizeCount = data.companies.filter(c => c.employee_count !== null && c.employee_count >= 3000).length;
  return <main>
    <header><Link href="/">mando <span>/ prospect intelligence</span></Link><small>Research cutoff {methodology.cutoff}</small></header>
    <nav className="breadcrumb"><Link href="/">Dashboard</Link> / Research methodology</nav>
    <section className="intro"><p className="eyebrow">COMPANY RESEARCH</p><h1>{methodology.title}</h1><p>A sourced starting cohort for the shared qualification engine.</p></section>
    <aside>Research records are unscored. Exact HCM go-live dates, active jobs, and mutual connections are unverified. Contact titles describe sourced roles and require current-role review before outreach. This page reads the committed research file, independently of the live database.</aside>
    <section className="stats" aria-label="Research coverage"><article><span>Confirmed HCM companies</span><strong>{data.companies.length}</strong></article><article><span>Sourced contacts</span><strong>{data.contacts.length}</strong></article><article><span>3,000+ workforce snapshots</span><strong>{sizeCount}</strong></article></section>
    {methodology.sections.map(section => <section className="panel detail-section" key={section.title}><h2>{section.title}</h2>{section.paragraphs.map(p => <p key={p} style={{lineHeight: 1.7}}>{p}</p>)}</section>)}
    <section className="panel detail-section"><h2>Earlier tracker: research these leads first</h2>
      <p>The supplied tracker has 16 leads, ordered below by its historical score. Its categories and 70/50 tier thresholds differ from the current dashboard. These are unverified research priorities, outside the 110 confirmed-company cohort; the scores are retained for context and are not current qualification scores.</p>
      <p><a className="source-link" href={priorTracker.source_url} target="_blank" rel="noopener noreferrer">Original tracker ↗</a> · {priorTracker.source_sheet} · checked {priorTracker.source_checked_at}</p>
      <div className="scroll"><table><thead><tr><th scope="col">Prior rank</th><th scope="col">Company lead</th><th scope="col">Legacy score /100</th><th scope="col">Original cells</th></tr></thead><tbody>{priorTracker.leads.map(lead => <tr key={lead.rank}><td>{lead.rank}</td><td>{lead.company_name}<small>Needs primary-source and current-contact review</small></td><td>{lead.legacy_total}</td><td>{lead.source_range}</td></tr>)}</tbody></table></div>
    </section>
    <section className="panel"><div className="panel-heading"><h2>Company research cohort</h2><p>{data.order_basis}</p><p>Expand a row to inspect sources, contacts, entity scope, and open gaps.</p></div>
      {data.companies.map(company => {
        const evidence = data.company_evidence.find(e => e.company_id === company.id)!;
        const contacts = data.contacts.filter(c => c.company_id === company.id);
        return <details key={company.id} style={{padding: "16px 24px", borderTop: "1px solid var(--border)"}}>
          <summary style={{cursor: "pointer"}}>{company.name} · {company.employee_count?.toLocaleString() ?? "Size unverified"}{company.employee_count !== null && " employees (source snapshot)"} · {contacts.length} contact{contacts.length !== 1 && "s"} · Unscored</summary>
          <p>{evidence.confirmation_reason} <a className="source-link" href={company.source} target="_blank" rel="noopener noreferrer">Company evidence ↗</a></p>
          <p>{evidence.employee_count_reason}</p><p className="muted">Scope: {evidence.entity_scope}. Checked {evidence.checked_at}.</p>
          <div className="contact-grid">{contacts.map(contact => {
            const note = data.contact_evidence.find(e => e.contact_id === contact.id)!;
            return <article className="contact-card" key={contact.id}><h3>{contact.name}</h3><p>{contact.title}</p><p className="muted">{note.persona} · {note.reason}</p><div className="contact-links"><a className="source-link" href={contact.linkedin_url} target="_blank" rel="noopener noreferrer">LinkedIn ↗</a><a className="source-link" href={contact.source} target="_blank" rel="noopener noreferrer">Role source ↗</a><a className="source-link" href={note.identity_source} target="_blank" rel="noopener noreferrer">Identity source ↗</a></div><p className="muted">Mutual connection: not verified.</p></article>;
          })}</div>
          <p>Open research gaps:</p><ul>{evidence.research_gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
        </details>;
      })}
    </section><footer>Sources describe reported customer use and roles; verify current facts before qualification or outreach.</footer>
  </main>;
}
