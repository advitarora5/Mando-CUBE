// Budget capacity from SEC annual filings: parsing guards (stale tags, entity ambiguity) and the rubric's capacity points.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetFromSignals, capacityPoints } from '../../src/domain/ingestion/pipeline-score.ts';
import { classifyFacts, parseFinancials, cikIndex, secCikFor } from '../../src/pipeline/financials.ts';

const NOW = new Date('2026-10-26T12:00:00Z');
const fy = (end, val, accn = '0000000001-26-000001', form = '10-K') => ({ start: `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`, end, val, form, filed: `${end.slice(0, 4)}-12-31`, accn });
const facts = (tags) => ({ 'us-gaap': Object.fromEntries(Object.entries(tags).map(([tag, rows]) => [tag, { units: { USD: rows } }])) });
const sig = (extra = {}) => ({ type: 'budget_clue', signal_date: '2026-05-01', source_url: 'https://example.com/clue', quote: 'bought a testing tool', confidence: 0.9, first_seen_at: '2026-10-12T00:00:00Z', last_seen_at: '2026-10-12T00:00:00Z', ...extra });

test('parse: latest fiscal year, prior year paired by date, source is the filing', () => {
  const f = parseFinancials(facts({
    OperatingIncomeLoss: [fy('2025-12-31', 5e9, '0000310764-26-000010'), fy('2024-12-31', 4e9)],
    Revenues: [fy('2025-12-31', 25e9), fy('2024-12-31', 22e9)],
  }), 310764, NOW);
  assert.deepEqual(f, { fiscal_year_end: '2025-12-31', currency: 'USD', operating_income: 5e9, prior_operating_income: 4e9, revenue: 25e9, prior_revenue: 22e9, source_url: 'https://www.sec.gov/Archives/edgar/data/310764/000031076426000010/' });
});

test('parse: a stale revenue tag is skipped for a newer one; a stale operating-income tag gives no financials', () => {
  const f = parseFinancials(facts({
    OperatingIncomeLoss: [fy('2025-12-31', 8e9), fy('2024-12-31', 7e9)],
    Revenues: [fy('2012-12-31', 19e9)],
    RevenueFromContractWithCustomerExcludingAssessedTax: [fy('2025-12-31', 30e9), fy('2024-12-31', 28e9)],
  }), 1, NOW);
  assert.equal(f.revenue, 30e9);
  assert.equal(parseFinancials(facts({ OperatingIncomeLoss: [fy('2014-12-31', 3e9)] }), 1, NOW), null, 'insurer-style stale tag: Needs evidence');
  assert.equal(parseFinancials({ 'ifrs-full': {} }, 1, NOW), null, 'IFRS filer with no operating figure');
  assert.equal(parseFinancials(facts({ OperatingIncomeLoss: [fy('2025-12-31', 1e9, 'a', '10-Q')] }), 1, NOW), null, 'quarterly forms are ignored');
});

test('parse: revenue from another fiscal year earns no growth point; a missing prior year is null', () => {
  const f = parseFinancials(facts({ OperatingIncomeLoss: [fy('2025-12-31', 1e9)], Revenues: [fy('2024-12-31', 9e9), fy('2023-12-31', 8e9)] }), 1, NOW);
  assert.equal(f.revenue, null);
  assert.equal(f.prior_operating_income, null);
  assert.equal(capacityPoints(f), 10);
});

const units = (byUnit) => ({ units: byUnit });

test('parse: an IFRS filer reporting in euros gets its real figures, labeled in euros', () => {
  const f = parseFinancials({ 'ifrs-full': {
    ProfitLossFromOperatingActivities: units({ EUR: [fy('2025-12-31', 9e9), fy('2024-12-31', 8e9)] }),
    Revenue: units({ EUR: [fy('2025-12-31', 50e9), fy('2024-12-31', 49e9)] }),
  } }, 1, NOW);
  assert.deepEqual([f.currency, f.operating_income, f.prior_operating_income, f.revenue, f.prior_revenue], ['EUR', 9e9, 8e9, 50e9, 49e9]);
  assert.equal(capacityPoints(f), 12);
  assert.match(budgetFromSignals([], NOW, f).reason, /operating income EUR 9\.0B/);
});

