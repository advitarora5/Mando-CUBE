import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalIdentityMode, selectLocalIdentityCandidates } from '../scripts/discovery-local-identity.mjs';
import { runPipeline } from '../src/pipeline/runner.ts';
import { makeCtx } from './ingestion/helpers.mjs';
import { SupabaseStore } from '../src/pipeline/store/supabase.ts';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DISCOVERY_SOURCES } from '../scripts/discovery-plan.mjs';

test('AI discovery rejects remote databases, remote models, wrong models and non-execution mode', () => {
  const mode = { execute: true, approved: false };
  const env = { PIPELINE_SUPABASE_URL: 'http://127.0.0.1:55321' };
  assert.equal(assertLocalIdentityMode(mode, env).maxChecks, 3);
  for (const [options, changes] of [[{ approved: true }, {}], [{ execute: false }, {}], [{}, { PIPELINE_ALLOW_REMOTE: 'override' }],
    [{}, { PIPELINE_SUPABASE_URL: 'https://remote.supabase.co' }], [{}, { OLLAMA_HOST: 'https://remote.example' }], [{}, { OLLAMA_MODEL: 'other' }]]) {
    assert.throws(() => assertLocalIdentityMode({ ...mode, ...options }, { ...env, ...changes }));
  }
});

test('candidate selection protects human decisions and disabled siblings while bounding work to one name', async () => {
  const reviews = [
    { candidate_name: 'Rejected', normalized_name: 'rejected', status: 'rejected', created_at: '2026-01-01' },
    { candidate_name: 'Similar', normalized_name: 'similar', status: 'pending', reason: 'similar_name', created_at: '2026-01-01' },
    { candidate_name: 'Disabled', normalized_name: 'disabled', status: 'pending', reason: 'no_website', created_at: '2026-01-01' },
    { candidate_name: 'Eligible', normalized_name: 'eligible', status: 'pending', reason: 'no_website', created_at: '2026-01-02' },
  ];
  const store = { reviewItems: async () => reviews, workdaySites: async () => [
    ...['rejected', 'similar', 'disabled', 'eligible', 'new'].map(normalized_name => ({ normalized_name, enabled: true, company_id: null })),
    { normalized_name: 'disabled', enabled: false }], unassignedSignals: async () => [{ company_name: 'New' }] };
  const selected = await selectLocalIdentityCandidates(store, { heldFirst: true });
  assert.deepEqual(selected.map(candidate => candidate.name), ['Eligible']);
  assert.deepEqual(selected[0].corporate_urls, ['https://eligible.com/', 'https://eligible.org/', 'https://eligible.edu/']);
  store.reviewItems = async () => reviews.slice(0, 3);
  assert.deepEqual((await selectLocalIdentityCandidates(store, { heldFirst: true })).map(candidate => candidate.name), ['New'], 'nothing held is eligible, so a new name still runs');
  store.unassignedSignals = async () => [];
  assert.deepEqual(await selectLocalIdentityCandidates(store), [], 'protected reviews are never selected as a fallback');
});

test('new candidates go before held ones, and a held candidate runs once nothing new is left', async () => {
  const site = normalized_name => ({ id: normalized_name, normalized_name, enabled: true, company_id: null });
  let signals = [{ company_name: 'Newco' }, { company_name: 'Heldco' }];
  const store = { reviewItems: async () => [{ candidate_name: 'Heldco', normalized_name: 'heldco', status: 'pending', reason: 'no_website', created_at: '2026-01-01' }],
    workdaySites: async () => ['newco', 'heldco'].map(site), unassignedSignals: async () => signals };
  assert.equal((await selectLocalIdentityCandidates(store))[0].name, 'Newco');
  signals = [{ company_name: 'Heldco' }];
  assert.equal((await selectLocalIdentityCandidates(store))[0].name, 'Heldco', 'a new signal on a held name does not make it new');
});

test('the local batch limit counts each eligible company only once', async () => {
  const store = {
    reviewItems: async () => [{ candidate_name: 'Protected', normalized_name: 'protected', status: 'pending', reason: 'similar_name' }],
    workdaySites: async () => ['protected', 'alpha', 'beta', 'gamma', 'delta'].map(normalized_name => ({ normalized_name, enabled: true })),
    unassignedSignals: async () => ['Protected', 'Alpha Inc', 'Alpha', 'Beta', 'Gamma', 'Delta'].map(company_name => ({ company_name })),
  };
  assert.deepEqual((await selectLocalIdentityCandidates(store, { limit: 3 })).map(candidate => candidate.name), ['Alpha Inc', 'Beta', 'Gamma']);
});

