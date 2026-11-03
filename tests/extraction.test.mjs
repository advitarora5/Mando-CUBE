import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractionSchema } from '../src/data/ingestion/extraction.ts';
import { checkEvidence } from '../src/data/ingestion/evidence.ts';

const sources = [{
  capture_ref: 'run/capture-1',
  segments: [
    { id: 'seg-a', text: 'Hays Electrical Services\nThis role starts by supporting the active implementation.\nThe company’s Workday HCM platform goes live later.' },
    { id: 'seg-b', text: 'Completely different words appear in this other segment.' },
  ],
}];
const claim = (evidence = {}, extra = {}) => ({
  statement: 'Supporting the active implementation',
  company: { name: 'Hays Electrical Services', role: 'customer' },
  signal_type: 'implementation',
  product_area: 'HCM',
  date: null,
  evidence: { capture_ref: 'run/capture-1', segment_id: 'seg-a', quote: 'supporting the active implementation', ...evidence },
  ...extra,
});
// Statement mirrors the quote so these cases test only the quote check.
const rejection = evidence => checkEvidence([claim(evidence, { statement: evidence.quote ?? 'supporting the active implementation' })], sources).rejected[0]?.reason;

test('schema accepts a well-formed claim', () => {
  assert.equal(extractionSchema.safeParse({ claims: [claim()] }).success, true);
});

test('schema rejects an active/verified flag', () => {
  assert.equal(extractionSchema.safeParse({ claims: [claim({}, { active: true })] }).success, false);
  assert.equal(extractionSchema.safeParse({ claims: [claim({}, { verified: true })] }).success, false);
});

test('schema rejects a day value on a month-only date and accepts null', () => {
  const date = (precision, normalized) => ({ raw: 'July 2024', normalized, precision, kind: 'event' });
  assert.equal(extractionSchema.safeParse({ claims: [claim({}, { date: date('month', '2024-07-01') })] }).success, false);
  assert.equal(extractionSchema.safeParse({ claims: [claim({}, { date: date('month', null) })] }).success, true);
  assert.equal(extractionSchema.safeParse({ claims: [claim({}, { date: date('day', '2024-07-15') })] }).success, true);
});

test('a verbatim quote passes', () => {
  assert.equal(checkEvidence([claim()], sources).accepted.length, 1);
});

test('a paraphrase fails', () => {
  assert.match(rejection({ quote: 'helps with the ongoing implementation work' }), /not verbatim/);
  assert.match(rejection({ quote: 'Supporting The Active Implementation' }), /not verbatim/);
});

test('a quote from a different segment than the one cited fails', () => {
  assert.match(rejection({ segment_id: 'seg-b' }), /not verbatim/);
});

test('an unknown capture or segment fails', () => {
  assert.match(rejection({ capture_ref: 'run/capture-9' }), /unknown capture_ref/);
  assert.match(rejection({ segment_id: 'seg-z' }), /unknown segment_id/);
});

test('an empty or too-short quote fails', () => {
  assert.match(rejection({ quote: '' }), /shorter/);
  assert.match(rejection({ quote: 'Workday' }), /shorter/);
  assert.match(rejection({ quote: 'Workday HCM' }), /shorter/);
});

test('a quote spanning a line break in the source passes', () => {
  assert.equal(rejection({ quote: 'Hays Electrical Services This role starts by supporting' }), undefined);
});

test('curly and straight apostrophes are interchangeable, wording is not', () => {
  assert.equal(rejection({ quote: "The company's Workday HCM platform" }), undefined);
  assert.match(rejection({ quote: "The company's Workday HR platform" }), /not verbatim/);
});

const reason = extra => checkEvidence([claim({}, extra)], sources).rejected[0]?.reason;

test('a statement that adds words beyond its quote fails', () => {
  assert.match(reason({ statement: 'Hays is supporting the active implementation' }), /adds words not in the quote: hays/);
  assert.equal(reason({ statement: 'It is supporting the active implementation' }), undefined);
});

test('a statement cannot call a posting still active', () => {
  assert.match(reason({ statement: 'supporting the active implementation is still open' }), /adds words not in the quote: still, open/);
});

test('company names must be stated and consistent with the role', () => {
  assert.match(reason({ company: { name: null, role: 'customer' } }), /without a company name/);
  assert.equal(reason({ company: { name: null, role: 'unknown' } }), undefined);
  assert.match(reason({ company: { name: 'Hays Plumbing', role: 'customer' } }), /not named/);
  assert.equal(reason({ company: { name: 'hays electrical services', role: 'customer' } }), undefined);
});

test('a date must appear in the capture', () => {
  const date = raw => ({ date: { raw, normalized: null, precision: 'unknown', kind: 'event' } });
  assert.match(reason(date('October 2026')), /not in/);
  assert.equal(reason(date('later')), undefined);
});

test('a repeated claim is rejected as a duplicate, the same quote for another company is not', () => {
  const twice = checkEvidence([claim(), claim(), claim({}, { company: { name: null, role: 'unknown' } })], sources);
  assert.equal(twice.accepted.length, 2);
  assert.match(twice.rejected[0].reason, /duplicate/);
});
