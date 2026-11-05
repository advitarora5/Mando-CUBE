// Budget capacity inputs from SEC XBRL "company facts": annual operating income and revenue from the latest 10-K/20-F,
// under US GAAP or IFRS, in whatever currency the filer reports. Capacity asks only "positive?" and "grew?", so nothing
// is converted: years are compared within one currency. A company is matched by exact normalized name to one SEC CIK;
// anything ambiguous, stale or missing returns null and Budget stays "Needs evidence" for that part. Never estimated.
import { normalizeName } from "../domain/ingestion/normalize.ts";
import type { Financials } from "../domain/ingestion/pipeline-score.ts";
import type { PipelineContext } from "./types.ts";

type Concept = [taxonomy: string, tag: string];
const OPERATING: Concept[] = [["us-gaap", "OperatingIncomeLoss"], ["ifrs-full", "ProfitLossFromOperatingActivities"]];
const REVENUE: Concept[] = [
  ["us-gaap", "Revenues"], ["us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"], ["us-gaap", "RevenueFromContractWithCustomerIncludingAssessedTax"], ["us-gaap", "SalesRevenueNet"],
  ["ifrs-full", "Revenue"], ["ifrs-full", "RevenueFromContractsWithCustomers"],
];
const CURRENCY = /^[A-Z]{3}$/; // ISO codes only: units also include "shares", "pure" and "USD/shares"
const MAX_AGE_DAYS = 548; // newest fiscal year must have ended within ~18 months
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;

type Fact = { start?: string; end: string; val: number; form: string; filed: string; accn: string };
type Year = { end: string; val: number; accn: string };
type Series = { currency: string; years: Year[] };
type Facts = Record<string, Record<string, { units?: Record<string, Fact[]> }> | undefined> | null | undefined;

// One value per fiscal year end (latest filing wins), annual durations only, newest first.
function annualSeries(rows: Fact[]): Year[] {
  const byEnd = new Map<string, Fact>();
  for (const r of rows) {
    if (!r.start || !/^(10-K|20-F)/.test(r.form) || days(r.start, r.end) < 340 || days(r.start, r.end) > 390) continue;
    const kept = byEnd.get(r.end);
    if (!kept || r.filed > kept.filed) byEnd.set(r.end, r);
  }
  return [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end)).map(r => ({ end: r.end, val: r.val, accn: r.accn }));
}

// One concept's series, in its most current currency (a filer can change reporting currency, or add a short translation).
function conceptSeries(facts: Facts, [taxonomy, tag]: Concept, currency?: string): Series | null {
  return Object.entries(facts?.[taxonomy]?.[tag]?.units ?? {})
    .filter(([unit]) => CURRENCY.test(unit) && (!currency || unit === currency))
    .map(([unit, rows]) => ({ currency: unit, years: annualSeries(rows) }))
    .filter(s => s.years.length)
    .sort((a, b) => b.years[0].end.localeCompare(a.years[0].end) || b.years.length - a.years.length)[0] ?? null;
}

// Several tags can describe a figure and old ones go stale (a tag may stop years ago): take the one with the newest year.
function newest(facts: Facts, concepts: Concept[], currency?: string): Series | null {
  return concepts.map(concept => conceptSeries(facts, concept, currency)).filter((s): s is Series => !!s).sort((a, b) => b.years[0].end.localeCompare(a.years[0].end))[0] ?? null;
}
const priorOf = (series: Year[]) => series.find(y => days(y.end, series[0].end) > 350 && days(y.end, series[0].end) < 380)?.val ?? null;

export function parseFinancials(rawFacts: unknown, cik: number, now: Date): Financials | null {
  const facts = rawFacts as Facts;
  const operating = newest(facts, OPERATING);
  if (!operating) return null;
  const op = operating.years;
  if (days(op[0].end, now.toISOString().slice(0, 10)) > MAX_AGE_DAYS) return null;
  const rev = newest(facts, REVENUE, operating.currency)?.years ?? [];
  // Revenue must be for the same fiscal year as operating income, or its growth says nothing about it.
  const sameYear = rev.length && rev[0].end === op[0].end;
  // Some banks tag total income as their operating figure (ING: both EUR 25.68B, pre-tax profit EUR 11.79B). That is not profit.
  if (sameYear && rev[0].val === op[0].val) return null;
  return {
    fiscal_year_end: op[0].end, currency: operating.currency, operating_income: op[0].val, prior_operating_income: priorOf(op),
    revenue: sameYear ? rev[0].val : null, prior_revenue: sameYear ? priorOf(rev) : null,
    source_url: `https://www.sec.gov/Archives/edgar/data/${cik}/${op[0].accn.replace(/-/g, "")}/`,
  };
}

