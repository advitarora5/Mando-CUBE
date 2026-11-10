// Nonprofit (Form 990) financials: exact-name matching, prior-year pairing, surplus, staleness. Inline fixtures, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupNonprofitFinancials, nonprofitPacing } from '../../src/pipeline/financials-nonprofit.ts';

nonprofitPacing.ms = 0;
const NOW = new Date('2026-11-09T12:00:00Z');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const org = (ein, name) => ({ ein, name });
const filing = (tax_prd, totrevenue, totfuncexpns) => ({ tax_prd, totrevenue, totfuncexpns, pdf_url: `https://example.org/${tax_prd}.pdf` });
// search -> organizations list; organizations/<ein>.json -> filings.
const api = (orgs, filings = []) => async (url) =>
  url.includes('search.json') ? json({ organizations: orgs }) : json({ filings_with_data: filings });
const run = (fetchFn, name = 'Banner Health') => lookupNonprofitFinancials(fetchFn, name, NOW);

test('found: surplus from the return totals, prior year paired, flagged and named', async () => {
  const r = await run(api([org(1, 'BANNER HEALTH'), org(2, 'Banner Health Foundation')], [filing(202212, 8e9, 8.1e9), filing(202312, 9e9, 8.5e9)]));
  assert.equal(r.status, 'found');
  assert.equal(r.requests, 2);
  assert.deepEqual(r.financials, { fiscal_year_end: '2023-12-31', currency: 'USD', operating_income: 5e8, prior_operating_income: -1e8, revenue: 9e9, prior_revenue: 8e9, source_url: 'https://example.org/202312.pdf', surplus: true, matched_name: 'BANNER HEALTH' });
});

test('prior year is null when not the previous fiscal year', async () => {
  const r = await run(api([org(1, 'Banner Health')], [filing(202112, 7e9, 7e9), filing(202312, 9e9, 8.5e9)]));
  assert.equal(r.financials.prior_operating_income, null);
  assert.equal(r.financials.prior_revenue, null);
});

test('negative surplus is kept as a negative number', async () => {
  const r = await run(api([org(1, 'Banner Health')], [filing(202312, 8e9, 8.4e9)]));
  assert.equal(r.financials.operating_income, -4e8);
});

test('ambiguous: two organizations share the exact name', async () => {
  const r = await run(api([org(1, 'Banner Health'), org(2, 'BANNER HEALTH INC')], [filing(202312, 1, 1)]));
  assert.deepEqual([r.financials, r.status, r.requests], [null, 'ambiguous', 1]);
});

test('no_match: only prefix or partial names, never accepted', async () => {
  const r = await run(api([org(1, 'Banner Health Foundation'), org(2, 'Banner Health Plan Inc')]));
  assert.deepEqual([r.financials, r.status], [null, 'no_match']);
});

test('stale_filing: tax period ended more than 36 months ago', async () => {
  const r = await run(api([org(1, 'Banner Health')], [filing(202301, 9e9, 8e9)]));
  assert.deepEqual([r.financials, r.status], [null, 'stale_filing']);
});

test('no_filing: organization has no return with figures', async () => {
  const r = await run(api([org(1, 'Banner Health')], []));
  assert.deepEqual([r.financials, r.status], [null, 'no_filing']);
});

test('no_filing: revenue exactly equal to expenses is a pass-through entity, not a surplus', async () => {
  const r = await run(api([org(1, 'Banner Health')], [filing(202312, 4e7, 4e7)]));
  assert.deepEqual([r.financials, r.status], [null, 'no_filing']);
});

test('fetch_failed: server error or network error; 429 is retried', async () => {
  assert.equal((await run(async () => json({}, 500))).status, 'fetch_failed');
  assert.equal((await run(async () => { throw new Error('down'); })).status, 'fetch_failed');
  let calls = 0;
  const flaky = async (url) => (calls++ === 0 ? json({}, 429) : api([org(1, 'Banner Health')], [filing(202312, 2, 1)])(url));
  nonprofitPacing.ms = 1;
  const r = await run(flaky);
  nonprofitPacing.ms = 0;
  assert.equal(r.status, 'found');
  assert.equal(r.requests, 3);
});