test('parse: US GAAP figures in another currency count; dollars keep their $ label', () => {
  const cad = parseFinancials({ 'us-gaap': { OperatingIncomeLoss: units({ CAD: [fy('2025-12-31', 11e9)] }) } }, 1, NOW);
  assert.equal(cad.currency, 'CAD');
  assert.match(budgetFromSignals([], NOW, cad).reason, /operating income CAD 11\.0B/);
  const dollars = parseFinancials(facts({ OperatingIncomeLoss: [fy('2025-12-31', 5e9)] }), 1, NOW);
  assert.match(budgetFromSignals([], NOW, dollars).reason, /operating income \$5\.0B/);
});

test('parse: years and revenue are never compared across currencies', () => {
  const switched = parseFinancials({ 'ifrs-full': {
    ProfitLossFromOperatingActivities: units({ USD: [fy('2025-12-31', 2e9)], EUR: [fy('2024-12-31', 9e9)] }),
    Revenue: units({ EUR: [fy('2025-12-31', 50e9), fy('2024-12-31', 40e9)] }),
  } }, 1, NOW);
  assert.equal(switched.currency, 'USD');
  assert.equal(switched.prior_operating_income, null, 'last year was in euros, so growth is unknown, not a comparison');
  assert.equal(switched.revenue, null, 'revenue only in another currency earns no growth point');
  assert.equal(capacityPoints(switched), 10);
});

test('parse: per-share and count units are not money; a short translated year does not replace the full series', () => {
  assert.equal(parseFinancials({ 'us-gaap': { OperatingIncomeLoss: units({ 'USD/shares': [fy('2025-12-31', 3)], shares: [fy('2025-12-31', 3)], pure: [fy('2025-12-31', 3)] }) } }, 1, NOW), null);
  const f = parseFinancials({ 'ifrs-full': { ProfitLossFromOperatingActivities: units({ USD: [fy('2025-12-31', 2e9)], EUR: [fy('2025-12-31', 2e9), fy('2024-12-31', 1e9)] }) } }, 1, NOW);
  assert.deepEqual([f.currency, f.prior_operating_income], ['EUR', 1e9]);
});

test('parse: an operating figure identical to revenue is total income, not profit, so on its own it earns nothing', () => {
  const bank = { 'ifrs-full': {
    ProfitLossFromOperatingActivities: units({ EUR: [fy('2025-12-31', 25e9), fy('2024-12-31', 21e9)] }),
    Revenue: units({ EUR: [fy('2025-12-31', 25e9), fy('2024-12-31', 21e9)] }),
  } };
  assert.equal(parseFinancials(bank, 1, NOW), null);
  assert.equal(classifyFacts(bank, 1, NOW).status, 'no_operating_income', 'a current filing without a real operating figure, not a stale one');
  const yearApart = parseFinancials({ 'ifrs-full': {
    ProfitLossFromOperatingActivities: units({ EUR: [fy('2025-12-31', 5e9)] }),
    Revenue: units({ EUR: [fy('2024-12-31', 5e9)] }),
  } }, 1, NOW);
  assert.equal(yearApart.operating_income, 5e9, 'equal numbers from different years are a coincidence');
});

test('parse: a filer that moved from US GAAP to IFRS uses the newer one, without a growth comparison across them', () => {
  const f = parseFinancials({
    'us-gaap': { OperatingIncomeLoss: units({ USD: [fy('2024-12-31', 9e9)] }) },
    'ifrs-full': { ProfitLossFromOperatingActivities: units({ USD: [fy('2025-12-31', 2e9)] }) },
  }, 1, NOW);
  assert.deepEqual([f.operating_income, f.prior_operating_income], [2e9, null]);
});

