import type { CompanyListItem } from "@/domain/contracts/company";

export type Sort = "score-desc" | "score-asc" | "name-asc" | "name-desc" | "employees-desc" | "employees-asc" | "rank-asc" | "rank-desc" | "tier-asc" | "tier-desc";
export type Filters = { search: string; tier: string; min: number | null; max: number | null; sort: Sort };
const names = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export function scoreOrder(a: CompanyListItem, b: CompanyListItem) {
  return (b.score?.total ?? -1) - (a.score?.total ?? -1) || names.compare(a.name, b.name) || a.id.localeCompare(b.id);
}

// Competition ranks are computed against the complete dataset, before filtering.
export function companyRanks(companies: CompanyListItem[]) {
  const ranks = new Map<string, number>();
  const scored = companies.filter(c => c.score).toSorted(scoreOrder);
  let previous: number | null = null;
  let rank = 0;
  scored.forEach((company, i) => {
    if (company.score!.total !== previous) rank = i + 1;
    previous = company.score!.total;
    ranks.set(company.id, rank);
  });
  return ranks;
}

export function queryCompanies(companies: CompanyListItem[], filters: Filters) {
  const search = filters.search.trim().toLowerCase();
  return companies.filter(c => {
    const text = [c.name, c.domain, c.industry, c.headquarters, c.why_now, ...c.contacts.flatMap(contact => [contact.name, contact.title])].filter(Boolean).join(" ").toLowerCase();
    if (search && !text.includes(search)) return false;
    if (filters.tier !== "All" && (c.score?.tier ?? "Unscored") !== filters.tier) return false;
    if ((filters.min !== null || filters.max !== null) && !c.score) return false;
    if (filters.min !== null && c.score!.total < filters.min) return false;
    if (filters.max !== null && c.score!.total > filters.max) return false;
    return true;
  }).toSorted((a, b) => {
    const tie = names.compare(a.name, b.name) || a.id.localeCompare(b.id);
    if (filters.sort.startsWith("tier")) {
      const order = { Disqualified: 0, Maybe: 1, Qualified: 2 };
      if (!a.score || !b.score) return a.score === b.score ? tie : !a.score ? 1 : -1;
      const difference = order[a.score.tier] - order[b.score.tier];
      return (filters.sort === "tier-asc" ? difference : -difference) || scoreOrder(a, b);
    }
    if (filters.sort === "name-asc") return tie;
    if (filters.sort === "name-desc") return -tie;
    if (filters.sort.startsWith("employees")) {
      if (a.employee_count === null || b.employee_count === null) return a.employee_count === b.employee_count ? tie : a.employee_count === null ? 1 : -1;
      return (filters.sort === "employees-asc" ? a.employee_count - b.employee_count : b.employee_count - a.employee_count) || tie;
    }
    if (!a.score || !b.score) return a.score === b.score ? tie : !a.score ? 1 : -1;
    return ((filters.sort === "score-asc" || filters.sort === "rank-desc") ? a.score.total - b.score.total : b.score.total - a.score.total) || tie;
  });
}
