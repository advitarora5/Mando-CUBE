import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../src/pipeline/store/memory.ts';
import { workScoringQueue } from '../../src/pipeline/scoring-queue.ts';
import { parseScoringCommand } from '../../scripts/pipeline-scoring.mjs';
import { makeCtx, clock } from './helpers.mjs';

const add = (store, name = 'Fictional Alder', domain = 'alder.example', run = 'run-a') => store.createPipelineCompany({ name, domain, employee_count: null, source: 'https://proof.example/' }, run, { signal_ids: [], normalized_name: null });

test('simultaneous confirmed website admissions reuse one company and preserve existing fields', async () => {
  const store = new MemoryStore();
  const [a, b] = await Promise.all([add(store), add(store, 'Another issuer name', 'https://www.ALDER.example/careers', 'run-b')]);
  assert.equal(a, b);
  assert.equal(store.companyRows.length, 1);
  assert.equal(await store.companyCreatedInRun(a, 'run-a'), true);
  assert.equal(await store.companyCreatedInRun(b, 'run-b'), false);
  const original = structuredClone(store.companyRows[0]);
  assert.equal(await add(store, 'Replacement name', 'alder.example'), a);
  assert.deepEqual(store.companyRows[0], original);
  await assert.rejects(add(store, original.name, 'different.example'), /identity requires review/);
  await assert.rejects(add(store, 'Fictional Subsidiary', 'subsidiary.alder.example'), /identity requires review/);
});

test('one scoring entry coalesces evidence requests and scores an existing non-pipeline company', async () => {
  const now = clock(), store = new MemoryStore({ now });
  const id = store.addExistingCompany({ name: 'Fictional Research Company', domain: 'research.example' });
  await store.enqueueScoring(id); await store.enqueueScoring(id);
  assert.equal(store.scoringJobs.size, 1);
  assert.equal(store.scoringJobs.get(id).requested, 3);
  store.companies = async () => { throw Error('Queued scoring must not scan the entire company list'); };
  const report = await workScoringQueue(makeCtx({ store, now }), { limit: 10 });
  assert.equal(report.completed, 1);
  assert.equal(store.scores.length, 1);
  assert.match(store.scores[0].authority_evidence, /unknown|Needs evidence/i);
  assert.equal(store.scoringJobs.get(id).status, 'done');
  assert.equal(store.contacts.length, 0);
  assert.equal(store.enrichment.size, 0);
});

test('evidence arriving during scoring is left pending for a second pass', async () => {
  const now = clock(), store = new MemoryStore({ now }), id = await add(store);
  const finish = store.finishScoring.bind(store);
  store.finishScoring = async (...args) => { await store.enqueueScoring(id); return finish(...args); };
  const first = await workScoringQueue(makeCtx({ store, now }), { limit: 1 });
  assert.equal(first.completed, 1);
  assert.equal(store.scoringJobs.get(id).status, 'pending');
  assert.ok(store.scoringJobs.get(id).requested > store.scoringJobs.get(id).completed);
  store.finishScoring = finish;
  const next = await workScoringQueue(makeCtx({ store, now }), { limit: 1 });
  assert.equal(next.completed, 1);
  assert.equal(next.counts.unchanged, 1);
  assert.equal(store.scores.length, 1, 'unchanged retry does not append duplicate assessments');
  assert.equal(store.scoringJobs.get(id).status, 'done');
});

test('failed score commits retain work for retry without acknowledging or saving a partial score', async () => {
  const now = clock(), store = new MemoryStore({ now }), id = await add(store);
  store.failAfter.finishScoring = 0;
  const ctx = makeCtx({ store, now });
  const failed = await workScoringQueue(ctx, { limit: 2 });
  assert.equal(failed.retry, 1);
  assert.equal(store.scoringJobs.get(id).completed, 0);
  assert.equal(store.scoringJobs.get(id).status, 'retry');
  assert.equal(store.scores.length, 0);
  assert.equal((await workScoringQueue(ctx, { limit: 2 })).attempted, 0);
  now.advanceDays(1); delete store.failAfter.finishScoring;
  assert.equal((await workScoringQueue(ctx, { limit: 2 })).completed, 1);
  assert.equal(store.scores.length, 1);
});

test('unavailable financial evidence preserves the saved assessment and keeps scoring queued', async () => {
  const now = clock(), store = new MemoryStore({ now }), id = await add(store);
  const ctx = makeCtx({ store, now });
  ctx.contact = '';
  await workScoringQueue(ctx, { limit: 1, companyId: id });
  store.scores[0].budget_score = 10;
  const previous = structuredClone(store.scores[0]);
  await store.enqueueScoring(id);
  const report = await workScoringQueue(ctx, { limit: 1, companyId: id });
  assert.equal(report.retry, 1);
  assert.equal(report.counts.financials_deferred, 1);
  assert.deepEqual(store.scores, [previous]);
  assert.equal(store.scoringJobs.get(id).lastError, 'financials_deferred');
});

test('abandoned scoring can be reclaimed after five minutes and stale acknowledgements are rejected', async () => {
  const now = clock(), store = new MemoryStore({ now }), id = await add(store);
  const first = await store.claimScoring(id);
  assert.equal(await store.claimScoring(id), null);
  now.advanceDays(1);
  const second = await store.claimScoring(id);
  assert.notEqual(first.token, second.token);
  await assert.rejects(store.finishScoring(first, null, now().toISOString()), /no longer current/);
  await store.failScoring(first, 'score_failed');
  assert.equal(store.scoringJobs.get(id).claim.token, second.token);
  await store.failScoring(second, 'score_failed');
  assert.equal(store.scoringJobs.get(id).status, 'retry');
});

test('concurrent workers claim different companies and a selected company does not drain unrelated work', async () => {
  const now = clock(), store = new MemoryStore({ now });
  const a = await add(store), b = await add(store, 'Fictional Birch', 'birch.example');
  const [ca, cb] = await Promise.all([store.claimScoring(), store.claimScoring()]);
  assert.notEqual(ca.company_id, cb.company_id);
  await store.failScoring(ca, 'score_failed'); await store.failScoring(cb, 'score_failed');
  now.advanceDays(1);
  const report = await workScoringQueue(makeCtx({ store, now }), { limit: 10, companyId: a });
  assert.equal(report.completed, 1);
  assert.equal(store.scoringJobs.get(b).status, 'retry');
  assert.equal(store.scores.length, 1);
});

test('scoring command accepts bounded worker options and rejects invalid or repeated flags', () => {
  assert.equal(parseScoringCommand(['status']).command, 'status');
  assert.equal(parseScoringCommand(['work', '--watch', '--limit', '3', '--poll-seconds', '2']).watch, true);
  for (const argv of [[], ['status', '--watch'], ['work', '--limit', '0'], ['work', '--limit', '101'], ['work', '--limit'], ['work', '--poll-seconds', '2'], ['work', '--watch', '--watch'], ['work', '--company', 'bad'], ['work', '--sectoin', '3'], ['enqueue', 'bad']]) assert.throws(() => parseScoringCommand(argv));
});
