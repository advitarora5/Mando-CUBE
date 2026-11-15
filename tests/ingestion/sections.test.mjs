import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSections, parseSectionCommand, sectionDatabaseTarget, uniqueIssuers } from '../../src/pipeline/sections.ts';

const cli = fileURLToPath(new URL('../../scripts/pipeline.mjs', import.meta.url));
const manifestUrl = new URL('../../src/data/sec-sections-v1.json', import.meta.url);
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
  cwd: tmpdir(), encoding: 'utf8', timeout: 10_000,
  env: { ...process.env, PIPELINE_SUPABASE_URL: 'http://127.0.0.1:1', PIPELINE_SUPABASE_KEY: '',
    PIPELINE_CONTACT_REVIEWS_FILE: '/nonexistent-section-test-file', PIPELINE_SEC_FILE: '/nonexistent-section-test-file' },
});

test('frozen manifest covers every issuer exactly once in 10 balanced contiguous sections', () => {
  const { manifest, sections } = loadSections();
  const original = uniqueIssuers(JSON.parse(readFileSync(new URL('../../sec.json', import.meta.url), 'utf8')));
  const assigned = sections.flatMap(s => s.issuers);
  assert.equal(sections.length, 10);
  assert.equal(assigned.length, manifest.issuer_count);
  assert.equal(new Set(assigned.map(i => i.cik)).size, assigned.length);
  assert.deepEqual(assigned, original);
  assert.ok(Math.max(...sections.map(s => s.issuers.length)) - Math.min(...sections.map(s => s.issuers.length)) <= 1);
  let end = 0;
  for (const [i, section] of sections.entries()) {
    assert.equal(section.number, i + 1);
    assert.equal(section.start, end + 1);
    assert.equal(section.end - section.start + 1, section.issuers.length);
    end = section.end;
  }
  assert.equal(end, original.length);
  assert.deepEqual(loadSections(), { manifest, sections });
});

test('issuer deduplication uses CIK, retaining first occurrence and distinct same-name issuers', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ cik_str: i + 1, title: 'Same name' }));
  rows.splice(1, 0, { cik_str: 1, title: 'Alternate ticker name' });
  const issuers = uniqueIssuers(Object.fromEntries(rows.map((row, i) => [i, row])));
  assert.deepEqual(issuers.map(i => i.cik), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(issuers[0].name, 'Same name');
  assert.throws(() => uniqueIssuers({ 0: { cik_str: 0, title: 'Bad' } }), /positive CIK/);
});

test('changed snapshot is refused rather than silently reassigning sections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mando-sections-'));
  try {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    writeFileSync(join(dir, 'sec.json'), '{}');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, snapshot: 'sec.json' }));
    assert.throws(() => loadSections(pathToFileURL(join(dir, 'manifest.json'))), /differs from the frozen/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only explicit valid section previews are accepted', () => {
  assert.deepEqual(parseSectionCommand(['sections']), { section: null });
  for (const n of ['1', '3', '10']) assert.deepEqual(parseSectionCommand(['section', n, '--preview']), { section: Number(n) });
  for (const args of [
    ['section'], ['section', '0', '--preview'], ['section', '11', '--preview'],
    ['section', '1.5', '--preview'], ['section', '03', '--preview'], ['section', '3'],
    ['section', '3', '--limit', '25'], ['section', '3', '--preview', '--limit', '25'],
    ['section', '3', '--preveiw'], ['sections', '--count', '9'],
  ]) assert.throws(() => parseSectionCommand(args));
});

test('target description reports only the hostname and does not claim to identify production', () => {
  assert.match(sectionDatabaseTarget({}), /not configured/);
  assert.match(sectionDatabaseTarget({ PIPELINE_SUPABASE_URL: 'http://localhost:54321' }), /^local: localhost/);
  assert.equal(sectionDatabaseTarget({ PIPELINE_SUPABASE_URL: 'https://user:private@example.com/private?private=1' }), 'remote: example.com (preview does not connect)');
  assert.throws(() => sectionDatabaseTarget({ PIPELINE_SUPABASE_URL: 'invalid' }), /^Error: Invalid pipeline database target URL\.$/);
});

test('CLI previews are deterministic from another directory with no database or provider initialization', () => {
  const overview = run('sections');
  assert.equal(overview.status, 0, overview.stderr);
  assert.match(overview.stdout, /8028 unique issuers across 10 sections/);
  assert.match(overview.stdout, /local: 127.0.0.1/);
  const first = run('section', '3', '--preview');
  const second = run('section', '3', '--preview');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, /Section: 3 of 10/);
  const { sections } = loadSections();
  assert.equal(first.stdout.split('\n').filter(line => /^\d+\t\d+\t/.test(line)).length, sections[2].issuers.length);
});

test('CLI refuses execution and misplaced section flags before opening a database', () => {
  for (const args of [
    ['section', '3'], ['section', '11', '--preview'], ['section', '3', '--preveiw'],
    ['section', '3', '--limit', '25'], ['sections', '--count', '9'],
    ['run', '--section', '3'], ['run', '--sectoin', '3'], ['run', '--preview'],
  ]) {
    const child = run(...args);
    assert.equal(child.status, 1, `${args}: ${child.stderr}`);
    assert.doesNotMatch(child.stderr, /ENOENT|fetch failed|Set PIPELINE_SUPABASE/);
  }
});
