import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSecEmployeeEvidence, savedSecEmployeeEvidence } from '../../src/pipeline/sec-employee-evidence.ts';
import { lookupFinancials } from '../../src/pipeline/financials.ts';
import { scoreStage } from '../../src/pipeline/stages.ts';
import { clock, makeCtx } from './helpers.mjs';

const NOW = new Date('2026-11-08T12:00:00Z');
const fact = overrides => ({ end: '2025-12-31', val: 3500, filed: '2026-02-25', form: '10-K', accn: '0000000001-26-000001', ...overrides });
const body = (rows = [fact()], overrides = {}) => ({ cik: 1, entityName: 'Pilot Corp',
  facts: { dei: { EntityNumberOfEmployees: { units: { employee: rows } } } }, ...overrides });
const parse = payload => parseSecEmployeeEvidence(payload, 'Pilot Corp', 1, NOW);

function context(payload = body(), status = 200) {
  let calls = 0;
  const ctx = makeCtx({ now: clock(NOW.toISOString()), fetch: async () => {
    calls++;
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  } });
  ctx.store.latestCapture = async () => ({ body: JSON.stringify({ a: { title: 'Pilot Corp', cik_str: 1 }, b: { title: 'Other Entity', cik_str: 1 } }) });
  return { ctx, calls: () => calls };
}

test('SEC workforce is matched to entity and CIK, with dated filing provenance', () => {
  assert.deepEqual(parse(body()), { employee_count: 3500, as_of: '2025-12-31', source: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/' });
  assert.equal(parse(body(undefined, { cik: 2 })), null);
  assert.equal(parse(body(undefined, { entityName: 'Pilot Subsidiary' })), null);
  assert.equal(parse(body(undefined, { entityName: null })), null);
});

test('latest period and amendment win, including a count falling below the threshold', () => {
  const rows = [fact(), fact({ end: '2026-06-30', filed: '2026-08-01', form: '10-Q', val: 2900 }),
    fact({ end: '2026-06-30', filed: '2026-08-15', form: '10-Q/A', val: 2800 })];
  assert.equal(parse(body(rows)).employee_count, 2800);
  assert.equal(parse(body([fact({ val: 0 })])).employee_count, 0);
  assert.equal(parse(body([fact(), fact({ val: 4000 })])), null, 'equally current contradictory counts are held');
  assert.equal(parse(body([fact(), fact({ filed: '2026-03-01', val: -1 })])), null, 'invalid latest count does not revive older large count');
});

test('missing tags, wrong units, stale and future facts cannot earn points', () => {
  for (const payload of [null, {}, body(undefined, { facts: {} }), body([fact({ end: '2020-01-01' })]),
    body([fact({ end: '2027-01-01', filed: '2027-02-01' })]), body([fact({ filed: '2027-01-01' })]),
    body([fact({ end: '2026-02-30' })]), body([fact({ accn: '../bad' })]), body([fact({ val: 3500.5 })])]) {
    assert.equal(parse(payload), null);
  }
  const payload = body();
  payload.facts.dei.EntityNumberOfEmployees.units = { USD: [fact()], pure: [fact()] };
  assert.equal(parse(payload), null);
});

test('financial lookup shares one SEC request and never reuses workforce for another entity name', async () => {
  const { ctx, calls } = context();
  const first = await lookupFinancials(ctx, 'Pilot Corp');
  assert.equal(first.employeeEvidence.employee_count, 3500);
  assert.equal(first.financials, null);
  assert.equal((await lookupFinancials(ctx, 'Pilot Corp')).requests, 0);
  assert.equal((await lookupFinancials(ctx, 'Other Entity')).employeeEvidence, undefined);
  assert.equal(calls(), 1);
});

async function withCompany() {
  const setup = context();
  const { ctx } = setup;
  const id = ctx.store.addExistingCompany({ name: 'Pilot Corp', domain: 'pilot.example' });
  ctx.store.companyRows[0].pipeline = true;
  const contactId = await ctx.store.insertContact({ company_id: id, name: 'Pat Pilot', title: 'Director of HRIS',
    source: 'https://pilot.example/team', linkedin_status: 'confirmed', linkedin_url: null,
    email: null, email_status: null, phone: null, phone_status: null, mutual_connection: null });
  return { ...setup, id, contactId };
}

test('normal score stage automatically earns the bonus and a reviewed count takes precedence', async () => {
  const { ctx, id, calls } = await withCompany();
  const result = await scoreStage(ctx);
  assert.equal(result.counts.employee_evidence_sec, 1);
  assert.equal((await ctx.store.latestScore(id)).authority_score, 23);
  assert.match((await ctx.store.latestScore(id)).authority_evidence, /Headcount 3500 as of 2025-12-31/);
  ctx.employeeEvidence = [{ company_domain: 'pilot.example', employee_count: 2900, as_of: '2026-10-01', source: 'https://pilot.example/report' }];
  assert.equal((await scoreStage(ctx)).counts.employee_evidence_reviewed, 1);
  assert.equal((await ctx.store.latestScore(id)).authority_score, 20);
  assert.equal(calls(), 1);
});

test('SEC outage retains dated evidence while rescoring an employer mismatch', async () => {
  const { ctx, id, contactId } = await withCompany();
  await scoreStage(ctx);
  await ctx.store.updateContact(contactId, { contact_sources: { role_review: { status: 'different_employer' } } });
  const outage = { ...ctx, fetch: async () => new Response('', { status: 503 }) };
  const result = await scoreStage(outage);
  assert.equal(result.counts.employee_evidence_retained, 1);
  assert.equal((await ctx.store.latestScore(id)).authority_score, 0);
});

test('retained evidence requires a current date and exact SEC filing URL', () => {
  const value = 'https://pilot.example/team | Authority. Headcount 3500 as of 2025-12-31: https://www.sec.gov/Archives/edgar/data/1/000000000126000001/';
  assert.equal(savedSecEmployeeEvidence(value, NOW).employee_count, 3500);
  assert.equal(savedSecEmployeeEvidence(value.replace('2025-12-31', '2020-01-01'), NOW), null);
  assert.equal(savedSecEmployeeEvidence(value.replace('www.sec.gov', 'sec.example'), NOW), null);
  assert.equal(savedSecEmployeeEvidence(value.replace('2025-12-31', '2027-01-01'), NOW), null);
});
