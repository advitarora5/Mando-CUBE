export type Snapshot = { week_start: string; company_id: string; rank: number; total?: number | null };

export type Movement =
  | { kind: "new" }
  | { kind: "same"; from: number }
  | { kind: "up" | "down"; from: number; places: number };

export function chicagoToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// Weeks start Monday (America/Chicago), matching the weekly snapshot saver.
export function chicagoWeekStart(now = new Date()) {
  const day = new Date(`${chicagoToday(now)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

// The comparison week is the most recent saved week before the current one.
export function baselineWeek(snapshots: Snapshot[], currentWeek: string) {
  return snapshots.map(s => s.week_start).filter(w => w < currentWeek).sort().at(-1) ?? null;
}

export function previousRanks(snapshots: Snapshot[], week: string | null) {
  return Object.fromEntries(snapshots.filter(s => s.week_start === week).map(s => [s.company_id, s.rank]));
}

export function rankMovement(current: number | undefined, previous: number | undefined): Movement | null {
  if (current === undefined) return null;
  if (previous === undefined) return { kind: "new" };
  if (current === previous) return { kind: "same", from: previous };
  return { kind: current < previous ? "up" : "down", from: previous, places: Math.abs(previous - current) };
}

export function describeMovement(m: Movement | null, current?: number) {
  if (!m) return "—";
  if (m.kind === "new") return "New";
  if (m.kind === "same") return "No change";
  return `Moved from rank ${m.from} to rank ${current}`;
}

// Weekly movement for one company's history, oldest to newest, each week compared with the one before.
export function companyHistory(snapshots: Snapshot[]) {
  const sorted = snapshots.toSorted((a, b) => a.week_start.localeCompare(b.week_start));
  return sorted.map((s, i) => ({ ...s, movement: i === 0 ? { kind: "new" } as Movement : rankMovement(s.rank, sorted[i - 1].rank) }));
}
