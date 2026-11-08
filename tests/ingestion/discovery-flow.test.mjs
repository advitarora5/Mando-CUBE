import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryPlan, executeDiscovery } from '../../scripts/discovery-plan.mjs';
import { discoveryScoreScope } from '../../scripts/discovery-score-scope.mjs';
import { runPipeline } from '../../src/pipeline/runner.ts';
import { makeCtx, worldFetch, worldTenant, WORLD_NAMES, response, worldTreg } from './helpers.mjs';

test('a recovered admission is enriched, while an attachment to an existing company is only scored', async () => {
  const store = {
    companies: async () => ['new', 'existing', 'unrelated'].map(id => ({ id })),
    assignSignals: async () => {},
    createPipelineCompany: async () => 'new',
    admitReview: async (_id, _domain, _source, existing) => existing ?? 'new',
  };
  const scope = discoveryScoreScope(store);
  await store.admitReview('a', 'new.example', 'https://new.example/', null, null);
  await store.admitReview('b', 'existing.example', 'https://existing.example/', 'existing', null);
  scope('enrich');
  assert.deepEqual(await store.companies(), [{ id: 'new' }]);
  scope('score');
  assert.deepEqual(await store.companies(), [{ id: 'new' }, { id: 'existing' }]);
});

test('discovery admits, scores and researches only new companies, then repeats without duplicates', async () => {
  const http = worldFetch();
  const fetch = async (url, init) => {
    const got = await http(url, init);
    if (String(url).includes('/job/') && got.ok) {
      const body = await got.json();
      const tenant = new URL(url).hostname.split('.')[0];
      body.hiringOrganization = { name: WORLD_NAMES.find(n => worldTenant(n) === tenant), url: `https://${tenant}.example/` };
      return response(200, body);
    }
    return got;
  };
  const ctx = makeCtx({ fetch, caps: { treg: 1, llm: 0 } });
  ctx.store.settingsRows.push({ key: 'ready_for_contacts_threshold', value: 0 });
  const treg = worldTreg();
  const unrelated = await ctx.store.createPipelineCompany({ name: 'Untouched Existing Systems', domain: 'untouched.example', employee_count: null, source: 'https://untouched.example/' }, null, { signal_ids: [], normalized_name: null });
  const prepareStage = discoveryScoreScope(ctx.store);
  const run = (context, options) => {
    prepareStage(options.plan);
    context.treg = options.plan === 'enrich' ? treg : null;
    return runPipeline(context, options);
  };
  const plan = discoveryPlan(20);
  const first = await executeDiscovery(ctx, run, plan);
  assert.equal(first.status, 'succeeded');
  assert.equal(ctx.store.companyRows.length, 13);
  assert.equal(ctx.store.scores.length, 24);
  assert.equal(await ctx.store.latestScore(unrelated), null, 'discovery must not rescore untouched existing pipeline companies');
  assert.equal(ctx.store.contacts.length, 12);
  assert.equal(ctx.spend.spent('treg'), 0);
  const snapshot = () => [ctx.store.companyRows.length, ctx.store.scores.length, ctx.store.contacts.length, ctx.store.captures.length, ctx.store.signals.length];
  const before = snapshot();
  const second = await executeDiscovery(ctx, run, plan);
  assert.equal(second.status, 'succeeded');
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(ctx.store.duplicateCompanies(), []);
  assert.equal(first.reports.at(-1).jobs[0].counts.companies_researched, 12);
  assert.equal(treg.calls.filter(c => c.endpoint === 'treg.people.email.find').length, 0);
});
