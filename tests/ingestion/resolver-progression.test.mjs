import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolverNames } from '../../src/pipeline/collectors/workday.ts';
import { normalizeName } from '../../src/domain/ingestion/normalize.ts';
import { MemoryStore } from '../../src/pipeline/store/memory.ts';
import { makeCtx, secFixture } from './helpers.mjs';

async function setup(count) {
  const names = Array.from({ length: count }, (_, i) => `Progress Robotics ${i} Inc`);
  const store = new MemoryStore();
  await store.saveCapture({
    source: 'sec-company-list', url: 'https://www.sec.gov/files/company_tickers.json',
    fetched_at: '2026-10-24T12:00:00Z', http_status: 200, content_type: 'application/json',
    raw: secFixture(names), fingerprint: 'a'.repeat(64), meta: { kind: 'sec_company_list' },
  }, null);
  const markAttempted = async name => store.saveResolverAttempt({
    normalized_name: normalizeName(name), company_name: name,
    found: names.indexOf(name) % 2 === 0, probes: 1,
  });
  return { names, store, ctx: makeCtx({ store }), markAttempted };
}

test('resolver advances successive batches beyond the old lookup window and past 1,000 names', async () => {
  const { names, ctx, markAttempted } = await setup(1005);
  const max = 20;
  // Both successful and unsuccessful attempts must be skipped for now.
  for (const name of names.slice(0, max * 5)) await markAttempted(name);
  for (let offset = max * 5; offset < names.length; offset += max) {
    const batch = await resolverNames(ctx, max);
    assert.deepEqual(batch.map(c => c.name), names.slice(offset, offset + max));
    for (const candidate of batch) await markAttempted(candidate.name);
  }
  assert.deepEqual(await resolverNames(ctx, max), [], 'an exhausted SEC list stays exhausted');
});

test('resolver checks attempts in bounded pages and stops once enough new names are found', async () => {
  const { names, store, ctx, markAttempted } = await setup(1005);
  for (const name of names.slice(0, 199)) await markAttempted(name);
  const lookups = [];
  const lookup = store.resolverAttempts.bind(store);
  store.resolverAttempts = async candidates => {
    lookups.push(candidates);
    return lookup(candidates);
  };
  const batch = await resolverNames(ctx, 3);
  assert.deepEqual(batch.map(c => c.name), names.slice(199, 202));
  assert.ok(lookups.every(page => page.length <= 200), 'avoid unbounded database filters');
  assert.equal(lookups.length, 2, 'do not fetch attempt history for the rest of the SEC list');
});

test('resolver returns a short final batch without filling it with previously attempted names', async () => {
  const { names, ctx, markAttempted } = await setup(205);
  for (const name of names.slice(0, 200)) await markAttempted(name);
  assert.deepEqual((await resolverNames(ctx, 20)).map(c => c.name), names.slice(200));
  assert.deepEqual(await resolverNames(ctx, 0), []);
});
