import { z } from "zod";
import { normalizeDomain } from "../domain/ingestion/normalize.ts";
import { daysSince } from "../domain/scoring/go-live.ts";

// Reviewed inputs only. The operator must check that the source describes this employer,
// including the entity boundary (a subsidiary cannot inherit its parent's headcount).
export const employeeEvidenceSchema = z.array(z.strictObject({
  company_domain: z.string().transform(normalizeDomain).pipe(z.string()),
  employee_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  as_of: z.iso.date(),
  basis: z.enum(["exact", "lower_bound", "approximate"]).optional(),
  date_basis: z.enum(["effective", "publication", "observed"]).optional(),
  published_on: z.iso.date().optional(),
  observed_on: z.iso.date().optional(),
  source: z.url({ protocol: /^https?$/ }),
})).superRefine((rows, ctx) => {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.company_domain)) ctx.addIssue({ code: "custom", message: "Duplicate company domain in employee evidence" });
    seen.add(row.company_domain);
  }
});

export type EmployeeEvidence = z.infer<typeof employeeEvidenceSchema>[number];

// Match the financial scorer's 548-day annual-report window. Future evidence earns no credit.
export function employeeEvidenceForCompany(rows: EmployeeEvidence[], domain: string | null, now: Date) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;
  const row = rows.find(row => row.company_domain === normalized);
  const age = daysSince(row?.as_of, now);
  return row && age !== null && age >= 0 && age <= (row.date_basis === "observed" ? 30 : 548) ? row : null;
}

// Only retain a previously awarded, machine-formatted headcount on this same
// company assessment when collection is unavailable/skipped. Never infer a new
// claim from an unsourced company count or a generic “size3” phrase alone.
export function savedEmployeeEvidence(value: string | null | undefined, now: Date): Omit<EmployeeEvidence, "company_domain"> | null {
  if (!/\bsize\s*3\b/i.test(value ?? "")) return null;
  const match = value?.match(/ Headcount (at least )?(\d+) (as of|reported on|observed on) (\d{4}-\d{2}-\d{2}): (\S+)$/);
  if (!match || !z.iso.date().safeParse(match[4]).success) return null;
  const employee_count = Number(match[2]);
  const age = daysSince(match[4], now);
  const date_basis = match[3] === "observed on" ? "observed" : match[3] === "reported on" ? "publication" : "effective";
  try {
    const source = new URL(match[5]);
    if (!/^https?:$/.test(source.protocol) || source.username || source.password || !Number.isSafeInteger(employee_count) ||
      employee_count < 3000 || age === null || age < 0 || age > (date_basis === "observed" ? 30 : 548)) return null;
    return { employee_count, as_of: match[4], source: source.href, basis: match[1] ? "lower_bound" : "exact", date_basis };
  } catch { return null; }
}
