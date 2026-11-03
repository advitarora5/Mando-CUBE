import { mkdirSync, writeFileSync } from 'node:fs';
import { discoveryPlan, assertLocalTarget, assertApprovedTarget, executeDiscovery } from './discovery-plan.mjs';
import { resolve } from 'node:path';
import { discoveryScoreScope } from './discovery-score-scope.mjs';
import { withSourceBudget } from './discovery-source-budget.mjs';
import { summarizeJob } from './discovery-report.mjs';

const output = resolve(process.env.DISCOVERY_OUTPUT || 'var/discovery');
const save = summary => {
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
};

const args = process.argv.slice(2);
try {
  let limit = 10, execute = false, approved = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execute-local') execute = true;
    else if (args[i] === '--execute-approved') { execute = true; approved = true; }
    else if (args[i] === '--limit') limit = Number(args[++i]);
    else throw Error(`Unknown argument: ${args[i]}`);
  }
  const plan = discoveryPlan(limit);
  let summary = { status: 'prepared', ...plan };
  if (execute) {
    if (args.includes('--execute-local') && approved) throw Error('Choose one database mode');
    if (approved) assertApprovedTarget(process.env);
    else assertLocalTarget(process.env.PIPELINE_SUPABASE_URL);
    const { contextFromEnv } = await import('../src/pipeline/context.ts');
    const { runPipeline } = await import('../src/pipeline/runner.ts');
    const ctx = await contextFromEnv({ ...process.env, PIPELINE_ALLOW_REMOTE: approved ? process.env.PIPELINE_ALLOW_REMOTE : '', TREG_BUDGET_USD: '0', PIPELINE_LLM_BUDGET_USD: '0' },
      { dryRun: false, noLlm: true, noTreg: true, maxSpend: 0 });
    const maxNew = Number(process.env.DISCOVERY_MAX_NEW || 3), maxRequests = Number(process.env.DISCOVERY_MAX_REQUESTS || 20);
    if (![maxNew, maxRequests].every(n => Number.isInteger(n) && n >= 1 && n <= 100)) throw Error('Invalid run bounds');
    const settings = ctx.store.settings.bind(ctx.store), sources = ctx.store.sources.bind(ctx.store);
    ctx.store.settings = async () => { const current = await settings(); return { ...current, max_new_companies_per_run: Math.min(current.max_new_companies_per_run, maxNew) }; };
    ctx.store.sources = async () => (await sources()).map(s => ({ ...s,
      max_requests_per_run: Math.min(s.max_requests_per_run, maxRequests),
      config: ['workday-tenant-crawl', 'workday-tenant-wayback'].includes(s.id)
        ? { ...s.config, index_page_size: 1, request_timeout_ms: 8000, index_retries: 1 }
        : s.config }));
    // Discovery scores only companies touched by matching. Periodic full rescoring
    // remains the responsibility of the existing daily/rescore plans.
    const prepareScoreScope = discoveryScoreScope(ctx.store);
    summary = { ...plan, status: 'running', jobs: [] };
    save(summary);
    const result = await executeDiscovery(ctx, async (...options) => {
      prepareScoreScope(options[1].plan);
      const report = options[1].plan === 'collect'
        ? await withSourceBudget(options[0], scoped => runPipeline(scoped, options[1]))
        : await runPipeline(...options);
      summary.jobs.push(...report.jobs.map(summarizeJob));
      save(summary);
      return report;
    }, plan);
    // Persist counts and statuses only; raw errors/provider payloads may contain private data.
    summary = { ...plan, status: result.status, jobs: result.reports.flatMap(r => r.jobs.map(summarizeJob)) };
    if (result.status !== 'succeeded') process.exitCode = 1;
  }
  save(summary);
  console.log(JSON.stringify(summary, null, 2));
} catch {
  save({ status: 'failed', message: 'Preflight or execution failed; no successful run is claimed.' });
  // Do not echo credentials, URLs or provider error bodies in unattended output.
  console.error('Discovery stopped. Check arguments, local database configuration, and required source integration.');
  process.exitCode = 1;
}
