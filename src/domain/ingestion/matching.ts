import type { CompanyAlias } from "../../data/company-aliases.ts";
import { aliasOwner } from "./duplicates.ts";
import { isSimilarName, normalizeDomain, normalizeName } from "./normalize.ts";

export type KnownCompany = { id: string; name: string; domain: string | null };

export type Candidate = {
  name: string;
  domain: string | null;
  // The website has independent identity and source corroboration, not only a provider name match.
  domain_confirmed: boolean;
  // Yes or no: current evidence ties this company, under this name, to its Workday site.
  // Stored signal confidence values are heuristics and do not decide admission.
  workday_verified: boolean;
};

export type MatchDecision =
  | { action: "skip"; why: string }
  | { action: "attach"; company_id: string; why: string }
  | { action: "create"; why: string }
  | { action: "review"; reason: "similar_name" | "no_website" | "untrusted_signal" | "over_run_cap"; suggested_company_id: string | null; why: string };

// Organisations that are never leads: Workday itself (its own career site is a Workday tenant).
const EXCLUDED = new Set(["workday"]);
export function isExcludedCompany(name: string | null | undefined): boolean {
  return EXCLUDED.has(normalizeName(name));
}

// Rules: a confirmed exact website match merges. A similar (or equal) name without one goes to review.
// A new company needs a confirmed corporate website and a verified Workday connection, nothing more.
// Scoring and research judge the company after admission.
export function decideMatch(candidate: Candidate, known: KnownCompany[], room: { canCreate: boolean }, aliases: CompanyAlias[] = []): MatchDecision {

  if (isExcludedCompany(candidate.name)) return { action: "skip", why: "excluded organisation (the vendor)" };
  const domain = normalizeDomain(candidate.domain);
  if (domain && candidate.domain_confirmed) {
    const exact = known.find(company => normalizeDomain(company.domain) === domain);
    if (exact) return { action: "attach", company_id: exact.id, why: `website ${domain} matches ${exact.name}` };
  }
  const ownerId = aliasOwner(candidate.name, aliases);
  const owner = ownerId ? known.find(company => company.id === ownerId) : undefined;
  if (owner) return { action: "attach", company_id: owner.id, why: `${candidate.name} is a known name of ${owner.name}` };
  // Explicit parent/subdomain relationships are ambiguous; do not guess a registrable domain.
  const related = domain && known.find(company => { const other = normalizeDomain(company.domain); return other && (domain.endsWith(`.${other}`) || other.endsWith(`.${domain}`)); });
  if (related) return { action: "review", reason: "similar_name", suggested_company_id: related.id, why: "website is a parent or subdomain of an existing company" };

  const similar = known.find(company => isSimilarName(company.name, candidate.name));
  if (similar) return { action: "review", reason: "similar_name", suggested_company_id: similar.id, why: `name is similar to existing ${similar.name}` };
  if (!domain || !candidate.domain_confirmed) return { action: "review", reason: "no_website", suggested_company_id: null, why: "no confirmed website" };
  // "untrusted_signal" is the stored reason code (a database check constraint); it now means the connection is unverified.
  if (!candidate.workday_verified) return { action: "review", reason: "untrusted_signal", suggested_company_id: null, why: "Workday connection not verified: evidence is stale or the name is an unconfirmed guess" };
  if (!room.canCreate) return { action: "review", reason: "over_run_cap", suggested_company_id: null, why: "new-company cap for this run reached" };
  return { action: "create", why: `new company with website ${domain} and a verified Workday connection` };
}

// Size handling: companies under 3,000 employees are not blocked, only scored lower by the rubric; unknown is labelled.
export function sizeLabel(employeeCount: number | null | undefined): string {
  if (employeeCount == null) return "size unknown";
  return employeeCount >= 3000 ? `${employeeCount.toLocaleString("en-US")} employees` : `${employeeCount.toLocaleString("en-US")} employees (under 3,000)`;
}

export { normalizeName };
