import { employeeLabel } from "@/data/employee-label";
import Link from "next/link";
import { categories } from "@/domain/contracts/company";
import { safeUrl, type CompanyDetail, type Contact } from "@/domain/contracts/detail";
import { Editor, type Field } from "@/features/company-editor/editor";
import { saveCompany, saveContact, saveInsights } from "@/features/company-editor/actions";

function Source({ value }: { value: string | null }) {
  const url = safeUrl(value);
  return url ? <a className="source-link" href={url} target="_blank" rel="noopener noreferrer">View source ↗</a> : <span className="muted">No source provided</span>;
}
function contactFields(contact?: Contact): Field[] {
  return [
    { name: "name", label: "Name", value: contact?.name ?? "", required: true },
    { name: "title", label: "Title", value: contact?.title ?? "" },
    { name: "linkedin_url", label: "LinkedIn / profile link", value: contact?.linkedin_url ?? "", type: "url" },
    { name: "source", label: "Evidence source link", value: contact?.source ?? "", type: "url" },
    { name: "mutual_connection", label: "Mutual connection", value: contact?.mutual_connection ?? "" },
  ];
}
const labels = { authority: "Functional Authority", reachability: "Reachability & Conviction", budget: "Customer Budget", release: "Workday Release Alignment", timing: "Timing Trigger" };
function ImportedResearch({ evidence }: { evidence: string }) {
  const prefix =
    "Unmapped spreadsheet research; category evidence needs review.\n";

  const researchStart = evidence.indexOf(prefix);
if (researchStart < 0) return null;

  let research: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(evidence.slice(researchStart + prefix.length));

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid research");
    }

    research = parsed as Record<string, unknown>;
  } catch {
    return (
      <section className="panel detail-section">
        <h2>Imported spreadsheet research</h2>
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {evidence}
        </p>
      </section>
    );
  }

  const fields = [
    ["evidence", "Research and sources"],
    ["contact_targets", "Potential buyer contacts"],
    ["estimated_employees", "Employee estimate"],
    ["trigger_event_date", "Original trigger date"],
    ["spreadsheet_tier", "Original spreadsheet tier"],
    ["why_now", "Original why now"],
  ];

  return (
    <section className="panel detail-section">
      <h2>Imported spreadsheet research</h2>
      <p className="muted">
        Original spreadsheet notes. Category evidence and scores await review.
      </p>
      <details>
        <summary>View original research</summary>
        <dl>
          {fields.map(([key, label]) => (
            <div key={key}>
              <dt><strong>{label}</strong></dt>
              <dd style={{
                margin: "8px 0 20px",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}>
                {typeof research[key] === "string" && research[key]
                  ? research[key] as string
                  : "Not provided"}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
export function Detail({ company: c }: { company: CompanyDetail }) {
  const insights = c.insights;
  const days = c.days_since_signal;
  const companyFields: Field[] = [
    { name: "name", label: "Company name", value: c.name, required: true },
    { name: "domain", label: "Domain", value: c.domain, help: "example.com (no https://)" },
    { name: "industry", label: "Industry", value: c.industry },
    { name: "headquarters", label: "Headquarters", value: c.headquarters },
    { name: "employee_count", label: "Employees", value: c.employee_count, type: "number" },
    { name: "workday_signal_date", label: "Workday signal date", value: c.workday_signal_date, type: "date" },
    { name: "source", label: "Company source link", value: c.source, type: "url" },
  ];
  return <main className="detail-page">
    <header><Link href="/">mando <span>/ prospect intelligence</span></Link></header>
    <nav className="breadcrumb"><Link href="/">← Company priorities</Link></nav>
    <section className="detail-heading"><div><p className="eyebrow">COMPANY PROFILE</p><h1>{c.name}</h1><p>{c.industry ?? "Industry pending"} · {c.headquarters ?? "Headquarters pending"}</p></div><div className="score-summary"><strong>{c.score?.total ?? "—"}</strong><span>{c.score?.tier ?? "Unscored"}</span></div></section>
    <aside>{c.score?.tier_reason ?? "No qualification assessment is available yet."}</aside>
    <div className="detail-grid">
      <section className="panel detail-section"><Editor title="Company overview" action={saveCompany} hidden={{ company_id: c.id, updated_at: c.updated_at }} fields={companyFields}>
        <dl className="facts"><div><dt>Domain</dt><dd>{c.domain ?? "Not provided"}</dd></div><div><dt>Employees</dt><dd>{employeeLabel(c.employee_count, c.score?.authority_evidence) ?? "Not provided"}</dd></div><div><dt>Workday signal date</dt><dd>{c.workday_signal_date ?? "Not provided"}</dd></div><div><dt>Days since signal</dt><dd>{days === null ? "Not provided" : days < 0 ? "Signal date is in the future" : `${days} days`}</dd></div></dl><Source value={c.source} />
      </Editor></section>
      <section className="panel detail-section"><Editor title="Buyer insights" action={saveInsights} hidden={{ company_id: c.id, updated_at: insights?.updated_at ?? "" }} fields={[
        { name: "persona_override", label: "Buyer persona", value: insights?.persona_override ?? insights?.persona_generated ?? "", help: "Clear to restore the suggested persona." },
        { name: "level_override", label: "Buyer level", value: insights?.level_override ?? insights?.level_generated ?? "", help: "Clear to restore the suggested level." },
        { name: "why_now_override", label: "Why now", value: insights?.why_now_override ?? insights?.why_now_generated ?? "", type: "textarea", help: "Clear to restore the suggested rationale." },
      ]}>
        <dl className="facts"><div><dt>Buyer persona</dt><dd>{insights?.persona_override ?? insights?.persona_generated ?? "Not generated"}</dd></div><div><dt>Level</dt><dd>{insights?.level_override ?? insights?.level_generated ?? "Not generated"}</dd></div><div className="full-width"><dt>Why now</dt><dd>{insights?.why_now_override ?? insights?.why_now_generated ?? "Not generated"}</dd></div></dl>
      </Editor></section>
    </div>
    <ImportedResearch evidence={c.score?.authority_evidence ?? ""} />
    <section className="panel detail-section"><div className="section-title"><h2>Qualification evidence</h2><span className="muted">{c.score ? `Assessed ${new Date(c.score.assessed_at).toLocaleDateString("en-US", { timeZone: "America/Chicago" })}` : "No assessment yet"}</span></div>
      <div className="evidence-grid">{categories.map(category => {
        const evidence = c.score?.[`${category}_evidence`] ?? "";
        const split = evidence.indexOf(" | ");
        const reason = evidence.startsWith("Unmapped spreadsheet research;")
  ? "Imported research awaits category review."
  : split >= 0
    ? evidence.slice(split + 3)
        .split("\n\nUnmapped spreadsheet research;")[0]
    : evidence;
        return <article className="evidence-card" key={category}><div><h3>{labels[category]}</h3><strong>{c.score?.[`${category}_score`] ?? "—"}</strong></div><p>{reason || "Evidence not provided"}</p><Source value={split >= 0 ? evidence.slice(0, split) : null} /></article>;
      })}</div>
    </section>
    <section className="panel detail-section"><h2>Buyer contacts</h2><div className="contact-grid">{c.contacts.map(contact => <article key={contact.id} className="contact-card"><Editor title={contact.name} action={saveContact} hidden={{ company_id: c.id, id: contact.id }} fields={contactFields(contact)}><p>{contact.title ?? "Title not provided"}</p><p className="muted">{contact.mutual_connection ?? "No mutual connection recorded"}</p><div className="contact-links">{safeUrl(contact.linkedin_url) && <a className="source-link" href={safeUrl(contact.linkedin_url)!} target="_blank" rel="noopener noreferrer">Profile ↗</a>}<Source value={contact.source} /></div></Editor></article>)}</div>
      <div className="add-contact"><Editor title="New contact" label="Add contact" action={saveContact} hidden={{ company_id: c.id, id: "" }} fields={contactFields()}><p className="muted">Add a buyer or influencer and their public source links.</p></Editor></div>
    </section>
  </main>;
}
