import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCapture } from '../scripts/ingestion/validate-capture.mjs';
import { sourceConfigSchema } from '../src/data/ingestion/contracts.ts';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/ingestion/mixed-sources.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(fixture);

test('varied sources and unknown companies/dates are valid collection inputs', () => {
  const report = validateCapture(fixture);
  assert.equal(report.ok, true);
  assert.equal(report.captures, 5);
  assert.match(report.warnings.join(' '), /publication dates/);
});

test('rejects malformed URLs, invented date precision and invalid collection times', () => {
  for (const mutate of [
    batch => { batch.captures[0].url = 'file:///secrets'; },
    batch => { batch.captures[0].published_date = { raw: '2024', normalized: '2024-01-01', precision: 'year' }; },
    batch => { batch.captures[0].collected_at = '2026-10-08T15:00:00Z'; },
    batch => { batch.captures[0].published_date = { raw: 'Feb 30', normalized: '2026-02-30', precision: 'day' }; },
  ]) {
    const batch = copy(); mutate(batch);
    assert.equal(validateCapture(batch).ok, false);
  }
});

test('rejects duplicate captures and broken/cyclic comment context', () => {
  for (const mutate of [
    batch => { batch.captures[1].url = batch.captures[0].url; },
    batch => { batch.captures[0].segments[1].parent_id = 'absent'; },
    batch => { batch.captures[0].segments[0].parent_id = 'comment-1'; },
    batch => { batch.pages_visited = 11; },
  ]) {
    const batch = copy(); mutate(batch);
    assert.equal(validateCapture(batch).ok, false);
  }
});

test('blocked empty runs remain reportable without inventing evidence', () => {
  const batch = copy(); batch.captures = []; batch.pages_visited = 1; batch.outcome = 'blocked';
  assert.equal(validateCapture(batch).ok, false);
  batch.failures = [{ url: 'https://example.com/', occurred_at: '2026-10-09T15:01:00Z', reason: 'Access unavailable' }];
  const report = validateCapture(batch);
  assert.equal(report.ok, true);
  assert.match(report.warnings.join(' '), /No captures/);
});

test('config enables only the Reddit pilot and rejects duplicate source IDs', () => {
  const config = JSON.parse(readFileSync(new URL('../config/ingestion/sources.json', import.meta.url), 'utf8'));
  const parsed = sourceConfigSchema.parse(config);
  assert.deepEqual(parsed.sources.filter(source => source.enabled).map(source => source.id), ['reddit-workday']);
  config.sources[1].id = config.sources[0].id;
  assert.equal(sourceConfigSchema.safeParse(config).success, false);
});
