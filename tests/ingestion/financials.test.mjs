// Budget capacity from SEC annual filings: parsing guards (stale tags, entity ambiguity) and the rubric's capacity points.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetFromSignals, capacityPoints } from '../../src/domain/ingestion/pipeline-score.ts';
import { parseFinancials, cikIndex } from '../../src/pipeline/financials.ts';

const NOW = new Date('2026-10-26T12:00:00Z');
const fy = (end, val, accn = '0000000001-26-000001', form = '10-K') => ({ start: `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`, end, val, form, filed: `${end.slice(0, 4)}-12-31`, accn });
const facts = (tags) => ({ 'us-gaap': Object.fromEntries(Object.entries(tags).map(([tag, rows]) => [tag, { units: { USD: rows } }])) });
const sig = (extra = {}) => ({ type: 'budget_clue', signal_date: '2026-05-01', source_url: 'https://example.com/clue', quote: 'bought a testing tool', confidence: 0.9, first_seen_at: '2026-10-12T00:00:00Z', last_seen_at: '2026-10-12T00:00:00Z', ...extra });

test('parse: latest fiscal year, prior year paired by date, source is the filing', () => {
  const f = parseFinancials(facts({
    OperatingIncomeLoss: [fy('2025-12-31', 5e9, '0000310764-26-000010'), fy('2024-12-31', 4e9)],
    Revenues: [fy('2025-12-31', 25e9), fy('2024-12-31', 22e9)],
  }), 310764, NOW);
  assert.deepEqual(f, { fiscal_year_end: '2025-12-31', operating_income: 5e9, prior_operating_income: 4e9, revenue: 25e9, prior_revenue: 22e9, source_url: 'https://www.sec.gov/Archives/edgar/data/310764/000031076426000010/' });
});

test('parse: a stale revenue tag is skipped for a newer one; a stale operating-income tag gives no financials', () => {
  const f = parseFinancials(facts({
    OperatingIncomeLoss: [fy('2025-12-31', 8e9), fy('2024-12-31', 7e9)],
    Revenues: [fy('2012-12-31', 19e9)],
    RevenueFromContractWithCustomerExcludingAssessedTax: [fy('2025-12-31', 30e9), fy('2024-12-31', 28e9)],
  }), 1, NOW);
  assert.equal(f.revenue, 30e9);
  assert.equal(parseFinancials(facts({ OperatingIncomeLoss: [fy('2014-12-31', 3e9)] }), 1, NOW), null, 'insurer-style stale tag: Needs evidence');
  assert.equal(parseFinancials({ 'ifrs-full': {} }, 1, NOW), null, 'foreign IFRS filer');
  assert.equal(parseFinancials(facts({ OperatingIncomeLoss: [fy('2025-12-31', 1e9, 'a', '10-Q')] }), 1, NOW), null, 'quarterly forms are ignored');
});

test('parse: revenue from another fiscal year earns no growth point; a missing prior year is null', () => {
  const f = parseFinancials(facts({ OperatingIncomeLoss: [fy('2025-12-31', 1e9)], Revenues: [fy('2024-12-31', 9e9), fy('2023-12-31', 8e9)] }), 1, NOW);
  assert.equal(f.revenue, null);
  assert.equal(f.prior_operating_income, null);
  assert.equal(capacityPoints(f), 10);
});

test('cik index: one CIK per normalized name; share classes collapse, conflicting names are dropped', () => {
  const list = JSON.stringify({ 0: { cik_str: 1652044, title: 'Alphabet Inc.' }, 1: { cik_str: 1652044, title: 'ALPHABET INC' }, 2: { cik_str: 7, title: 'Acme Corp' }, 3: { cik_str: 8, title: 'ACME Inc.' } });
  const index = cikIndex(list);
  assert.equal(index.get('alphabet'), 1652044);
  assert.equal(index.has('acme'), false, 'two different filers share a name: no match');
});

test('capacity: 10 for positive operating income, +1 revenue growth, +1 operating income growth, 0 otherwise', () => {
  const base = { fiscal_year_end: '2025-12-31', source_url: 'https://www.sec.gov/x/', operating_income: 5, prior_operating_income: 4, revenue: 9, prior_revenue: 8 };
  assert.equal(capacityPoints(base), 12);
  assert.equal(capacityPoints({ ...base, prior_revenue: 10 }), 11);
  assert.equal(capacityPoints({ ...base, prior_operating_income: 6, prior_revenue: 10 }), 10);
  assert.equal(capacityPoints({ ...base, operating_income: -5 }), 0, 'revenue or size alone is not capacity');
  assert.equal(capacityPoints(null), 0);
});

test('budget: rubric example 10 + 1 + 1 + 6 = 18; capped at 20; filing is the source; loss gives a sourced zero', () => {
  const f = { fiscal_year_end: '2025-12-31', source_url: 'https://www.sec.gov/Archives/edgar/data/1/2/', operating_income: 5e9, prior_operating_income: 4e9, revenue: 9e9, prior_revenue: 8e9 };
  const modernizing = { ...sig({ type: 'hiring' }), project_type: 'implementation' };
  const a = budgetFromSignals([modernizing], NOW, f);
  assert.equal(a.score, 18);
  assert.equal(a.source, f.source_url);
  assert.equal(a.status, 'met');
  assert.equal(budgetFromSignals([sig()], NOW, f).score, 20, '12 + 8 reaches the cap exactly');
  assert.equal(budgetFromSignals([], NOW, f).score, 12, 'capacity alone, no investment signal');
  const loss = budgetFromSignals([], NOW, { ...f, operating_income: -1e9 });
  assert.deepEqual([loss.score, loss.status, loss.source], [0, 'not_met', f.source_url]);
  assert.equal(budgetFromSignals([], NOW).status, 'unknown', 'no filing, no signal: unchanged Needs evidence');
  assert.equal(budgetFromSignals([sig()], NOW).score, 8, 'no filing: unchanged signal-only score');
});
