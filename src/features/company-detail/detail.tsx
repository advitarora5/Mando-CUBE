import Link from "next/link";
import { Fragment } from "react";
import { ChevronRight, ExternalLink, Globe, TriangleAlert, Users } from "lucide-react";
import { employeeLabel } from "@/data/employee-label";
import { categories } from "@/domain/contracts/company";
import { safeUrl, type CompanyDetail, type Contact } from "@/domain/contracts/detail";
import { Editor, type Field } from "@/features/company-editor/editor";
import { WeeklyHistory } from "@/features/weekly-history/history";
import type { Movement, Snapshot } from "@/domain/history";
import type { DeltaExplanation } from "@/domain/delta-explanation";
import { ContactDrafts } from "@/features/outreach/drafts";
import type { StoredDraft } from "@/server/repositories/outreach-drafts";
import { saveCompany, saveContact, saveInsights, saveLeadStatus } from "@/features/company-editor/actions";
import { leadStatuses, leadStatusLabels, leadStatusOf, leadStatusText } from "@/domain/lead-status";
import { goLiveScore } from "@/domain/scoring/go-live";
import { rubric } from "@/domain/scoring/rubric";
import { parseEvidenceDetail } from "@/domain/scoring/evidence-detail";
import { categoryCells } from "@/domain/scoring/view";
import { contactFunction, contactProvenance, emailLabel, emailState, functionLabel, reachSummary } from "@/domain/contacts/contact-view";
import { bullets, formatDate } from "@/domain/text";
import { TierChip, ScoreBar } from "@/components/score";
import { EvidenceCards, SourceChip } from "@/components/evidence";
import { Avatar, ChannelIcons } from "@/components/channels";
import { Tabs } from "@/components/tabs";
import { CopyButton } from "@/components/copy-button";
import { Delta } from "@/features/pipeline/delta";

function contactFields(contact?: Contact): Field[] {
  return [
    { name: "name", label: "Name", value: contact?.name ?? "", required: true },
    { name: "title", label: "Title", value: contact?.title ?? "" },
    { name: "linkedin_url", label: "LinkedIn / profile link", value: contact?.linkedin_url ?? "", type: "url" },
    { name: "source", label: "Evidence source link", value: contact?.source ?? "", type: "url" },
    { name: "mutual_connection", label: "Mutual connection", value: contact?.mutual_connection ?? "" },
    { name: "email", label: "Work email", value: contact?.email ?? "", type: "email" },
    { name: "email_verified", label: "Email verified", value: contact?.email_verified ? "on" : "", type: "checkbox", help: "Only for emails you confirmed. Needs an email." },
    { name: "email_source", label: "Email source link", value: contact?.email_source ?? "", type: "url" },
    { name: "phone", label: "Phone", value: contact?.phone ?? "", type: "tel" },
    { name: "phone_source", label: "Phone source link", value: contact?.phone_source ?? "", type: "url" },
  ];
}

const missing = <span className="faint">Not recorded</span>;

function ImportedResearch({ evidence }: { evidence: string }) {
  const prefix = "Unmapped spreadsheet research; category evidence needs review.\n";
  const start = evidence.indexOf(prefix);
  if (start < 0) return null;
  let research: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(evidence.slice(start + prefix.length));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) research = parsed as Record<string, unknown>;
  } catch { research = null; }
  const fields = [["evidence", "Research and sources"], ["contact_targets", "Potential buyer contacts"], ["estimated_employees", "Employee estimate"], ["trigger_event_date", "Original trigger date"], ["spreadsheet_tier", "Original spreadsheet tier"], ["why_now", "Original why now"]];
  return <section className="card">
    <div className="card-head"><h2>Imported spreadsheet research</h2><span className="muted">Original notes; category evidence awaits review</span></div>
    <div className="card-body"><details className="raw"><summary>View original research</summary>
      {research ? <dl className="kv" style={{ marginTop: 10 }}>{fields.map(([key, label]) => <Fragment key={key}><dt>{label}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{typeof research![key] === "string" && research![key] ? research![key] as string : missing}</dd></Fragment>)}</dl>
        : <pre>{evidence}</pre>}
    </details></div>
  </section>;
}

