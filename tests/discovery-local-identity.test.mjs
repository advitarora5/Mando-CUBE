import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalIdentityMode, selectLocalIdentityCandidates } from '../scripts/discovery-local-identity.mjs';
import { runPipeline } from '../src/pipeline/runner.ts';
import { makeCtx } from './ingestion/helpers.mjs';
import { SupabaseStore } from '../src/pipeline/store/supabase.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const selected = await selectLocalIdentityCandidates(store);
  assert.deepEqual(selected.map(candidate => candidate.name), ['Eligible']);
  assert.deepEqual(selected[0].corporate_urls, ['https://eligible.com/', 'https://eligible.org/', 'https://eligible.edu/']);
  store.reviewItems = async () => reviews.slice(0, 3);
  assert.deepEqual((await selectLocalIdentityCandidates(store)).map(candidate => candidate.name), ['New']);
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
