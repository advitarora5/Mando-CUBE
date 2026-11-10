// Budget capacity inputs from SEC XBRL "company facts": annual operating income and revenue from the latest 10-K/20-F/40-F,
// under US GAAP or IFRS, in whatever currency the filer reports. Capacity asks only "positive?" and "grew?", so nothing
// is converted: years are compared within one currency. A company is matched by exact normalized name to one SEC CIK;
// anything ambiguous, stale or missing returns null and Budget stays "Needs evidence" for that part. Never estimated.
// A filer with no usable operating figure (banks and insurers often have none) falls back to pre-tax income, labeled as such.
import { normalizeName } from "../domain/ingestion/normalize.ts";
import type { Financials } from "../domain/ingestion/pipeline-score.ts";
import { BANK_ALLOWLIST, SEC_ALIASES } from "./financial-aliases.ts";
import { lookupBankFinancials } from "./financials-bank.ts";
import { lookupForeignFinancials } from "./financials-foreign.ts";
import { lookupNonprofitFinancials } from "./financials-nonprofit.ts";
import { lookupUniversityFinancials } from "./financials-university.ts";
import type { PipelineContext } from "./types.ts";

type Concept = [taxonomy: string, tag: string];
const OPERATING: Concept[] = [["us-gaap", "OperatingIncomeLoss"], ["ifrs-full", "ProfitLossFromOperatingActivities"]];
const PRE_TAX: Concept[] = [
  ["us-gaap", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"],
  ["us-gaap", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"],
  ["us-gaap", "IncomeLossIncludingPortionAttributableToNoncontrollingInterestBeforeIncomeTaxes"],
  ["ifrs-full", "ProfitLossBeforeTax"],
];
// Last resort when a filer has neither operating nor pre-tax income.
const NET_INCOME: Concept[] = [["us-gaap", "NetIncomeLoss"], ["us-gaap", "ProfitLoss"], ["ifrs-full", "ProfitLoss"]];
// Shown as evidence only: it confirms the profit is cash, and never changes the points.
const CASH_FLOW: Concept[] = [["us-gaap", "NetCashProvidedByUsedInOperatingActivities"], ["ifrs-full", "CashFlowsFromUsedInOperatingActivities"]];
const REVENUE: Concept[] = [
  ["us-gaap", "Revenues"], ["us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"], ["us-gaap", "RevenueFromContractWithCustomerIncludingAssessedTax"], ["us-gaap", "SalesRevenueNet"],
  ["ifrs-full", "Revenue"], ["ifrs-full", "RevenueFromContractsWithCustomers"],
  // Banks: total revenue net of interest expense (Wells Fargo) and revenue and operating income (UBS). Last, so a plain revenue tag still wins a tie.
  ["us-gaap", "RevenuesNetOfInterestExpense"], ["ifrs-full", "RevenueAndOperatingIncome"],
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
    if (!r.start || !/^(10-K|20-F|40-F)/.test(r.form) || days(r.start, r.end) < 340 || days(r.start, r.end) > 390) continue;
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
const isCurrent = (series: Series | null, now: Date): series is Series => !!series && days(series.years[0].end, now.toISOString().slice(0, 10)) <= MAX_AGE_DAYS;
const priorOf = (series: Year[]) => series.find(y => days(y.end, series[0].end) > 350 && days(y.end, series[0].end) < 380)?.val ?? null;

export function parseFinancials(rawFacts: unknown, cik: number, now: Date): Financials | null {
  const facts = rawFacts as Facts;
  const operating = newest(facts, OPERATING);
  // Some banks tag total income as their operating figure (ING: both EUR 25.68B, pre-tax profit EUR 11.79B). That is not profit.
  const revenueLatest = (series: Series) => newest(facts, REVENUE, series.currency)?.years[0];
  const isTotalIncome = (series: Series) => { const r = revenueLatest(series); return r?.end === series.years[0].end && r.val === series.years[0].val; };
  const usable = isCurrent(operating, now) && !isTotalIncome(operating) ? operating : null;
  const preTax = newest(facts, PRE_TAX), net = newest(facts, NET_INCOME);
  const income = usable ?? (isCurrent(preTax, now) ? preTax : isCurrent(net, now) ? net : null);
  if (!income) return null;
  const years = income.years;
  const cash = newest(facts, CASH_FLOW, income.currency)?.years[0];
  const rev = newest(facts, REVENUE, income.currency)?.years ?? [];
  // Revenue must be for the same fiscal year as the income figure, or its growth says nothing about it.
  const sameYear = rev.length && rev[0].end === years[0].end;
  return {
    fiscal_year_end: years[0].end, currency: income.currency, operating_income: years[0].val, prior_operating_income: priorOf(years),
    revenue: sameYear ? rev[0].val : null, prior_revenue: sameYear ? priorOf(rev) : null,
    source_url: `https://www.sec.gov/Archives/edgar/data/${cik}/${years[0].accn.replace(/-/g, "")}/`,
    ...(usable ? {} : income === net && income !== preTax ? { net_income: true } : { pre_tax: true }),
    ...(cash?.end === years[0].end ? { operating_cash_flow: cash.val } : {}),
  };
}

// A hand-checked alias wins; otherwise an exact normalized-name match. Never a prefix or fuzzy match: those attached the wrong company in testing.
export function secCikFor(index: Map<string, number>, companyName: string): number | undefined {
  // A name can carry a note in parentheses ("Concentrix (formerly Convergys)", "Black Rifle Coffee Company (BRC Inc.)"): try the whole name,
  // then the name without the note, then the note itself. Each is still an exact match.
  const notes = [...companyName.matchAll(/\(([^)]*)\)/g)].map(m => m[1]);
  const tries = [companyName, companyName.replace(/\([^)]*\)/g, " "), ...notes].map(normalizeName).filter(Boolean);
  for (const key of tries) { const cik = SEC_ALIASES[key] ?? index.get(key); if (cik) return cik; }
  return undefined;
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
  const figure = newest(facts, OPERATING) ?? newest(facts, PRE_TAX) ?? newest(facts, NET_INCOME);
  return { financials: null, status: figure && !isCurrent(figure, now) ? "stale_filing" : "no_operating_income" };
}

type LookupState = { index: Map<string, number> | null; byCik: Map<number, Pick<FinancialsLookup, "financials" | "status">>; stopped: boolean };
const cache = new WeakMap<PipelineContext, LookupState>();

// Financials for one company, with the reason when there are none. Needs the SEC list capture and PIPELINE_CONTACT
// (the SEC answers 403 without one). The first failed SEC call stops further calls for this context.
async function lookupSecFinancials(ctx: PipelineContext, companyName: string): Promise<FinancialsLookup> {
  if (!ctx.contact) return { financials: null, status: "no_contact", requests: 0 };
  let state = cache.get(ctx);
  if (!state) { state = { index: null, byCik: new Map(), stopped: false }; cache.set(ctx, state); }
  if (!state.index) {
    const capture = await ctx.store.latestCapture("sec-company-list");
    state.index = capture ? cikIndex(capture.body) : new Map();
  }
  if (!state.index.size) return { financials: null, status: "no_sec_list", requests: 0 };
  const cik = secCikFor(state.index, companyName);
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

// SEC first. A name the SEC list does not have is then tried against nonprofit annual returns (IRS 990), US university finance data (IPEDS),
// EU/UK annual filings and, for
// hand-checked names only, FDIC bank reports;
// each accepts only an exact, confirmed match. Their misses keep the SEC answer; an outage is reported as one so a saved score is kept.
// ponytail: these lookups run on every score pass (about 6 paced requests per unmatched company); cache them in a table if that gets slow.
export async function lookupFinancials(ctx: PipelineContext, companyName: string, domain: string | null = null): Promise<FinancialsLookup> {
  const sec = await lookupSecFinancials(ctx, companyName);
  if (sec.status !== "no_sec_match") return sec;
  let requests = sec.requests, status: FinancialsStatus = sec.status;
  const sources = [() => lookupNonprofitFinancials(ctx.fetch, companyName, ctx.now()), () => lookupUniversityFinancials(ctx.fetch, companyName, ctx.now()), () => lookupForeignFinancials(ctx.fetch, companyName, domain, ctx.now())];
  if (BANK_ALLOWLIST.has(normalizeName(companyName))) sources.push(() => lookupBankFinancials(ctx.fetch, companyName, ctx.now()));
  for (const source of sources) {
    const found = await source();
    requests += found.requests;
    if (found.status === "found") return { financials: found.financials, status: "found", requests };
    if (found.status === "fetch_failed" || found.status === "stale_filing") status = found.status;
  }
  return { financials: null, status, requests };
}
