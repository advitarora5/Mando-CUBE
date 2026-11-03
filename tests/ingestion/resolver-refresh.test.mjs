import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkdayResolver, resolverCandidates } from '../../src/pipeline/collectors/workday.ts';
import { MemoryStore, DEFAULT_SOURCES } from '../../src/pipeline/store/memory.ts';
import { normalizeName } from '../../src/domain/ingestion/normalize.ts';
import { collectStage, extractStage } from '../../src/pipeline/stages.ts';
import { clock, makeCtx, response } from './helpers.mjs';

const name = 'Refresh Robotics Inc';
const robots = 'User-agent: *\nAllow: /\nSitemap: https://refreshrobotics.wd5.myworkdayjobs.com/Careers/siteMap.xml\n';
const source = {
  ...DEFAULT_SOURCES.find(s => s.id === 'workday-site-resolver'),
  config: { names_per_site: 1, full_name_pods: 1, first_word_pods: 1 },
};
const limits = { maxItems: 1, maxRequests: 20, minDelayMs: 1000, dryRun: false };

async function setup(names = [name]) {
  const now = clock('2026-10-01T00:00:00Z');
  const store = new MemoryStore({ now });
  await store.saveCapture({
    source: 'sec-company-list', url: 'https://www.sec.gov/files/company_tickers.json',
    fetched_at: now().toISOString(), http_status: 200, content_type: 'application/json',
    raw: JSON.stringify(Object.fromEntries(names.map((title, i) => [i, { title }]))),
    fingerprint: 'a'.repeat(64), meta: { kind: 'sec_company_list' },
  }, null);
  const ctx = makeCtx({ store, now, fetch: async () => response(200, robots) });
  return { ctx, store, now };
}

test('successful discovery becomes due at seven days; unchanged robots refresh evidence without duplicating it', async () => {
  const { ctx, store, now } = await setup();
  const first = await collectStage(ctx, source, { limit: 1, dryRun: false });
  assert.equal(first.counts.new_captures, 1);
  await extractStage(ctx, { limit: 20 });
  const signal = store.signals.find(s => s.type === 'known_customer');
  assert.ok(signal);
  const initialSeen = signal.last_seen_at;
  const captureCount = store.captures.length;
  now.advanceDays(6);
  assert.deepEqual(await resolverCandidates(ctx, 1), []);
  now.advanceDays(1);
  const recheck = await collectStage(ctx, source, { limit: 1, dryRun: false });
  assert.equal(recheck.counts.unchanged_captures, 1);
  assert.equal(recheck.counts.signals_refreshed, 1);
  assert.equal(store.captures.length, captureCount);
  assert.equal(store.signals.length, 1);
  assert.notEqual(signal.last_seen_at, initialSeen);
  assert.equal(signal.last_seen_at, now().toISOString());
  assert.deepEqual(await resolverCandidates(ctx, 1), [], 'a successful refresh resets the clock');
});

test('completed misses are retried at thirty days, not on every run', async () => {
  const { ctx, store, now } = await setup();
  ctx.fetch = async () => response(422, 'Unknown tenant');
  await new WorkdayResolver().collect(source, limits, ctx);
  assert.equal(store.attempts.get(normalizeName(name)).found, false);
  now.advanceDays(29);
  assert.deepEqual(await resolverCandidates(ctx, 1), []);
  now.advanceDays(1);
  assert.equal((await resolverCandidates(ctx, 1))[0].name, name);
});

test('new discoveries alternate with due rechecks; successful sites get refresh priority over old misses', async () => {
  const names = ['New Alpha Inc', 'New Beta Inc', 'Old Miss Inc', 'Old Success Inc'];
  const { ctx, store, now } = await setup(names);
  await store.saveResolverAttempt({ normalized_name: 'old miss', company_name: names[2], found: false, probes: 2 });
  await store.saveResolverAttempt({ normalized_name: 'old success', company_name: names[3], found: true, probes: 1 });
  now.advanceDays(30);
  assert.deepEqual((await resolverCandidates(ctx, 4)).map(c => c.name), [names[0], names[3], names[1], names[2]]);
});

