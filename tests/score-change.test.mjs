import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScoreChange, describeScoreChange, scoreTriggers, triggerLabel } from '../src/domain/ingestion/score-change.ts';

const row = (over = {}) => ({
  authority_score: 20, reachability_score: 15, budget_score: 10, release_score: 8, timing_score: 7,
  authority_evidence: 'https://x.example | Assessment status: met. Jane Doe, VP HRIS: role confirmed 20.',
  reachability_evidence: 'https://x.example | Assessment status: met. Jane Doe: named work email 15.',
  budget_evidence: 'b', release_evidence: 'r', timing_evidence: 't', ...over,
});

test('first assessment, refresh and evidence-only updates are named plainly', () => {
  assert.equal(describeScoreChange(null, row(), 'pipeline_run'), 'First assessment.');
  assert.equal(describeScoreChange(row(), row(), 'periodic_refresh'), 'Re-saved with no score change (periodic refresh).');
  assert.equal(describeScoreChange(row(), row(), 'pipeline_run'), 'Evidence or tier updated; no category score changed.');
});

test('each changed category is listed with its new reason, without the link or status prefix', () => {
  const text = describeScoreChange(row(), row({ authority_score: 25, reachability_score: 20, reachability_evidence: 'https://y.example | Assessment status: met. Raj Patel: named work email and direct phone 20.' }), 'new_contacts');
  assert.equal(text, 'Authority 20 to 25: Jane Doe, VP HRIS: role confirmed 20. Reachability 15 to 20: Raj Patel: named work email and direct phone 20.');
  assert.ok(!text.includes('https://') && !text.includes('Assessment status'));
});

test('long reasons and many changes are clipped', () => {
  const long = 'x'.repeat(400);
  const text = describeScoreChange(row(), row({ authority_score: 1, reachability_score: 2, budget_score: 3, release_score: 4, timing_score: 5, authority_evidence: long, reachability_evidence: long, budget_evidence: long, release_evidence: long, timing_evidence: long }), 'pipeline_run');
  assert.ok(text.length <= 480, `length ${text.length}`);
  assert.ok(text.includes('…'));
});

test('the stored record carries the run, trigger, previous score id and summary', () => {
  const change = buildScoreChange({ previous: { id: 'prev-1', ...row() }, row: row({ timing_score: 3 }), trigger: 'csv_import', runId: 'run-9' });
  assert.deepEqual(Object.keys(change).sort(), ['change_summary', 'change_trigger', 'previous_score_id', 'run_id']);
  assert.equal(change.run_id, 'run-9'); assert.equal(change.change_trigger, 'csv_import'); assert.equal(change.previous_score_id, 'prev-1');
  assert.match(change.change_summary, /^Timing 7 to 3/);
  assert.deepEqual(buildScoreChange({ previous: null, row: row(), trigger: 'pipeline_run', runId: null }), { run_id: null, change_trigger: 'pipeline_run', previous_score_id: null, change_summary: 'First assessment.' });
});

test('every trigger has a plain-language label', () => {
  for (const t of scoreTriggers) assert.ok(triggerLabel[t].length > 0, t);
});
