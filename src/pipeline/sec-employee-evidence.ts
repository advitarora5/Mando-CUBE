import { z } from "zod";
import { normalizeName } from "../domain/ingestion/normalize.ts";
import { daysSince } from "../domain/scoring/go-live.ts";
import type { EmployeeEvidence } from "./employee-evidence.ts";

export type SecEmployeeEvidence = Omit<EmployeeEvidence, "company_domain">;
const date = z.iso.date();
const accession = /^\d{10}-\d{2}-\d{6}$/;
const forms = /^(10-K|10-Q|20-F|40-F)(\/A)?$/;
const filingSource = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/$/;
type Fact = { end: string; filed: string; form: string; accn: string; val: unknown };

// Companyfacts contains non-custom facts applying to the entire filing entity.
// Never infer a subsidiary's workforce from a parent's differently named filing.
export function parseSecEmployeeEvidence(body: unknown, companyName: string, cik: number, now: Date): SecEmployeeEvidence | null {
  const payload = body as { cik?: unknown; entityName?: unknown; facts?: { dei?: { EntityNumberOfEmployees?: { units?: Record<string, unknown> } } } } | null;
  if (!Number.isSafeInteger(cik) || cik <= 0 || !payload || Number(payload.cik) !== cik || typeof payload.entityName !== "string" ||
    !normalizeName(companyName) || normalizeName(payload.entityName) !== normalizeName(companyName)) return null;
  const raw = payload.facts?.dei?.EntityNumberOfEmployees?.units?.employee;
  if (!Array.isArray(raw)) return null;
  const rows = (raw as Partial<Fact>[]).filter((row): row is Fact => {
    if (!row || !date.safeParse(row.end).success || !date.safeParse(row.filed).success ||
      typeof row.form !== "string" || !forms.test(row.form) || typeof row.accn !== "string" || !accession.test(row.accn)) return false;
    return (daysSince(row.end, now) ?? -1) >= 0 && (daysSince(row.filed, now) ?? -1) >= 0 && row.end! <= row.filed!;
  }).sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed) || b.accn.localeCompare(a.accn));
  const latest = rows[0];
  if (!latest || (daysSince(latest.end, now) ?? Infinity) > 548 ||
    !Number.isSafeInteger(latest.val) || Number(latest.val) < 0) return null;
  // A contradictory equally current disclosure needs review; never pick the larger count.
  if (rows.some(row => row.end === latest.end && row.filed === latest.filed && row.val !== latest.val)) return null;
  return { employee_count: Number(latest.val), as_of: latest.end,
    source: `https://www.sec.gov/Archives/edgar/data/${cik}/${latest.accn.replaceAll("-", "")}/` };
}

// Retain the last SEC observation on the same company record through temporary
// lookup failures. Its effective date still expires; current roles are rescored.
export function savedSecEmployeeEvidence(value: string | null | undefined, now: Date): SecEmployeeEvidence | null {
  const match = value?.match(/ Headcount (\d+) as of (\d{4}-\d{2}-\d{2}): (\S+)$/);
  if (!match || !date.safeParse(match[2]).success || !filingSource.test(match[3])) return null;
  const age = daysSince(match[2], now);
  const employee_count = Number(match[1]);
  return Number.isSafeInteger(employee_count) && age !== null && age >= 0 && age <= 548
    ? { employee_count, as_of: match[2], source: match[3] } : null;
}
