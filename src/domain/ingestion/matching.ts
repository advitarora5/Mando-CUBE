import type { CompanyAlias } from "../../data/company-aliases.ts";
import { aliasOwner } from "./duplicates.ts";
import { isSimilarName, normalizeDomain, normalizeName } from "./normalize.ts";

export type KnownCompany = { id: string; name: string; domain: string | null };

export type Candidate = {
  name: string;
  domain: string | null;
  // The domain came from a resolver whose returned name equals the candidate's normalized name.
  domain_confirmed: boolean;
  // Highest-confidence signal behind this candidate; 0.9+ counts as trusted (structural evidence such as a career site).
  best_confidence: number;
};

export type MatchDecision =
  | { action: "skip"; why: string }
  | { action: "attach"; company_id: string; why: string }
  | { action: "create"; why: string }
  | { action: "review"; reason: "similar_name" | "no_website" | "untrusted_signal" | "over_run_cap"; suggested_company_id: string | null; why: string };

export const TRUSTED_CONFIDENCE = 0.9;

// Organisations that are never leads: Workday itself (its own career site is a Workday tenant).
const EXCLUDED = new Set(["workday"]);
export function isExcludedCompany(name: string | null | undefined): boolean {
  return EXCLUDED.has(normalizeName(name));
}

// Rules: an exact website match or a reviewed alias (src/data/company-aliases.ts) merges. A similar (or equal)
// name without either goes to review. A new company with a confirmed website and a trusted signal is created.
// Everything else goes to review.
export function decideMatch(candidate: Candidate, known: KnownCompany[], room: { canCreate: boolean }, aliases: CompanyAlias[] = []): MatchDecision {
  if (isExcludedCompany(candidate.name)) return { action: "skip", why: "excluded organisation (the vendor)" };
  const domain = normalizeDomain(candidate.domain);
  if (domain) {
    const exact = known.find(company => normalizeDomain(company.domain) === domain);
    if (exact) return { action: "attach", company_id: exact.id, why: `website ${domain} matches ${exact.name}` };
  }
  const ownerId = aliasOwner(candidate.name, aliases);
  const owner = ownerId ? known.find(company => company.id === ownerId) : undefined;
  if (owner) return { action: "attach", company_id: owner.id, why: `${candidate.name} is a known name of ${owner.name}` };
  const similar = known.find(company => isSimilarName(company.name, candidate.name));
  if (similar) return { action: "review", reason: "similar_name", suggested_company_id: similar.id, why: `name is similar to existing ${similar.name}` };
  if (!domain || !candidate.domain_confirmed) return { action: "review", reason: "no_website", suggested_company_id: null, why: "no confirmed website" };
  if (candidate.best_confidence < TRUSTED_CONFIDENCE) return { action: "review", reason: "untrusted_signal", suggested_company_id: null, why: `best signal confidence ${candidate.best_confidence}` };
  if (!room.canCreate) return { action: "review", reason: "over_run_cap", suggested_company_id: null, why: "new-company cap for this run reached" };
  return { action: "create", why: `new company with website ${domain} and a trusted signal` };
}

// Size handling: companies under 3,000 employees are not blocked, only scored lower by the rubric; unknown is labelled.
export function sizeLabel(employeeCount: number | null | undefined): string {
  if (employeeCount == null) return "size unknown";
  return employeeCount >= 3000 ? `${employeeCount.toLocaleString("en-US")} employees` : `${employeeCount.toLocaleString("en-US")} employees (under 3,000)`;
}

export { normalizeName };
