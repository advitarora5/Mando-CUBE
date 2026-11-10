// Budget capacity for US colleges and universities (public and private) from IPEDS finance data, as republished by the
// Urban Institute Education Data API (free, no key). US public universities file no IRS 990, so the nonprofit source misses them.
// Fields (harmonized across forms): rev_total_current = total revenues and investment return, exp_total_current = total
// expenses; the difference is the year's surplus (it ties to the change in net position for public GASB filers). Urban
// maps GASB (public) and FASB (private) filers onto the same two fields, so no per-form field set is needed; the two bases
// are not strictly comparable (GASB revenue includes capital appropriations/grants; FASB includes gains), hence `surplus`.
// Urban's `year` is the fall of the academic year: year Y = fiscal year ended June 30 of Y+1 (verified against Iowa State and Harvard).
// Assumed for every institution; the few with other year-ends are off by up to a few months.
// Only an exact normalized-name match to exactly ONE unitid is accepted; the latest fiscal year must end within 36 months.
import { normalizeName } from "../domain/ingestion/normalize.ts";
import type { Financials } from "../domain/ingestion/pipeline-score.ts";

export type UniversityStatus = "found" | "no_match" | "ambiguous" | "no_filing" | "stale_filing" | "fetch_failed";
export type UniversityLookup = { financials: Financials | null; status: UniversityStatus; requests: number };
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const API = "https://educationdata.urban.org/api/v1/college-university/ipeds";
const MAX_AGE_DAYS = 1096; // 36 months
const RETRIES = 3;
const YEARS_TRIED = 3; // newest finance year first; IPEDS finance lags about two years
const HEADERS = { "User-Agent": "Mando-CUBE-experiment", Accept: "application/json" };
// At most one request per second; tests set ms to 0.
export const universityPacing = { ms: 1000 };
let last = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
type Row = Record<string, unknown>;

// GET JSON with spacing and 429 backoff. null = could not be fetched; 404 is a real answer ({}).
async function getJson(fetchFn: FetchFn, url: string, count: { n: number }): Promise<Row | null> {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const wait = last + universityPacing.ms - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    count.n++;
    let res: Response;
    try { res = await fetchFn(url, { headers: HEADERS }); } catch { return null; }
    if (res.status === 429 && attempt < RETRIES) { await sleep(universityPacing.ms * 2 ** (attempt + 1)); continue; }
    if (res.status === 404) return {};
    if (!res.ok) return null;
    try { return (await res.json()) as Row; } catch { return null; }
  }
  return null;
}
// The directory is the same for every company in a run: read it once per fetch function, never cache a failure.
const directories = new WeakMap<FetchFn, { top: number; body: Row }>();
const rows = (body: Row): Row[] => (Array.isArray(body.results) ? (body.results as Row[]) : []);

export async function lookupUniversityFinancials(fetchFn: FetchFn, companyName: string, now: Date): Promise<UniversityLookup> {
  const count = { n: 0 };
  const done = (financials: Financials | null, status: UniversityStatus): UniversityLookup => ({ financials, status, requests: count.n });
  const wanted = normalizeName(companyName);
  if (!wanted) return done(null, "no_match");

  // The name filter is ignored by the API, so read the (1 MB, name-only) directory once and match locally.
  const top = now.getUTCFullYear() - 2;
  let cached = directories.get(fetchFn);
  if (cached?.top !== top) {
    const body = await getJson(fetchFn, `${API}/directory/${top}/?fields=unitid,inst_name`, count);
    if (!body) return done(null, "fetch_failed");
    directories.set(fetchFn, cached = { top, body });
  }
  const dir = cached.body;
  const exact = rows(dir).filter(r => num(r.unitid) !== null && typeof r.inst_name === "string" && normalizeName(r.inst_name) === wanted);
  if (!exact.length) return done(null, "no_match");
  if (new Set(exact.map(r => r.unitid)).size > 1) return done(null, "ambiguous");
  const unitid = exact[0].unitid as number;
  const name = exact[0].inst_name as string;

  // undefined = fetch failed, null = no usable row for that year.
  const finance = async (year: number): Promise<{ rev: number; exp: number } | null | undefined> => {
    const body = await getJson(fetchFn, `${API}/finance/${year}/?unitid=${unitid}&fields=unitid,rev_total_current,exp_total_current`, count);
    if (!body) return undefined;
    const row = rows(body).find(r => r.unitid === unitid);
    const rev = num(row?.rev_total_current), exp = num(row?.exp_total_current);
    return rev !== null && exp !== null ? { rev, exp } : null;
  };

  let year = top, latest: { rev: number; exp: number } | null = null;
  for (; year > top - YEARS_TRIED; year--) {
    const f = await finance(year);
    if (f === undefined) return done(null, "fetch_failed");
    if (f) { latest = f; break; }
  }
  if (!latest) return done(null, "no_filing");
  const end = `${year + 1}-06-30`;
  if ((now.getTime() - Date.parse(end)) / 86400000 > MAX_AGE_DAYS) return done(null, "stale_filing");

  const prior = await finance(year - 1);
  if (prior === undefined) return done(null, "fetch_failed");
  return done({
    fiscal_year_end: end, currency: "USD",
    operating_income: latest.rev - latest.exp,
    prior_operating_income: prior ? prior.rev - prior.exp : null,
    revenue: latest.rev, prior_revenue: prior ? prior.rev : null,
    source_url: `https://nces.ed.gov/ipeds/datacenter/InstitutionProfile.aspx?unitId=${unitid}`,
    surplus: true, matched_name: name,
  }, "found");
}
