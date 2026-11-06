import test from 'node:test';
import assert from 'node:assert/strict';
import { withSourceBudget } from '../../scripts/discovery-source-budget.mjs';
import { runPipeline } from '../../src/pipeline/runner.ts';
import { makeCtx, response, secFixture } from './helpers.mjs';

test('a stalled source is aborted and a later independent source still completes', async () => {
  let aborted = false;
  const ctx = makeCtx({ fetch: async (url, options) => {
    if (String(url).includes('commoncrawl')) return new Promise((_, reject) => {
      const stop = () => { aborted = true; reject(new DOMException('deadline', 'AbortError')); };
      if (options.signal.aborted) stop(); else options.signal.addEventListener('abort', stop, { once: true });
    });
    if (String(url).endsWith('robots.txt')) return response(200, 'User-agent: *\nAllow: /');
    return response(200, secFixture());
  } });
  const collect = source => scoped => runPipeline(scoped, { plan: 'collect', source, limit: 2, dryRun: false, trigger: 'manual' });
  const slow = await withSourceBudget(ctx, collect('workday-tenant-crawl'), 30);
  assert.equal(aborted, true);
  assert.equal(slow.jobs[0].status, 'blocked');
  const next = await withSourceBudget(ctx, collect('sec-company-list'), 3000);
  assert.equal(next.jobs[0].status, 'succeeded');
  assert.equal(next.jobs[0].counts.items, 1);
  assert.ok(ctx.collected['sec-company-list'], 'source capture references survive the scoped context');
});

test('deadline interrupts a long backoff rather than consuming the whole run', async () => {
  const ctx = makeCtx();
  let deadlineReached;
  await withSourceBudget(ctx, async scoped => {
    await scoped.sleep(60000);
    deadlineReached = scoped.signal.aborted;
  }, 20);
  assert.equal(deadlineReached, true);
});

test('a source deadline preserves items collected before the stalled request', async () => {
  const ctx = makeCtx({ fetch: async (url, options) => {
    if (String(url).includes('web.archive.org')) return response(200,
      'https://firsttenant.wd5.myworkdayjobs.com/robots.txt\nhttps://slowtenant.wd5.myworkdayjobs.com/robots.txt');
    if (String(url).includes('firsttenant')) return response(200,
      'Sitemap: https://firsttenant.wd5.myworkdayjobs.com/Careers/siteMap.xml');
    return new Promise((_, reject) => {
      const stop = () => reject(new DOMException('deadline', 'AbortError'));
      if (options.signal.aborted) stop(); else options.signal.addEventListener('abort', stop, { once: true });
    });
  } });
  // Advance the pacing clock so this fixture tests cancellation rather than real waits.
  let tick = Date.now();
  ctx.now = () => new Date(tick += 2000);
  const source = ctx.store.sourceRows.find(s => s.id === 'workday-tenant-wayback');
  source.config = { pods: ['wd5'] };
  const report = await withSourceBudget(ctx, scoped => runPipeline(scoped,
    { plan: 'collect', source: source.id, limit: 2, dryRun: false, trigger: 'manual' }), 100);
  assert.equal(report.jobs[0].status, 'blocked');
  assert.equal(report.jobs[0].counts.items, 1);
  assert.equal(ctx.store.captures.filter(c => c.meta.kind === 'workday_robots').length, 1);
  assert.ok(ctx.store.captures.every(c => c.source_id === source.id));
});
