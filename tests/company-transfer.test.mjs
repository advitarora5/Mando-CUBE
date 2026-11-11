import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { planTransfer, sanitizePackage, transferSql } from '../scripts/company-transfer.mjs';
import { transferFixture } from './helpers/company-transfer-fixture.mjs';

test('reviewed transfer creates new companies and attaches by normalized domain', () => {
  const data = transferFixture(), company = data.companies[0].company;
  assert.equal(planTransfer(data, []).mapping[0].action, 'create');
  const target = { id: randomUUID(), name: 'Existing legal company name', domain: `https://www.${company.domain}/` };
  const mapping = planTransfer(data, [target]).mapping[0];
  assert.equal(mapping.action, 'attach'); assert.equal(mapping.target_id, target.id);
});
test('ambiguous names and duplicate normalized domains hold the package', () => {
  const data = transferFixture(), c = data.companies[0].company;
  const held = planTransfer(data, [{ id: randomUUID(), name: c.name + ' Inc.', domain: 'different.example' }]);
  assert.equal(held.mapping[0].action, 'review'); assert.throws(() => transferSql(held), /Resolve held/);
  assert.equal(planTransfer(data, [{ id: randomUUID(), name: 'One', domain: c.domain }, { id: randomUUID(), name: 'Two', domain: `www.${c.domain}` }]).mapping[0].action, 'review');
});
test('batch duplicates map to the same target company', () => {
  const data = transferFixture(), second = structuredClone(data.companies[0]);
  second.company.id = randomUUID(); second.company.name = 'Another legal spelling';
  for (const r of [...second.signals, ...second.sites]) { r.id = randomUUID(); r.company_id = second.company.id; }
  data.companies.push(second);
  const plan = planTransfer(data, []);
  assert.deepEqual(plan.mapping.map(m => m.action), ['create', 'attach']);
  assert.equal(plan.mapping[0].target_id, plan.mapping[1].target_id);
});
test('only reviewed, connected evidence is accepted, and scores/settings are stripped', () => {
  const data = transferFixture();
  data.scores = [{ score: 99 }]; data.companies[0].company.tier = 'A';
  const safe = sanitizePackage(data);
  assert.equal(safe.scores, undefined); assert.equal(safe.companies[0].company.tier, undefined);
  assert.equal(safe.sources[0].config, undefined);
  data.companies[0].review.approved = false; assert.throws(() => sanitizePackage(data), /approved:true/);
  data.companies[0].review.approved = true; data.companies[0].signals[0].company_id = randomUUID();
  assert.throws(() => sanitizePackage(data), /ownership/);
});
test('SQL previews roll back; apply retains dates and includes transactional ownership guards', () => {
  const plan = planTransfer(transferFixture(), []), sql = transferSql(plan);
  assert.match(sql, /ROLLBACK;\s*$/); assert.match(transferSql(plan, { apply: true }), /COMMIT;\s*$/);
  assert.match(sql, /Target companies changed/); assert.match(sql, /Signal belongs to another company/);
  assert.match(sql, /Workday site belongs to another company/);
  assert.match(sql, /least\(first_seen_at/); assert.match(sql, /greatest\(last_seen_at/);
  assert.doesNotMatch(sql, /INSERT INTO public\.(scores|company_insights|weekly_snapshots|contacts)\b/i);
});

test('pending resolutions require a selected company and explicit evidence IDs', () => {
  const data = transferFixture(), id = randomUUID();
  assert.throws(() => planTransfer(data, [], { pendingReviews: [{ id, local_company_id: randomUUID(), note: 'Checked', signal_ids: [], site_ids: [] }] }), /selected company/);
  assert.throws(() => planTransfer(data, [], { pendingReviews: [{ id, local_company_id: data.companies[0].company.id, note: 'Checked', signal_ids: [], site_ids: [] }] }), /no reviewed evidence/);
  const plan = planTransfer(data, [], { pendingReviews: [{ id, local_company_id: data.companies[0].company.id, note: 'Checked', signal_ids: [randomUUID()], site_ids: [] }] });
  assert.equal(plan.pending_reviews[0].normalized_name, data.companies[0].company.name.toLowerCase());
  assert.match(transferSql(plan), /Explicit pending review changed or was rejected/);
});

test('capture transfer preserves raw bytes and collector fingerprint separately', () => {
  const data = transferFixture(), exactHash = data.captures[0].content_hash;
  data.captures[0].content_hash = 'a'.repeat(64);
  const safe = sanitizePackage(data);
  assert.equal(safe.captures[0].content_hash, exactHash);
  assert.equal(safe.captures[0].meta.import_original_content_hash, 'a'.repeat(64));
  assert.equal(safe.captures[0].body, data.captures[0].body);
  assert.deepEqual(sanitizePackage(safe), safe);
});
