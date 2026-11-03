"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, BadgeCheck, Bookmark, CircleHelp, Columns3, Copy, Download, Search, SquareArrowOutUpRight, CalendarClock, X, SearchX } from "lucide-react";
import { categories, type Category, type CompanyListItem } from "@/domain/contracts/company";
import { rankMovement } from "@/domain/history";
import type { DeltaExplanation } from "@/domain/delta-explanation";
import { rankContacts, emailState } from "@/domain/contacts/contact-view";
import { categoryCells, shortLabel } from "@/domain/scoring/view";
import { rubric } from "@/domain/scoring/rubric";
import { leadStatusOf, leadStatusText } from "@/domain/lead-status";
import { employeeLabel } from "@/data/employee-label";
import { formatDate } from "@/domain/text";
import { companyRanks } from "@/features/company-list/query";
import { ScoreCell, TierChip } from "@/components/score";
import { Avatar, ChannelIcons } from "@/components/channels";
import { SlideOver } from "@/components/slide-over";
import { useCopy, useToast } from "@/components/toast";
import { isTyping, PIPELINE_EVENT } from "@/components/command-palette";
import { usePersisted } from "@/components/use-persisted";
import { applyState, computeKpis, defaultState, fromParams, rangeError, tierOptions, toCsv, toParams, views, type PipelineSort, type PipelineState, type View } from "./state";
import { CompanyPreview, type PanelTab } from "./company-preview";
import { Delta } from "./delta";

type Optional = "why" | "signal" | "lead" | "employees";
const optionalColumns: { id: Optional; label: string }[] = [
  { id: "why", label: "Why now" }, { id: "signal", label: "Workday signal date" }, { id: "lead", label: "Lead status" }, { id: "employees", label: "Employees" },
];
const STICKY = { check: 0, rank: 36, company: 116 };


function SortButton({ label, field, sort, setSort, numeric, tip }: { label: string; field: string; sort: PipelineSort; setSort: (s: PipelineSort) => void; numeric?: boolean; tip?: string }) {
  const active = sort.startsWith(`${field}-`);
  const ascending = sort.endsWith("asc");
  const firstDirection = numeric ? "desc" : "asc";
  const next = active ? (ascending ? "desc" : "asc") : firstDirection;
  return <button type="button" className={`sort${active ? " active" : ""}`} onClick={() => setSort(`${field}-${next}` as PipelineSort)} aria-label={`Sort by ${tip ?? label}`} title={tip}>
    {label}{active && (ascending ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />)}
  </button>;
}

