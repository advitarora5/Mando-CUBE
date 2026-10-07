import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineWeek, chicagoWeekStart, companyHistory, describeMovement, previousRanks, rankMovement } from '../src/domain/history.ts';
const snaps = [
 { week_start: '2026-09-28', company_id: 'a', rank: 5 }, { week_start: '2026-10-05', company_id: 'a', rank: 1 },
 { week_start: '2026-10-05', company_id: 'b', rank: 2 },
];
test('week starts Monday in Chicago', () => {
 assert.equal(chicagoWeekStart(new Date('2026-10-06T15:00:00Z')), '2026-10-05');
 assert.equal(chicagoWeekStart(new Date('2026-10-12T03:00:00Z')), '2026-10-05'); // Sunday evening in Chicago
});
test('baseline is latest saved week before the current one', () => {
 assert.equal(baselineWeek(snaps, '2026-10-12'), '2026-10-05');
 assert.equal(baselineWeek(snaps, '2026-10-05'), '2026-09-28');
 assert.equal(baselineWeek([], '2026-10-05'), null);
 assert.deepEqual(previousRanks(snaps, '2026-10-05'), { a: 1, b: 2 });
});
test('rank movement', () => {
 assert.equal(describeMovement(rankMovement(1, 5), 1), 'Moved from rank 5 to rank 1');
 assert.deepEqual(rankMovement(1, 5), { kind: 'up', from: 5, places: 4 });
 assert.deepEqual(rankMovement(7, 3), { kind: 'down', from: 3, places: 4 });
 assert.equal(rankMovement(3, 3).kind, 'same');
 assert.equal(rankMovement(3, undefined).kind, 'new');
 assert.equal(rankMovement(undefined, 3), null);
});
test('company history is oldest to newest with movement', () => {
 const h = companyHistory(snaps.filter(s => s.company_id === 'a'));
 assert.deepEqual(h.map(r => r.movement.kind), ['new', 'up']);
});
