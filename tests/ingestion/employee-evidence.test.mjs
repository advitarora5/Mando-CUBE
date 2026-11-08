import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { employeeEvidenceSchema, employeeEvidenceForCompany } from '../../src/pipeline/employee-evidence.ts';
import { contextFromEnv } from '../../src/pipeline/context.ts';
import { scoreStage } from '../../src/pipeline/stages.ts';
import { makeCtx, clock } from './helpers.mjs';

const NOW = new Date('2026-11-08T12:00:00Z');
const evidence = overrides => ({ company_domain: 'research.example', employee_count: 3000,
  as_of: '2026-06-30', source: 'https://research.example/annual-report', ...overrides });

test('headcount evidence validates domain, integer count, date, source and normalized duplicates', () => {
  const rows = employeeEvidenceSchema.parse([evidence({ company_domain: 'https://www.research.example/' })]);
  assert.equal(rows[0].company_domain, 'research.example');
  for (const overrides of [{ company_domain: 'unknown' }, { employee_count: -1 },
    { employee_count: 3000.5 }, { as_of: '2026-02-30' }, { source: 'file:///report' }]) {
    assert.equal(employeeEvidenceSchema.safeParse([evidence(overrides)]).success, false);
  }
  assert.equal(employeeEvidenceSchema.safeParse([evidence(), evidence({ company_domain: 'www.research.example' })]).success, false);
});

test('evidence matches exact employer domain and excludes future and stale reports', () => {
  assert.equal(employeeEvidenceForCompany([evidence()], 'www.research.example', NOW)?.employee_count, 3000);
  for (const domain of [null, 'subsidiary.research.example', 'other.example']) {
    assert.equal(employeeEvidenceForCompany([evidence()], domain, NOW), null);
  }
  for (const age of [-1, 549]) {
    const as_of = new Date(NOW.getTime() - age * 86400000).toISOString().slice(0, 10);
    assert.equal(employeeEvidenceForCompany([evidence({ as_of })], 'research.example', NOW), null);
  }
  const as_of = new Date(NOW.getTime() - 548 * 86400000).toISOString().slice(0, 10);
  assert.ok(employeeEvidenceForCompany([evidence({ as_of })], 'research.example', NOW));
});

async function scoreWithEvidence(rows, confirmed = true) {
  const ctx = makeCtx({ now: clock(NOW.toISOString()) });
  const id = ctx.store.addExistingCompany({ name: 'Research Company', domain: 'research.example', employee_count: 99999 });
  ctx.store.companyRows[0].pipeline = true;
  ctx.employeeEvidence = rows;
  await ctx.store.insertContact({ company_id: id, name: 'Pat Buyer', title: 'Director of HRIS',
    source: 'https://research.example/team', linkedin_url: 'https://www.linkedin.com/in/pat-buyer',
    linkedin_status: confirmed ? 'confirmed' : 'unconfirmed',
    contact_sources: { name_title_linkedin: { provider: 'test' } },
    email: null, email_status: null, phone: null, phone_status: null, mutual_connection: null });
  await scoreStage(ctx);
  return { ctx, id, score: await ctx.store.latestScore(id) };
}

test('normal scoring entry point awards size points and retains source and date with contact provenance', async () => {
  const { ctx, id, score } = await scoreWithEvidence(employeeEvidenceSchema.parse([evidence()]));
  assert.equal(score.authority_score, 23);
  assert.match(score.authority_evidence, /^https:\/\/research.example\/team \|/);
  assert.ok(score.authority_evidence.includes('3000 as of 2026-06-30: https://research.example/annual-report'));
  const again = await scoreStage(ctx);
  assert.equal(again.counts.unchanged, 1);
  assert.equal((await ctx.store.latestScore(id)).authority_score, 23);
  ctx.employeeEvidence = [evidence({ as_of: "2026-07-01", source: "https://research.example/new-report" })];
  const updated = await scoreStage(ctx);
  assert.equal(updated.counts.rescored, 1);
  assert.match((await ctx.store.latestScore(id)).authority_evidence, /2026-07-01: https:\/\/research.example\/new-report/);
  ctx.employeeEvidence = [evidence({ employee_count: 2999 })];
  await scoreStage(ctx);
  assert.equal((await ctx.store.latestScore(id)).authority_score, 20);
});

test('legacy unsourced headcount, stale or wrong-company evidence and unconfirmed contacts earn no size bonus', async () => {
  for (const rows of [[], [evidence({ as_of: '2020-01-01' })], [evidence({ company_domain: 'other.example' })], [evidence({ employee_count: 2999 })]]) {
    assert.equal((await scoreWithEvidence(rows)).score.authority_score, 20);
  }
  assert.equal((await scoreWithEvidence([evidence()], false)).score.authority_score, 5);
});

test('context loads reviewed headcount evidence and rejects malformed files before store access', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'employee-evidence-'));
  const path = join(dir, 'evidence.json');
  try {
    writeFileSync(path, JSON.stringify([evidence()]));
    const ctx = await contextFromEnv({ PIPELINE_EMPLOYEE_EVIDENCE_FILE: path }, { dryRun: true, noLlm: true, noTreg: true });
    assert.equal(ctx.employeeEvidence[0].employee_count, 3000);
    writeFileSync(path, JSON.stringify([evidence({ employee_count: -1 })]));
    await assert.rejects(contextFromEnv({ PIPELINE_EMPLOYEE_EVIDENCE_FILE: path }, { dryRun: false, noLlm: true, noTreg: true }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sourced size bonus can move a fully evidenced pipeline assessment from 67 to 70', async () => {
  const { scoreCompany } = await import('../../src/domain/ingestion/pipeline-score.ts');
  const { defaultSettings } = await import('../../src/domain/ingestion/settings.ts');
  const contact = { name: 'Pat Buyer', title: 'Director of HRIS', source: 'https://research.example/team',
    linkedin_url: 'https://www.linkedin.com/in/pat-buyer', linkedin_status: 'confirmed',
    email: null, email_status: null, phone: null, phone_status: null, mutual_connection: null };
  const signals = [{ type: 'go_live', project_type: 'implementation', signal_date: '2026-10-01',
    source_url: 'https://research.example/workday-launch', quote: 'Workday implementation went live October 1.',
    confidence: 1, first_seen_at: NOW.toISOString(), last_seen_at: NOW.toISOString() }];
  const financials = { fiscal_year_end: '2026-06-30', currency: 'USD', operating_income: 100,
    prior_operating_income: 90, revenue: 1000, prior_revenue: 1000, source_url: 'https://research.example/financials' };
  const before = scoreCompany('example', signals, [contact], defaultSettings, NOW, { employee_count: 3000, financials });
  const after = scoreCompany('example', signals, [contact], defaultSettings, NOW, {
    employee_count: 3000, employee_source: evidence().source, employee_as_of: evidence().as_of, financials });
  assert.equal(before.result.total, 67);
  assert.equal(before.result.tier, 'Maybe');
  assert.equal(after.result.total, 70);
  assert.equal(after.result.tier, 'Qualified');
});
