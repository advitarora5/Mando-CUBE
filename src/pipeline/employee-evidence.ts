import { z } from "zod";
import { normalizeDomain } from "../domain/ingestion/normalize.ts";
import { daysSince } from "../domain/scoring/go-live.ts";

// Reviewed inputs only. The operator must check that the source describes this employer,
// including the entity boundary (a subsidiary cannot inherit its parent's headcount).
export const employeeEvidenceSchema = z.array(z.strictObject({
  company_domain: z.string().transform(normalizeDomain).pipe(z.string()),
  employee_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  as_of: z.iso.date(),
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
  return row && age !== null && age >= 0 && age <= 548 ? row : null;
}
