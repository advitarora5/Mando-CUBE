// Budget capacity for FDIC-insured banks that do not file with the SEC (private, mutual, subsidiary banks) from the
// FDIC BankFind Suite API (free, no key; the banks' own regulatory Call Reports). Call Reports have no operating income,
// so `operating_income` carries the bank's NET INCOME (flagged `net_income`). Income items are year-to-date, so only the
// December (full-year) report is used. FDIC amounts are in thousands of dollars. Revenue = total interest income +
// noninterest income. The NAME filter is an exact-phrase match; we additionally require equal normalizeName and exactly
// ONE active institution. Bank names are often shared ("First National Bank"): several matches => ambiguous.
import { normalizeName } from "../domain/ingestion/normalize.ts";
import type { Financials } from "../domain/ingestion/pipeline-score.ts";

export type BankStatus = "found" | "no_match" | "ambiguous" | "no_filing" | "stale_filing" | "fetch_failed";
export type BankLookup = { financials: Financials | null; status: BankStatus; requests: number };
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type Row = Record<string, unknown>;
type Body = { data?: { data?: Row }[] };

const API = "https://api.fdic.gov/banks";
const MAX_AGE_DAYS = 548; // 18 months
const RETRIES = 3;
const HEADERS = { "User-Agent": "Mando-CUBE-experiment", Accept: "application/json" };
// At most one request per second; tests set ms to 0.
export const bankPacing = { ms: 1000 };
let last = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// GET JSON with spacing and 429 backoff. null = could not be fetched.
async function getJson(fetchFn: FetchFn, url: string, count: { n: number }): Promise<Body | null> {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const wait = last + bankPacing.ms - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    count.n++;
    let res: Response;
    try { res = await fetchFn(url, { headers: HEADERS }); } catch { return null; }
    if (res.status === 429 && attempt < RETRIES) { await sleep(bankPacing.ms * 2 ** (attempt + 1)); continue; }
    if (!res.ok) return null;
    try { return (await res.json()) as Body; } catch { return null; }
  }
  return null;
}
const rows = (body: Body): Row[] => (Array.isArray(body.data) ? body.data : []).map(d => d?.data ?? {});

export async function lookupBankFinancials(fetchFn: FetchFn, companyName: string, now: Date): Promise<BankLookup> {
  const count = { n: 0 };
  const done = (financials: Financials | null, status: BankStatus): BankLookup => ({ financials, status, requests: count.n });
  const wanted = normalizeName(companyName);
  if (!wanted) return done(null, "no_match");

  const url = (path: string, filters: string, fields: string, limit: number, sort = "") =>
    `${API}/${path}?filters=${encodeURIComponent(filters)}&fields=${fields}&limit=${limit}${sort}`;
  const found = await getJson(fetchFn, url("institutions", `NAME:"${companyName.replace(/"/g, "")}" AND ACTIVE:1`, "NAME,CERT,ACTIVE", 100), count);
  if (!found) return done(null, "fetch_failed");
  const exact = rows(found).filter(r => r.ACTIVE === 1 && num(r.CERT) && typeof r.NAME === "string" && normalizeName(r.NAME) === wanted);
  if (!exact.length) return done(null, "no_match");
  if (new Set(exact.map(r => r.CERT)).size > 1) return done(null, "ambiguous");
  const cert = exact[0].CERT as number;
  const name = exact[0].NAME as string;

  const year = now.getUTCFullYear();
  const fin = await getJson(fetchFn,
    url("financials", `CERT:${cert} AND REPDTE:[${year - 3}0101 TO ${year}1231]`, "REPDTE,NETINC,INTINC,NONII", 16, "&sort_by=REPDTE&sort_order=DESC"), count);
  if (!fin) return done(null, "fetch_failed");
  const dec = rows(fin).filter(r => /^\d{4}1231$/.test(String(r.REPDTE)) && num(r.NETINC) !== null)
    .sort((a, b) => String(b.REPDTE).localeCompare(String(a.REPDTE)));
  const latest = dec[0];
  if (!latest) return done(null, "no_filing");
  const y = Number(String(latest.REPDTE).slice(0, 4));
  const end = `${y}-12-31`;
  if ((now.getTime() - Date.parse(end)) / 86400000 > MAX_AGE_DAYS) return done(null, "stale_filing");

  const prior = dec.find(r => Number(String(r.REPDTE).slice(0, 4)) === y - 1);
  const rev = (r: Row | undefined) => (r && num(r.INTINC) !== null && num(r.NONII) !== null ? ((r.INTINC as number) + (r.NONII as number)) * 1000 : null);
  return done({
    fiscal_year_end: end, currency: "USD",
    operating_income: (latest.NETINC as number) * 1000,
    prior_operating_income: prior ? (prior.NETINC as number) * 1000 : null,
    revenue: rev(latest), prior_revenue: rev(prior),
    source_url: `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${cert}`,
    net_income: true, matched_name: name,
  }, "found");
}
