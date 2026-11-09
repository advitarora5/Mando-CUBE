import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, previewEmployeeEvidence } from '../../scripts/preview-employee-evidence.mjs';

const now = new Date('2026-11-08T12:00:00Z');
const evidence = [{ company_domain: 'pilot.example', employee_count: 3500,
  as_of: '2026-06-30', source: 'https://pilot.example/report' }];
const score = { id: 's1', company_id: 'c1', assessed_at: '2026-11-01T12:00:00Z',
  rubric_version: 'mando-team-70:pipeline-v3', authority_score: 20,
  authority_evidence: 'https://pilot.example/team | Director of HRIS confirmed',
  reachability_score: 10, reachability_evidence: 'https://linkedin.com/in/pilot | Confirmed profile',
  budget_score: 17, release_score: 8, timing_score: 12, tier: 'Maybe' };
const data = () => ({ companies: [{ id: 'c1', name: 'Pilot', domain: 'pilot.example' }],
  contacts: [{ company_id: 'c1', name: 'Pat Pilot', title: 'Director of HRIS',
    source: 'https://pilot.example/team', linkedin_status: 'confirmed' }], scores: [{ ...score }] });

test('read-only comparison uses current records, preserves input, and reports a supported promotion', () => {
  const input = data();
  const backup = structuredClone(input);
  const [row] = previewEmployeeEvidence(input, evidence, now);
  assert.equal(row.status, 'preview_ready');
  assert.equal(row.total_before, 67);
  assert.equal(row.total_after, 70);
  assert.equal(row.newly_qualified, true);
  assert.deepEqual(input, backup);
});

test('manual policies and unexplained authority differences are held for review', () => {
  const input = data();
  input.scores[0].rubric_version = 'manual-review';
  assert.equal(previewEmployeeEvidence(input, evidence, now)[0].status, 'held_different_scoring_policy');
  input.scores[0] = { ...score, authority_score: 25 };
  assert.equal(previewEmployeeEvidence(input, evidence, now)[0].status, 'held_saved_authority_requires_review');
});

test('expired reviews and documented employer mismatches cannot yield a size bonus', () => {
  const input = data();
  input.contacts[0].contact_sources = { role_review: { status: 'different_employer' } };
  const [row] = previewEmployeeEvidence(input, evidence, now);
  assert.equal(row.status, 'held_saved_authority_requires_review');
  assert.equal(row.calculated_with_headcount, 0);
  input.contacts[0].contact_sources = { role_review: { status: 'confirmed', reviewed_on: '2020-01-01' } };
  assert.equal(previewEmployeeEvidence(input, evidence, now)[0].calculated_with_headcount, 5);
});

test('assessment selection compares instants across time zones and ignores future rows', () => {
  const input = data();
  input.scores.push({ ...score, id: 's2', assessed_at: '2026-11-01T08:00:00-06:00' });
  input.scores.push({ ...score, id: 's3', assessed_at: '2027-01-01T12:00:00Z', authority_score: 0 });
  assert.equal(previewEmployeeEvidence(input, evidence, now)[0].assessed_at, '2026-11-01T08:00:00-06:00');
});

test('preview rejects write flags before accessing data', async () => {
  await assert.rejects(main(['--apply', 'true'], {}), /Usage/);
});