for (const failure of ['network', 'timeout', 'server']) {
  test(`${failure} failures are not recorded as misses, and recovery is eligible on the next run`, async () => {
    const { ctx, store } = await setup();
    let requests = 0;
    ctx.fetch = async () => {
      requests++;
      if (failure === 'network') throw new TypeError('temporary network failure');
      if (failure === 'timeout') { const error = new Error('timed out'); error.name = 'AbortError'; throw error; }
      return response(500, 'Temporary server failure');
    };
    const failed = await new WorkdayResolver().collect(source, limits, ctx);
    assert.ok(failed.errors.length);
    assert.ok(requests > 0 && requests <= limits.maxRequests);
    assert.equal(store.attempts.size, 0);
    ctx.fetch = async () => response(200, robots);
    const recovered = await new WorkdayResolver().collect(source, limits, ctx);
    assert.equal(recovered.items.length, 1);
    assert.equal(store.attempts.get(normalizeName(name)).found, true);
  });
}

test('a request cap interrupting tenant probes does not record a completed miss', async () => {
  const { ctx, store } = await setup();
  ctx.fetch = async () => response(422, 'Unknown tenant');
  await new WorkdayResolver().collect(source, { ...limits, maxRequests: 1 }, ctx);
  assert.equal(store.attempts.size, 0);
  await new WorkdayResolver().collect(source, limits, ctx);
  assert.equal(store.attempts.get(normalizeName(name)).found, false);
});

test('a blocked recheck neither refreshes evidence nor delays the next eligible retry', async () => {
  const { ctx, store, now } = await setup();
  await collectStage(ctx, source, { limit: 1, dryRun: false });
  await extractStage(ctx, { limit: 20 });
  const signal = store.signals[0];
  const seen = signal.last_seen_at;
  const tried = store.attempts.get(normalizeName(name)).tried_at;
  now.advanceDays(7);
  ctx.fetch = async () => response(403, 'Forbidden');
  const failed = await collectStage(ctx, source, { limit: 1, dryRun: false });
  assert.match(failed.blocked, /blocked/);
  assert.equal(signal.last_seen_at, seen);
  assert.equal(store.attempts.get(normalizeName(name)).tried_at, tried);
  assert.equal((await resolverCandidates(ctx, 1))[0].name, name);
});

test('a vanished site does not renew known-customer evidence', async () => {
  const { ctx, store, now } = await setup();
  await collectStage(ctx, source, { limit: 1, dryRun: false });
  await extractStage(ctx, { limit: 20 });
  const seen = store.signals[0].last_seen_at;
  now.advanceDays(7);
  ctx.fetch = async () => response(422, 'Unknown tenant');
  const out = await collectStage(ctx, source, { limit: 1, dryRun: false });
  assert.equal(out.counts.items, 0);
  assert.equal(store.signals[0].last_seen_at, seen);
  assert.equal(store.attempts.get(normalizeName(name)).found, false);
});

test('rechecks use a known host even when its pod is outside the guessing list', async () => {
  const { ctx, store, now } = await setup();
  await store.upsertWorkdaySite({ tenant: 'unusualtenant', pod: 'wd999', site: 'Careers', company_name: name,
    normalized_name: normalizeName(name), match_kind: 'first_word', discovered_from: source.id, capture_id: null });
  await store.saveResolverAttempt({ normalized_name: normalizeName(name), company_name: name, found: true, probes: 1 });
  now.advanceDays(7);
  const urls = [];
  ctx.fetch = async url => {
    urls.push(String(url));
    return response(200, 'Sitemap: https://unusualtenant.wd999.myworkdayjobs.com/Careers/siteMap.xml');
  };
  const out = await new WorkdayResolver().collect(source, limits, ctx);
  assert.deepEqual(urls, ['https://unusualtenant.wd999.myworkdayjobs.com/robots.txt']);
  assert.equal(out.items[0].meta.match_kind, 'first_word', 'rechecking must not upgrade identity confidence');
});

test('dry-run rechecks leave timestamps unchanged', async () => {
  const { ctx, store, now } = await setup();
  await store.saveResolverAttempt({ normalized_name: normalizeName(name), company_name: name, found: true, probes: 1 });
  const tried = store.attempts.get(normalizeName(name)).tried_at;
  now.advanceDays(7);
  await new WorkdayResolver().collect(source, { ...limits, dryRun: true }, ctx);
  assert.equal(store.attempts.get(normalizeName(name)).tried_at, tried);
});
