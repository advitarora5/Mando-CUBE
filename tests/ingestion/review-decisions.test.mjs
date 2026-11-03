import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, DEFAULT_SOURCES } from '../../src/pipeline/store/memory.ts';
import { WorkdayJobs } from '../../src/pipeline/collectors/workday.ts';
import { makeCtx } from './helpers.mjs';

async function pendingReview(store) {
  const { id } = await store.addReviewItem({ candidate_name: 'Example Corp', normalized_name: 'example', candidate_domain: 'example.com', employee_count: null, suggested_company_id: null, reason: 'untrusted_signal' });
  const site = { tenant: 'example', pod: 'wd1', site: 'Careers', company_name: 'Example Corp', normalized_name: 'example', match_kind: 'first_word', discovered_from: 'workday-site-resolver', capture_id: null };
  await store.upsertWorkdaySite(site);
  await store.linkWorkdaySites('example', { review_item_id: id });
  store.signals.push({ id: 'waiting', review_item_id: id, company_id: null });
  return { id, site };
}

test('reject quarantines evidence and disables the incorrect association without deleting or recrawling it', async () => {
  const store = new MemoryStore();
  const { id, site } = await pendingReview(store);
  const existing = store.addExistingCompany({ name: 'Previously verified company', domain: 'verified.example' });
  store.sites.push({ ...store.sites[0], id: 'verified-site', site: 'Verified', company_id: existing });
  store.signals.push({ id: 'verified-signal', review_item_id: id, company_id: existing });
  assert.equal(await store.resolveReview(id, { action: 'reject' }, 'Wrong employer', null), null);
  assert.equal(store.reviews[0].status, 'rejected');
  assert.equal(store.sites[0].enabled, false);
  assert.equal(store.sites[1].enabled, true);
  assert.equal(store.signals[0].company_id, null);
  assert.equal(store.signals[1].company_id, existing);
  assert.deepEqual(await store.unassignedSignals(), []);
  const rediscovered = await store.upsertWorkdaySite(site);
  assert.equal(rediscovered.inserted, false);
  assert.equal(store.sites[0].enabled, false);
  store.sites[1].enabled = false;
  const ctx = makeCtx({ store });
  const out = await new WorkdayJobs().collect(DEFAULT_SOURCES.find(source => source.id === 'workday-career-sites'), { maxRequests: 10, maxItems: 10, minDelayMs: 0, dryRun: false }, ctx);
  assert.equal(out.requests, 0);
  await assert.rejects(store.resolveReview(id, { action: 'approve' }, 'Again', null), /not pending/);
});

for (const action of ['approve', 'merge']) {
  test(`${action} attaches waiting evidence and sites and preserves existing company data`, async () => {
    const store = new MemoryStore();
    const { id } = await pendingReview(store);
    const existing = store.addExistingCompany({ name: 'Existing', domain: 'existing.example' });
    store.contacts.push({ id: 'contact', company_id: existing, name: 'Existing contact' });
    store.scores.push({ id: 'score', company_id: existing });
    const protectedRows = structuredClone({ contacts: store.contacts, scores: store.scores });
    const decision = action === 'approve' ? { action, domain: 'corrected.example' } : { action, company_id: existing };
    const resolved = await store.resolveReview(id, decision, 'Verified corporate link', null);
    assert.equal(store.signals[0].company_id, resolved);
    assert.equal(store.sites[0].company_id, resolved);
    assert.equal(store.sites[0].enabled, true);
    assert.equal(store.companyRows.length, action === 'approve' ? 2 : 1);
    assert.deepEqual({ contacts: store.contacts, scores: store.scores }, protectedRows);
    if (action === 'approve') assert.equal(store.companyRows.find(company => company.id === resolved).domain, 'corrected.example');
    await assert.rejects(store.resolveReview(id, { action: 'reject' }, 'Again', null), /not pending/);
  });
}

test('merging into a nonexistent company leaves the review and evidence unchanged', async () => {
  const store = new MemoryStore();
  const { id } = await pendingReview(store);
  await assert.rejects(store.resolveReview(id, { action: 'merge', company_id: 'missing' }, 'Bad target', null), /does not exist/);
  assert.equal(store.reviews[0].status, 'pending');
  assert.equal(store.signals[0].company_id, null);
  assert.equal(store.sites[0].enabled, true);
});
