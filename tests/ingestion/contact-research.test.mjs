import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleForFreeResearch, enrichStage, PEOPLE_SEARCH, EMAIL_FIND } from '../../src/pipeline/enrich.ts';
import { scoreCompany } from '../../src/domain/ingestion/pipeline-score.ts';
import { defaultSettings } from '../../src/domain/ingestion/settings.ts';
import { makeCtx, clock, worldTreg } from './helpers.mjs';

const NOW = new Date('2026-10-13T12:00:00Z');
const signal = extra => ({ type: 'known_customer', signal_date: null, source_url: 'https://employer.example/workday', quote: 'Our company uses Workday HCM.', confidence: 0.95, first_seen_at: NOW.toISOString(), last_seen_at: NOW.toISOString(), ...extra });
async function world({ signals = [signal()], treg = worldTreg(), ready = false } = {}) {
  const ctx = makeCtx({ now: clock(NOW.toISOString()), treg, caps: { treg: 1, llm: 0 } });
  const id = ctx.store.addExistingCompany({ name: 'Research Company', domain: 'research.example' });
  ctx.store.companyRows[0].pipeline = true;
  ctx.store.signalsForCompany = async () => signals;
  if (ready) ctx.store.settingsRows = [{ key: 'ready_for_contacts_threshold', value: 0 }];
  const score = scoreCompany(id, signals, [], defaultSettings, NOW);
  await ctx.store.insertScore(score.result.row, NOW.toISOString());
  return { ctx, id };
}

test('fresh sourced customer/hiring evidence unlocks research; weak, stale, future or missing evidence does not', () => {
  assert.equal(eligibleForFreeResearch([signal()], defaultSettings, NOW), true);
  assert.equal(eligibleForFreeResearch([signal({ type: 'hiring' })], defaultSettings, NOW), true);
  for (const extra of [{ type: 'event' }, { confidence: 0.6 }, { confidence: 2 }, { source_url: 'https://' }, { quote: ' ' }, { last_seen_at: '2020-01-01' }, { last_seen_at: '2027-01-01' }, { last_seen_at: 'invalid' }]) {
    assert.equal(eligibleForFreeResearch([signal(extra)], defaultSettings, NOW), false, JSON.stringify(extra));
  }
});

test('below 25 points, free research finds unconfirmed contacts and rescoring retains source links without paid email', async () => {
  const { ctx, id } = await world();
  const first = await ctx.store.latestScore(id);
  assert.ok(first.budget_score + first.release_score + first.timing_score < 25);
  const result = await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(result.counts.contacts_added, 1);
  assert.equal(ctx.treg.calls.filter(c => c.endpoint === EMAIL_FIND).length, 0, 'even with an available $1 paid cap');
  const contacts = await ctx.store.contactsForCompany(id);
  assert.equal(contacts[0].linkedin_status, 'unconfirmed');
  const latest = await ctx.store.latestScore(id);
  assert.equal(latest.authority_score, 5);
  assert.equal(latest.reachability_score, 0);
  assert.match(latest.authority_evidence, /https:\/\/www.linkedin.com\/in\/pat-lee-test/);
  assert.equal(ctx.store.scores.length, 2);
  const calls = ctx.treg.calls.length;
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(ctx.treg.calls.length, calls, 'contact research is reused on repeat runs');
});

test('paid lookup still requires readiness and budget; raising readiness eligibility later resumes deferred work', async () => {
  const { ctx } = await world();
  await enrichStage(ctx, { maxCompanies: 1 });
  ctx.store.settingsRows = [{ key: 'ready_for_contacts_threshold', value: 0 }];
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(ctx.treg.calls.filter(c => c.endpoint === EMAIL_FIND).length, 1);
});

test('eligible research with no provider stays pending; scope, terminal status and zero-item cap are respected', async () => {
  const { ctx, id } = await world({ treg: null });
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(await ctx.store.enrichmentStatus(id), 'pending');
  assert.equal((await ctx.store.contactsForCompany(id)).length, 0);
  for (const state of ['out_of_scope', 'done', 'no_contacts_found', 'zero_cap']) {
    const { ctx, id } = await world();
    if (state === 'out_of_scope') ctx.store.companyRows[0].pipeline = false;
    else if (state !== 'zero_cap') await ctx.store.setEnrichment(id, state, 'fixture');
    await enrichStage(ctx, { maxCompanies: state === 'zero_cap' ? 0 : 1 });
    assert.equal(ctx.treg.calls.length, 0, state);
  }
});

test('temporary provider errors remain pending and succeed on a later run', async () => {
  const { ctx, id } = await world({ treg: worldTreg({ extra: { [PEOPLE_SEARCH]: () => ({ ok: false, status: 503, cost_usd: 0, error: 'temporary outage' }) } }) });
  const first = await enrichStage(ctx, { maxCompanies: 1 });
  assert.ok(first.errors.length);
  assert.equal(await ctx.store.enrichmentStatus(id), 'pending');
  ctx.treg = worldTreg();
  const second = await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(second.counts.contacts_added, 1);
});

test('auth/rate errors and nonzero-cost free responses stop further calls and save no contacts', async () => {
  for (const response of [{ ok: false, status: 401, cost_usd: 0, error: 'auth' }, { ok: false, status: 429, cost_usd: 0, error: 'rate limit' }, { ok: true, status: 200, cost_usd: 0.01, body: { data: [] }, call_id: 'unexpected' }]) {
    const { ctx, id } = await world({ treg: worldTreg({ extra: { [PEOPLE_SEARCH]: () => response } }) });
    const result = await enrichStage(ctx, { maxCompanies: 2 });
    assert.ok(result.blocked);
    assert.equal((await ctx.store.contactsForCompany(id)).length, 0);
    assert.equal(await ctx.store.enrichmentStatus(id), 'pending');
    assert.equal(ctx.treg.calls.filter(c => c.endpoint === PEOPLE_SEARCH).length, 1);
  }
});

test('free calls request zero cost and no paid fallback; zero budget still permits research but not email', async () => {
  const { ctx } = await world({ ready: true });
  ctx.spend = makeCtx({ caps: { treg: 0, llm: 0 } }).spend;
  const result = await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(result.counts.contacts_added, 1);
  const call = ctx.treg.calls.find(c => c.endpoint === PEOPLE_SEARCH);
  assert.equal(call.opts.headers['X-Treg-Route-Max-Cost'], '0');
  assert.equal(call.opts.headers['X-Treg-Route-Waterfall'], '0');
  assert.equal(ctx.treg.calls.filter(c => c.endpoint === EMAIL_FIND).length, 0);
});