test('held first still respects the cooldown, so a batch without due holds moves on to new names', async () => {
  const sites = ['newco', 'heldco'].map(normalized_name => ({ id: normalized_name, normalized_name, capture_id: 'same', enabled: true, company_id: null }));
  const store = { reviewItems: async () => [{ candidate_name: 'Heldco', normalized_name: 'heldco', status: 'pending', reason: 'no_website', created_at: '2026-01-01' }],
    workdaySites: async () => sites, unassignedSignals: async () => [{ company_name: 'Newco' }] };
  const [first] = await selectLocalIdentityCandidates(store, { heldFirst: true });
  assert.equal(first.name, 'Heldco');
  const retries = { heldco: { signature: first.retry_signature, retry_after: 5000 } };
  assert.equal((await selectLocalIdentityCandidates(store, { heldFirst: true, retries, now: 2000 }))[0].name, 'Newco');
});

test('among new candidates, a company with a real name goes before one with only a tenant slug', async () => {
  const store = { reviewItems: async () => [], unassignedSignals: async () => [{ company_name: 'Aaslug' }, { company_name: 'Zeta Holdings Inc' }, { company_name: 'Bbslug' }],
    workdaySites: async () => [
      { id: '1', normalized_name: 'aaslug', tenant: 'aaslug', company_name: 'Aaslug', enabled: true, company_id: null },
      { id: '2', normalized_name: 'zeta', tenant: 'zetaholdings', company_name: 'Zeta Holdings Inc', enabled: true, company_id: null },
      { id: '3', normalized_name: 'bbslug', tenant: 'bbslug', company_name: 'Bbslug', enabled: true, company_id: null }] };
  assert.equal((await selectLocalIdentityCandidates(store))[0].name, 'Zeta Holdings Inc');
});

test('corporate URL guesses try the observed tenant before the joined full name', async () => {
  const store = { reviewItems: async () => [], unassignedSignals: async () => [{ company_name: 'Fernhill Design Systems Inc' }],
    workdaySites: async () => [{ normalized_name: 'fernhill design systems', tenant: 'fernhill', enabled: true, company_id: null }] };
  const [selected] = await selectLocalIdentityCandidates(store);
  assert.deepEqual(selected.corporate_urls, ['https://fernhill.com/', 'https://fernhilldesignsystems.com/', 'https://fernhill.org/']);
});

test('unchanged held candidate yields to another candidate until cooldown expires or evidence changes', async () => {
  const sites = ['alpha', 'beta'].map(normalized_name => ({ id: normalized_name, normalized_name, capture_id: 'old', enabled: true, company_id: null }));
  const store = { reviewItems: async () => [], workdaySites: async () => sites,
    unassignedSignals: async () => [{ id: 'a', company_name: 'Alpha' }, { id: 'b', company_name: 'Beta' }] };
  const first = (await selectLocalIdentityCandidates(store, { now: 1000 }))[0];
  const retries = { alpha: { signature: first.retry_signature, retry_after: 5000 } };
  assert.equal((await selectLocalIdentityCandidates(store, { retries, now: 2000 }))[0].name, 'Beta');
  assert.equal((await selectLocalIdentityCandidates(store, { retries, now: 5000 }))[0].name, 'Alpha');
  sites[0].capture_id = 'new-evidence';
  assert.equal((await selectLocalIdentityCandidates(store, { retries, now: 2000 }))[0].name, 'Alpha');
});

test('creating a review and assigning its signals does not bypass the unresolved cooldown', async () => {
  let reviews = [], signals = [{ id: 'a', company_name: 'Alpha' }, { id: 'b', company_name: 'Beta' }];
  const store = { reviewItems: async () => reviews,
    workdaySites: async () => ['alpha', 'beta'].map(normalized_name => ({ id: normalized_name, normalized_name, capture_id: 'same-evidence', enabled: true, company_id: null })),
    unassignedSignals: async () => signals };
  const first = (await selectLocalIdentityCandidates(store))[0];
  const retries = { alpha: { signature: first.retry_signature, retry_after: 5000 } };
  reviews = [{ id: 'new-review', normalized_name: 'alpha', candidate_name: 'Alpha', candidate_domain: null, status: 'pending', reason: 'no_website', created_at: '2026-01-01' }];
  signals = signals.slice(1);
  assert.equal((await selectLocalIdentityCandidates(store, { retries, now: 2000, heldFirst: true }))[0].name, 'Beta');
  reviews[0].candidate_domain = 'new-evidence.example';
  assert.equal((await selectLocalIdentityCandidates(store, { retries, now: 2000, heldFirst: true }))[0].name, 'Alpha');
});

