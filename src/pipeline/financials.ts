// Budget capacity inputs from SEC XBRL "company facts": annual operating income and revenue from the latest 10-K/20-F.
// A company is matched by exact normalized name to one SEC CIK; anything ambiguous, foreign (IFRS), stale or missing
// returns null and Budget stays "Needs evidence" for that part. Never estimated.
import { normalizeName } from "../domain/ingestion/normalize.ts";
import type { Financials } from "../domain/ingestion/pipeline-score.ts";
import type { PipelineContext } from "./types.ts";

const OPERATING = ["OperatingIncomeLoss"];
const REVENUE = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"];
const MAX_AGE_DAYS = 548; // newest fiscal year must have ended within ~18 months
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;

type Fact = { start?: string; end: string; val: number; form: string; filed: string; accn: string };
type Year = { end: string; val: number; accn: string };
type Facts = { "us-gaap"?: Record<string, { units?: { USD?: Fact[] } }> } | null | undefined;

// One value per fiscal year end (latest filing wins), annual durations only, newest first.
function annualSeries(facts: Facts, tag: string): Year[] {
  const rows = facts?.["us-gaap"]?.[tag]?.units?.USD ?? [];
  const byEnd = new Map<string, Fact>();
  for (const r of rows) {
    if (!r.start || !/^(10-K|20-F)/.test(r.form) || days(r.start, r.end) < 340 || days(r.start, r.end) > 390) continue;
    const kept = byEnd.get(r.end);
    if (!kept || r.filed > kept.filed) byEnd.set(r.end, r);
  }
  return [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end)).map(r => ({ end: r.end, val: r.val, accn: r.accn }));
}

// Several tags can describe revenue and old ones go stale (a tag may stop years ago): take the one with the newest year.
function newest(facts: Facts, tags: string[]): Year[] {
  return tags.map(tag => annualSeries(facts, tag)).filter(s => s.length).sort((a, b) => b[0].end.localeCompare(a[0].end))[0] ?? [];
}
const priorOf = (series: Year[]) => series.find(y => days(y.end, series[0].end) > 350 && days(y.end, series[0].end) < 380)?.val ?? null;

export function parseFinancials(rawFacts: unknown, cik: number, now: Date): Financials | null {
  const facts = rawFacts as Facts;
  const op = newest(facts, OPERATING);
  if (!op.length || days(op[0].end, now.toISOString().slice(0, 10)) > MAX_AGE_DAYS) return null;
  const rev = newest(facts, REVENUE);
  // Revenue must be for the same fiscal year as operating income, or its growth says nothing about it.
  const sameYear = rev.length && rev[0].end === op[0].end;
  return {
    fiscal_year_end: op[0].end, operating_income: op[0].val, prior_operating_income: priorOf(op),
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

const cache = new WeakMap<PipelineContext, { index: Map<string, number> | null; byCik: Map<number, Financials | null> }>();

// Financials for one company, or null. Needs the SEC list capture and PIPELINE_CONTACT (the SEC answers 403 without one).
export async function financialsFor(ctx: PipelineContext, companyName: string): Promise<Financials | null> {
  if (!ctx.contact) return null;
  let state = cache.get(ctx);
  if (!state) { state = { index: null, byCik: new Map() }; cache.set(ctx, state); }
  if (!state.index) {
    const capture = await ctx.store.latestCapture("sec-company-list");
    state.index = capture ? cikIndex(capture.body) : new Map();
  }
  const cik = state.index.get(normalizeName(companyName));
  if (!cik) return null;
  if (state.byCik.has(cik)) return state.byCik.get(cik)!;
  let found: Financials | null = null;
  try {
    // The SEC wants "Name contact" as the User-Agent; the pipeline's standard agent string is answered with 403.
    const res = await ctx.fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`, {
      headers: { "user-agent": `Mando-CUBE ${ctx.contact}`, accept: "application/json" }, signal: AbortSignal.timeout(30000),
    });
    if (res.ok) found = parseFinancials(((await res.json()) as { facts?: unknown }).facts, cik, ctx.now());
    else ctx.log.warn(`SEC company facts ${cik}: HTTP ${res.status}`);
  } catch (error) { ctx.log.warn(`SEC company facts ${cik}: ${(error as Error).message}`); }
  await ctx.sleep(150); // SEC fair access: at most 10 requests a second
  state.byCik.set(cik, found);
  return found;
}
