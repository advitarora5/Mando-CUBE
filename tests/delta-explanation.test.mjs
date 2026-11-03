import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainDelta } from '../src/domain/delta-explanation.ts';

const score = (over = {}) => ({
  id: 's1', assessed_at: '2026-10-05T12:00:00Z', rubric_version: 'mando-team-70', total: 60, tier: 'Maybe',
  authority_score: 20, reachability_score: 15, budget_score: 10, release_score: 8, timing_score: 7,
  authority_evidence: 'a', reachability_evidence: 'r', budget_evidence: 'b', release_evidence: 'rel', timing_evidence: 't', ...over,
});
const jane = { name: 'Jane Doe', title: 'VP HRIS' };
const run = (over) => explainDelta({ currentRank: 3, previousRank: 6, current: score({ id: 's2' }), previous: score(), newContacts: [], ...over });

test('nothing to explain for unchanged, unranked or first-week companies', () => {
  assert.equal(run({ currentRank: 6 }), null);
  assert.equal(run({ currentRank: undefined }), null);
  const fresh = run({ previousRank: undefined });
  assert.equal(fresh.cause, 'new'); assert.match(fresh.summary, /New to the ranking/);
});

test('new contacts that change Authority and Reachability are named as the reason', () => {
  const r = run({
    current: score({ id: 's2', authority_score: 25, reachability_score: 20, total: 70, tier: 'Qualified' }),
    newContacts: [jane, { name: 'Raj Patel', title: 'HRIS Lead' }],
  });
  assert.equal(r.cause, 'contacts');
  assert.match(r.summary, /^Moved up 3 places \(rank 6 to 3\)\. New contacts changed Authority and Reachability\.$/);
  assert.match(r.reasons[0], /New contacts \(Jane Doe \(VP HRIS\), Raj Patel \(HRIS Lead\)\) changed Authority 20 to 25 and Reachability 15 to 20\./);
  assert.ok(r.reasons.includes('Total 60 to 70 (+10).'));
  assert.ok(r.reasons.includes('Tier Maybe to Qualified.'));
  assert.ok(!r.reasons.some(x => x.startsWith('Authority 20 to 25')), 'not repeated');
});

test('one new contact reads as singular and long contact lists are shortened', () => {
  const one = run({ current: score({ id: 's2', authority_score: 25, total: 65 }), newContacts: [jane] });
  assert.match(one.reasons[0], /^New contact \(Jane Doe \(VP HRIS\)\) changed Authority 20 to 25\./);
  const many = run({ current: score({ id: 's2', authority_score: 25, total: 65 }), newContacts: ['A', 'B', 'C', 'D', 'E'].map(name => ({ name })) });
  assert.match(many.reasons[0], /A, B, C and 2 more/);
});

test('Authority or Reachability changing without new contacts says so', () => {
  const r = run({ currentRank: 8, previousRank: 6, current: score({ id: 's2', reachability_score: 10, total: 55 }) });
  assert.equal(r.cause, 'scores');
  assert.match(r.summary, /^Moved down 2 places \(rank 6 to 8\)\. Reachability 15 to 10\.$/);
  assert.match(r.reasons[0], /Reachability changed with updated contact or role evidence; no new contacts were added\./);
});

test('new contacts that do not change Authority or Reachability are mentioned but not blamed', () => {
  const r = run({ current: score({ id: 's2', budget_score: 15, total: 65 }), newContacts: [jane] });
  assert.equal(r.cause, 'scores');
  assert.ok(r.reasons.some(x => /1 new contact added \(Jane Doe \(VP HRIS\)\); Authority and Reachability did not change\./.test(x)));
  assert.ok(r.reasons.includes('Budget 10 to 15 (+5).'));
});

test('Timing and Release changes with unchanged evidence are attributed to the calendar', () => {
  const r = run({ currentRank: 9, previousRank: 6, current: score({ id: 's2', timing_score: 3, total: 56 }) });
  assert.match(r.reasons[0], /Timing 7 to 3 \(-4\): the evidence is unchanged, so this follows the calendar\./);
  const changed = run({ currentRank: 9, previousRank: 6, current: score({ id: 's2', release_score: 0, release_evidence: 'new evidence', total: 52 }) });
  assert.match(changed.reasons[0], /^Release 8 to 0 \(-8\)\.$/);
});

