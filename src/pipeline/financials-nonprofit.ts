// Budget capacity for US nonprofits (hospitals, private universities, foundations) from the IRS Form 990 data that
// ProPublica Nonprofit Explorer republishes (free, no key). "Surplus" is the return's own total revenue minus total
// expenses: a nonprofit has no operating income, so the figure is flagged `surplus` and never presented as one.
// Only an exact normalized-name match to exactly ONE organization is accepted, and only a return whose tax period ended
// within 36 months (990s are filed 1-2 years late). Public universities and foreign bodies do not file 990s: no_match.
import { normalizeName } from "../domain/ingestion/normalize.ts";
import type { Financials } from "../domain/ingestion/pipeline-score.ts";

export type NonprofitStatus = "found" | "no_match" | "ambiguous" | "no_filing" | "stale_filing" | "fetch_failed";
export type NonprofitLookup = { financials: Financials | null; status: NonprofitStatus; requests: number };
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const API = "https://projects.propublica.org/nonprofits/api/v2";
const MAX_AGE_DAYS = 1096; // 36 months
const RETRIES = 3;
const HEADERS = { "User-Agent": "mando-cube-ingestion/1.0", Accept: "application/json" };
// At most one request per second; tests set ms to 0.
export const nonprofitPacing = { ms: 1000 };
let last = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Filing = { tax_prd?: number | null; totrevenue?: number | null; totfuncexpns?: number | null; pdf_url?: string | null };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
// 202312 -> 2023-12-31 (last day of that month).
const periodEnd = (prd: number) => new Date(Date.UTC(Math.floor(prd / 100), prd % 100, 0)).toISOString().slice(0, 10);

// GET JSON with spacing and 429 backoff. null = could not be fetched; 404 is a real answer ({}).
async function getJson(fetchFn: FetchFn, url: string, count: { n: number }): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const wait = last + nonprofitPacing.ms - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    count.n++;
    let res: Response;
    try { res = await fetchFn(url, { headers: HEADERS }); } catch { return null; }
    if (res.status === 429 && attempt < RETRIES) { await sleep(nonprofitPacing.ms * 2 ** (attempt + 1)); continue; }
    if (res.status === 404) return {};
    if (!res.ok) return null;
    try { return (await res.json()) as Record<string, unknown>; } catch { return null; }
  }
  return null;
}

export async function lookupNonprofitFinancials(fetchFn: FetchFn, companyName: string, now: Date): Promise<NonprofitLookup> {
  const count = { n: 0 };
  const done = (financials: Financials | null, status: NonprofitStatus): NonprofitLookup => ({ financials, status, requests: count.n });
  const wanted = normalizeName(companyName);
  if (!wanted) return done(null, "no_match");

  const search = await getJson(fetchFn, `${API}/search.json?q=${encodeURIComponent(companyName)}`, count);
  if (!search) return done(null, "fetch_failed");
  const orgs = (Array.isArray(search.organizations) ? search.organizations : []) as { ein?: number; name?: string }[];
  const exact = orgs.filter(o => o.ein && o.name && normalizeName(o.name) === wanted);
  if (!exact.length) return done(null, "no_match");
  if (new Set(exact.map(o => o.ein)).size > 1) return done(null, "ambiguous");
  const { ein, name } = exact[0];

  const detail = await getJson(fetchFn, `${API}/organizations/${ein}.json`, count);
  if (!detail) return done(null, "fetch_failed");
  const filings = ((Array.isArray(detail.filings_with_data) ? detail.filings_with_data : []) as Filing[])
    .filter(f => num(f.tax_prd) && num(f.totrevenue) !== null && num(f.totfuncexpns) !== null)
    .sort((a, b) => b.tax_prd! - a.tax_prd!);
  const latest = filings[0];
  if (!latest) return done(null, "no_filing");
  const end = periodEnd(latest.tax_prd!);
  if ((now.getTime() - Date.parse(end)) / 86400000 > MAX_AGE_DAYS) return done(null, "stale_filing");

  // Revenue exactly equal to expenses is a pass-through parent or shell (Rochester Regional Health's 990 shows $41M, not the system): not a real result.
  if (latest.totrevenue === latest.totfuncexpns) return done(null, "no_filing");

  const prior = filings.find(f => f.tax_prd === latest.tax_prd! - 100); // same month, previous year
  return done({
    fiscal_year_end: end, currency: "USD",
    operating_income: latest.totrevenue! - latest.totfuncexpns!,
    prior_operating_income: prior ? prior.totrevenue! - prior.totfuncexpns! : null,
    revenue: latest.totrevenue!, prior_revenue: prior ? prior.totrevenue! : null,
    source_url: latest.pdf_url || `https://projects.propublica.org/nonprofits/organizations/${ein}`,
    surplus: true, matched_name: name,
  }, "found");
}
