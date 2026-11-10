// Budget capacity inputs for companies that do not file with the SEC, from the free, keyless filings.xbrl.org index of
// ESEF/UK annual reports (IFRS, mostly EU/UK/Nordic listed companies; entities are keyed by LEI). Identity is the risk, so a
// company is accepted only when ONE filing entity's name equals the company's name after normalization (exact, never
// prefix or fuzzy) AND Wikidata, an independent source, agrees: the entity's LEI belongs to a Wikidata item whose official
// website matches the given domain (or, with no domain given, whose label equals the name). Everything else returns null.
// Japan, Australia, Korea, Taiwan, India etc. are not in this index, so they return no_match. Never estimated or converted.
import { normalizeDomain, normalizeName } from "../domain/ingestion/normalize.ts";
import type { Financials } from "../domain/ingestion/pipeline-score.ts";
import { FOREIGN_LEI_ALIASES } from "./financial-aliases.ts";

export type ForeignStatus = "found" | "no_match" | "ambiguous" | "no_filing" | "stale_filing" | "fetch_failed";
export type ForeignLookup = { financials: Financials | null; status: ForeignStatus; requests: number };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const XBRL = "https://filings.xbrl.org";
const MAX_AGE_DAYS = 548;
export const pacing = { gapMs: 1000 }; // at most 1 request a second; tests set it to 0
// Local legal forms normalizeName does not know ("SAAB Aktiebolag", "Kone Oyj", "Equinor ASA").
const LOCAL_FORMS = new Set(["ab", "aktiebolag", "publ", "oyj", "abp", "asa", "as", "kk", "ltd", "srl", "sas", "nv", "spa", "ag", "kgaa", "sarl", "oy", "a", "s"]);
const key = (name: string | null | undefined) => normalizeName((name ?? "").replace(/\([^)]*\)/g, " ").replace(/\./g, "")).split(" ").filter(w => !LOCAL_FORMS.has(w)).join(" ");
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Concept = string;
const OPERATING: Concept[] = ["ifrs-full:ProfitLossFromOperatingActivities"];
const PRE_TAX: Concept[] = ["ifrs-full:ProfitLossBeforeTax"];
const NET_INCOME: Concept[] = ["ifrs-full:ProfitLoss"];
const REVENUE: Concept[] = ["ifrs-full:Revenue", "ifrs-full:RevenueFromContractsWithCustomers", "ifrs-full:RevenueAndOperatingIncome"];

type Fact = { value?: string | number; dimensions?: Record<string, string> };
type Year = { end: string; val: number };
type Series = { currency: string; years: Year[] };

// Plain annual facts only: exactly concept/entity/period/unit (no segment or parent-only dimensions), newest year first.
function series(facts: Fact[], lei: string, concepts: Concept[], currency?: string): Series | null {
  const out: Series[] = [];
  for (const concept of concepts) {
    const byUnit = new Map<string, Map<string, number>>();
    for (const f of facts) {
      const d = f.dimensions;
      if (!d || d.concept !== concept || d.entity !== `scheme:${lei}` || Object.keys(d).length !== 4) continue;
      const unit = /^iso4217:([A-Z]{3})$/.exec(d.unit ?? "")?.[1], [start, end] = (d.period ?? "").split("/");
      const val = Number(f.value);
      if (!unit || !end || !start || !Number.isFinite(val) || (currency && unit !== currency)) continue;
      const last = new Date(Date.parse(end) - (end.endsWith("T00:00:00") ? 86400000 : 0)).toISOString().slice(0, 10); // period ends are exclusive
      if (days(start.slice(0, 10), last) < 340 || days(start.slice(0, 10), last) > 390) continue;
      if (!byUnit.has(unit)) byUnit.set(unit, new Map());
      byUnit.get(unit)!.set(last, val);
    }
    for (const [unit, years] of byUnit) out.push({ currency: unit, years: [...years].map(([end, val]) => ({ end, val })).sort((a, b) => b.end.localeCompare(a.end)) });
  }
  return out.sort((a, b) => b.years[0].end.localeCompare(a.years[0].end))[0] ?? null;
}
const priorOf = (years: Year[]) => years.find(y => days(y.end, years[0].end) > 350 && days(y.end, years[0].end) < 380)?.val ?? null;

