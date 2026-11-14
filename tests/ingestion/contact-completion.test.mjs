import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichStage, EMAIL_FIND } from '../../src/pipeline/enrich.ts';
import { runPipeline } from '../../src/pipeline/runner.ts';
import { makeCtx, worldTreg } from './helpers.mjs';
import { createTregClient, researchCompany } from '../../scripts/contact-research.mjs';
const VERIFY = 'treg.people.email.verify';
async function setup(contacts = []) {
  const ctx = makeCtx({ treg: worldTreg(), caps: { treg: 1 } });
  const id = ctx.store.addExistingCompany({ name: 'Example', domain: 'example.com' });
  ctx.store.companyRows[0].pipeline = true;
  ctx.store.signalsForCompany = async () => [{ type: 'known_customer', source_url: 'https://example.com/workday', quote: 'We use Workday HCM.', confidence: .9, last_seen_at: ctx.now().toISOString() }];
  for (const contact of contacts) await ctx.store.insertContact({ company_id: id, name: 'Alex Person', title: 'Director HRIS', source: 'manual', linkedin_url: null, email: null, email_status: null, phone: null, phone_status: null, mutual_connection: null, contact_sources: { manual: 'retain' }, ...contact });
  return { ctx, id };
}
for (const state of ['missing', 'unverified', 'verified']) {
  test(`pipeline completes ${state} contact in place, then repeat runs make no paid calls`, async () => {
    const { ctx, id } = await setup([{ email: state === 'missing' ? null : 'manual@example.com', email_verified: state === 'verified' }]);
    const before = structuredClone(ctx.store.contacts[0]);
    await ctx.store.setEnrichment(id, 'done', 'previous discovery');
    const first = await enrichStage(ctx, { maxCompanies: 1 });
    assert.deepEqual(first.errors, []);
    assert.equal(ctx.store.contacts.length, 1);
    assert.equal(ctx.store.contacts[0].id, before.id);
    assert.equal(ctx.store.contacts[0].source, 'manual');
    assert.equal(ctx.store.contacts[0].contact_sources.manual, 'retain');
    assert.equal(ctx.treg.calls.filter(c => c.endpoint === EMAIL_FIND).length, state === 'missing' ? 1 : 0);
    assert.equal(ctx.treg.calls.filter(c => c.endpoint === VERIFY).length, state === 'verified' ? 0 : 1);
    const count = ctx.treg.calls.length;
    await enrichStage(ctx, { maxCompanies: 1 });
    assert.equal(ctx.treg.calls.length, count);
  });
}
test('overlapping pipeline stages share the company claim and insert only one identity', async () => {
  const { ctx } = await setup();
  await Promise.all([enrichStage(ctx, { maxCompanies: 1 }), enrichStage(ctx, { maxCompanies: 1 })]);
  assert.equal(ctx.store.contacts.length, 1);
  assert.equal(ctx.treg.calls.filter(c => c.endpoint === EMAIL_FIND).length, 1);
});
test('queued-worker claim excludes pipeline and cached queued lookup resumes through pipeline without repurchase', async () => {
  const { ctx, id } = await setup([{}]);
  await ctx.store.claimContactResearch(id, 'queued-worker');
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(ctx.treg.calls.length, 0);
  await ctx.store.releaseContactResearch(id, 'queued-worker');
  const client = createTregClient({ token: 'offline', maxRunUsd: .1, maxCallUsd: .1,
    checkpoint: { get: ctx.store.contactCall.bind(ctx.store), start: ctx.store.startContactCall.bind(ctx.store), finish: ctx.store.finishContactCall.bind(ctx.store) },
    fetchImpl: async () => Response.json({ output: { email: 'alex@example.com' } }, { headers: { 'X-Treg-Cost-Micro': '1000' } }),
  });
  await client.call(id, EMAIL_FIND, { domain: 'example.com', full_name: 'Alex Person' });
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(ctx.treg.calls.filter(c => c.endpoint === EMAIL_FIND).length, 0);
  assert.equal(ctx.store.contacts[0].email_verified, true);
});
test('lost paid response is checkpointed before dispatch and never retried by either worker', async () => {
  const { ctx, id } = await setup([{}]);
  ctx.treg = worldTreg({ emailFind: () => { throw new Error('lost response'); } });
  await enrichStage(ctx, { maxCompanies: 1 });
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(ctx.treg.calls.filter(c => c.endpoint === EMAIL_FIND).length, 1);
  const client = createTregClient({ token: 'offline', maxRunUsd: 1, maxCallUsd: .1,
    checkpoint: { get: ctx.store.contactCall.bind(ctx.store) }, fetchImpl: () => assert.fail('Must not retry') });
  await assert.rejects(client.call(id, EMAIL_FIND, { domain: 'example.com', full_name: 'Alex Person' }), /unresolved/);
});
test('manual edits during verification win the compare-and-set update', async () => {
  const { ctx } = await setup([{ email: 'manual@example.com' }]);
  ctx.treg = worldTreg({ extra: { [VERIFY]: async () => {
    ctx.store.contacts[0].email = 'corrected@example.com';
    ctx.store.contacts[0].contact_sources.manual = 'corrected';
    return { ok: true, status: 200, body: { output: { status: 'valid', valid: true } }, cost_usd: .001, call_id: 'v' };
  } } });
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(ctx.store.contacts[0].email, 'corrected@example.com');
  assert.equal(ctx.store.contacts[0].email_verified, undefined);
  assert.equal(ctx.store.contacts[0].contact_sources.manual, 'corrected');
});
test('budget exhaustion between lookup and verification resumes from durable lookup', async () => {
  const { ctx } = await setup([{}]);
  ctx.spend = makeCtx({ caps: { treg: .02 } }).spend;
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(ctx.treg.calls.filter(c => c.endpoint === VERIFY).length, 0);
  ctx.spend = makeCtx({ caps: { treg: 1 } }).spend;
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(ctx.treg.calls.filter(c => c.endpoint === EMAIL_FIND).length, 1);
  assert.equal(ctx.store.contacts[0].email_verified, true);
});
test('dry-run, free-only, exhausted budget and employer mismatch do not dispatch paid calls', async () => {
  for (const mode of ['dryRun', 'freeOnly', 'budget', 'employer']) {
    const { ctx } = await setup([mode === 'employer' ? { contact_sources: { role_review: { status: 'different_employer' } } } : {}]);
    if (mode === 'budget') ctx.spend = makeCtx({ caps: { treg: 0 } }).spend;
    if (mode === 'employer') ctx.store.setEnrichment(ctx.store.companyRows[0].id, 'done', 'fixture');
    const before = structuredClone(ctx.store.contacts);
    await enrichStage(ctx, { maxCompanies: 1, [mode]: true });
    assert.equal(ctx.treg.calls.filter(c => [EMAIL_FIND, VERIFY].includes(c.endpoint)).length, 0);
    assert.deepEqual(ctx.store.contacts, before);
  }
});
test('queued research completes an existing manual email without buying a lookup', async () => {
  const existing = [{ id: 'manual', name: 'Alex Person', email: 'manual@example.com', contact_sources: { manual: true } }];
  const calls = [];
  await researchCompany({ company: { id: 'company', name: 'Example', domain: 'example.com' }, existing, maxContacts: 3,
    client: { call: async (_, endpoint) => { calls.push(endpoint); return { response: { output: endpoint.endsWith('search') ? { people: [] } : { status: 'valid', valid: true } } }; } },
    save: () => assert.fail('No new identity'), update: async (snapshot, patch) => { assert.equal(snapshot.id, 'manual'); assert.equal(patch.email, 'manual@example.com'); return true; } });
  assert.deepEqual(calls, ['treg.people.search', VERIFY]);
  assert.equal(existing[0].email_verified, true);
});

