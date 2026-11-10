import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewHeadcountAuthority } from '../../src/pipeline/employee-authority-preview.ts';
import { getOnlyFetch, main } from '../../scripts/audit-headcount-coverage.mjs';
const now = new Date('2026-11-09T16:00:00Z');
const contact = { name: 'Pat', title: 'Director of HRIS', source: 'https://pilot.example/team', linkedin_status: 'confirmed' };
const evidence = { employee_count: 3500, as_of: '2026-11-09', source: 'https://pilot.example/about', basis: 'lower_bound', date_basis: 'observed' };
const compare = (saved, people = [contact], ev = evidence) => previewHeadcountAuthority(people, ev, saved, now);

test('Authority-only audit accounts for the cap and does not double award size points', () => {
  assert.equal(compare({ authority_score: 20 }).additional_points, 3);
  assert.equal(compare({ authority_score: 23 }).additional_points, 0);
  assert.equal(compare({ authority_score: 25 }).comparison_status, 'already_at_authority_cap');
  assert.equal(compare({ authority_score: 25 }).authority_after, 25);
  assert.equal(compare({ authority_score: 21, authority_evidence: 'role18 + size3 + ownership0' }).additional_points, 0);
  assert.equal(compare({ authority_score: 21, authority_evidence: 'Role 18 + confirmed 3,000+ employer/group 3' }).additional_points, 0);
  assert.equal(compare({ authority_score: 19 }).authority_after, null);
  assert.equal(compare(null).comparison_status, 'no_saved_authority');
});

test('current role, source, precision, threshold and single-contact rules remain in force', () => {
  for (const people of [[], [{ ...contact, linkedin_status: 'unconfirmed', contact_sources: { name_title_linkedin: {} } }], [{ ...contact, source: null }],
    [{ ...contact, contact_sources: { role_review: { status: 'different_employer' } } }],
    [{ ...contact, contact_sources: { role_review: { status: 'confirmed', reviewed_on: '2020-01-01' } } }]]) {
    assert.equal(compare({ authority_score: 5 }, people).size_component, 0);
  }
  assert.equal(compare({ authority_score: 20 }, [contact], { ...evidence, basis: 'approximate' }).additional_points, 0);
  assert.equal(compare({ authority_score: 20 }, [contact], { ...evidence, employee_count: 2999 }).additional_points, 0);
  assert.equal(compare({ authority_score: 20 }, [contact], null).additional_points, 0);
  for (const as_of of ['2020-01-01', '2026-09-01', '2027-01-01']) {
    assert.equal(compare({ authority_score: 20 }, [contact], { ...evidence, as_of }).additional_points, 0);
  }
});

test('audit refuses mutations including Request objects and unknown CLI flags before access', async () => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']) {
    assert.throws(() => getOnlyFetch('https://pilot.example', { method }), /GET only/);
    assert.throws(() => getOnlyFetch(new Request('https://pilot.example', { method })), /GET only/);
  }
  await assert.rejects(main(['--apply', 'true'], {}), /Usage/);
  await assert.rejects(main(['--output', '/tmp/unused.json'], {}), /private Supabase/);
});
