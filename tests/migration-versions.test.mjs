import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

test('Supabase SQL migrations have unique version prefixes', () => {
  const migrations = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(filename => filename.endsWith('.sql'));
  const versions = new Map();
  for (const filename of migrations) {
    const match = /^(\d+)_.+\.sql$/.exec(filename);
    assert.ok(match, `Invalid migration filename: ${filename}`);
    const version = match[1];
    assert.ok(!versions.has(version), `Duplicate migration version ${version}: ${versions.get(version)} and ${filename}`);
    versions.set(version, filename);
  }
});
