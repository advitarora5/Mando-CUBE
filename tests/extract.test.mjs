import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRuns, extractCaptures } from '../scripts/ingestion/extract.mjs';

const capture = {
  capture_ref: 'run/capture-1', url: 'https://example.com/job', title: null, source_type: 'job_listing',
  collected_at: '2026-10-10T00:00:00Z', published_date: null,
  segments: [{ id: 'seg-a', parent_id: null, kind: 'page', author: null, published_date: null, text: 'Acme Corp went live on Workday HCM on 2026-09-01 after a long project.' }],
};
const claim = (quote, extra = {}) => ({
  statement: 'Acme Corp went live on Workday HCM', company: { name: 'Acme Corp', role: 'customer' }, signal_type: 'implementation',
  product_area: 'HCM', date: { raw: '2026-09-01', normalized: '2026-09-01', precision: 'day', kind: 'event' },
  evidence: { capture_ref: 'run/capture-1', segment_id: 'seg-a', quote }, ...extra,
});
const reply = content => async () => ({ ok: true, text: async () => JSON.stringify({ message: { content } }) + '\n' });
const ollama = claims => reply(JSON.stringify({ claims }));

test('extractCaptures keeps verbatim claims and rejects invented quotes', async () => {
  const { accepted, rejected, error } = await extractCaptures([capture], ollama([claim('Acme Corp went live on Workday HCM'), claim('never appears in the source')]));
  assert.equal(error, null);
  assert.equal(accepted.length, 1);
  assert.match(rejected[0].reason, /not verbatim/);
});

test('extractCaptures reports invalid JSON instead of throwing', async () => {
  assert.ok((await extractCaptures([capture], reply('not json'))).error);
});

test('a reply cut off at num_predict is retried as halves that keep the first segment', async () => {
  const thread = { ...capture, segments: ['Acme Corp post', 'Acme Corp went live on Workday HCM', 'reply two', 'reply three'].map((text, i) => ({ id: `s${i}`, parent_id: null, kind: 'comment', author: null, published_date: null, text })) };
  const prompts = [];
  const fetchImpl = async (_, { body }) => {
    const content = JSON.parse(body).messages[0].content;
    prompts.push(content);
    const cut = prompts.length === 1;
    const claims = content.includes('went live') ? [claim('Acme Corp went live on Workday HCM', { date: null, evidence: { capture_ref: 'run/capture-1', segment_id: 's1', quote: 'Acme Corp went live on Workday HCM' } })] : [];
    return { ok: true, text: async () => JSON.stringify({ message: { content: cut ? '{"claims": [' : JSON.stringify({ claims }) }, done: true, done_reason: cut ? 'length' : 'stop' }) + '\n' };
  };
  const { accepted, error } = await extractCaptures([thread], fetchImpl);
  assert.equal(error, null);
  assert.equal(accepted.length, 1);
  assert.equal(prompts.length, 3);
  assert.ok(prompts.slice(1).every(p => p.includes('Acme Corp post')));
});

test('compareRuns separates stable claims, claims some runs missed, and changed fields', () => {
  const a = claim('Acme Corp went live on Workday HCM');
  const b = claim('after a long project', { statement: 'after a long project' });
  const vendor = { ...a, company: { name: 'Acme Corp', role: 'vendor' } };
  const { stable, unstable, drift } = compareRuns([{ accepted: [a, b] }, { accepted: [vendor] }]);
  assert.equal(stable, 0);
  assert.equal(unstable.length, 1);
  assert.match(drift[0], /customer.*vs.*vendor/);
  assert.equal(compareRuns([{ accepted: [a, b] }, { accepted: [b, a] }]).stable, 2);
});
