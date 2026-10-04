import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyRanks, queryCompanies } from '../src/features/company-list/query.ts';
const base = { search: '', tier: 'All', min: null, max: null, sort: 'score-desc' };
const make = (id, name, total, tier, employee_count = 3000) => ({ id, name, industry: 'Manufacturing', headquarters: null, domain: null, why_now: null, employee_count, contacts: [{ name: 'John Smith', title: 'HRIS Director' }], score: total === null ? null : { total, tier } });
const rows = [make('a', 'Demo Company 2', 80, 'Qualified'), make('b', 'Demo Company 10', 55, 'Maybe'), make('c', 'Demo Company 3', 55, 'Maybe'), make('d', 'Demo Company 4', 49, 'Disqualified', null), make('e', 'Demo Company 5', null, null)];
test('rank preserves ties and does not depend on filtered display order', () => {
 const ranks = companyRanks(rows);
 assert.deepEqual([...ranks.values()], [1, 2, 2, 4]);
 assert.equal(ranks.has('e'), false);
 const visible = queryCompanies(rows, { ...base, tier: 'Maybe', sort: 'name-desc' });
 assert.equal(visible.length, 2);
 assert.equal(ranks.get(visible[0].id), 2);
});
test('combined tier and inclusive score boundaries', () => {
 assert.deepEqual(queryCompanies(rows, { ...base, min: 55, max: 80 }).map(c => c.id), ['a', 'c', 'b']);
 assert.equal(queryCompanies(rows, { ...base, tier: 'Qualified', min: 80, max: 80 })[0].id, 'a');
 assert.equal(queryCompanies(rows, { ...base, tier: 'Unscored', min: 0 }).length, 0);
});
test('search ignores case/outer whitespace and searches contacts and industries', () => {
 assert.equal(queryCompanies(rows, { ...base, search: ' JOHN SMITH ' }).length, 5);
 assert.equal(queryCompanies(rows, { ...base, search: 'manufacturing', tier: 'Disqualified' })[0].id, 'd');
 assert.equal(queryCompanies(rows, { ...base, search: 'no match' }).length, 0);
});
test('sorting keeps missing data last and compares company numbers naturally', () => {
 assert.deepEqual(queryCompanies(rows, { ...base, sort: 'name-asc' }).map(c => c.name), ['Demo Company 2', 'Demo Company 3', 'Demo Company 4', 'Demo Company 5', 'Demo Company 10']);
 assert.equal(queryCompanies(rows, { ...base, sort: 'score-asc' }).at(-1).id, 'e');
 assert.equal(queryCompanies(rows, { ...base, sort: 'employees-asc' }).at(-1).id, 'd');
 assert.equal(queryCompanies(rows, { ...base, tier: 'Unscored' })[0].id, 'e');
});
test('rank directions and tier directions preserve missing values and score tie breaks', () => {
 assert.deepEqual(queryCompanies(rows, { ...base, sort: 'rank-asc' }).map(c => c.id), ['a', 'c', 'b', 'd', 'e']);
 assert.deepEqual(queryCompanies(rows, { ...base, sort: 'rank-desc' }).map(c => c.id), ['d', 'c', 'b', 'a', 'e']);
 assert.deepEqual(queryCompanies(rows, { ...base, sort: 'tier-desc' }).map(c => c.id), ['a', 'c', 'b', 'd', 'e']);
 assert.deepEqual(queryCompanies(rows, { ...base, sort: 'tier-asc' }).map(c => c.id), ['d', 'c', 'b', 'a', 'e']);
});
