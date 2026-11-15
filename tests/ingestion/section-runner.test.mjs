import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../../src/pipeline/store/memory.ts';
import { runPipeline } from '../../src/pipeline/runner.ts';
import { collectStage, extractStage, matchStage } from '../../src/pipeline/stages.ts';
import { discoveryBatch } from '../../src/pipeline/section-scope.ts';
import { normalizeName } from '../../src/domain/ingestion/normalize.ts';
import { makeCtx, clock, worldFetch, worldTreg, groundedModel, WORLD_NAMES, worldTenant } from './helpers.mjs';

export const scopeFor = (section, names, offset = 0) => ({ version: 'fictional-sections-v1', section, snapshotSha256: 'a'.repeat(64), ambiguousNames: [], issuers: names.map((name, i) => ({ cik: offset + i + 1000, name })) });
const execute = (ctx, limit = 2) => runPipeline(ctx, { plan: 'section', limit, dryRun: false, trigger: 'manual' });
function context(store, scope, names, now = clock()) {
  return { ...makeCtx({ store, now, fetch: worldFetch({ names, existingTenants: names.length }), treg: worldTreg() }), sectionScope: scope };
}
export async function seedCapture(store, scope, issuer, { raw, url, meta, source = 'workday-site-resolver' } = {}) {
  const tenant = worldTenant(issuer.name);
  const body = raw ?? `User-agent: *\nAllow: /\nSitemap: https://${tenant}.wd5.myworkdayjobs.com/${tenant}Careers/siteMap.xml`;
  const saved = await store.saveCapture({ source, url: url ?? `https://${tenant}.wd5.myworkdayjobs.com/robots.txt`, raw: body,
    fingerprint: createHash('sha256').update(body).digest('hex'), fetched_at: '2026-10-13T12:00:00Z', http_status: 200, content_type: 'text/plain',
    meta: { kind: 'workday_robots', normalized_name: normalizeName(issuer.name), company_name: issuer.name, tenant, pod: 'wd5', match_kind: 'full_name', ...meta } }, null);
  await store.linkSectionCapture(scope, issuer.cik, saved.id);
  return saved;
}

test('concurrent disjoint sections discover, extract, collect jobs and admit only their own issuers', async () => {
  const names = WORLD_NAMES.slice(0, 4), store = new MemoryStore();
  const a = context(store, scopeFor(1, names.slice(0, 2)), names);
  const b = context(store, scopeFor(2, names.slice(2), 2), names);
  const [ra, rb] = await Promise.all([execute(a), execute(b)]);
  for (const r of [ra, rb]) {
    assert.deepEqual(r.jobs.flatMap(j => j.errors), []);
    assert.equal(r.section.found, 2);
    assert.equal(r.jobs.some(j => /score|enrich/.test(j.job)), false);
  }
  assert.equal(store.companyRows.length, 4);
  assert.equal(store.scores.length, 0);
  assert.equal(store.contacts.length, 0);
  for (const ctx of [a, b]) {
    const allowed = new Set(ctx.sectionScope.issuers.map(i => normalizeName(i.name)));
    const captures = new Set(await store.sectionCaptureIds(ctx.sectionScope));
    assert.ok(captures.size > 2);
    assert.ok(store.captures.filter(c => captures.has(c.id)).every(c => allowed.has(c.meta.normalized_name)));
    assert.ok(!ctx.fetch.calls.some(c => /sec.gov|commoncrawl|web.archive/.test(c.url)));
    const otherTenants = names.filter(n => !allowed.has(normalizeName(n))).map(worldTenant);
    assert.ok(!ctx.fetch.calls.some(c => otherTenants.some(t => c.url.includes(`${t}.`))));
  }
});

test('a repeat skips completed discovery and a new device resumes remaining issuer positions', async () => {
  const names = WORLD_NAMES.slice(0, 3), store = new MemoryStore(), scope = scopeFor(3, names);
  await execute(context(store, scope, names), 1);
  const next = context(store, scope, names);
  const report = await execute(next, 1);
  assert.equal(report.section.found, 2);
  assert.equal(report.section.pending, 1);
  assert.match(report.jobs[0].job, /discover:1001$/);
  assert.ok(!report.jobs.some(j => /discover:1000$/.test(j.job)));
});

