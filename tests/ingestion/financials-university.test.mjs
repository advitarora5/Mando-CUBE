// University (IPEDS via Urban Institute) financials: exact-name matching, prior-year pairing, surplus, staleness. Inline fixtures, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupUniversityFinancials, universityPacing } from '../../src/pipeline/financials-university.ts';

universityPacing.ms = 0;
const NOW = new Date('2026-11-09T12:00:00Z'); // directory year 2024; newest finance year tried is 2024
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const inst = (unitid, inst_name) => ({ unitid, inst_name });
const fin = (unitid, rev, exp) => ({ unitid, rev_total_current: rev, exp_total_current: exp });
// finance: { year: row }; years not listed return no rows.
const api = (insts, finance = {}) => async (url) => {
  if (url.includes('/directory/')) return json({ results: insts });
  const year = url.match(/finance\/(\d+)\//)[1];
  return json({ results: finance[year] ? [finance[year]] : [] });
};
const run = (fetchFn, name = 'Iowa State University') => lookupUniversityFinancials(fetchFn, name, NOW);

test('found: surplus from total revenues minus expenses, prior year paired, flagged and named', async () => {
  const r = await run(api([inst(1, 'Iowa State University'), inst(2, 'Iowa State University Foundation')], { 2023: fin(1, 1558, 1475), 2022: fin(1, 1432, 1403) }));
  assert.equal(r.status, 'found');
  assert.equal(r.requests, 4); // directory + finance 2024 (empty) + 2023 + 2022
  assert.deepEqual(r.financials, { fiscal_year_end: '2024-06-30', currency: 'USD', operating_income: 83, prior_operating_income: 29, revenue: 1558, prior_revenue: 1432, source_url: 'https://nces.ed.gov/ipeds/datacenter/InstitutionProfile.aspx?unitId=1', surplus: true, matched_name: 'Iowa State University' });
});

test('prior year is null when the previous year has no figures', async () => {
  const r = await run(api([inst(1, 'Iowa State University')], { 2023: fin(1, 10, 5) }));
  assert.equal(r.financials.prior_operating_income, null);
  assert.equal(r.financials.prior_revenue, null);
});

test('deficit is kept as a negative number', async () => {
  const r = await run(api([inst(1, 'Iowa State University')], { 2023: fin(1, 100, 140) }));
  assert.equal(r.financials.operating_income, -40);
});

test('ambiguous: two unitids share the exact normalized name', async () => {
  const r = await run(api([inst(1, 'Iowa State University'), inst(2, 'Iowa State University Inc')], { 2023: fin(1, 1, 1) }));
  assert.deepEqual([r.financials, r.status, r.requests], [null, 'ambiguous', 1]);
});

test('no_match: only prefix or campus variants, never accepted', async () => {
  const r = await run(api([inst(1, 'Iowa State University-Ames'), inst(2, 'Iowa State University Foundation')]));
  assert.deepEqual([r.financials, r.status], [null, 'no_match']);
});

test('stale_filing: latest fiscal year ended more than 36 months ago', async () => {
  const r = await run(api([inst(1, 'Iowa State University')], { 2022: fin(1, 10, 5) })); // FY ended 2023-06-30
  assert.deepEqual([r.financials, r.status], [null, 'stale_filing']);
});

test('no_filing: no finance row in the years tried, or null totals', async () => {
  assert.equal((await run(api([inst(1, 'Iowa State University')]))).status, 'no_filing');
  assert.equal((await run(api([inst(1, 'Iowa State University')], { 2023: fin(1, null, null) }))).status, 'no_filing');
});

test('fetch_failed: server error or network error; 429 is retried', async () => {
  assert.equal((await run(async () => json({}, 500))).status, 'fetch_failed');
  assert.equal((await run(async () => { throw new Error('down'); })).status, 'fetch_failed');
  let calls = 0;
  const flaky = async (url) => (calls++ === 0 ? json({}, 429) : api([inst(1, 'Iowa State University')], { 2023: fin(1, 2, 1) })(url));
  universityPacing.ms = 1;
  const r = await run(flaky);
  universityPacing.ms = 0;
  assert.equal(r.status, 'found');
  assert.equal(r.requests, 5); // 429 + directory + 2024 + 2023 + 2022
});
