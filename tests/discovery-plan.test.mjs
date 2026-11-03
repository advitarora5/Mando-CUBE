import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoveryPlan, assertSources, assertLocalTarget, executeDiscovery, DISCOVERY_SOURCES } from '../scripts/discovery-plan.mjs';

test('plan covers discovery followed by job collection and processing, with no enrichment', () => {
  const plan = discoveryPlan(5);
  assert.equal(plan.limit, 5);
  assert.deepEqual(plan.steps.slice(-3).map(s => s.plan), ['extract', 'match', 'score']);
  assert.equal(plan.steps.filter(s => s.plan === 'collect').length, 5);
  assert.equal(plan.paid_services, false);
  for (const n of [0, -1, 101, NaN, 1.5]) assert.throws(() => discoveryPlan(n));
});
test('remote targets and missing or disabled source dependencies fail closed', () => {
  for (const u of ['https://example.com', 'http://localhost.evil:54321', 'http://localhost:54321/path', 'http://user:pass@localhost:54321']) assert.throws(() => assertLocalTarget(u));
  assertLocalTarget('http://127.0.0.1:54321');
  assert.throws(() => assertSources([]));
  assert.throws(() => assertSources(DISCOVERY_SOURCES.map(id => ({ id, enabled: false }))));
});
test('missing sources stop before any stage executes', async () => {
  let calls = 0;
  await assert.rejects(executeDiscovery({ store: { sources: async () => [] } }, async () => { calls++; }, discoveryPlan()));
  assert.equal(calls, 0);
});
test('source failures preserve other collection attempts and remain visible in final status', async () => {
  const calls = [];
  const ctx = { store: { sources: async () => DISCOVERY_SOURCES.map(id => ({ id, enabled: true })) } };
  const result = await executeDiscovery(ctx, async (_, opts) => {
    calls.push(opts);
    return { jobs: [{ status: opts.source === 'workday-tenant-crawl' ? 'failed' : 'succeeded' }] };
  }, discoveryPlan());
  assert.equal(calls.length, 9);
  assert.equal(result.status, 'needs_attention');
});
test('processing failure stops dependent matching and scoring', async () => {
  const calls = [];
  const ctx = { store: { sources: async () => DISCOVERY_SOURCES.map(id => ({ id, enabled: true })) } };
  const result = await executeDiscovery(ctx, async (_, opts) => {
    calls.push(opts.plan);
    return { jobs: [{ status: opts.plan === 'extract' ? 'failed' : 'succeeded' }] };
  }, discoveryPlan());
  assert.equal(calls.at(-1), 'extract');
  assert.equal(result.status, 'needs_attention');
});

test('partial matching still scores admitted companies while reporting needs_attention', async () => {
  const calls = [];
  const ctx = { store: { sources: async () => DISCOVERY_SOURCES.map(id => ({ id, enabled: true })) } };
  const result = await executeDiscovery(ctx, async (_, opts) => {
    calls.push(opts.plan);
    return { jobs: [{ status: opts.plan === 'match' ? 'partial' : 'succeeded' }] };
  }, discoveryPlan());
  assert.equal(calls.at(-1), 'score');
  assert.equal(calls.length, 9);
  assert.equal(result.status, 'needs_attention');
});

test('real CLI prepares without credentials and overwrites stale success on invalid execution', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mando-discovery-'));
  const cli = fileURLToPath(new URL('../scripts/discovery.mjs', import.meta.url));
  try {
    const prepared = spawnSync(process.execPath, [cli, '--limit', '2'], { cwd, encoding: 'utf8' });
    assert.equal(prepared.status, 0);
    assert.equal(JSON.parse(readFileSync(join(cwd, 'var/discovery/summary.json'))).status, 'prepared');
    const denied = spawnSync(process.execPath, [cli, '--execute-local'], { cwd, encoding: 'utf8',
      env: { ...process.env, PIPELINE_SUPABASE_URL: 'https://private-target.example', PIPELINE_SUPABASE_KEY: 'secret-test-value' } });
    assert.equal(denied.status, 1);
    assert.equal(JSON.parse(readFileSync(join(cwd, 'var/discovery/summary.json'))).status, 'failed');
    assert.ok(!`${denied.stdout}${denied.stderr}`.includes('secret-test-value'));
    assert.ok(!`${denied.stdout}${denied.stderr}`.includes('private-target'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
