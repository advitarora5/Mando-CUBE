import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryPlan, executeDiscovery } from '../../scripts/discovery-plan.mjs';
import { discoveryScoreScope } from '../../scripts/discovery-score-scope.mjs';
import { runPipeline } from '../../src/pipeline/runner.ts';
import { makeCtx, worldFetch, worldTenant, WORLD_NAMES, response } from './helpers.mjs';

test('discovery command admits and scores from posting website proof on its first run, then repeats without duplicates', async () => {
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
  // No model, Treg or live network. Sources use captured/synthetic fixture responses.
  const ctx = makeCtx({ fetch, caps: { treg: 0, llm: 0 } });
  const unrelated = await ctx.store.createPipelineCompany({ name: 'Untouched Existing Systems', domain: 'untouched.example', employee_count: null, source: 'https://untouched.example/' }, null, { signal_ids: [], normalized_name: null });
  const prepareStage = discoveryScoreScope(ctx.store);
  const run = (context, options) => { prepareStage(options.plan); return runPipeline(context, options); };
  const plan = discoveryPlan(20);
  const first = await executeDiscovery(ctx, run, plan);
  assert.equal(first.status, 'succeeded');
  assert.equal(ctx.store.companyRows.length, 13);
  assert.equal(ctx.store.scores.length, 12);
  assert.equal(await ctx.store.latestScore(unrelated), null, 'discovery must not rescore untouched existing pipeline companies');
  assert.equal(ctx.store.contacts.length, 0);
  assert.equal(ctx.spend.spent('treg'), 0);
  const snapshot = () => [ctx.store.companyRows.length, ctx.store.scores.length, ctx.store.captures.length, ctx.store.signals.length];
  const before = snapshot();
  const second = await executeDiscovery(ctx, run, plan);
  assert.equal(second.status, 'succeeded');
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(ctx.store.duplicateCompanies(), []);
  assert.ok(first.reports.flatMap(r => r.jobs).every(j => j.job !== 'enrich'));
});
