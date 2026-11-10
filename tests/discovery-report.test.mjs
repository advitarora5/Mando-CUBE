import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryRollup, summarizeJob } from '../scripts/discovery-report.mjs';

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

const key = n => String(n).padStart(16, 'a');
const matchJob = (counts, keys) => ({ job: 'match', counts, candidate_keys: keys });

test('rollup counts unique candidates, admissions and held cases without double counting', () => {
  const rollup = discoveryRollup([
    matchJob({ candidates: 2, new_companies: 1, review_no_website: 1, identity_held: 1 }, [key(1), key(2)]),
    matchJob({ candidates: 1, joined_pending_review: 1, pending_reason_no_website: 1 }, [key(2)]),
    matchJob({ candidates: 1, attached_existing: 1, review_existing: 1 }, [key(3)]),
  ]);
  assert.deepEqual(rollup.candidates, { checked: 4, unique: 3 });
  assert.deepEqual(rollup.admissions, { new_companies: 1, attached_existing: 1 });
  assert.deepEqual(rollup.held, { new_reviews: 1, still_held: 2, identity_held: 1, by_reason: { no_website: 2 } });
});

test('rollup never presents an unmeasured sum as a unique count', () => {
  const rollup = discoveryRollup([matchJob({ candidates: 2 }, [key(1)]), { job: 'match', counts: { candidates: 1 } }]);
  assert.deepEqual(rollup.candidates, { checked: 3, unique: null });
});

test('rollup reports scoring coverage and contacts, ignoring malformed input', () => {
  const rollup = discoveryRollup([null, 'text',
    { job: 'score', counts: { scored: 1, rescored: 1, unchanged: 1, with_contacts: 1, without_contacts: 2, zero_budget: 2, financials_found: 1, financials_no_contact: 2, financials_deferred: 'x' } },
    { job: 'enrich', counts: { contacts_added: 3, research_evidence_missing: 1, no_treg: 2 } }]);
  assert.equal(rollup.scoring.assessments_written, 2);
  assert.deepEqual(rollup.scoring.zero_points, { budget: 2 });
  assert.deepEqual(rollup.scoring.financials, { found: 1, no_contact: 2, deferred: 0 });
  assert.deepEqual(rollup.contacts, { scored_with_contacts: 1, scored_without_contacts: 2, added: 3, research_evidence_missing: 1, waiting_for_provider: 2,
    companies_researched: 0, companies_verified: 0, assessments_written: 0 });
  assert.equal(discoveryRollup(undefined).candidates.checked, 0);
});

test('summaries keep only well-formed candidate hashes', () => {
  const summary = summarizeJob({ job: 'match', counts: {}, candidate_keys: [key(1), 'Fictional Company Name', 7] });
  assert.deepEqual(summary.candidate_keys, [key(1)]);
});