test('completed misses are retained; temporary failures retry after cooldown without blocking fresh work', async () => {
  const now = clock(), names = WORLD_NAMES.slice(0, 2), store = new MemoryStore({ now }), scope = scopeFor(1, names);
  await store.ensureSection(scope);
  await store.saveSectionProgress(scope, 1000, { status: 'retry', probes: 3 }, now().toISOString());
  assert.deepEqual(discoveryBatch(scope, await store.sectionProgress(scope), 2, now()).map(i => i.cik), [1001]);
  await store.saveSectionProgress(scope, 1001, { status: 'miss', probes: 12 }, now().toISOString());
  assert.deepEqual(discoveryBatch(scope, await store.sectionProgress(scope), 2, now()), []);
  now.advanceDays(1);
  assert.deepEqual(discoveryBatch(scope, await store.sectionProgress(scope), 2, now()).map(i => i.cik), [1000]);
  const missCtx = context(store, scopeFor(2, [WORLD_NAMES[4]], 5), names, now);
  missCtx.fetch = worldFetch({ names, existingTenants: 0 });
  const missed = await execute(missCtx, 1);
  assert.equal(missed.section.miss, 1);
  const retryCtx = context(store, scopeFor(3, [WORLD_NAMES[5]], 6), names, now);
  retryCtx.fetch = async () => { throw new TypeError('Fictional network failure'); };
  const failed = await execute(retryCtx, 1);
  assert.equal(failed.section.retry, 1);
  assert.ok(failed.jobs.some(j => j.status !== 'succeeded'));
});

test('capture storage and membership failures never checkpoint discovery as complete', async () => {
  for (const method of ['saveCapture', 'linkSectionCapture']) {
    const names = WORLD_NAMES.slice(0, 1), store = new MemoryStore(), scope = scopeFor(1, names);
    store.failAfter[method] = 0;
    const failed = await execute(context(store, scope, names), 1);
    assert.equal(failed.section.found, 0);
    assert.equal(failed.section.retry, 1);
    delete store.failAfter[method];
    const now = clock('2026-10-14T12:00:00Z');
    const resumed = await execute(context(store, scope, names, now), 1);
    assert.equal(resumed.section.found, 1);
    assert.equal(store.companyRows.length, 1);
  }
});

test('interruption after discovery resumes stored evidence without rediscovering', async () => {
  const names = WORLD_NAMES.slice(0, 1), store = new MemoryStore(), scope = scopeFor(1, names);
  await store.ensureSection(scope);
  const ctx = context(store, scope, names);
  ctx.sectionIssuer = scope.issuers[0];
  await collectStage(ctx, (await store.sources()).find(s => s.id === 'workday-site-resolver'), { limit: 1, dryRun: false });
  assert.equal((await store.sectionProgress(scope))[0].status, 'found');
  assert.equal(store.extractions.length, 0);
  const resumed = await execute(context(store, scope, names), 1);
  assert.ok(!resumed.jobs.some(j => /discover:/.test(j.job)));
  assert.equal(store.companyRows.length, 1);
});

test('scoped extraction filters before the limit and matching leaves unrelated reviews and sites unchanged', async () => {
  const names = WORLD_NAMES.slice(0, 2), store = new MemoryStore(), scope = scopeFor(1, [names[0]]), other = scopeFor(2, [names[1]], 1);
  await store.ensureSection(scope); await store.ensureSection(other);
  const foreign = await seedCapture(store, other, other.issuers[0]);
  const own = await seedCapture(store, scope, scope.issuers[0]);
  const otherCtx = context(store, other, names);
  await extractStage(otherCtx, { limit: 10 });
  otherCtx.treg = null;
  await matchStage(otherCtx);
  const review = structuredClone(store.reviews), sites = structuredClone(store.sites), signals = structuredClone(store.signals);
  assert.deepEqual((await store.pendingCaptures(1, undefined, scope)).map(c => c.id), [own.id]);
  await execute(context(store, scope, names), 1);
  assert.deepEqual(store.reviews.filter(r => r.normalized_name === normalizeName(names[1])), review);
  assert.deepEqual(store.sites.filter(s => s.capture_id === foreign.id), sites);
  assert.deepEqual(store.signals.filter(s => s.capture_id === foreign.id), signals);
});