for (const plan of ['daily', 'all', 'enrich']) {
  test(`${plan} entry point completes a below-threshold existing contact`, async () => {
    const { ctx } = await setup([{ email: 'manual@example.com' }]);
    ctx.store.sources = async () => [];
    const report = await runPipeline(ctx, { plan, limit: 1, dryRun: false, trigger: 'manual' });
    assert.ok(report.jobs.some(job => job.job === 'enrich'));
    assert.equal(ctx.store.contacts[0].email_verified, true);
    assert.equal(ctx.treg.calls.filter(c => c.endpoint === EMAIL_FIND).length, 0);
    assert.equal(ctx.treg.calls.filter(c => c.endpoint === VERIFY).length, 1);
  });
}

for (const state of ['missing', 'unverified', 'verified']) {
  test(`queued worker completes ${state} contact independently of search coverage`, async () => {
    const existing = [{ id: 'original', name: 'Alex Person', email: state === 'missing' ? null : 'manual@example.com',
      email_verified: state === 'verified', contact_sources: { manual: 'retained' } }];
    const calls = [];
    const options = { company: { id: 'company', name: 'Example', domain: 'example.com' }, existing, maxContacts: 3,
      client: { call: async (_, endpoint) => {
        calls.push(endpoint);
        return { response: { output: endpoint.endsWith('search') ? { people: [] } : endpoint.endsWith('find') ? { email: 'alex@example.com' } : { status: 'valid', valid: true } } };
      } }, save: () => assert.fail('Must preserve identity'), update: async (snapshot, patch) => {
        assert.equal(snapshot.id, 'original'); assert.equal(patch.contact_sources.manual, 'retained'); return true;
      } };
    await researchCompany(options);
    assert.equal(existing[0].id, 'original');
    assert.equal(existing[0].email_verified, true);
    assert.equal(calls.filter(endpoint => endpoint === EMAIL_FIND).length, state === 'missing' ? 1 : 0);
    assert.equal(calls.filter(endpoint => endpoint === VERIFY).length, state === 'verified' ? 0 : 1);
    calls.length = 0;
    await researchCompany(options);
    assert.deepEqual(calls, ['treg.people.search']);
  });
}

test('completion recognizes the live Filtrat verified verdict and keeps other ambiguous verdicts risky', async () => {
  for (const [provider, status, valid, expected] of [
    ['filtrat.people.email.verify.resolve_catchall', 'verified', undefined, true],
    ['filtrat.people.email.verify.resolve_catchall', 'verified', false, false],
    ['filtrat.people.email.verify.resolve_catchall', 'catchall', undefined, false],
    ['unknown', 'verified', undefined, false],
  ]) {
    const { ctx } = await setup([{ email: 'manual@example.com' }]);
    ctx.treg = worldTreg({ extra: { [VERIFY]: async () => ({
      ok: true, status: 200, body: { output: { status, valid }, _treg: { served_by: provider } },
      cost_usd: 0, call_id: 'v',
    }) } });
    const result = await enrichStage(ctx, { maxCompanies: 1 });
    assert.deepEqual(result.errors, []);
    assert.equal(ctx.store.contacts[0].email_verified, expected);
    assert.equal(ctx.store.contacts[0].email_status, expected ? 'valid' : 'risky');
  }
});
