import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicatePairs, matchExistingCompany, aliasOwner } from '../src/domain/ingestion/duplicates.ts';
import { decideMatch } from '../src/domain/ingestion/matching.ts';
import { isSimilarName } from '../src/domain/ingestion/normalize.ts';
import { companyAliases, distinctCompanies } from '../src/data/company-aliases.ts';
import { importCompanies } from '../scripts/import-companies.mjs';

const co = (id, name, domain = null) => ({ id, name, domain });
const flex = co('f1', 'Flex', 'flex.com');
const guess = co('g1', 'Guess Inc.');
const rochester = co('r1', 'Rochester Regional Health', 'rochesterregional.org');
const aliases = [{ company_id: 'f1', name: 'Flex', aliases: ['Flextronics'] }];

test('duplicate report finds the same website, name, alias and similar names, strongest first', () => {
  const companies = [flex, guess, rochester, co('f2', 'Flextronics'), co('g2', 'GUESS'), co('r2', 'Rochester Regional Health System'), co('w1', 'Wawa', 'https://www.flex.com/about'), co('t1', 'Target')];
  const pairs = findDuplicatePairs(companies, aliases);
  assert.deepEqual(pairs.map(p => [p.a.id, p.b.id, p.reasons.join('+')]), [
   ['f1', 'w1', 'same_website'], ['g1', 'g2', 'same_name'], ['f1', 'f2', 'known_alias'], ['r1', 'r2', 'similar_name'],
  ]);
  const checked = findDuplicatePairs(companies, aliases, [{ company_ids: ['r2', 'r1'], note: 'Checked: separate organisations.' }]);
  assert.equal(checked.some(p => p.a.id === 'r1'), false);
  assert.deepEqual(findDuplicatePairs([flex, guess, co('t1', 'Target'), co('t2', 'Targa Resources')]), []);
});

test('a company being added matches by website, then name, then alias; a similar name needs a person', () => {
  const known = [flex, guess, rochester];
  assert.deepEqual(matchExistingCompany({ name: 'Anything', domain: 'https://flex.com/careers' }, known), { kind: 'existing', company: flex, reason: 'same_website' });
  assert.deepEqual(matchExistingCompany({ name: 'guess' }, known), { kind: 'existing', company: guess, reason: 'same_name' });
  assert.deepEqual(matchExistingCompany({ name: 'Flextronics' }, known, aliases), { kind: 'existing', company: flex, reason: 'known_alias' });
  assert.deepEqual(matchExistingCompany({ name: 'Rochester Regional Health System' }, known), { kind: 'review', company: rochester, reason: 'similar_name' });
  assert.equal(matchExistingCompany({ name: 'Guess' }, [guess, co('g2', 'GUESS, Inc')]).kind, 'ambiguous');
  assert.deepEqual(matchExistingCompany({ name: 'Brand New Co', domain: 'brandnew.com' }, known, aliases), { kind: 'new' });
  assert.equal(aliasOwner('FLEXTRONICS', aliases), 'f1');
  assert.equal(aliasOwner('', aliases), null);
});

test('the pipeline attaches a known alias to its company instead of queueing it again', () => {
  const candidate = { name: 'Flextronics', domain: null, domain_confirmed: false, best_confidence: 0.95 };
  assert.deepEqual(decideMatch(candidate, [flex], { canCreate: true }, aliases), { action: 'attach', company_id: 'f1', why: 'Flextronics is a known name of Flex' });
  assert.equal(decideMatch(candidate, [flex], { canCreate: true }).reason, 'no_website'); // unchanged without aliases
  assert.equal(decideMatch(candidate, [], { canCreate: true }, aliases).reason, 'no_website'); // alias of a company not loaded
});

test('the alias list is well formed and adds names the rules would not match', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.equal(new Set(companyAliases.map(a => a.company_id)).size, companyAliases.length);
  for (const entry of companyAliases) {
    assert.match(entry.company_id, uuid);
    for (const alias of entry.aliases) assert.equal(isSimilarName(alias, entry.name), false, `${alias} is already matched by name`);
  }
  const owners = companyAliases.flatMap(e => e.aliases.map(alias => aliasOwner(alias, companyAliases)));
  assert.deepEqual(owners, companyAliases.flatMap(e => e.aliases.map(() => e.company_id))); // no alias belongs to two companies
  for (const pair of distinctCompanies) assert.ok(pair.company_ids.every(id => uuid.test(id)) && pair.note.trim());
});


// A minimal stand-in for the Supabase client: reads return fixed rows, writes are recorded.
function fakeDb(companies) {
  const writes = [];
  const from = table => {
    const q = { select: () => q, order: () => q, eq: () => q, range: () => q, upsert: () => { writes.push(table); return q; },
      then: (resolve) => resolve({ data: table === 'companies' ? companies : [], error: null }) };
    return q;
  };
  return { from, writes };
}
const record = name => ({ company: { name, industry: null, headquarters: null, employee_count: null, workday_signal_date: null, source: null },
  score: { rubric_version: 'x', authority_score: 0, reachability_score: 0, budget_score: 0, release_score: 0, timing_score: 0, authority_evidence: '', reachability_evidence: '', budget_evidence: '', release_evidence: '', timing_evidence: '', tier: 'Disqualified' }, whyNow: null });

test('the CSV importer reuses existing companies and stops on a similar name until someone decides', async (t) => {
  t.mock.method(console, 'table', () => {});
  t.mock.method(console, 'log', () => {});
  // Flex's real ID, so the shipped alias list (Flextronics -> Flex) is what the importer checks.
  const known = [co('a1a1a1a1-0000-4000-8000-000000000001', 'Guess Inc.'), co('e53f08f9-86da-54fe-b068-f730bd77e256', 'Flex'), co('a1a1a1a1-0000-4000-8000-000000000003', 'Rochester Regional Health')];
  const plan = await importCompanies(fakeDb(known), [record('GUESS'), record('Flextronics'), record('Rochester Regional Health System'), record('Brand New Co')]);
  assert.deepEqual(plan.map(p => [p.companyId === known[0].id || p.companyId === known[1].id, p.companyAction]), [
   [true, 'Keep existing (Guess Inc.)'], [true, 'Keep existing (Flex)'], [false, 'Needs review: similar to Rochester Regional Health'], [false, 'Add'],
  ]);
  const db = fakeDb(known);
  await assert.rejects(importCompanies(db, [record('Rochester Regional Health System')], true), /similar company names need a decision/);
  assert.deepEqual(db.writes, []);
  const confirmed = fakeDb(known);
  await importCompanies(confirmed, [record('Rochester Regional Health System')], true, ['rochester regional health system']);
  assert.ok(confirmed.writes.includes('companies'));
});
