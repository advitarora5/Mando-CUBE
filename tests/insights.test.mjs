import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseInsights } from '../src/domain/insights/generate.ts';
test('parses model JSON, tolerating wrapper text', () => {
 const out = parseInsights('Sure:\n{"persona":" HRIS lead ","level":"Director","why_now":"Went live in August."}');
 assert.deepEqual(out, { persona: 'HRIS lead', level: 'Director', why_now: 'Went live in August.' });
});
test('rejects bad level, empty fields and non-JSON', () => {
 for (const bad of ['{"persona":"a","level":"Boss","why_now":"x"}', '{"persona":"","level":"VP","why_now":"x"}', 'no json']) assert.throws(() => parseInsights(bad));
});
test('prompt carries the stored evidence', () => {
 const p = buildPrompt({ name: 'Acme', industry: null, employee_count: 4000, workday_signal_date: '2026-08-01', contacts: [], score: { authority_score: 20, authority_evidence: 'https://x.com | CHRO owns HRIS' } });
 assert.match(p, /Acme/); assert.match(p, /CHRO owns HRIS/);
});