test('cik index: one CIK per normalized name; share classes collapse, conflicting names are dropped', () => {
  const list = JSON.stringify({ 0: { cik_str: 1652044, title: 'Alphabet Inc.' }, 1: { cik_str: 1652044, title: 'ALPHABET INC' }, 2: { cik_str: 7, title: 'Acme Corp' }, 3: { cik_str: 8, title: 'ACME Inc.' } });
  const index = cikIndex(list);
  assert.equal(index.get('alphabet'), 1652044);
  assert.equal(index.has('acme'), false, 'two different filers share a name: no match');
});

test('capacity: 10 for positive operating income, +1 revenue growth, +1 operating income growth, 0 otherwise', () => {
  const base = { fiscal_year_end: '2025-12-31', currency: 'USD', source_url: 'https://www.sec.gov/x/', operating_income: 5, prior_operating_income: 4, revenue: 9, prior_revenue: 8 };
  assert.equal(capacityPoints(base), 12);
  assert.equal(capacityPoints({ ...base, prior_revenue: 10 }), 11);
  assert.equal(capacityPoints({ ...base, prior_operating_income: 6, prior_revenue: 10 }), 10);
  assert.equal(capacityPoints({ ...base, operating_income: -5 }), 0, 'revenue or size alone is not capacity');
  assert.equal(capacityPoints(null), 0);
});

