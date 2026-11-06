import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryHealthMarkdown } from '../scripts/discovery-health.mjs';
import { DISCOVERY_SOURCES } from '../scripts/discovery-plan.mjs';

const healthy = () => ({ status: 'succeeded', jobs: [
  ...DISCOVERY_SOURCES.map(source => ({ job: 'collect', source, status: 'succeeded', counts: { items: 2 }, requests: 3 })),
  { job: 'extract', status: 'succeeded' }, { job: 'extract', status: 'succeeded' },
  { job: 'match', status: 'succeeded', counts: { new_companies: 1, review_no_website: 2 } },
  { job: 'score', status: 'succeeded', counts: { scored: 1 } },
] });

test('health summary distinguishes new companies, reviews and assessment writes', () => {
  const summary = healthy();
  summary.jobs[2].cache_hit = true;
  const text = discoveryHealthMarkdown(summary);
  assert.match(text, /Result: \*\*succeeded\*\*/);
  assert.match(text, /New companies admitted: \*\*1\*\*\. New reviews: \*\*2\*\*/);
  assert.match(text, /Assessments written: \*\*1\*\*/);
  assert.match(text, /Common Crawl \| succeeded \| 2 \| 3 \| yes/);
});

test('a nominal success missing scoring is shown as needing attention', () => {
  const summary = healthy();
  summary.jobs.pop();
  const text = discoveryHealthMarkdown(summary);
  assert.match(text, /Result: \*\*needs_attention/);
  assert.match(text, /Scoring: \*\*not run/);
  assert.match(text, /not confirmed healthy/);
});

test('partial sources and early interruption do not imply a rollback or lost successes', () => {
  const summary = healthy();
  summary.status = 'time_limit';
  summary.jobs[2].status = 'failed';
  summary.jobs.at(-2).counts.pending_reason_no_website = 4;
  const text = discoveryHealthMarkdown(summary);
  assert.match(text, /Common Crawl \| failed/);
  assert.match(text, /In-flight writes may have completed/);
  assert.match(text, /Existing reviews still held \(no_website\): \*\*4/);
  assert.match(text, /New companies admitted: \*\*1/);
});

test('provider text and malformed counters cannot enter the summary', () => {
  const summary = healthy();
  summary.status = 'secret-provider-body';
  summary.jobs[0].status = 'secret-provider-body';
  summary.jobs[0].counts.items = 'secret-provider-body';
  summary.jobs[0].errors = ['https://secret@host/?token=secret'];
  summary.jobs[0].diagnostics = [{ host: 'secret-provider-body' }];
  summary.jobs.at(-2).counts.new_companies = -1;
  const text = discoveryHealthMarkdown(summary);
  assert.doesNotMatch(text, /secret/);
  assert.match(text, /Result: \*\*unknown/);
  assert.match(text, /New companies admitted: \*\*0/);
});

test('missing report claims no successful execution', () => {
  assert.match(discoveryHealthMarkdown(null), /No successful run is claimed/);
});

test('coverage explains the score: contacts, zero categories and whether filings could be checked', () => {
  const summary = healthy();
  summary.jobs.at(-2).counts.candidates = 2;
  summary.jobs.at(-2).candidate_keys = ['a'.repeat(16), 'b'.repeat(16)];
  Object.assign(summary.jobs.at(-1).counts, { with_contacts: 1, without_contacts: 2, zero_authority: 2, zero_budget: 3, financials_no_contact: 2, financials_found: 1, financials_deferred: 1 });
  const text = discoveryHealthMarkdown(summary);
  assert.match(text, /Candidates checked: \*\*2\*\*; unique: \*\*2\*\*/);
  assert.match(text, /Contact coverage: \*\*1\*\* of \*\*3\*\*/);
  assert.match(text, /Authority 2, Reachability 0, Budget 3/);
  assert.match(text, /filing found 1/);
  assert.match(text, /\*\*2\*\* scored companies could not be checked/);
  assert.match(text, /kept instead of being lowered during the outage: \*\*1/);
});

test('a run whose candidates were not hashed says so, and unknown counter names never render', () => {
  const summary = healthy();
  summary.jobs.at(-2).counts.candidates = 1;
  Object.assign(summary.jobs.at(-1).counts, { without_contacts: 1, 'financials_secret-provider-body': 4, 'zero_secret-provider-body': 4 });
  const text = discoveryHealthMarkdown(summary);
  assert.match(text, /unique: \*\*not measured/);
  assert.doesNotMatch(text, /secret/);
  assert.doesNotMatch(text, /could not be checked/);
});
