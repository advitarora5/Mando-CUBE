"use client";

import { useState } from "react";
import Link from "next/link";
import { categories, type CompanyListItem, type Score } from "@/domain/contracts/company";
import { safeUrl } from "@/domain/contracts/detail";
import { companyRanks, queryCompanies, type Sort } from "./query";

function ScoreCells({ score }: { score: Score | null }) {
  return categories.map(category => {
    const evidence = score?.[`${category}_evidence`] ?? "";
    const split = evidence.indexOf(" | ");
    const url = safeUrl(split >= 0 ? evidence.slice(0, split) : null);
    const reason = evidence.startsWith("Unmapped spreadsheet research;")
  ? "Category evidence awaiting review. Open company for original research."
  : split >= 0 ? evidence.slice(split + 3) : evidence;
    return <td key={category} className="category-score"><strong>{score?.[`${category}_score`] ?? "Unscored"}</strong>{reason && <small>{reason}</small>}{url && <a className="source-link" href={url} target="_blank" rel="noopener noreferrer">Source ↗</a>}</td>;
  });
}

function SortHeader({ label, field, sort, setSort }: {
  label: string; field: "rank" | "name" | "score" | "tier"; sort: Sort; setSort: (sort: Sort) => void;
}) {
  const active = sort.startsWith(`${field}-`);
  const ascending = sort.endsWith("asc");
  const nextDirection = active ? ascending ? "desc" : "asc" : field === "score" || field === "tier" ? "desc" : "asc";
  return <th aria-sort={active ? ascending ? "ascending" : "descending" : "none"}>
    <button className={`sort-heading${active ? " active" : ""}`} aria-label={`Sort by ${label}`} title={`Sort ${label} ${nextDirection === "asc" ? "ascending" : "descending"}`} onClick={() => setSort(`${field}-${nextDirection}` as Sort)}>
      {label}{active && <span aria-hidden="true">{ascending ? "↑" : "↓"}</span>}
    </button>
  </th>;
}

export function CompanyList({ companies, mode }: { companies: CompanyListItem[]; mode: "sample" | "database" }) {
  const [search, setSearch] = useState("");
  const [tier, setTier] = useState("All");
  const [minimum, setMinimum] = useState("");
  const [maximum, setMaximum] = useState("");
  const [sort, setSort] = useState<Sort>("rank-asc");
  const min = minimum === "" ? null : Number(minimum);
  const max = maximum === "" ? null : Number(maximum);
  const invalid = [min, max].some(n => n !== null && (!Number.isFinite(n) || n < 0 || n > 100)) ? "Scores must be between 0 and 100." : min !== null && max !== null && min > max ? "Minimum score must not exceed maximum score." : null;
  const ranks = companyRanks(companies);
  const visible = invalid ? [] : queryCompanies(companies, { search, tier, min, max, sort });
  function clear() { setSearch(""); setTier("All"); setMinimum(""); setMaximum(""); setSort("rank-asc"); }
  const active = search || tier !== "All" || minimum || maximum || sort !== "rank-asc";
  return <section className="panel">
    <div className="panel-heading"><h2>Company priorities</h2><p>Ranks reflect total scores across all companies, regardless of filters or display order.</p></div>
    <div className="list-controls">
      <label className="search-control">Search companies<input type="search" placeholder="Company, industry, or contact" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <label>Tier<select value={tier} onChange={e => setTier(e.target.value)}>{["All", "Qualified", "Maybe", "Disqualified", "Unscored"].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Minimum score<input type="number" min="0" max="100" step="1" placeholder="0" value={minimum} onChange={e => setMinimum(e.target.value)} /></label>
      <label>Maximum score<input type="number" min="0" max="100" step="1" placeholder="100" value={maximum} onChange={e => setMaximum(e.target.value)} /></label>

      <button className="button secondary" onClick={clear} disabled={!active}>Reset</button>
    </div>
    {invalid && <p className="filter-error" role="alert">{invalid}</p>}
    <p className="result-count" role="status">Showing {visible.length} of {companies.length} companies</p>
    <div className="scroll"><table><thead><tr><SortHeader label="Rank" field="rank" sort={sort} setSort={setSort} /><SortHeader label="Company A–Z" field="name" sort={sort} setSort={setSort} /><th>Employees</th><th>Authority /25</th><th>Reachability /25</th><th>Budget /20</th><th>Release /15</th><th>Timing /15</th><SortHeader label="Total /100" field="score" sort={sort} setSort={setSort} /><SortHeader label="Tier" field="tier" sort={sort} setSort={setSort} /><th>Why now</th><th>Contacts</th></tr></thead>
      <tbody>{visible.map(c => <tr key={c.id}><td className="rank-cell">{ranks.has(c.id) ? `#${ranks.get(c.id)}` : "—"}</td><td><strong>{mode === "database" ? <Link className="company-link" href={`/companies/${c.id}`}>{c.name} ↗</Link> : c.name}</strong><small>{c.industry ?? "Industry pending"}</small></td><td>{c.employee_count?.toLocaleString() ?? "—"}</td><ScoreCells score={c.score} /><td className="total-score"><strong>{c.score?.total ?? "—"}</strong></td><td><span className={`tier-badge ${c.score?.tier.toLowerCase() ?? "unscored"}`}>{c.score?.tier ?? "Unscored"}</span></td><td>
  <details>
    <summary>Read why now</summary>
    <p style={{ minWidth: "260px", maxWidth: "360px" }}>
      {c.why_now ?? "Research pending"}
    </p>
  </details>
</td><td>{c.contacts.length ? c.contacts.map(contact => <div key={contact.id}>{safeUrl(contact.linkedin_url) ? <a className="source-link" href={safeUrl(contact.linkedin_url)!} target="_blank" rel="noopener noreferrer">{contact.name} ↗</a> : contact.name}<small>{contact.title}</small></div>) : "Contacts pending"}</td></tr>)}</tbody>
    </table></div>
    {!visible.length && !invalid && <div className="empty">{companies.length ? <><p>No companies match your filters.</p><button className="button secondary" onClick={clear}>Clear filters</button></> : "No companies yet."}</div>}
  </section>;
}