test('pending review recovery only handles owned evidence and preserves rejected decisions', async () => {
  const names = WORLD_NAMES.slice(0, 2), store = new MemoryStore(), scope = scopeFor(1, [names[0]]), other = scopeFor(2, [names[1]], 1);
  const a = context(store, scope, names), b = context(store, other, names);
  a.treg = null; b.treg = null;
  await execute(a, 1); await execute(b, 1);
  assert.equal(store.reviews.length, 2);
  const otherReview = structuredClone(store.reviews.find(r => r.normalized_name === normalizeName(names[1])));
  const recovered = await execute(context(store, scope, names), 1);
  assert.ok(recovered.jobs.some(j => j.counts.recovered_reviews === 1));
  assert.deepEqual(store.reviews.find(r => r.id === otherReview.id), otherReview);
  await store.resolveReview(otherReview.id, { action: 'reject' }, 'Fictional human rejection', null);
  await execute(context(store, other, names), 1);
  assert.equal(store.reviews.find(r => r.id === otherReview.id).status, 'rejected');
});

test('shared raw evidence preserves both memberships without relabeling another company context', async () => {
  const names = WORLD_NAMES.slice(0, 2), store = new MemoryStore(), scope = scopeFor(1, [names[0]]), other = scopeFor(2, [names[1]], 1);
  await store.ensureSection(scope); await store.ensureSection(other);
  const shared = await seedCapture(store, other, other.issuers[0]);
  await store.linkSectionCapture(scope, scope.issuers[0].cik, shared.id);
  const before = structuredClone(await store.captureById(shared.id));
  assert.deepEqual(await store.pendingCaptures(10, undefined, scope), []);
  assert.deepEqual(await store.sectionCaptureIds(scope), [shared.id]);
  assert.deepEqual(await store.sectionCaptureIds(other), [shared.id]);
  await execute(context(store, scope, names), 1);
  assert.deepEqual(await store.captureById(shared.id), before);
});

test('scope cannot be combined with global plans and ambiguous names remain held', async () => {
  const names = WORLD_NAMES.slice(0, 1), store = new MemoryStore(), scope = scopeFor(1, names);
  const ctx = context(store, scope, names);
  await assert.rejects(runPipeline(ctx, { plan: 'all', limit: 1, dryRun: false, trigger: 'manual' }), /global plans/);
  scope.ambiguousNames = names.map(normalizeName);
  const report = await execute(ctx, 1);
  assert.equal(report.section.held_ambiguous, 1);
  assert.equal(ctx.fetch.calls.length, 0);
});

test('a model response followed by a signal-write failure leaves evidence queued for retry', async () => {
  const names = WORLD_NAMES.slice(0, 1), store = new MemoryStore(), scope = scopeFor(1, names);
  const ctx = context(store, scope, names);
  ctx.llm = groundedModel();
  store.failAfter.upsertSignal = 1; // Resolver signal succeeds; the first posting signal fails.
  const failed = await execute(ctx, 1);
  assert.ok(failed.jobs.some(j => j.counts.error_extract));
  assert.ok(store.extractions.some(e => e.method === 'llm' && e.status === 'done'));
  assert.ok((await store.pendingCaptures(200, undefined, scope)).length > 0);
  delete store.failAfter.upsertSignal;
  const resumed = await execute(context(store, scope, names), 1);
  assert.deepEqual(resumed.jobs.flatMap(j => j.errors), []);
  assert.equal((await store.pendingCaptures(200, undefined, scope)).length, 0);
  assert.equal(store.companyRows.length, 1);
});

test('deduplicated legacy signals retain their original capture and gain section membership', async () => {
  const names = WORLD_NAMES.slice(0, 1), store = new MemoryStore(), scope = scopeFor(1, names);
  await store.ensureSection(scope);
  const original = await seedCapture(store, scope, scope.issuers[0]);
  const legacy = makeCtx({ store });
  await extractStage(legacy, { limit: 1 });
  const signal = structuredClone(store.signals[0]);
  store.sectionCaptures = [];
  const updated = await seedCapture(store, scope, scope.issuers[0], { raw: (await store.captureById(original.id)).body + '\n# changed response' });
  await extractStage(context(store, scope, names), { limit: 10 });
  assert.equal(store.signals[0].id, signal.id);
  assert.equal(store.signals[0].capture_id, original.id);
  assert.ok((await store.sectionCaptureIds(scope)).includes(original.id));
  assert.ok((await store.sectionCaptureIds(scope)).includes(updated.id));
  assert.equal((await store.unassignedSignals(scope)).length, 1);
});
