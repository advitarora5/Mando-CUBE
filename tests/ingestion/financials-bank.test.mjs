// FDIC bank financials: exact-name matching, December values in thousands, prior-year pairing, staleness. Inline fixtures, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupBankFinancials, bankPacing } from '../../src/pipeline/financials-bank.ts';

bankPacing.ms = 0;
const NOW = new Date('2026-11-09T12:00:00Z');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const wrap = rows => ({ data: rows.map(data => ({ data })) });
const inst = (CERT, NAME, ACTIVE = 1) => ({ CERT, NAME, ACTIVE });
const rep = (REPDTE, NETINC, INTINC, NONII) => ({ REPDTE, NETINC, INTINC, NONII });
const api = (insts, reps = []) => async url => (url.includes('/institutions') ? json(wrap(insts)) : json(wrap(reps)));
const run = (fetchFn, name = 'First National Bank of Omaha') => lookupBankFinancials(fetchFn, name, NOW);

test('found: December values x1000, prior year paired, quarterly rows ignored', async () => {
  const r = await run(api([inst(5452, 'First National Bank of Omaha')],
    [rep('20260630', 300, 1, 1), rep('20251231', 491, 2613, 416), rep('20250930', 375, 1, 1), rep('20241231', 414, 2640, 408)]));
  assert.equal(r.status, 'found');
  assert.equal(r.requests, 2);
  assert.deepEqual(r.financials, { fiscal_year_end: '2025-12-31', currency: 'USD', operating_income: 491000, prior_operating_income: 414000,
    revenue: 3029000, prior_revenue: 3048000, source_url: 'https://banks.data.fdic.gov/bankfind-suite/bankfind/details/5452', net_income: true, matched_name: 'First National Bank of Omaha' });
});

test('loss kept negative; prior year null when absent', async () => {
  const r = await run(api([inst(1, 'First National Bank of Omaha')], [rep('20251231', -50, 100, 20), rep('20231231', 5, 1, 1)]));
  assert.equal(r.financials.operating_income, -50000);
  assert.equal(r.financials.prior_operating_income, null);
  assert.equal(r.financials.prior_revenue, null);
});

test('ambiguous: several active charters share the name', async () => {
  const r = await run(api([inst(1, 'First National Bank'), inst(2, 'First National Bank')], [rep('20251231', 1, 1, 1)]), 'First National Bank');
  assert.deepEqual([r.financials, r.status, r.requests], [null, 'ambiguous', 1]);
});

test('no_match: partial names and inactive institutions are never accepted', async () => {
  const r = await run(api([inst(1, 'First National Bank of Omaha Trust'), inst(2, 'First National Bank of Omaha', 0)]));
  assert.deepEqual([r.financials, r.status], [null, 'no_match']);
});

test('stale_filing: latest December older than 18 months; no_filing without a December row', async () => {
  assert.equal((await run(api([inst(1, 'First National Bank of Omaha')], [rep('20241231', 1, 1, 1)]))).status, 'stale_filing');
  assert.equal((await run(api([inst(1, 'First National Bank of Omaha')], [rep('20260630', 1, 1, 1)]))).status, 'no_filing');
});

test('fetch_failed: server or network error; 429 is retried', async () => {
  assert.equal((await run(async () => json({}, 500))).status, 'fetch_failed');
  assert.equal((await run(async () => { throw new Error('down'); })).status, 'fetch_failed');
  let calls = 0;
  const flaky = async url => (calls++ === 0 ? json({}, 429) : api([inst(1, 'First National Bank of Omaha')], [rep('20251231', 2, 1, 1)])(url));
  bankPacing.ms = 1;
  const r = await run(flaky);
  bankPacing.ms = 0;
  assert.equal(r.status, 'found');
  assert.equal(r.requests, 3);
});
