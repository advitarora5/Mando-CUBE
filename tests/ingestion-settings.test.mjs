import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultSettings, parseSettings, mayScore, readyForContacts, isSignalFresh } from '../src/domain/ingestion/settings.ts';

const migration = readFileSync(new URL('../supabase/migrations/202610120001_ingestion_foundation.sql', import.meta.url), 'utf8');

test('code defaults match the settings seeded by the migration', () => {
 const insert = migration.slice(migration.indexOf('insert into public.pipeline_settings'), migration.indexOf('create table public.sources'));
 const seeded = Object.fromEntries([...insert.matchAll(/\('([a-z_]+)', '([^']+)', '/g)].map(([, key, value]) => [key, JSON.parse(value)]));
 assert.deepEqual(seeded, defaultSettings);
});

test('settings rows override defaults; bad values and unknown keys throw', () => {
 assert.equal(parseSettings([{ key: 'scoring_scope', value: 'all' }]).scoring_scope, 'all');
 assert.deepEqual(parseSettings([]), defaultSettings);
 assert.throws(() => parseSettings([{ key: 'scoring_scope', value: 'everything' }]));
 assert.throws(() => parseSettings([{ key: 'ready_for_contacts_threshold', value: 51 }]));
 assert.throws(() => parseSettings([{ key: 'max_requests_per_run', value: 0 }]));
 assert.throws(() => parseSettings([{ key: 'unknown_cap', value: 1 }]));
});

test('pipeline_only scope scores only pipeline-created companies', () => {
 const pipelineOnly = parseSettings([]);
 const all = parseSettings([{ key: 'scoring_scope', value: 'all' }]);
 assert.deepEqual([mayScore(pipelineOnly, true), mayScore(pipelineOnly, false), mayScore(all, false)], [true, false, true]);
});

test('ready for contacts at Budget + Release + Timing of 25 or more, adjustable', () => {
 const settings = parseSettings([]);
 assert.equal(readyForContacts({ budget_score: 10, release_score: 9, timing_score: 6 }, settings), true);
 assert.equal(readyForContacts({ budget_score: 10, release_score: 9, timing_score: 5 }, settings), false);
 assert.equal(readyForContacts({ budget_score: 10, release_score: 9, timing_score: 5 }, parseSettings([{ key: 'ready_for_contacts_threshold', value: 24 }])), true);
});

test('every signal type expires after 14 days unless seen again; go-live does not', () => {
 const settings = parseSettings([]);
 const now = new Date('2026-10-12T12:00:00Z');
 assert.equal(isSignalFresh({ type: 'hiring', last_seen_at: '2026-09-28T12:00:00Z' }, settings, now), true);
 assert.equal(isSignalFresh({ type: 'hiring', last_seen_at: '2026-09-28T11:59:00Z' }, settings, now), false);
 assert.equal(isSignalFresh({ type: 'release_planning', last_seen_at: '2026-09-01T00:00:00Z' }, settings, now), false);
 for (const type of ['known_customer', 'budget_clue', 'event']) {
  assert.equal(isSignalFresh({ type, last_seen_at: '2026-09-28T11:59:00Z' }, settings, now), false, type);
 }
 assert.equal(isSignalFresh({ type: 'go_live', last_seen_at: '2025-01-01T00:00:00Z' }, settings, now), true);
});