test('budget: rubric example 10 + 1 + 1 + 6 = 18; capped at 20; filing is the source; loss gives a sourced zero', () => {
  const f = { fiscal_year_end: '2025-12-31', currency: 'USD', source_url: 'https://www.sec.gov/Archives/edgar/data/1/2/', operating_income: 5e9, prior_operating_income: 4e9, revenue: 9e9, prior_revenue: 8e9 };
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

const PRE_TAX_TAG = 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest';

test('pre-tax: a filer with no operating figure uses pre-tax income, on the same bands, and says so', () => {
  const f = parseFinancials(facts({ [PRE_TAX_TAG]: [fy('2025-12-31', 8e9), fy('2024-12-31', 7e9)], Revenues: [fy('2025-12-31', 30e9), fy('2024-12-31', 28e9)] }), 1, NOW);
  assert.deepEqual([f.pre_tax, f.operating_income, f.prior_operating_income], [true, 8e9, 7e9]);
  assert.equal(capacityPoints(f), 12);
  const budget = budgetFromSignals([], NOW, f);
  assert.equal(budget.status, 'met');
  assert.match(budget.reason, /positive pre-tax income \$8\.0B \(FY ending 2025-12-31, no current operating income figure\)/);
  assert.doesNotMatch(budget.reason, /positive operating income/);
});

test('pre-tax: a filer with a usable operating figure never uses it, even when pre-tax is larger', () => {
  const f = parseFinancials(facts({ OperatingIncomeLoss: [fy('2025-12-31', 1e9)], [PRE_TAX_TAG]: [fy('2025-12-31', 9e9)] }), 1, NOW);
  assert.equal(f.operating_income, 1e9);
  assert.equal('pre_tax' in f, false);
  assert.match(budgetFromSignals([], NOW, f).reason, /positive operating income \$1\.0B/);
  const loss = parseFinancials(facts({ OperatingIncomeLoss: [fy('2025-12-31', -1e9)], [PRE_TAX_TAG]: [fy('2025-12-31', 9e9)] }), 1, NOW);
  assert.equal(capacityPoints(loss), 0, 'a real operating loss is not rescued by a pre-tax gain');
});

test('pre-tax: replaces an operating tag that is really total income, or one that stopped being filed', () => {
  const bank = { 'ifrs-full': {
    ProfitLossFromOperatingActivities: units({ EUR: [fy('2025-12-31', 25e9)] }), Revenue: units({ EUR: [fy('2025-12-31', 25e9)] }),
    ProfitLossBeforeTax: units({ EUR: [fy('2025-12-31', 11e9), fy('2024-12-31', 7e9)] }),
  } };
  const f = parseFinancials(bank, 1, NOW);
  assert.deepEqual([f.pre_tax, f.currency, f.operating_income], [true, 'EUR', 11e9]);
  assert.match(budgetFromSignals([], NOW, f).reason, /pre-tax income EUR 11\.0B/);
  const stale = parseFinancials(facts({ OperatingIncomeLoss: [fy('2014-12-31', 3e9)], [PRE_TAX_TAG]: [fy('2025-12-31', 2e9)] }), 1, NOW);
  assert.deepEqual([stale.pre_tax, stale.operating_income], [true, 2e9]);
});

test('pre-tax: a loss earns nothing, and an old figure is stale on either basis', () => {
  const loss = parseFinancials(facts({ [PRE_TAX_TAG]: [fy('2025-12-31', -2e9)] }), 1, NOW);
  assert.equal(capacityPoints(loss), 0);
  assert.match(budgetFromSignals([], NOW, loss).reason, /non-positive pre-tax income -\$2\.0B/);
  const old = facts({ OperatingIncomeLoss: [fy('2023-12-31', 1e9)], [PRE_TAX_TAG]: [fy('2023-12-31', 1e9)] });
  assert.equal(parseFinancials(old, 1, NOW), null);
  assert.equal(classifyFacts(old, 1, NOW).status, 'stale_filing');
  assert.equal(classifyFacts(facts({ [PRE_TAX_TAG]: [fy('2023-12-31', 1e9)] }), 1, NOW).status, 'stale_filing');
});

test('annual forms: a 40-F counts as an annual filing; a current report does not', () => {
  const f = parseFinancials({ 'ifrs-full': { ProfitLossBeforeTax: units({ CAD: [fy('2025-12-31', 7e9, 'a', '40-F'), fy('2024-12-31', 6e9, 'b', '40-F')] }) } }, 1, NOW);
  assert.deepEqual([f.currency, f.operating_income, f.prior_operating_income], ['CAD', 7e9, 6e9]);
  assert.equal(parseFinancials(facts({ [PRE_TAX_TAG]: [fy('2025-12-31', 1e9, 'a', '8-K')] }), 1, NOW), null);
});

test('parse: net income is the last resort, labeled, and a stale pre-tax tag does not block it', () => {
  const f = parseFinancials(facts({ NetIncomeLoss: [fy('2025-12-31', 3e9), fy('2024-12-31', 2e9)], Revenues: [fy('2025-12-31', 20e9), fy('2024-12-31', 18e9)] }), 1, NOW);
  assert.deepEqual([f.net_income, f.pre_tax, f.operating_income, f.prior_operating_income], [true, undefined, 3e9, 2e9]);
  assert.equal(capacityPoints(f), 12);
  assert.match(budgetFromSignals([], NOW, f).reason, /positive net income \$3\.0B \(FY ending 2025-12-31, no current operating income figure\)/);
  const stale = parseFinancials(facts({ [PRE_TAX_TAG]: [fy('2014-12-31', 9e9)], NetIncomeLoss: [fy('2025-12-31', 1e9)] }), 1, NOW);
  assert.deepEqual([stale.net_income, stale.operating_income], [true, 1e9]);
  assert.equal(parseFinancials(facts({ NetIncomeLoss: [fy('2014-12-31', 1e9)] }), 1, NOW), null);
});

test('parse: operating cash flow is evidence for the same fiscal year only and never changes the points', () => {
  const base = { OperatingIncomeLoss: [fy('2025-12-31', 5e9)] };
  const f = parseFinancials(facts({ ...base, NetCashProvidedByUsedInOperatingActivities: [fy('2025-12-31', 7e9)] }), 1, NOW);
  assert.equal(f.operating_cash_flow, 7e9);
  assert.match(budgetFromSignals([], NOW, f).reason, /operating cash flow \$7\.0B/);
  assert.equal(capacityPoints(f), capacityPoints(parseFinancials(facts(base), 1, NOW)));
  const other = parseFinancials(facts({ ...base, NetCashProvidedByUsedInOperatingActivities: [fy('2024-12-31', 7e9)] }), 1, NOW);
  assert.equal('operating_cash_flow' in other, false);
});

test('parse: bank revenue tags (net of interest expense; revenue and operating income) give revenue growth', () => {
  const us = parseFinancials(facts({ [PRE_TAX_TAG]: [fy('2025-12-31', 25e9), fy('2024-12-31', 23e9)], RevenuesNetOfInterestExpense: [fy('2025-12-31', 83e9), fy('2024-12-31', 80e9)] }), 1, NOW);
  assert.deepEqual([us.pre_tax, us.revenue, us.prior_revenue], [true, 83e9, 80e9]);
  assert.equal(capacityPoints(us), 12);
  const ifrs = parseFinancials({ 'ifrs-full': {
    ProfitLossBeforeTax: units({ USD: [fy('2025-12-31', 9e9), fy('2024-12-31', 7e9)] }),
    RevenueAndOperatingIncome: units({ USD: [fy('2025-12-31', 50e9), fy('2024-12-31', 47e9)] }),
  } }, 1, NOW);
  assert.deepEqual([ifrs.revenue, ifrs.prior_revenue], [50e9, 47e9]);
  const plain = parseFinancials(facts({ OperatingIncomeLoss: [fy('2025-12-31', 5e9)], Revenues: [fy('2025-12-31', 20e9)], RevenuesNetOfInterestExpense: [fy('2025-12-31', 99e9)] }), 1, NOW);
  assert.equal(plain.revenue, 20e9, 'a plain revenue tag wins a tie');
});

test('match: a hand-checked alias wins over the index; other names need an exact match; prefixes never match', () => {
  const index = cikIndex(JSON.stringify({ 0: { cik_str: 1, title: 'Acme Corp' }, 1: { cik_str: 2, title: 'Target Hospitality Corp.' }, 2: { cik_str: 3, title: 'Otis Worldwide Corp' } }));
  assert.equal(secCikFor(index, 'Target'), 27419, 'alias, although the exact index has no "target"');
  assert.equal(secCikFor(index, 'Otis'), 1781335, 'alias beats a prefix that would also fit');
  assert.equal(secCikFor(index, 'Acme, Inc.'), 1, 'exact normalized match');
  assert.equal(secCikFor(index, 'Acm'), undefined);
  assert.equal(secCikFor(index, 'Otis Worldwide'), 3, 'exact name still matches without an alias');
});

test('score: nonprofit surplus and the matched entity are labeled in the Budget evidence', () => {
  const f = { fiscal_year_end: '2024-06-30', currency: 'USD', operating_income: 12e6, prior_operating_income: 9e6, revenue: 400e6, prior_revenue: 380e6, source_url: 'https://example.org/990', surplus: true, matched_name: 'Example Health System' };
  const reason = budgetFromSignals([], NOW, f).reason;
  assert.match(reason, /positive net surplus \$12M \(FY ending 2024-06-30, revenue less expenses, not operating income, matched to Example Health System\)/);
  assert.equal(capacityPoints(f), 12);
});

test('match: a note in parentheses is tried without the note and as the name; every try is still an exact match', () => {
  const index = cikIndex(JSON.stringify({ 0: { cik_str: 10, title: 'Concentrix Corp' }, 1: { cik_str: 11, title: 'BRC Inc.' }, 2: { cik_str: 12, title: 'Information Services Group Inc.' }, 3: { cik_str: 13, title: 'Target Hospitality Corp.' } }));
  assert.equal(secCikFor(index, 'Concentrix (formerly Convergys)'), 10);
  assert.equal(secCikFor(index, 'Black Rifle Coffee Company (BRC Inc.)'), 11);
  assert.equal(secCikFor(index, 'Information Services Group (ISG)'), 12);
  assert.equal(secCikFor(index, 'Target (US retailer)'), 27419, 'the alias is found on the name without the note');
  assert.equal(secCikFor(index, 'Acme (Widgets)'), undefined, 'no exact match for any try');
  assert.equal(secCikFor(index, 'Target Hospitality'), 13);
});
