import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTier, applyTierRules, hasEvidence } from '../src/domain/scoring/tier-rules.ts';
const evidence = 'https://google.com | Fictional evidence reason.';
const qualified = { authority_score: 25, reachability_score: 25, budget_score: 20, release_score: 15, timing_score: 15, authority_evidence: evidence, reachability_evidence: evidence };
test('evidence needs both an HTTP(S) source and nonempty reason', () => {
 for (const value of ['', 'https://google.com', 'https://google.com | ', '| a reason', 'javascript:alert(1) | reason', 'not-a-url | reason']) assert.equal(hasEvidence(value), false);
 assert.equal(hasEvidence(evidence), true);
 assert.equal(hasEvidence(' http://example.com | a reason '), true);
});
test('a maximum total cannot bypass either evidence gate', () => {
 for (const key of ['authority_evidence', 'reachability_evidence']) {
  const result = evaluateTier({ ...qualified, [key]: '' });
  assert.equal(result.total, 100);
  assert.equal(result.tier, 'Disqualified');
  assert.match(result.tier_reason, /evidence/);
 }
});
test('thresholds are inclusive after evidence checks', () => {
 assert.equal(evaluateTier(qualified).tier, 'Qualified');
 assert.equal(evaluateTier({ ...qualified, budget_score: 0 }).tier, 'Qualified'); // 80
 assert.equal(evaluateTier({ ...qualified, authority_score: 15, reachability_score: 15, budget_score: 10, release_score: 10, timing_score: 5 }).tier, 'Maybe'); // 55
 assert.equal(evaluateTier({ ...qualified, authority_score: 15, reachability_score: 15, budget_score: 10, release_score: 10, timing_score: 4 }).tier, 'Disqualified'); // 54
});
test('timing-only companies fail even if evidence strings are present', () => {
 const result = evaluateTier({ ...qualified, authority_score: 0, reachability_score: 0, budget_score: 0 });
 assert.equal(result.tier, 'Disqualified');
 assert.match(result.tier_reason, /Timing signals alone/);
});
test('invalid scores fail closed and stale stored tiers/totals are ignored', () => {
 assert.equal(evaluateTier({ ...qualified, timing_score: 16 }).tier, 'Disqualified');
 assert.equal(evaluateTier({ ...qualified, budget_score: -1 }).tier, 'Disqualified');
 assert.equal(evaluateTier({ ...qualified, authority_score: NaN }).tier, 'Disqualified');
 const stored = { ...qualified, total: 1, tier: 'Maybe', authority_evidence: '' };
 const result = applyTierRules(stored);
 assert.equal(result.total, 100);
 assert.equal(result.tier, 'Disqualified');
 assert.equal(stored.total, 1);
});
