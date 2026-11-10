import { authorityFromContacts, differentEmployer } from "../domain/ingestion/pipeline-score.ts";
import type { ScoringContact } from "../domain/ingestion/pipeline-score.ts";
import type { EmployeeEvidence } from "./employee-evidence.ts";
import { rubric } from "../domain/scoring/rubric.ts";
import { daysSince } from "../domain/scoring/go-live.ts";

// Authority-only comparison. Never change another category or reinterpret a rubric.
export function previewHeadcountAuthority(contacts: ScoringContact[], evidence: Omit<EmployeeEvidence, "company_domain"> | null,
  saved: { authority_score: number; authority_evidence?: string | null } | null, now: Date) {
  const currentContacts = contacts.filter(contact => !differentEmployer(contact));
  const without = authorityFromContacts(currentContacts, { employee_count: null }, now);
  const age = daysSince(evidence?.as_of, now);
  const fresh = evidence && age !== null && age >= 0 && age <= (evidence.date_basis === "observed" ? 30 : 548);
  const withSize = fresh ? authorityFromContacts(currentContacts, {
    employee_count: evidence.employee_count, employee_source: evidence.source, employee_as_of: evidence.as_of,
    employee_basis: evidence.basis ?? "exact", employee_date_basis: evidence.date_basis ?? "effective",
  }, now) : without;
  const savedSize = /\bsize\s*\+?3\b|confirmed\s+3,?000\+\s+employer(?:\/group)?\s+3\b/i.test(saved?.authority_evidence ?? "");
  const before = saved?.authority_score ?? null;
  const eligible = (withSize.detail.size ?? 0) === 3;
  let after = before;
  let status = "no_supported_size_bonus";
  if (eligible) {
    if (before === null) { after = null; status = "no_saved_authority"; }
    else if (before >= rubric.authority.weight) { status = "already_at_authority_cap"; }
    else if (savedSize) { status = "size_bonus_already_documented"; }
    else if (before === withSize.score) { status = "saved_already_equals_with_size_calculation"; }
    else if (before === without.score) { after = withSize.score; status = "additional_size_points_supported"; }
    else { after = null; status = "saved_authority_not_reproduced"; }
  }
  return { authority_without_size: without.score, authority_with_size: withSize.score,
    size_component: withSize.detail.size ?? 0, increment_after_cap: withSize.score - without.score,
    saved_size_documented: savedSize, authority_before: before, authority_after: after,
    additional_points: after !== null && before !== null ? after - before : null, comparison_status: status };
}