function ContactRow({ contact, primary, companyId, drafts }: { contact: Contact; primary: boolean; companyId: string; drafts: StoredDraft[] }) {
  const role = contactFunction(contact.title);
  const state = emailState(contact);
  const sources = contactProvenance(contact.contact_sources);
  const profile = safeUrl(contact.linkedin_url);
  const candidate = safeUrl(sources.linkedinCandidate);
  const sent = drafts.filter(d => d.sent_at).map(d => d.sent_at!).sort().at(-1);
  const stateChip = state === "verified" ? "ok" : state === "invalid" ? "err" : state === "risky" || state === "unverified" ? "warn" : "neutral";
  return <div className="contact-row">
    <div className="person" style={{ alignItems: "flex-start" }}><Avatar name={contact.name} large />
      <div className="person-text"><strong>{contact.name}</strong><small>{contact.title ?? "Title not recorded"}</small>
        <div className="contact-tags">
          {primary && <span className="role-tag primary">Top contact</span>}
          <span className="role-tag">{functionLabel[role]}</span>
          <span className={`chip ${sent ? "info" : "neutral"}`}>{sent ? `Contacted ${formatDate(sent, { month: "short", day: "numeric" })}` : "Not contacted"}</span>
        </div>
      </div>
    </div>
    <ChannelIcons contact={contact} tipPosition="left" />
    <div className="contact-detail">
      <div className="contact-line">
        {contact.email ? <span><a href={`mailto:${contact.email}`}>{contact.email}</a> <span className={`chip ${stateChip}`}>{emailLabel(contact)}</span></span> : <span className="faint">{emailLabel(contact)}</span>}
        {profile ? <a href={profile} target="_blank" rel="noopener noreferrer">LinkedIn profile</a> : candidate ? <span><a href={candidate} target="_blank" rel="noopener noreferrer">Possible LinkedIn</a> <span className="chip warn">Unconfirmed</span></span> : <span className="faint">{contact.linkedin_status === "not_found" ? "LinkedIn not found" : "No LinkedIn"}</span>}
        {contact.phone ? <a href={`tel:${contact.phone}`}>{contact.phone}</a> : <span className="faint">No phone</span>}
      </div>
      {sources.flags.map(flag => <p key={flag} className="contact-flag"><TriangleAlert aria-hidden />{flag}</p>)}
      <div className="contact-line">
        {contact.mutual_connection ? <span>Mutual: {contact.mutual_connection}</span> : <span className="faint">No mutual connection</span>}
        {safeUrl(contact.source) && <SourceChip url={contact.source!} />}
        {safeUrl(contact.email_source) && <SourceChip url={contact.email_source!} />}
        {(sources.emailSource || sources.emailVerification || sources.providerTitle || sources.companyLine || contact.enriched_at) && <details className="raw"><summary>Verification details</summary>
          <dl className="kv" style={{ marginTop: 8 }}>
            {sources.emailSource && <><dt>Email found by</dt><dd>{sources.emailSource}</dd></>}
            {sources.emailVerification && <><dt>Verification</dt><dd>{sources.emailVerification}</dd></>}
            {sources.linkedinNote && <><dt>LinkedIn</dt><dd>{sources.linkedinNote}</dd></>}
            {sources.providerTitle && <><dt>Title per provider</dt><dd>{sources.providerTitle}</dd></>}
            {sources.companyLine && <><dt>Company line</dt><dd><a href={`tel:${sources.companyLine}`}>{sources.companyLine}</a></dd></>}
            {contact.enriched_at && <><dt>Enriched</dt><dd>{formatDate(contact.enriched_at)}</dd></>}
          </dl></details>}
        <Editor title="" label="Edit" action={saveContact} hidden={{ company_id: companyId, id: contact.id }} fields={contactFields(contact)}>{null}</Editor>
      </div>
    </div>
  </div>;
}

