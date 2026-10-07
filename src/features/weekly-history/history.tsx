import { companyHistory, describeMovement, type Movement, type Snapshot } from "@/domain/history";

export function MovementBadge({ movement, current }: { movement: Movement | null; current?: number }) {
  const label = describeMovement(movement, current);
  if (!movement) return <span className="muted">—</span>;
  const symbol = movement.kind === "up" ? `▲ ${movement.places}` : movement.kind === "down" ? `▼ ${movement.places}` : movement.kind === "new" ? "New" : "–";
  return <span className={`movement ${movement.kind}`} title={label} aria-label={label}>{symbol}</span>;
}

export function WeeklyHistory({ snapshots }: { snapshots: Snapshot[] }) {
  const rows = companyHistory(snapshots).toReversed();
  return <section className="panel detail-section"><div className="section-title"><h2>Weekly history</h2><span className="muted">{rows.length ? `${rows.length} saved week${rows.length === 1 ? "" : "s"}` : "No weeks saved yet"}</span></div>
    {rows.length > 0 && <div className="scroll"><table><thead><tr><th>Week of</th><th>Rank</th><th>Total /100</th><th>Movement</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.week_start}><td>{r.week_start}</td><td>#{r.rank}</td><td>{r.total ?? "—"}</td><td><MovementBadge movement={r.movement} current={r.rank} /> <small>{describeMovement(r.movement, r.rank)}</small></td></tr>)}</tbody></table></div>}
  </section>;
}
