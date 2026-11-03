import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalIdentityMode, selectLocalIdentityCandidates } from '../scripts/discovery-local-identity.mjs';
import { runPipeline } from '../src/pipeline/runner.ts';
import { makeCtx } from './ingestion/helpers.mjs';
import { SupabaseStore } from '../src/pipeline/store/supabase.ts';

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