test('an unchanged own score means the move came from other companies', () => {
  const r = run({ current: score({ id: 's1' }) });
  assert.equal(r.cause, 'others');
  assert.match(r.summary, /Own score is unchanged; other companies' scores changed\./);
  assert.ok(r.reasons.includes("Own score is unchanged at 60; the move comes from other companies' scores changing."));
});

test('a total moving the opposite way to the rank is explained', () => {
  const down = run({ currentRank: 9, previousRank: 6, current: score({ id: 's2', budget_score: 12, total: 62 }) });
  assert.ok(down.reasons.includes('Own total went up, but companies above it rose by more.'));
  const up = run({ currentRank: 3, previousRank: 6, current: score({ id: 's2', budget_score: 8, total: 58 }) });
  assert.ok(up.reasons.includes('Own total fell, but companies above it fell by more.'));
});

test('a rubric change and a missing earlier assessment are reported honestly', () => {
  const r = run({ current: score({ id: 's2', rubric_version: 'mando-team-70:pipeline-v3', release_score: 0, total: 52 }) });
  assert.equal(r.cause, 'rubric');
  assert.equal(r.reasons[0], 'Rescored under a different rubric version (mando-team-70 to mando-team-70:pipeline-v3).');
  assert.match(r.summary, /Rescored under a new rubric version: Release 8 to 0\./);
  const both = run({ current: score({ id: 's2', rubric_version: 'v3', authority_score: 25, total: 65 }), newContacts: [jane] });
  assert.equal(both.cause, 'contacts'); assert.match(both.summary, /New contacts changed Authority\. Also rescored under a new rubric version\./);
  const noContacts = run({ current: score({ id: 's2', rubric_version: 'v3', authority_score: 25, total: 65 }) });
  assert.equal(noContacts.cause, 'rubric'); assert.ok(noContacts.reasons.some(x => /Authority changed after rescoring under a new rubric version; no new contacts were added\./.test(x)));
  const unknown = run({ previous: null });
  assert.equal(unknown.cause, 'unknown'); assert.match(unknown.summary, /The earlier assessment is not available to compare\./);
});

test('reasons the pipeline recorded are stated first and make the cause certain', () => {
  const recorded = [
    { assessed_at: '2026-10-10T12:00:00Z', trigger: 'new_contacts', summary: 'Authority 20 to 25: Jane Doe, VP HRIS: role confirmed 20.' },
    { assessed_at: '2026-10-12T12:00:00Z', trigger: 'periodic_refresh', summary: 'Re-saved with no score change (periodic refresh).' },
    { assessed_at: '2026-09-01T12:00:00Z', trigger: 'pipeline_run', summary: 'before the earlier assessment, ignored' },
  ];
  // No contact rows were found in the window, but the pipeline recorded that new contacts triggered the rescore.
  const r = run({ current: score({ id: 's2', authority_score: 25, total: 65, assessed_at: '2026-10-13T12:00:00Z' }), recorded });
  assert.equal(r.cause, 'contacts');
  assert.equal(r.reasons[0], 'Recorded when scored (2026-10-10; new contacts were found): Authority 20 to 25: Jane Doe, VP HRIS: role confirmed 20.');
  assert.ok(r.reasons.some(x => /The pipeline recorded that new contacts were found, and Authority 20 to 25 changed\./.test(x)));
  assert.ok(!r.reasons.some(x => x.includes('ignored')), 'rows from before the comparison window are not used');
  assert.ok(!r.reasons.some(x => x.includes('periodic refresh')), 'a refresh with no change is not a reason');
});

test('a recorded trigger other than contacts is added to the summary shown on the hover', () => {
  const r = run({ current: score({ id: 's2', budget_score: 15, total: 65, assessed_at: '2026-10-13T12:00:00Z' }), recorded: [{ assessed_at: '2026-10-12T12:00:00Z', trigger: 'pipeline_run', summary: 'Budget 10 to 15: budget clue found.' }] });
  assert.match(r.summary, /Recorded cause: the pipeline scored new or changed signals\.$/);
  assert.equal(r.reasons[0], 'Recorded when scored (2026-10-12; the pipeline scored new or changed signals): Budget 10 to 15: budget clue found.');
  const none = run({ current: score({ id: 's2', budget_score: 15, total: 65 }) });
  assert.ok(!none.summary.includes('Recorded'), 'older scores without a record behave as before');
});

test('newly added companies are named when they pushed an unchanged company down', () => {
  const r = run({ currentRank: 102, previousRank: 101, current: score({ id: 's1' }), newCompaniesAbove: 1 });
  assert.equal(r.cause, 'others');
  assert.equal(r.summary, 'Moved down 1 place (rank 101 to 102). Own score is unchanged; 1 newly added company scored higher.');
  assert.deepEqual(r.reasons, ['Own score is unchanged at 60.', '1 newly added company now scores higher.']);
  const several = run({ currentRank: 110, previousRank: 105, current: score({ id: 's1' }), newCompaniesAbove: 3 });
  assert.match(several.summary, /3 newly added companies scored higher\./);
  assert.ok(several.reasons.includes('3 newly added companies now score higher.'));
  assert.ok(several.reasons.includes("The other 2 places came from other companies' scores changing."), 'only the unexplained remainder is attributed elsewhere');
});

test('newly added companies never explain a move up, and are mentioned alongside a real score change', () => {
  const up = run({ currentRank: 3, previousRank: 6, current: score({ id: 's1' }), newCompaniesAbove: 2 });
  assert.match(up.summary, /Own score is unchanged; other companies' scores changed\./);
  assert.ok(!up.reasons.some(x => x.includes('newly added')));
  const both = run({ currentRank: 9, previousRank: 6, current: score({ id: 's2', budget_score: 12, total: 62 }), newCompaniesAbove: 2 });
  assert.equal(both.cause, 'scores');
  assert.ok(both.reasons.includes('2 newly added companies now score higher.'));
});
