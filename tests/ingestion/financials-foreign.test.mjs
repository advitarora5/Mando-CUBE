import test from "node:test";
import assert from "node:assert/strict";
import { lookupForeignFinancials, pacing } from "../../src/pipeline/financials-foreign.ts";

pacing.gapMs = 0;
const NOW = new Date("2026-11-09T00:00:00Z");
const LEI = "549300ZHO4JCQQI13M69";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const fact = (concept, start, end, value, unit = "SEK") => ({ value: String(value), dimensions: { concept, entity: `scheme:${LEI}`, period: `${start}T00:00:00/${end}T00:00:00`, unit: `iso4217:${unit}` } });
const report = (...extra) => ({ facts: Object.fromEntries([
  fact("ifrs-full:Revenue", "2025-01-01", "2026-01-01", 200), fact("ifrs-full:Revenue", "2024-01-01", "2025-01-01", 100),
  ...extra].map((f, i) => [`f${i}`, f])) });
const OPERATING = [fact("ifrs-full:ProfitLossFromOperatingActivities", "2025-01-01", "2026-01-01", 30), fact("ifrs-full:ProfitLossFromOperatingActivities", "2024-01-01", "2025-01-01", 20)];

// Routes by URL; `o` overrides the entity list, Wikidata rows, filings and report.
function router(o = {}) {
  const entities = o.entities ?? [{ attributes: { identifier: LEI, name: "SAAB Aktiebolag" } }];
  const wiki = o.wiki ?? [{ l: { value: "Saab Group" }, w: { value: "https://www.saab.com/" } }];
  const filings = o.filings ?? [{ attributes: { period_end: "2025-12-31", json_url: "/x/r.json", viewer_url: "/x/viewer.html" } }];
  return async url => {
    if (o.fail) throw new Error("network");
    if (url.includes("/api/entities")) return json({ data: entities });
    if (url.includes("query.wikidata.org")) return json({ results: { bindings: wiki } });
    if (url.includes("/api/filings")) return json({ data: filings });
    return json(o.report ?? report(...OPERATING));
  };
}

test("found: operating profit, prior year, revenue for the same year", async () => {
  const r = await lookupForeignFinancials(router(), "Saab", "saab.com", NOW);
  assert.equal(r.status, "found");
  assert.equal(r.requests, 4);
  assert.deepEqual(r.financials, { fiscal_year_end: "2025-12-31", currency: "SEK", operating_income: 30, prior_operating_income: 20, revenue: 200, prior_revenue: 100,
    source_url: "https://filings.xbrl.org/x/viewer.html", matched_name: "SAAB Aktiebolag" });
});

test("pre-tax fallback when there is no operating figure", async () => {
  const pre = fact("ifrs-full:ProfitLossBeforeTax", "2025-01-01", "2026-01-01", 50);
  const r = await lookupForeignFinancials(router({ report: report(pre) }), "Saab", "saab.com", NOW);
  assert.equal(r.financials.operating_income, 50);
  assert.equal(r.financials.pre_tax, true);
  assert.equal(r.financials.prior_operating_income, null);
});

test("currency of the filing is kept and revenue in another currency is ignored", async () => {
  const eur = [fact("ifrs-full:ProfitLossFromOperatingActivities", "2025-01-01", "2026-01-01", 7, "EUR")];
  const rep = { facts: Object.fromEntries([...eur, fact("ifrs-full:Revenue", "2025-01-01", "2026-01-01", 900, "SEK")].map((f, i) => [`f${i}`, f])) };
  const r = await lookupForeignFinancials(router({ report: rep }), "Saab", "saab.com", NOW);
  assert.equal(r.financials.currency, "EUR");
  assert.equal(r.financials.revenue, null);
});

test("ambiguous: two entities with the same name, or a website that does not match", async () => {
  const two = [{ attributes: { identifier: LEI, name: "Saab AB" } }, { attributes: { identifier: "OTHERLEI00000000000X", name: "SAAB Aktiebolag" } }];
  assert.equal((await lookupForeignFinancials(router({ entities: two }), "Saab", "saab.com", NOW)).status, "ambiguous");
  const wrongSite = await lookupForeignFinancials(router(), "Saab", "example.org", NOW);
  assert.equal(wrongSite.status, "ambiguous");
  assert.equal(wrongSite.financials, null);
});

test("no_match: prefix names are not accepted", async () => {
  const r = await lookupForeignFinancials(router({ entities: [{ attributes: { identifier: LEI, name: "Saab Barracuda AB" } }] }), "Saab", "saab.com", NOW);
  assert.equal(r.status, "no_match");
  assert.equal(r.requests, 1);
});

test("stale: newest fiscal year ended more than 18 months ago", async () => {
  const old = [{ attributes: { period_end: "2024-12-31", json_url: "/x/r.json" } }];
  assert.equal((await lookupForeignFinancials(router({ filings: old }), "Saab", "saab.com", NOW)).status, "stale_filing");
});

test("fetch_failed on network error and on HTTP 500", async () => {
  assert.equal((await lookupForeignFinancials(router({ fail: true }), "Saab", "saab.com", NOW)).status, "fetch_failed");
  assert.equal((await lookupForeignFinancials(async () => new Response("", { status: 500 }), "Saab", "saab.com", NOW)).status, "fetch_failed");
});

test("HTTP 429 is retried", async () => {
  let first = true;
  const inner = router();
  const r = await lookupForeignFinancials(async (u, i) => (first ? ((first = false), new Response("", { status: 429 })) : inner(u, i)), "Saab", "saab.com", NOW);
  assert.equal(r.status, "found");
});

test("a hand-checked LEI alias skips the name search and Wikidata, and names the aliased entity", async () => {
  const AMA = "9598004A3FTY3TEHHN09", urls = [];
  const f = (concept, start, end, value) => ({ value: String(value), dimensions: { concept, entity: `scheme:${AMA}`, period: `${start}T00:00:00/${end}T00:00:00`, unit: "iso4217:EUR" } });
  const rep = { facts: Object.fromEntries([f("ifrs-full:ProfitLossFromOperatingActivities", "2025-01-01", "2026-01-01", 5), f("ifrs-full:ProfitLossFromOperatingActivities", "2024-01-01", "2025-01-01", 4),
    f("ifrs-full:Revenue", "2025-01-01", "2026-01-01", 50), f("ifrs-full:Revenue", "2024-01-01", "2025-01-01", 40)].map((x, i) => [`f${i}`, x])) };
  const fetchFn = async url => { urls.push(url); return url.includes("/api/filings") ? json({ data: [{ attributes: { period_end: "2025-12-31", json_url: "/a/r.json", viewer_url: "/a/v.html" } }] }) : json(rep); };
  const r = await lookupForeignFinancials(fetchFn, "Amadeus", null, NOW);
  assert.equal(r.status, "found");
  assert.deepEqual([r.requests, r.financials.matched_name, r.financials.operating_income, r.financials.currency], [2, "Amadeus IT Group SA", 5, "EUR"]);
  assert.equal(urls.some(u => u.includes("/api/entities") || u.includes("wikidata")), false);
  assert.match(urls[0], /entity\.identifier/);
});
