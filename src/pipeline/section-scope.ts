import { normalizeName } from "../domain/ingestion/normalize.ts";
import { loadSections, type SectionIssuer } from "./sections.ts";

export type SectionScope = { version: string; section: number; snapshotSha256: string; issuers: SectionIssuer[]; ambiguousNames: string[] };
export type SectionProgress = { cik: number; status: "pending" | "found" | "miss" | "retry"; probes: number; attempted_at: string | null; next_attempt_at: string | null };

export function sectionNames(scope: SectionScope): Set<string> {
  const ambiguous = new Set(scope.ambiguousNames);
  return new Set(scope.issuers.map(i => normalizeName(i.name)).filter(n => n && !ambiguous.has(n)));
}

export function loadSectionScope(number: number): SectionScope {
  const { manifest, sections } = loadSections();
  const section = sections.find(s => s.number === number);
  if (!section) throw Error("Choose an explicit section number from 1 to 10.");
  const names = new Map<string, number>();
  for (const issuer of sections.flatMap(s => s.issuers)) {
    const name = normalizeName(issuer.name);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  return { version: manifest.version, section: number, snapshotSha256: manifest.snapshot_sha256,
    issuers: section.issuers, ambiguousNames: [...names].filter(([name, count]) => !name || count > 1).map(([name]) => name) };
}

// Fresh issuers precede temporary failures, so one failing company cannot monopolize a section.
export function discoveryBatch(scope: SectionScope, progress: SectionProgress[], limit: number, now: Date): SectionIssuer[] {
  const byCik = new Map(progress.map(p => [p.cik, p]));
  const names = sectionNames(scope);
  const eligible = scope.issuers.filter(i => names.has(normalizeName(i.name)));
  const fresh = eligible.filter(i => !byCik.has(i.cik) || byCik.get(i.cik)!.status === "pending");
  const retries = eligible.filter(i => {
    const p = byCik.get(i.cik);
    return p?.status === "retry" && (!p.next_attempt_at || Date.parse(p.next_attempt_at) <= now.getTime());
  }).sort((a, b) => (byCik.get(a.cik)!.attempted_at ?? "").localeCompare(byCik.get(b.cik)!.attempted_at ?? ""));
  return [...fresh, ...retries].slice(0, limit);
}
