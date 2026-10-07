import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentWeek, saveWeeklySnapshot, main } from '../scripts/save-weekly-snapshot.mjs';

const now = new Date('2026-10-05T12:00:00Z');
const evidence = 'https://example.com | Synthetic evidence';
function fixture({ reject = false, existing = [] } = {}) {
  const tables = {
    companies: ['a', 'b', 'c', 'unscored'].map(id => ({ id, name: id })),
    scores: ['a', 'b', 'c'].map((id, i) => ({
      id: `score-${id}`, company_id: id, assessed_at: '2026-10-04T12:00:00Z',
      authority_score: 25, reachability_score: 25, budget_score: 20,
      release_score: 10, timing_score: i === 2 ? 0 : 10,
      authority_evidence: evidence, reachability_evidence: i === 1 ? '' : evidence,
      total: -1, tier: 'Qualified',
    })),
    company_insights: [{ company_id: 'a', persona_generated: 'Generated', persona_override: 'Manual', why_now_generated: 'Synthetic trigger' }],
    weekly_snapshots: structuredClone(existing),
  };
  const batches = [];
  const db = { from(table) {
    let filter;
    const query = {
      select() { return this; }, order() { return this; },
      eq(key, value) { filter = [key, value]; return this; },
      async range(start, end) {
        const rows = tables[table].filter(row => !filter || row[filter[0]] === filter[1]);
        return { data: rows.slice(start, end + 1), error: null };
      },
      async insert(rows) {
        batches.push(structuredClone(rows));
        // Model PostgreSQL's single-statement commit/rollback boundary.
        if (reject) return { error: { message: 'synthetic constraint rejection' } };
        tables[table].push(...structuredClone(rows));
        return { error: null };
      },
    };
    return query;
  } };
  return { db, tables, batches, allowSave() { reject = false; } };
}

test('Chicago week boundary uses Monday and local date', () => {
  assert.equal(currentWeek(new Date('2026-10-05T03:00:00Z')), '2026-09-28');
  assert.equal(currentWeek(now), '2026-10-05');
});
test('default preview reuses evidence gates and competition ranks without writes', async () => {
  const f = fixture();
  const result = await saveWeeklySnapshot(f.db, { now });
  assert.equal(result.status, 'preview');
  assert.deepEqual(result.plan.map(row => row.snapshot.rank), [1, 1, 3]);
  assert.equal(result.plan[1].tier, 'Disqualified');
  assert.equal(result.plan[0].total, 90);
  assert.equal(result.plan[0].snapshot.persona, 'Manual');
  assert.equal(f.batches.length, 0);
});
test('apply saves one tied batch and repeat runs preserve the complete week', async () => {
  const f = fixture();
  assert.equal((await saveWeeklySnapshot(f.db, { now, apply: true })).status, 'saved');
  const saved = structuredClone(f.tables.weekly_snapshots);
  f.tables.scores[0].timing_score = 0;
  f.tables.companies.push({ id: 'new', name: 'New synthetic company' });
  f.tables.scores.push({ ...f.tables.scores[0], id: 'new-score', company_id: 'new' });
  assert.equal((await saveWeeklySnapshot(f.db, { now, apply: true })).status, 'existing');
  assert.deepEqual(f.tables.weekly_snapshots, saved);
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0].length, 3);
});
test('even a partially populated existing week is preserved without backfilling', async () => {
  const f = fixture({ existing: [{ id: 'old', week_start: '2026-10-05', company_id: 'a', rank: 9 }] });
  assert.equal((await saveWeeklySnapshot(f.db, { now, apply: true })).status, 'existing');
  assert.equal(f.batches.length, 0);
  assert.equal(f.tables.weekly_snapshots[0].rank, 9);
});
test('rejected batch leaves no partial rows and can be retried', async () => {
  const f = fixture({ reject: true });
  await assert.rejects(saveWeeklySnapshot(f.db, { now, apply: true }), /synthetic constraint rejection/);
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0].length, 3);
  assert.deepEqual(f.tables.weekly_snapshots, []);
  f.allowSave();
  assert.equal((await saveWeeklySnapshot(f.db, { now, apply: true })).status, 'saved');
  assert.equal(f.tables.weekly_snapshots.length, 3);
});
test('latest nonfuture score wins; malformed dates prevent saving', async () => {
  const f = fixture();
  f.tables.scores.push({ ...f.tables.scores[0], id: 'future', assessed_at: '2027-01-01T00:00:00Z' });
  const result = await saveWeeklySnapshot(f.db, { now });
  assert.equal(result.plan[0].snapshot.score_id, 'score-a');
  f.tables.scores[0].assessed_at = 'invalid';
  await assert.rejects(saveWeeklySnapshot(f.db, { now, apply: true }), /Invalid assessment date/);
  assert.equal(f.batches.length, 0);
});
test('empty assessment set does not issue an insert', async () => {
  const f = fixture();
  f.tables.scores = [];
  assert.equal((await saveWeeklySnapshot(f.db, { now, apply: true })).status, 'empty');
  assert.equal(f.batches.length, 0);
});
test('unknown or repeated flags fail before connecting', async () => {
  await assert.rejects(main(['--save']), /Usage/);
  await assert.rejects(main(['--apply', '--apply']), /Usage/);
});

test('a later week saves a separate complete batch without altering history', async () => {
  const f = fixture();
  await saveWeeklySnapshot(f.db, { now, apply: true });
  const history = structuredClone(f.tables.weekly_snapshots);
  await saveWeeklySnapshot(f.db, { now: new Date('2026-10-12T12:00:00Z'), apply: true });
  assert.deepEqual(f.tables.weekly_snapshots.slice(0, 3), history);
  assert.equal(f.tables.weekly_snapshots.length, 6);
  assert.equal(f.tables.weekly_snapshots[3].week_start, '2026-10-12');
});
