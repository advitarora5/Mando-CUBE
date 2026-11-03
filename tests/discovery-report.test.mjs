import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeJob } from '../scripts/discovery-report.mjs';

test('safe diagnostics retain host and HTTP status without tokens or provider bodies', () => {
  const report = summarizeJob({ job: 'collect', source_id: 'source', status: 'failed', ms: 10, counts: {},
    errors: ['http https://secret:secret@public.example/jobs?token=secret HTTP 500: secret provider body'] });
  assert.deepEqual(report.diagnostics, [{ host: 'public.example', http_status: 500 }]);
  assert.ok(!JSON.stringify(report).includes('secret'));
});

test('deadline and URL-free database errors are reported without copying raw messages', () => {
  const report = summarizeJob({ errors: ['database private-value'], blocked: 'source time budget reached' });
  assert.equal(report.reason, 'source_deadline');
  assert.deepEqual(report.diagnostics, [{ host: null, http_status: null }]);
  assert.ok(!JSON.stringify(report).includes('private-value'));
});