// Pure: one xBRL-JSON report -> Financials, or the reason there are none.
export function parseForeign(report: unknown, lei: string, now: Date, matchedName: string, sourceUrl: string): { financials: Financials | null; status: "found" | "no_filing" | "stale_filing" } {
  const facts = Object.values((report as { facts?: Record<string, Fact> })?.facts ?? {});
  const current = (s: Series | null): s is Series => !!s && days(s.years[0].end, now.toISOString().slice(0, 10)) <= MAX_AGE_DAYS;
  const operating = series(facts, lei, OPERATING), preTax = series(facts, lei, PRE_TAX), net = series(facts, lei, NET_INCOME);
  // Banks sometimes tag total income as operating profit: equal to revenue in the same year is not profit.
  const totalIncome = (s: Series) => { const r = series(facts, lei, REVENUE, s.currency)?.years[0]; return r?.end === s.years[0].end && r.val === s.years[0].val; };
  const usable = current(operating) && !totalIncome(operating) ? operating : null;
  const income = usable ?? (current(preTax) ? preTax : current(net) ? net : null);
  if (!income) return { financials: null, status: [operating, preTax, net].some(Boolean) ? "stale_filing" : "no_filing" };
  const rev = series(facts, lei, REVENUE, income.currency)?.years ?? [];
  const same = rev.length > 0 && rev[0].end === income.years[0].end;
  return {
    status: "found",
    financials: {
      fiscal_year_end: income.years[0].end, currency: income.currency, operating_income: income.years[0].val, prior_operating_income: priorOf(income.years),
      revenue: same ? rev[0].val : null, prior_revenue: same ? priorOf(rev) : null, source_url: sourceUrl, matched_name: matchedName,
      ...(usable ? {} : income === net && income !== preTax ? { net_income: true } : { pre_tax: true }),
    },
  };
}

type Attr = Record<string, string>;
const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

export async function lookupForeignFinancials(fetchFn: Fetch, companyName: string, domain: string | null, now: Date): Promise<ForeignLookup> {
  let requests = 0, last = 0;
  const get = async (url: string, accept: string): Promise<unknown> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = last + pacing.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now(); requests++;
      const res = await fetchFn(url, { headers: { "user-agent": "Mando-CUBE-experiment", accept }, signal: AbortSignal.timeout(60000) });
      if (res.status === 429) { await sleep(pacing.gapMs * 2 ** (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }
    throw new Error("HTTP 429");
  };
  const done = (status: ForeignStatus, financials: Financials | null = null): ForeignLookup => ({ financials, status, requests });
  const wanted = key(companyName), words = wanted.split(" ").filter(Boolean);
  if (!words.length) return done("no_match");
  try {
    // A hand-checked LEI alias skips the name search and the Wikidata confirmation; otherwise:
    const alias = FOREIGN_LEI_ALIASES[wanted];
    let lei: string, matchedName: string;
    if (alias) ({ lei, name: matchedName } = alias);
    else {
      // 1. Candidate entities, exact normalized-name equality only.
      const filter = JSON.stringify([{ name: "name", op: "ilike", val: `%${words.join("%")}%` }]);
      const entities = ((await get(`${XBRL}/api/entities?filter=${encodeURIComponent(filter)}&page%5Bsize%5D=100`, "application/json")) as { data?: { attributes?: Attr }[] }).data ?? [];
      const exact = entities.map(e => e.attributes).filter((a): a is Attr => !!a?.identifier && key(a.name) === wanted);
      if (!exact.length) return done("no_match");
      if (new Set(exact.map(a => a.identifier)).size > 1) return done("ambiguous");
      ({ identifier: lei, name: matchedName } = exact[0]);
      // 2. Independent confirmation: the same LEI on a Wikidata item whose website is the given domain.
      const sparql = `SELECT ?l ?w WHERE { ?i wdt:P1278 "${lei.replace(/[^A-Z0-9]/g, "")}". OPTIONAL { ?i wdt:P856 ?w } OPTIONAL { ?i rdfs:label ?l FILTER(lang(?l)="en") } }`;
      const rows = ((await get(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, "application/sparql-results+json")) as { results?: { bindings?: Record<string, { value: string }>[] } }).results?.bindings ?? [];
      const given = normalizeDomain(domain);
      const sites = rows.map(r => normalizeDomain(r.w?.value)).filter((d): d is string => !!d);
      const confirmed = given ? sites.some(site => sameSite(site, given)) : rows.some(r => key(r.l?.value) === wanted);
      if (!confirmed) return done("ambiguous");
    }
    // 3. Newest annual filing for that LEI, then its figures.
    const fFilter = JSON.stringify([{ name: "entity.identifier", op: "eq", val: lei }]);
    const filings = ((await get(`${XBRL}/api/filings?filter=${encodeURIComponent(fFilter)}&sort=-period_end&page%5Bsize%5D=3`, "application/json")) as { data?: { attributes?: Attr }[] }).data ?? [];
    const filing = filings.map(f => f.attributes).find(a => a?.json_url && a.period_end);
    if (!filing) return done("no_filing");
    if (days(filing.period_end, now.toISOString().slice(0, 10)) > MAX_AGE_DAYS) return done("stale_filing");
    const report = await get(`${XBRL}${filing.json_url}`, "application/json");
    const parsed = parseForeign(report, lei, now, matchedName, `${XBRL}${filing.viewer_url ?? filing.report_url ?? ""}`);
    return done(parsed.status, parsed.financials);
  } catch {
    return done("fetch_failed");
  }
}
