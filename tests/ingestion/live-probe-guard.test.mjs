import test from 'node:test';
import assert from 'node:assert/strict';
import { assertValidationTarget } from '../../scripts/discovery-live-local.mjs';

test('live probe accepts only the separate local validation target and no remote override', () => {
  assertValidationTarget({ PIPELINE_SUPABASE_URL: 'http://127.0.0.1:55321', PIPELINE_ALLOW_REMOTE: '' });
  for (const url of ['https://example.supabase.co', 'http://127.0.0.1:54321', 'http://localhost:55321', undefined]) {
    assert.throws(() => assertValidationTarget({ PIPELINE_SUPABASE_URL: url }));
  }
  assert.throws(() => assertValidationTarget({ PIPELINE_SUPABASE_URL: 'http://127.0.0.1:55321', PIPELINE_ALLOW_REMOTE: 'project' }));
});