export function Detail({ company: c, snapshots = [], drafts = [], rank, movement, explanation }: { company: CompanyDetail; snapshots?: Snapshot[]; drafts?: StoredDraft[]; rank?: number; movement?: Movement | null; explanation?: DeltaExplanation }) {
  const insights = c.insights;
  const days = c.days_since_signal;
  const goLive = goLiveScore(c.workday_signal_date);
  const why = insights?.why_now_override ?? insights?.why_now_generated ?? null;
  const whyBullets = bullets(why, 3);
  const employees = employeeLabel(c.employee_count, c.score?.authority_evidence);
  const reach = reachSummary(c.contacts);
  const emails = c.contacts.filter(k => k.email && emailState(k) !== "invalid").map(k => k.email!);
  const source = safeUrl(c.source);
  const release = parseEvidenceDetail(c.score?.release_evidence);
  const timing = parseEvidenceDetail(c.score?.timing_evidence);
  const companyFields: Field[] = [
    { name: "name", label: "Company name", value: c.name, required: true },
    { name: "domain", label: "Domain", value: c.domain, help: "example.com (no https://)" },
    { name: "industry", label: "Industry", value: c.industry },
    { name: "headquarters", label: "Headquarters", value: c.headquarters },
    { name: "employee_count", label: "Employees", value: c.employee_count, type: "number" },
    { name: "workday_signal_date", label: "Workday signal date", value: c.workday_signal_date, type: "date" },
    { name: "source", label: "Company source link", value: c.source, type: "url" },
  ];
  const activity = [
    c.score && { when: c.score.assessed_at, what: `Assessed: ${c.score.total}/100` },
    c.contacted_at && { when: c.contacted_at, what: "Marked contacted" },
    c.replied_at && { when: c.replied_at, what: "Replied" },
    c.demo_booked_at && { when: c.demo_booked_at, what: "Demo booked" },
    ...drafts.filter(d => d.sent_at).map(d => ({ when: d.sent_at!, what: `${d.channel === "email" ? "Email" : "LinkedIn message"} sent to ${c.contacts.find(k => k.id === d.contact_id)?.name ?? "a contact"}` })),
  ].filter((e): e is { when: string; what: string } => !!e).sort((a, b) => b.when.localeCompare(a.when));

  const overview = <div className="grid-2">
    <div className="stack">
      {explanation && <section className="card" aria-labelledby="delta-why"><div className="card-head"><h2 id="delta-why">Why the rank changed</h2></div><div className="card-body">
        <p className="delta-summary">{explanation.summary}</p>
        {explanation.reasons.length > 0 && <ul className="bullets">{explanation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
        <p className="muted">Compared with the assessment behind last week&apos;s rank.</p>
      </div></section>}
      <section className="card"><div className="card-head"><h2>Why now</h2></div><div className="card-body">
        {whyBullets.items.length ? <ul className="bullets">{whyBullets.items.map(item => <li key={item}>{item}</li>)}</ul> : <p className="muted">No why-now rationale yet. Add one under Buyer insights.</p>}
        {whyBullets.rest > 0 && <details className="raw" style={{ marginTop: 8 }}><summary>Show full rationale</summary><pre>{why}</pre></details>}
        {source && <div className="src-row" style={{ marginTop: 10 }}><SourceChip url={source} /></div>}
      </div></section>
      <section className="card"><div className="card-body"><Editor title="Buyer insights" action={saveInsights} hidden={{ company_id: c.id, updated_at: insights?.updated_at ?? "" }} fields={[
        { name: "persona_override", label: "Buyer persona", value: insights?.persona_override ?? insights?.persona_generated ?? "", help: "Clear to restore the suggested persona." },
        { name: "level_override", label: "Buyer level", value: insights?.level_override ?? insights?.level_generated ?? "", help: "Clear to restore the suggested level." },
        { name: "why_now_override", label: "Why now", value: insights?.why_now_override ?? insights?.why_now_generated ?? "", type: "textarea", help: "Clear to restore the suggested rationale." },
      ]}>
        <dl className="kv"><dt>Buyer persona</dt><dd>{insights?.persona_override ?? insights?.persona_generated ?? missing}</dd><dt>Buyer level</dt><dd>{insights?.level_override ?? insights?.level_generated ?? missing}</dd></dl>
      </Editor></div></section>
    </div>
    <div className="stack">
      <section className="card"><div className="card-head"><h2>Score</h2><a href="#evidence" className="muted">View evidence</a></div><div className="card-body">
        <div className="mini-scores">{categoryCells(c.score).map(cell => <a key={cell.category} href="#evidence" className="mini-score" style={{ color: "inherit", textDecoration: "none" }}>
          <span>{rubric[cell.category].label}</span>
          {cell.points === null ? <span className="empty-cell" style={{ gridColumn: "2 / 4", justifySelf: "end" }}>—</span> : cell.needsEvidence ? <span className="chip needs" style={{ gridColumn: "2 / 4", justifySelf: "end" }}>Needs evidence</span>
            : <><ScoreBar points={cell.points} max={cell.max} /><span className="n">{cell.points}<small> / {cell.max}</small></span></>}
        </a>)}</div>
        {c.score?.tier_reason && <p className="muted" style={{ marginTop: 12 }}>{c.score.tier_reason}</p>}
      </div></section>
      <section className="card"><div className="card-body"><Editor title="Key facts" action={saveCompany} hidden={{ company_id: c.id, updated_at: c.updated_at }} fields={companyFields}>
        <dl className="kv">
          <dt>Website</dt><dd>{c.domain ? <a href={`https://${c.domain}`} target="_blank" rel="noopener noreferrer">{c.domain}</a> : missing}</dd>
          <dt>Industry</dt><dd>{c.industry ?? missing}</dd>
          <dt>Headquarters</dt><dd>{c.headquarters ?? missing}</dd>
          <dt>Employees</dt><dd>{employees ?? missing}</dd>
          <dt>Workday signal</dt><dd>{formatDate(c.workday_signal_date) ?? missing}</dd>
        </dl>
      </Editor></div></section>
    </div>
  </div>;

  const contactsTab = <div className="stack">
    <section className="card">
      <div className="card-head"><h2>Buyer contacts</h2><span className="muted num">{reach.total} contacts · {reach.verified} verified email · {reach.linkedin} LinkedIn · {reach.phone} phone</span></div>
      {c.contacts.length ? <div className="contact-list">{c.contacts.map((contact, i) => <ContactRow key={contact.id} contact={contact} primary={i === 0} companyId={c.id} drafts={drafts.filter(d => d.contact_id === contact.id)} />)}</div>
        : <div className="empty-state"><Users aria-hidden /><strong>No contacts yet</strong><span>Add the HRIS, HR or enterprise-applications owner and their public source link.</span></div>}
    </section>
    <section className="card"><div className="card-body"><Editor title="Add a contact" label="Add contact" action={saveContact} hidden={{ company_id: c.id, id: "" }} fields={contactFields()}><p className="muted">Add a buyer or influencer with public source links.</p></Editor></div></section>
  </div>;

  const evidenceTab = <div className="stack">
    <div className="section-title" style={{ marginBottom: 0 }}><span className="muted">{c.score ? `Assessed ${formatDate(c.score.assessed_at)} · rubric ${c.score.rubric_version}` : "Not assessed yet"}</span></div>
    <EvidenceCards score={c.score} focus={null} />
    <ImportedResearch evidence={c.score?.authority_evidence ?? ""} />
  </div>;

  const signalsTab = <div className="grid-2">
    <section className="card"><div className="card-head"><h2>Workday timing</h2></div><div className="card-body">
      <dl className="kv">
        <dt>Signal date</dt><dd>{formatDate(c.workday_signal_date) ?? missing}</dd>
        <dt>Days since signal</dt><dd>{days === null ? missing : days < 0 ? `In ${-days} days` : `${days} days`}</dd>
        <dt>Go-live band</dt><dd>{goLive.score} / {rubric.timing.weight} · {goLive.reason}</dd>
        <dt>Timing evidence</dt><dd>{timing.reason || missing}</dd>
        <dt>Release evidence</dt><dd>{release.reason || missing}</dd>
      </dl>
    </div></section>
    <section className="card"><div className="card-head"><h2>Sources</h2></div><div className="card-body"><div className="src-row">
      {source && <SourceChip url={source} />}
      {categories.map(cat => parseEvidenceDetail(c.score?.[`${cat}_evidence`]).source).filter((u, i, all): u is string => !!u && all.indexOf(u) === i).map(u => <SourceChip key={u} url={u} />)}
      {!source && !c.score && <span className="muted">No sources recorded.</span>}
    </div></div></section>
  </div>;

  const outreachTab = <div className="grid-2">
    <div className="stack">{c.contacts.length ? c.contacts.map(contact => <section className="card" key={contact.id}>
      <div className="card-head"><div className="person"><Avatar name={contact.name} /><div className="person-text"><strong>{contact.name}</strong><small>{contact.title ?? "Title not recorded"}</small></div></div><ChannelIcons contact={contact} tipPosition="left" /></div>
      <div className="card-body"><ContactDrafts drafts={drafts.filter(d => d.contact_id === contact.id)} contactId={contact.id} companyId={c.id} email={contact.email} linkedinUrl={contact.linkedin_url} /></div>
    </section>) : <div className="card empty-state"><strong>No contacts to message yet</strong><span>Add a contact first; drafts appear here once generated.</span></div>}</div>
    <section className="card"><div className="card-body"><Editor title="Lead status" action={saveLeadStatus} hidden={{ company_id: c.id, updated_at: c.updated_at, previous_status: c.lead_status }} fields={[{ name: "lead_status", label: "Status", type: "select", value: c.lead_status, options: leadStatuses.map(status => ({ value: status, label: leadStatusLabels[status] })), help: "Sending a draft marks the lead contacted automatically." }]}>
      <dl className="kv"><dt>Status</dt><dd>{leadStatusOf(c) ? <span className="chip info">{leadStatusText(c)}</span> : <span className="faint">Not tracked — lead status is not stored in this database yet</span>}</dd>
        <dt>Contacted</dt><dd>{formatDate(c.contacted_at) ?? <span className="faint">Not yet</span>}</dd>
        <dt>Replied</dt><dd>{formatDate(c.replied_at) ?? <span className="faint">Not yet</span>}</dd>
        <dt>Demo booked</dt><dd>{formatDate(c.demo_booked_at) ?? <span className="faint">Not yet</span>}</dd></dl>
    </Editor></div></section>
  </div>;

  const activityTab = <div className="grid-2">
    <section className="card"><div className="card-head"><h2>Activity</h2></div><div className="card-body">
      {activity.length ? <ul className="timeline">{activity.map((e, i) => <li key={i}><span className="when">{formatDate(e.when)}</span><span>{e.what}</span></li>)}</ul> : <p className="muted">No activity recorded yet.</p>}
    </div></section>
    <WeeklyHistory snapshots={snapshots} />
  </div>;

  return <div className="record">
    <nav className="crumbs" aria-label="Breadcrumb"><Link href="/">Pipeline</Link><ChevronRight aria-hidden /><span aria-current="page">{c.name}</span></nav>
    <header className="record-head">
      <div className="record-id">
        <h1>{c.name}</h1>
        <div className="record-sub">
          {c.domain ? <a href={`https://${c.domain}`} target="_blank" rel="noopener noreferrer"><Globe aria-hidden style={{ width: 13, height: 13, verticalAlign: "-2px", marginRight: 4 }} />{c.domain}</a> : <span>No website recorded</span>}
          <span className="sep">·</span><span>{c.industry ?? "Industry not recorded"}</span>
          {c.headquarters && <><span className="sep">·</span><span>{c.headquarters}</span></>}
          {employees && <><span className="sep">·</span><span className="num">{employees} employees</span></>}
        </div>
        <div className="record-actions">
          <CopyButton text={emails.join(", ")} label={`${emails.length} email${emails.length === 1 ? "" : "s"}`} disabled={!emails.length}>Copy contacts</CopyButton>
          <a className="btn" href="#outreach">Outreach</a>
          {source && <a className="btn" href={source} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden />Open source</a>}
        </div>
      </div>
      <div className="record-score">
        <div className="stack" style={{ gap: 6, justifyItems: "end" }}><TierChip score={c.score} /><span className="muted num">{rank ? `Rank ${rank}` : "Unranked"} <Delta movement={movement ?? null} current={rank} note={explanation?.summary} /></span></div>
        <div className="record-total"><strong>{c.score?.total ?? "—"}</strong><small>of 100</small></div>
      </div>
    </header>
    <Tabs hash idPrefix="record" className="record-tabs" items={[
      { id: "overview", label: "Overview", content: <div className="record-panel">{overview}</div> },
      { id: "contacts", label: "Contacts", count: c.contacts.length, content: <div className="record-panel">{contactsTab}</div> },
      { id: "evidence", label: "Score evidence", content: <div className="record-panel">{evidenceTab}</div> },
      { id: "signals", label: "Signals", content: <div className="record-panel">{signalsTab}</div> },
      { id: "outreach", label: "Outreach", count: drafts.length, content: <div className="record-panel">{outreachTab}</div> },
      { id: "activity", label: "Activity", content: <div className="record-panel">{activityTab}</div> },
    ]} />
  </div>;
}