test('AI capability is rejected by the runner before logging or writes on a remote store', async () => {
  const store = new SupabaseStore('https://remote.supabase.co', 'fictional-key', 'remote');
  const ctx = makeCtx({ store });
  store.closeStaleRuns = () => { throw Error('unexpected write'); };
  await assert.rejects(() => runPipeline(ctx, { plan: 'match', limit: 1, dryRun: false, trigger: 'manual', localIdentity: { names: new Set(), resolve: () => {} } }), /loopback/);
});

test('admission-only CLI refuses prepare and approved modes before connecting or echoing secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discovery-ai-mode-'));
  try {
    for (const args of [['--ai-admission-only'], ['--local-ai', '--ai-admission-only'], ['--execute-approved', '--local-ai', '--ai-admission-only'],
      ['--execute-approved', '--approved-ai', '--ai-admission-only'], ['--execute-local', '--local-ai', '--approved-ai']]) {
      const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/discovery.mjs', import.meta.url)), ...args], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, DISCOVERY_OUTPUT: directory, PIPELINE_SUPABASE_URL: 'https://secret.invalid', PIPELINE_SUPABASE_KEY: 'secret-value' },
      });
      assert.equal(run.status, 1);
      const report = readFileSync(join(directory, 'summary.json'), 'utf8');
      assert.equal(JSON.parse(report).failure_stage, 'configuration');
      assert.ok(!`${report}${run.stdout}${run.stderr}`.includes('secret-value'));
    }
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\') && !resolve(directory).startsWith(resolve(tmpdir()) + '/')) throw Error('Unexpected temporary path');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('default local execution saves collection before deferring AI admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'discovery-ai-default-'));
  const events = [];
  let modelAvailable = false;
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    let body = [];
    if (path === '/rest/v1/sources') body = DISCOVERY_SOURCES.map(id => ({
      id, type: 'sec_company_list', enabled: true, config: {}, max_requests_per_run: 1, min_delay_ms: 1000,
    }));
    if (req.method === 'POST') {
      req.resume();
      body = { id: 'fixture-row' };
      if (path === '/rest/v1/raw_captures') events.push('capture');
    }
    if (path === '/api/tags') {
      events.push('model');
      if (modelAvailable) body = { models: [{ name: 'qwen2.5:7b', digest: 'fixture-digest' }] };
      else res.statusCode = 503;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const cli = fileURLToPath(new URL('../scripts/discovery.mjs', import.meta.url));
    const env = {
      ...process.env, DISCOVERY_OUTPUT: directory, PIPELINE_SUPABASE_URL: url, PIPELINE_SUPABASE_KEY: 'test-key',
      PIPELINE_ALLOW_REMOTE: '', PIPELINE_CONTACT: '', OLLAMA_HOST: url, OLLAMA_MODEL: '',
      PIPELINE_SEC_FILE: fileURLToPath(new URL('../sec.json', import.meta.url)),
    };
    const run = flags => promisify(execFile)(process.execPath, [cli, '--execute-local', ...flags], { cwd: directory, env, timeout: 15000 });
    await assert.rejects(run([]), { code: 1 });
    const summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
    assert.equal(summary.local_ai, true);
    assert.equal(summary.status, 'needs_attention');
    assert.deepEqual(events, [...DISCOVERY_SOURCES.map(() => 'capture'), 'model']);
    assert.equal(summary.jobs.at(-1).reason, 'admission_deferred');
    assert.ok(summary.jobs.slice(0, -1).every(job => job.status === 'succeeded'));
    assert.ok(summary.jobs.every(job => job.job !== 'score'));

    events.length = 0;
    await assert.rejects(run(['--ai-admission-only']), { code: 1 });
    assert.deepEqual(events, ['model']);
    const admission = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
    assert.deepEqual(admission.steps, [{ plan: 'match' }]);
    assert.equal(admission.jobs[0].reason, 'admission_deferred');

    modelAvailable = true;
    events.length = 0;
    await run(['--ai-admission-only']);
    const resumed = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
    assert.equal(resumed.status, 'succeeded');
    assert.deepEqual(events, ['model']);
    assert.deepEqual(resumed.jobs.map(job => job.job), ['match']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
