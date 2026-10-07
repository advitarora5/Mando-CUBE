import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dataPath } from '../scripts/research-data.mjs';
import { researchSql } from '../scripts/research-supabase-sql.mjs';
const data = JSON.parse(await readFile(dataPath, 'utf8'));

test('Supabase preview rolls back and includes only role-checked contacts', () => {
  const sql = researchSql(data);
  assert.match(sql, /rollback;\s*$/);
  const payload = JSON.parse(sql.split('$research_payload$')[1]);
  assert.equal(payload.companies.length, 110);
  assert.equal(payload.contacts.length, 19);
  assert(payload.contacts.every(c => data.contact_evidence.some(e => e.contact_id === c.id && e.role_status === 'company_listed_role_checked')));
});
test('Apply is atomic, preserves existing data and leaves scoring/security untouched', () => {
  const sql = researchSql(data, { apply: true });
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /Ambiguous company match/);
  assert.match(sql, /Contact profile belongs to another company/);
  assert.doesNotMatch(sql, /\b(update|delete|alter|grant|truncate)\b/i);
  assert.doesNotMatch(sql, /insert into public\.(scores|company_insights|weekly_snapshots)/);
  assert.equal((sql.match(/create temporary table/g) ?? []).length, 6);
});