export function Pipeline({ companies, mode, previousWeek, previousRanks, previousCompanyCount, initialQuery, explanations = {} }: {
  companies: CompanyListItem[]; mode: "sample" | "database"; previousWeek: string | null; previousRanks: Record<string, number>;
  previousCompanyCount: number | null; initialQuery: string; explanations?: Record<string, DeltaExplanation>;
}) {
  const copy = useCopy();
  const toast = useToast();
  const linkable = mode === "database";
  const [state, setState] = useState<PipelineState>(() => fromParams(new URLSearchParams(initialQuery)));
  const [density, setDensity] = usePersisted<"comfortable" | "compact">("pipeline.density", "comfortable");
  const [hidden, setHidden] = usePersisted<Optional[]>("pipeline.hidden", ["signal", "lead", "employees"]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(-1);
  const [panel, setPanel] = useState<{ id: string; tab: PanelTab; focus: Category | null } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLTableSectionElement>(null);

  const ranks = useMemo(() => companyRanks(companies), [companies]);
  const rows = useMemo(() => applyState(companies, state), [companies, state]);
  const kpis = useMemo(() => computeKpis(companies, previousCompanyCount), [companies, previousCompanyCount]);
  const error = rangeError(state);
  const show = (column: Optional) => !hidden.includes(column);

  const update = useCallback((patch: Partial<PipelineState>) => {
    setState(current => {
      const next = { ...current, ...patch };
      const query = toParams(next);
      window.history.replaceState(null, "", query ? `/?${query}` : "/");
      return next;
    });
    setActive(-1);
  }, []);

  const exportCsv = useCallback((subset?: CompanyListItem[]) => {
    const data = subset ?? rows;
    const blob = new Blob([toCsv(data, ranks)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: `mando-pipeline-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${data.length} compan${data.length === 1 ? "y" : "ies"}`);
  }, [rows, ranks, toast]);

  const toggleDensity = useCallback(() => setDensity(density === "compact" ? "comfortable" : "compact"), [density, setDensity]);

  // Palette actions, including ones requested from another page via ?action=.
  useEffect(() => {
    function run(action: string) { if (action === "density") toggleDensity(); if (action === "export") exportCsv(); }
    const params = new URLSearchParams(window.location.search);
    const pending = params.get("action");
    if (pending) { params.delete("action"); window.history.replaceState(null, "", params.size ? `/?${params}` : "/"); run(pending); }
    const onEvent = (event: Event) => run((event as CustomEvent<string>).detail);
    window.addEventListener(PIPELINE_EVENT, onEvent);
    return () => window.removeEventListener(PIPELINE_EVENT, onEvent);
  }, [toggleDensity, exportCsv]);

  // Keyboard: / search, J/K move, Enter open, X select, Esc clear.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || document.querySelector(".palette-backdrop")) return;
      if (isTyping(event.target)) { if (event.key === "Escape") (event.target as HTMLElement).blur(); return; }
      if (panel && event.key !== "Escape") {
        if (event.key === "j" || event.key === "k") { event.preventDefault(); move(event.key === "j" ? 1 : -1, true); }
        return;
      }
      if (event.key === "/") { event.preventDefault(); search.current?.focus(); }
      else if (event.key === "j" || event.key === "k") { event.preventDefault(); move(event.key === "j" ? 1 : -1, false); }
      else if (event.key === "Enter" && active >= 0 && rows[active] && !(event.target as HTMLElement).closest("button, a")) { event.preventDefault(); setPanel({ id: rows[active].id, tab: "overview", focus: null }); }
      else if (event.key === "x" && active >= 0 && rows[active]) toggleRow(rows[active].id);
      else if (event.key === "Escape" && selected.size) setSelected(new Set());
    }
    function move(step: number, withPanel: boolean) {
      setActive(current => {
        const base = withPanel && panel ? rows.findIndex(r => r.id === panel.id) : current;
        const next = Math.max(0, Math.min(rows.length - 1, base + step));
        tableRef.current?.querySelectorAll("tr")[next]?.scrollIntoView({ block: "nearest" });
        if (withPanel && rows[next]) setPanel(p => p && { ...p, id: rows[next].id });
        return next;
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function toggleRow(id: string) { setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  const allVisibleSelected = rows.length > 0 && rows.every(r => selected.has(r.id));
  function toggleAll() { setSelected(allVisibleSelected ? new Set() : new Set(rows.map(r => r.id))); }
  function setView(view: View) { update({ ...defaultState, sort: state.sort, view }); }
  function toggleColumn(column: Optional) { setHidden(hidden.includes(column) ? hidden.filter(c => c !== column) : [...hidden, column]); }

  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (state.view !== "all") chips.push({ key: "view", label: `View: ${views.find(v => v.id === state.view)!.label}`, clear: () => update({ view: "all" }) });
  if (state.q) chips.push({ key: "q", label: `Search: “${state.q}”`, clear: () => update({ q: "" }) });
  if (state.tier !== "All") chips.push({ key: "tier", label: `Tier: ${tierOptions.find(o => o.value === state.tier)!.label}`, clear: () => update({ tier: "All" }) });
  if (state.min || state.max) chips.push({ key: "range", label: `Score ${state.min || 0}–${state.max || 100}`, clear: () => update({ min: "", max: "" }) });
  if (state.verified) chips.push({ key: "verified", label: "Has verified email", clear: () => update({ verified: false }) });
  if (state.gaps) chips.push({ key: "gaps", label: "Evidence gaps", clear: () => update({ gaps: false }) });
  if (state.release) chips.push({ key: "release", label: "Release planners", clear: () => update({ release: false }) });

  const panelCompany = panel ? companies.find(c => c.id === panel.id) ?? null : null;
  const selectedRows = companies.filter(c => selected.has(c.id));
  const verifiedPct = kpis.contacts ? Math.round((kpis.verifiedContacts / kpis.contacts) * 100) : 0;
  const kpiItems: { id: View | "verified"; label: string; value: string; dot?: string; delta?: number | null; tip: string }[] = [
    { id: "all", label: "Companies", value: String(kpis.companies), delta: kpis.companiesDelta, tip: previousWeek ? `All companies. Change vs week of ${previousWeek}.` : "All companies" },
    { id: "qualified", label: "Qualified", value: String(kpis.byTier.qualified), dot: "qualified", tip: views[1].hint },
    { id: "maybe", label: "Maybe", value: String(kpis.byTier.maybe), dot: "maybe", tip: views[2].hint },
    { id: "needs", label: "Needs evidence", value: String(kpis.byTier.needs), dot: "needs", tip: views[3].hint },
    { id: "ready", label: "Ready for outreach", value: String(kpis.ready), tip: views[4].hint },
    { id: "verified", label: "Verified email", value: `${verifiedPct}%`, tip: `${kpis.verifiedContacts} of ${kpis.contacts} contacts have a verified email. Click to filter companies with one.` },
  ];

  return <>
    <section className="kpis" aria-label="Pipeline summary">
      {kpiItems.map(k => {
        const pressed = k.id === "verified" ? state.verified : k.id !== "all" && state.view === k.id;
        return <button key={k.id} type="button" className="kpi" aria-pressed={pressed} title={k.tip}
          onClick={() => k.id === "verified" ? update({ verified: !state.verified }) : setView(pressed ? "all" : k.id as View)}>
          <span className="kpi-label">{k.dot && <span className={`dot ${k.dot}`} aria-hidden />}{k.label}</span>
          <span className="kpi-value">{k.value}{k.delta != null && k.delta !== 0 && <span className={`kpi-delta ${k.delta > 0 ? "delta-up" : "delta-down"}`}>{k.delta > 0 ? "+" : ""}{k.delta}{previousWeek ? ` vs ${formatDate(previousWeek, { month: "short", day: "numeric" })}` : ""}</span>}</span>
        </button>;
      })}
    </section>

    <div className="toolbar" role="search">
      <label className="field"><Search aria-hidden /><span className="sr-only">Search companies</span>
        <input ref={search} className="input search" type="search" placeholder="Search…" value={state.q} onChange={e => update({ q: e.target.value })} /></label>
      <details className="menu">
        <summary className="btn"><Bookmark aria-hidden />{views.find(v => v.id === state.view)!.label}</summary>
        <div className="menu-pop left" role="menu">
          <p className="menu-label">Saved views</p>
          {views.map(v => <button key={v.id} type="button" role="menuitemradio" aria-checked={state.view === v.id} className="menu-item" title={v.hint}
            onClick={event => { setView(v.id); (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>{v.label}</button>)}
        </div>
      </details>
      <div className="toolbar-controls">
      <label className="sr-only" htmlFor="tier-filter">Tier</label>
      <select id="tier-filter" className="select" value={state.tier} onChange={e => update({ tier: e.target.value })}>{tierOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      <span className="range-group" title="Total score range">
        <input className="input range" inputMode="numeric" aria-label="Minimum total score" placeholder="Min" value={state.min} onChange={e => update({ min: e.target.value.replace(/\D/g, "").slice(0, 3) })} />–
        <input className="input range" inputMode="numeric" aria-label="Maximum total score" placeholder="Max" value={state.max} onChange={e => update({ max: e.target.value.replace(/\D/g, "").slice(0, 3) })} />
      </span>
      <span className="toolbar-sep" aria-hidden />
      <button type="button" className="toggle" aria-pressed={state.verified} onClick={() => update({ verified: !state.verified })} title="At least one contact with a verified email"><BadgeCheck aria-hidden /><span className="lbl-long">Verified email</span><span className="lbl-short">Verified</span></button>
      <button type="button" className="toggle" aria-pressed={state.gaps} onClick={() => update({ gaps: !state.gaps })} title="At least one category has no verified evidence yet"><CircleHelp aria-hidden /><span className="lbl-long">Evidence gaps</span><span className="lbl-short">Gaps</span></button>
      <button type="button" className="toggle" aria-pressed={state.release} onClick={() => update({ release: !state.release })} title="Release score above the 8-point baseline, i.e. in a Workday release-readiness window"><CalendarClock aria-hidden /><span className="lbl-long">Release planners</span><span className="lbl-short">Release</span></button>
      </div>
      <div className="toolbar-end">
        <span className="result-meta" role="status" aria-label={`${rows.length} of ${companies.length} companies shown`}>{rows.length}<span className="faint"> / {companies.length}</span></span>
        <details className="menu">
          <summary className="btn" aria-label="Display options"><Columns3 aria-hidden /><span className="lbl-collapse">Display</span></summary>
          <div className="menu-pop" role="menu">
            <p className="menu-label">Row density</p>
            <button type="button" role="menuitemradio" aria-checked={density === "comfortable"} className="menu-item" onClick={event => { if (density !== "comfortable") toggleDensity(); (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>Comfortable</button>
            <button type="button" role="menuitemradio" aria-checked={density === "compact"} className="menu-item" onClick={event => { if (density !== "compact") toggleDensity(); (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>Compact</button>
            <p className="menu-label">Optional columns</p>
            {optionalColumns.map(col => <button key={col.id} type="button" role="menuitemcheckbox" aria-checked={show(col.id)} className="menu-item" onClick={() => toggleColumn(col.id)}>{col.label}</button>)}
          </div>
        </details>
        <button type="button" className="btn" onClick={() => exportCsv()} disabled={!rows.length} title="Export the current view as CSV" aria-label="Export CSV"><Download aria-hidden /><span className="lbl-collapse">Export</span></button>
      </div>
    </div>

    {(chips.length > 0 || error) && <div className="active-filters" aria-label="Active filters">
      {chips.map(chip => <span key={chip.key} className="filter-chip">{chip.label}<button type="button" onClick={chip.clear} aria-label={`Remove filter ${chip.label}`}><X aria-hidden /></button></span>)}
      {error && <span className="filter-error" role="alert">{error}</span>}
      {chips.length > 0 && <button type="button" className="btn btn-ghost" onClick={() => update({ ...defaultState, sort: state.sort })}>Clear all</button>}
    </div>}

    <div className="table-wrap">
      {rows.length > 0 && <table className={`dt${density === "compact" ? " compact" : ""}`} aria-label="Company pipeline" aria-rowcount={rows.length}>
        <thead><tr>
          <th className="col-check sticky-1" style={{ left: STICKY.check }}><input type="checkbox" aria-label="Select all visible companies" checked={allVisibleSelected} onChange={toggleAll} /></th>
          <th className="sticky-1" style={{ left: STICKY.rank, width: 80 }}><SortButton label="Rank" field="rank" sort={state.sort} setSort={sort => update({ sort })} tip={previousWeek ? `Rank; change vs week of ${previousWeek}` : "Rank"} /></th>
          <th className="sticky-2" style={{ left: STICKY.company }}><SortButton label="Company" field="name" sort={state.sort} setSort={sort => update({ sort })} /></th>
          <th><SortButton label="Tier" field="tier" sort={state.sort} setSort={sort => update({ sort })} numeric /></th>
          <th className="num"><SortButton label="Total" field="score" sort={state.sort} setSort={sort => update({ sort })} numeric tip="Total score out of 100" /></th>
          {categories.map(cat => <th key={cat} className="col-score"><SortButton label={shortLabel[cat]} field={cat} sort={state.sort} setSort={sort => update({ sort })} numeric tip={`${rubric[cat].label} (out of ${rubric[cat].weight}): ${rubric[cat].explanation}`} /></th>)}
          <th>Top contact</th>
          {show("why") && <th className="col-why">Why now</th>}
          {show("signal") && <th>Workday signal</th>}
          {show("lead") && <th>Lead status</th>}
          {show("employees") && <th className="num"><SortButton label="Employees" field="employees" sort={state.sort} setSort={sort => update({ sort })} numeric /></th>}
          <th className="col-actions"><span className="sr-only">Actions</span></th>
        </tr></thead>
        <tbody ref={tableRef}>
          {rows.map((c, index) => {
            const rank = ranks.get(c.id);
            const movement = previousWeek ? rankMovement(rank, previousRanks[c.id]) : null;
            const cells = categoryCells(c.score);
            const contacts = rankContacts(c.contacts);
            const top = contacts[0];
            const topEmail = contacts.find(k => k.email && emailState(k) === "verified")?.email;
            const employees = employeeLabel(c.employee_count, c.score?.authority_evidence);
            const open = (tab: PanelTab, focus: Category | null = null) => { setActive(index); setPanel({ id: c.id, tab, focus }); };
            return <tr key={c.id} className={index === active ? "is-active" : undefined} aria-selected={selected.has(c.id)} onClick={() => open("overview")}>
              <td className="col-check sticky-1" style={{ left: STICKY.check }} onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${c.name}`} checked={selected.has(c.id)} onChange={() => toggleRow(c.id)} /></td>
              <td className="sticky-1" style={{ left: STICKY.rank }}><span className="cell-rank"><strong>{rank ?? "—"}</strong><Delta movement={movement} current={rank} note={explanations[c.id]?.summary} /></span></td>
              <td className="sticky-2" style={{ left: STICKY.company }}><div className="cell-company">
                {linkable ? <Link href={`/companies/${c.id}`} onClick={event => event.stopPropagation()} title={c.name}>{c.name}</Link> : <strong title={c.name}>{c.name}</strong>}
                <small title={c.industry ?? undefined}>{[c.industry ?? "Industry not recorded", employees && `${employees} emp.`].filter(Boolean).join(" · ")}</small>
              </div></td>
              <td><TierChip score={c.score} /></td>
              <td className="num"><span className="cell-total">{c.score?.total ?? <span className="empty-cell">—</span>}</span></td>
              {cells.map(cell => <td key={cell.category} className="col-score"><ScoreCell cell={cell} onOpen={() => open("evidence", cell.category)} /></td>)}
              <td>{top ? <div className="cell-contact">
                <div className="person"><Avatar name={top.name} /><div className="person-text"><strong title={top.name}>{top.name}</strong><small title={top.title ?? undefined}>{top.title ?? "Title not recorded"}</small></div></div>
                {contacts.length > 1 && <button type="button" className="btn btn-ghost more-contacts" onClick={event => { event.stopPropagation(); open("contacts"); }} aria-label={`${contacts.length - 1} more contacts`}>+{contacts.length - 1}</button>}
                <ChannelIcons contact={top} />
              </div> : <span className="empty-cell">No contacts yet</span>}</td>
              {show("why") && <td className="col-why"><span className="cell-truncate" title={c.why_now ?? undefined}>{c.why_now ?? <span className="empty-cell">—</span>}</span></td>}
              {show("signal") && <td className="cell-date">{formatDate(c.workday_signal_date) ?? <span className="empty-cell">—</span>}</td>}
              {show("lead") && <td>{leadStatusOf(c) ? leadStatusText(c) : <span className="empty-cell">Not tracked</span>}</td>}
              {show("employees") && <td className="num">{employees ?? <span className="empty-cell">—</span>}</td>}
              <td className="col-actions" onClick={event => event.stopPropagation()}><span className="row-actions">
                {linkable && <Link className="btn btn-ghost btn-icon" href={`/companies/${c.id}`} aria-label={`Open ${c.name} record`} data-tip="Open record" data-tip-pos="left"><SquareArrowOutUpRight aria-hidden /></Link>}
                <button type="button" className="btn btn-ghost btn-icon" disabled={!topEmail} onClick={() => topEmail && copy(topEmail, "Email")} aria-label={topEmail ? `Copy ${topEmail}` : "No verified email to copy"} data-tip={topEmail ? `Copy ${topEmail}` : "No verified email"} data-tip-pos="left"><Copy aria-hidden /></button>
              </span></td>
            </tr>;
          })}
        </tbody>
      </table>}
      {!rows.length && <div className="empty-state">
        <SearchX aria-hidden />
        {companies.length ? <><strong>No companies match these filters</strong><span>Try removing a filter or widening the score range.</span><button type="button" className="btn" onClick={() => update({ ...defaultState })}>Clear filters</button></>
          : <><strong>No companies yet</strong><span>Companies appear here once research is imported.</span></>}
      </div>}
    </div>

    {selected.size > 0 && <div className="bulkbar" role="region" aria-label="Bulk actions">
      <span className="num">{selected.size} selected</span>
      <button type="button" className="btn" onClick={() => {
        const emails = selectedRows.flatMap(c => c.contacts.filter(k => k.email && emailState(k) === "verified").map(k => k.email!));
        if (emails.length) copy(emails.join(", "), `${emails.length} verified email${emails.length === 1 ? "" : "s"}`); else toast("No verified emails in the selection", "error");
      }}><Copy aria-hidden />Copy verified emails</button>
      <button type="button" className="btn" onClick={() => exportCsv(selectedRows)}><Download aria-hidden />Export selected</button>
      <button type="button" className="btn" style={{ marginLeft: "auto" }} onClick={() => setSelected(new Set())}><X aria-hidden />Clear</button>
    </div>}

    <SlideOver open={!!panelCompany} onClose={() => setPanel(null)} labelledBy="sheet-title">
      {panelCompany && panel && <CompanyPreview company={panelCompany} explanation={explanations[panelCompany.id]} rank={ranks.get(panelCompany.id)} movement={previousWeek ? rankMovement(ranks.get(panelCompany.id), previousRanks[panelCompany.id]) : null}
        tab={panel.tab} focus={panel.focus} linkable={linkable} onClose={() => setPanel(null)} onTab={(tab, focus = null) => setPanel(p => p && { ...p, tab, focus })} />}
    </SlideOver>
  </>;
}
