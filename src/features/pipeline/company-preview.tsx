"use client";

import Link from "next/link";
import { Copy, ExternalLink, SquareArrowOutUpRight, X } from "lucide-react";
import type { Category, CompanyListItem } from "@/domain/contracts/company";
import { rankContacts, contactFunction, functionLabel, emailState } from "@/domain/contacts/contact-view";
import { categoryCells } from "@/domain/scoring/view";
import { rubric } from "@/domain/scoring/rubric";
import { leadStatusOf, leadStatusText } from "@/domain/lead-status";
import { safeUrl } from "@/domain/contracts/detail";
import { employeeLabel } from "@/data/employee-label";
import { bullets, formatDate } from "@/domain/text";
import { TierChip, ScoreBar } from "@/components/score";
import { EvidenceCards } from "@/components/evidence";
import { Avatar, ChannelIcons } from "@/components/channels";
import { TabBar } from "@/components/tabs";
import { useCopy } from "@/components/toast";
import { Delta } from "./delta";
import type { DeltaExplanation } from "@/domain/delta-explanation";
import type { Movement } from "@/domain/history";

export type PanelTab = "overview" | "contacts" | "evidence";

export function CompanyPreview({ company: c, rank, movement, explanation, tab, focus, onTab, onClose, linkable }: {
  company: CompanyListItem; rank: number | undefined; movement: Movement | null; explanation?: DeltaExplanation; tab: PanelTab; focus: Category | null;
  onTab: (tab: PanelTab, focus?: Category | null) => void; onClose: () => void; linkable: boolean;
}) {
  const copy = useCopy();
  const contacts = rankContacts(c.contacts);
  const emails = contacts.filter(k => k.email && emailState(k) !== "invalid").map(k => k.email!);
  const why = bullets(c.why_now);
  const employees = employeeLabel(c.employee_count, c.score?.authority_evidence);
  const source = safeUrl(c.source);

  const overview = <div className="stack">
    {explanation && <section aria-label="Why the rank changed">
      <p className="ev-label">Why the rank changed</p>
      <p className="delta-summary">{explanation.summary}</p>
      {explanation.reasons.length > 0 && <ul className="bullets">{explanation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    </section>}
    <section>
      <p className="ev-label">Why now</p>
      {why.items.length ? <ul className="bullets">{why.items.map(item => <li key={item}>{item}</li>)}</ul> : <p className="muted">No why-now rationale recorded yet.</p>}
      {why.rest > 0 && linkable && <p className="muted" style={{ marginTop: 6 }}><Link href={`/companies/${c.id}`}>Read the full rationale</Link></p>}
    </section>
    <section>
      <p className="ev-label">Score breakdown</p>
      <div className="mini-scores">{categoryCells(c.score).map(cell => <button key={cell.category} type="button" className="mini-score" onClick={() => onTab("evidence", cell.category)}>
        <span>{rubric[cell.category].label}</span>
        {cell.points === null ? <span className="empty-cell">—</span> : cell.needsEvidence ? <span className="chip needs" style={{ justifySelf: "end", gridColumn: "2 / 4" }}>Needs evidence</span>
          : <><ScoreBar points={cell.points} max={cell.max} /><span className="n">{cell.points}<small> / {cell.max}</small></span></>}
      </button>)}</div>
    </section>
    <section>
      <p className="ev-label">Key facts</p>
      <dl className="kv">
        <dt>Industry</dt><dd>{c.industry ?? <span className="faint">Not recorded</span>}</dd>
        <dt>Employees</dt><dd>{employees ?? <span className="faint">Not recorded</span>}</dd>
        <dt>Headquarters</dt><dd>{c.headquarters ?? <span className="faint">Not recorded</span>}</dd>
        <dt>Workday signal</dt><dd>{formatDate(c.workday_signal_date) ?? <span className="faint">Not recorded</span>}</dd>
        <dt>Lead status</dt><dd>{leadStatusOf(c) ? leadStatusText(c) : <span className="faint">Not tracked</span>}</dd>
        <dt>Website</dt><dd>{c.domain ? <a href={`https://${c.domain}`} target="_blank" rel="noopener noreferrer">{c.domain}</a> : <span className="faint">Not recorded</span>}</dd>
      </dl>
    </section>
  </div>;

  const contactPanel = contacts.length ? <div className="card"><div className="contact-list">{contacts.map((k, i) => <div className="contact-row" key={k.id}>
    <div className="person"><Avatar name={k.name} large /><div className="person-text"><strong>{k.name}</strong><small>{k.title ?? "Title not recorded"}</small>
      <div className="contact-tags">{i === 0 && <span className="role-tag primary">Top contact</span>}<span className="role-tag">{functionLabel[contactFunction(k.title)]}</span></div></div></div>
    <ChannelIcons contact={k} tipPosition="left" />
  </div>)}</div></div>
    : <div className="empty-state"><strong>No contacts yet</strong><span>Add the HRIS, HR or enterprise-applications owner on the full record.</span>{linkable && <Link className="btn" href={`/companies/${c.id}#contacts`}>Open contacts</Link>}</div>;

  return <>
    <div className="sheet-head">
      <div className="sheet-top">
        <div className="sheet-title">
          <h2 id="sheet-title">{c.name}</h2>
          <p>{[c.industry, employees && `${employees} employees`].filter(Boolean).join(" · ") || "Industry not recorded"}</p>
        </div>
        <div className="sheet-score"><strong>{c.score?.total ?? "—"}</strong><small>/ 100</small></div>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close panel (Esc)" data-tip="Close (Esc)" data-tip-pos="left"><X aria-hidden /></button>
      </div>
      <div className="sheet-meta">
        <TierChip score={c.score} />
        <span className="chip neutral">{rank ? `Rank ${rank}` : "Unranked"}</span>
        <Delta movement={movement} />
      </div>
      <TabBar<PanelTab> idPrefix="sheet" value={tab} onChange={id => onTab(id)} items={[
        { id: "overview", label: "Overview" },
        { id: "contacts", label: "Contacts", count: contacts.length },
        { id: "evidence", label: "Score evidence" },
      ]} />
    </div>
    <div className="sheet-body" id="sheet-panel" role="tabpanel" aria-labelledby={`sheet-${tab}`}>
      {tab === "overview" && overview}
      {tab === "contacts" && contactPanel}
      {tab === "evidence" && <EvidenceCards score={c.score} focus={focus} />}
    </div>
    <div className="sheet-foot">
      {linkable && <Link className="btn btn-primary" href={`/companies/${c.id}`}><SquareArrowOutUpRight aria-hidden />Open full record</Link>}
      <button type="button" className="btn" disabled={!emails.length} onClick={() => copy(emails.join(", "), `${emails.length} email${emails.length === 1 ? "" : "s"}`)}><Copy aria-hidden />Copy emails</button>
      {source && <a className="btn" href={source} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden />Open source</a>}
    </div>
  </>;
}
