// Finding the same company under two records, and matching a new name against existing companies.
// Pure functions: no I/O. The alias and distinct lists live in src/data/company-aliases.ts.
import type { CompanyAlias, DistinctCompanies } from "../../data/company-aliases.ts";
import { isSimilarName, nameSimilarity, normalizeDomain, normalizeName } from "./normalize.ts";

export type CompanyIdentity = { id: string; name: string; domain: string | null };
// Strongest first: the same website or name is almost certainly one company; a similar name needs a person.
export type DuplicateReason = "same_website" | "same_name" | "known_alias" | "similar_name";
export type DuplicatePair = { a: CompanyIdentity; b: CompanyIdentity; reasons: DuplicateReason[]; similarity: number };
export type ExistingMatch =
  | { kind: "existing"; company: CompanyIdentity; reason: Exclude<DuplicateReason, "similar_name"> }
  | { kind: "review"; company: CompanyIdentity; reason: "similar_name" }
  | { kind: "ambiguous"; companies: CompanyIdentity[]; reason: DuplicateReason }
  | { kind: "new" };

const strength: DuplicateReason[] = ["same_website", "same_name", "known_alias", "similar_name"];

// Normalized alias names, keyed by the company they belong to.
function aliasNames(aliases: CompanyAlias[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const entry of aliases) {
    const names = out.get(entry.company_id) ?? new Set<string>();
    for (const alias of entry.aliases) if (normalizeName(alias)) names.add(normalizeName(alias));
    out.set(entry.company_id, names);
  }
  return out;
}

// The company a name is a known alias of, if any.
export function aliasOwner(name: string, aliases: CompanyAlias[]): string | null {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  return aliases.find(entry => entry.aliases.some(alias => normalizeName(alias) === normalized))?.company_id ?? null;
}

// Every pair of companies that may be the same company, strongest evidence first.
// Pairs listed in distinctCompanies were checked by a person and are left out.
export function findDuplicatePairs(companies: CompanyIdentity[], aliases: CompanyAlias[] = [], distinct: DistinctCompanies[] = []): DuplicatePair[] {
  const known = aliasNames(aliases);
  const checked = new Set(distinct.map(d => [...d.company_ids].sort().join(" ")));
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < companies.length; i++) for (let j = i + 1; j < companies.length; j++) {
    const a = companies[i], b = companies[j];
    if (checked.has([a.id, b.id].sort().join(" "))) continue;
    const reasons: DuplicateReason[] = [];
    const domain = normalizeDomain(a.domain);
    if (domain && domain === normalizeDomain(b.domain)) reasons.push("same_website");
    const sameName = !!normalizeName(a.name) && normalizeName(a.name) === normalizeName(b.name);
    if (sameName) reasons.push("same_name");
    const aliasOf = (owner: CompanyIdentity, other: CompanyIdentity) => known.get(owner.id)?.has(normalizeName(other.name)) ?? false;
    if (aliasOf(a, b) || aliasOf(b, a)) reasons.push("known_alias");
    if (!sameName && isSimilarName(a.name, b.name)) reasons.push("similar_name");
    if (reasons.length) pairs.push({ a, b, reasons, similarity: nameSimilarity(a.name, b.name) });
  }
  const rank = (pair: DuplicatePair) => Math.min(...pair.reasons.map(reason => strength.indexOf(reason)));
  return pairs.sort((x, y) => rank(x) - rank(y) || y.similarity - x.similarity || x.a.name.localeCompare(y.a.name));
}

// Whether a company about to be added is already on the dashboard.
// A matching website, name or alias is the same company; a similar name needs a person to decide.
export function matchExistingCompany(candidate: { name: string; domain?: string | null }, known: CompanyIdentity[], aliases: CompanyAlias[] = []): ExistingMatch {
  const pick = (companies: CompanyIdentity[], reason: Exclude<DuplicateReason, "similar_name">): ExistingMatch | null =>
    companies.length === 1 ? { kind: "existing", company: companies[0], reason } : companies.length > 1 ? { kind: "ambiguous", companies, reason } : null;
  const domain = normalizeDomain(candidate.domain);
  const byWebsite = domain ? pick(known.filter(c => normalizeDomain(c.domain) === domain), "same_website") : null;
  if (byWebsite) return byWebsite;
  const name = normalizeName(candidate.name);
  const byName = name ? pick(known.filter(c => normalizeName(c.name) === name), "same_name") : null;
  if (byName) return byName;
  const owner = aliasOwner(candidate.name, aliases);
  const byAlias = owner ? pick(known.filter(c => c.id === owner), "known_alias") : null;
  if (byAlias) return byAlias;
  const similar = known.filter(c => isSimilarName(c.name, candidate.name));
  if (similar.length === 1) return { kind: "review", company: similar[0], reason: "similar_name" };
  if (similar.length > 1) return { kind: "ambiguous", companies: similar, reason: "similar_name" };
  return { kind: "new" };
}