type SecEntry = { title?: string; cik_str?: number };

// Normalized SEC name -> CIK, only where every entry with that name has the same CIK (share classes share one).
export function cikIndex(secListJson: string): Map<string, number> {
  const index = new Map<string, number>(), ambiguous = new Set<string>();
  let entries: SecEntry[] = [];
  try { entries = Object.values(JSON.parse(secListJson) as Record<string, SecEntry>); } catch { return index; }
  for (const e of entries) {
    const name = normalizeName(e?.title);
    if (!name || !e.cik_str) continue;
    if (index.has(name) && index.get(name) !== e.cik_str) ambiguous.add(name);
    else index.set(name, e.cik_str);
  }
  for (const name of ambiguous) index.delete(name);
  return index;
}

// Why a company has filing figures or not. The run reports these counts, so missing capacity is never silent.
export type FinancialsStatus = "found" | "no_contact" | "no_sec_list" | "fetch_failed" | "no_sec_match" | "no_filing_facts" | "no_operating_income" | "stale_filing";
export type FinancialsLookup = { financials: Financials | null; status: FinancialsStatus; requests: number };

// The lookup could not run, which says nothing about the company. Every other status is an answer about its filings.
export const financialsUnavailable = (status: FinancialsStatus) => status === "no_contact" || status === "no_sec_list" || status === "fetch_failed";

export function classifyFacts(rawFacts: unknown, cik: number, now: Date): Pick<FinancialsLookup, "financials" | "status"> {
  const financials = parseFinancials(rawFacts, cik, now);
  if (financials) return { financials, status: "found" };
  const facts = rawFacts as Facts;
  // Banks and insurers often report no operating income. It is not estimated.
  if (!facts?.["us-gaap"] && !facts?.["ifrs-full"]) return { financials: null, status: "no_filing_facts" };
  const operating = newest(facts, OPERATING);
  const isCurrent = operating && days(operating.years[0].end, now.toISOString().slice(0, 10)) <= MAX_AGE_DAYS;
  return { financials: null, status: operating && !isCurrent ? "stale_filing" : "no_operating_income" };
}

type LookupState = { index: Map<string, number> | null; byCik: Map<number, Pick<FinancialsLookup, "financials" | "status">>; stopped: boolean };
const cache = new WeakMap<PipelineContext, LookupState>();

// Financials for one company, with the reason when there are none. Needs the SEC list capture and PIPELINE_CONTACT
// (the SEC answers 403 without one). The first failed SEC call stops further calls for this context.
export async function lookupFinancials(ctx: PipelineContext, companyName: string): Promise<FinancialsLookup> {
  if (!ctx.contact) return { financials: null, status: "no_contact", requests: 0 };
  let state = cache.get(ctx);
  if (!state) { state = { index: null, byCik: new Map(), stopped: false }; cache.set(ctx, state); }
  if (!state.index) {
    const capture = await ctx.store.latestCapture("sec-company-list");
    state.index = capture ? cikIndex(capture.body) : new Map();
  }
  if (!state.index.size) return { financials: null, status: "no_sec_list", requests: 0 };
  const cik = state.index.get(normalizeName(companyName));
  if (!cik) return { financials: null, status: "no_sec_match", requests: 0 };
  const known = state.byCik.get(cik);
  if (known) return { ...known, requests: 0 };
  if (state.stopped) return { financials: null, status: "fetch_failed", requests: 0 };
  let found: Pick<FinancialsLookup, "financials" | "status"> = { financials: null, status: "fetch_failed" };
  try {
    // The SEC wants "Name contact" as the User-Agent; the pipeline's standard agent string is answered with 403.
    const res = await ctx.fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`, {
      headers: { "user-agent": `Mando-CUBE ${ctx.contact}`, accept: "application/json" }, signal: AbortSignal.timeout(30000),
    });
    if (res.ok) found = classifyFacts(((await res.json()) as { facts?: unknown }).facts, cik, ctx.now());
    else if (res.status === 404) found = { financials: null, status: "no_filing_facts" }; // the SEC has no XBRL facts for this CIK
    else { ctx.log.warn(`SEC company facts ${cik}: HTTP ${res.status}`); state.stopped = true; }
  } catch (error) { ctx.log.warn(`SEC company facts ${cik}: ${(error as Error).message}`); state.stopped = true; }
  await ctx.sleep(150); // SEC fair access: at most 10 requests a second
  state.byCik.set(cik, found);
  return { ...found, requests: 1 };
}
