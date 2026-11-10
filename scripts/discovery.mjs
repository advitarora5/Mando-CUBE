import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { discoveryPlan, assertLocalTarget, assertApprovedTarget, executeDiscovery } from './discovery-plan.mjs';
import { resolve } from 'node:path';
import { discoveryScoreScope } from './discovery-score-scope.mjs';
import { sourceBudgetMs, withSourceBudget } from './discovery-source-budget.mjs';
import { discoveryRollup, summarizeJob } from './discovery-report.mjs';

const output = resolve(process.env.DISCOVERY_OUTPUT || 'var/discovery');
const save = summary => {
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
};

const args = process.argv.slice(2);
let failureStage = 'configuration';
try {
  let limit = 10, execute = false, approved = false, localAi = false, approvedAi = false, admissionOnly = false, collectOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execute-local') execute = true;
    else if (args[i] === '--execute-approved') { execute = true; approved = true; }
    else if (args[i] === '--local-ai') localAi = true;
    else if (args[i] === '--approved-ai') approvedAi = true;
    else if (args[i] === '--ai-admission-only') admissionOnly = true;
    else if (args[i] === '--collect-only') collectOnly = true;
    else if (args[i] === '--limit') limit = Number(args[++i]);
    else throw Error(`Unknown argument: ${args[i]}`);
  }
  const plan = discoveryPlan(limit);
  if (localAi && approvedAi) throw Error('Choose one identity execution mode');
  if (collectOnly) {
    if (!execute || approved || localAi || approvedAi || admissionOnly) throw Error('Collection-only requires local execution without admission options');
    plan.steps = plan.steps.slice(0, -2);
  } else if (execute && !approved) {
    localAi = true;
    plan.steps = plan.steps.slice(0, -1);
  }
  if (admissionOnly) {
    if (!(localAi || approvedAi) || !execute || (localAi && approved)) throw Error('Admission-only discovery requires explicit identity execution');
    plan.steps = approvedAi ? [{ plan: 'match' }, { plan: 'score' }] : [{ plan: 'match' }];
  }
  if (localAi && (!execute || approved)) throw Error('AI discovery is local-only');
  const identity = localAi || approvedAi ? await import('./discovery-local-identity.mjs') : null;
  const approvedConfig = approvedAi ? identity.assertApprovedIdentityMode({ execute, approved }, process.env) : null;
  let summary = { status: 'prepared', ...plan };
  if (execute) {
    if (args.includes('--execute-local') && approved) throw Error('Choose one database mode');
    if (approved) assertApprovedTarget(process.env);
    else assertLocalTarget(process.env.PIPELINE_SUPABASE_URL);
    const { contextFromEnv } = await import('../src/pipeline/context.ts');
    const { runPipeline } = await import('../src/pipeline/runner.ts');
    failureStage = 'database_setup';
    const ctx = await contextFromEnv({ ...process.env, PIPELINE_ALLOW_REMOTE: approved ? process.env.PIPELINE_ALLOW_REMOTE : '', TREG_BUDGET_USD: '0', PIPELINE_LLM_BUDGET_USD: '0' },
      { dryRun: false, noLlm: true, noTreg: true, maxSpend: 0 });
    if (approvedAi) {
      failureStage = 'local_model_preflight';
      await identity.prepareLocalDiscoveryIdentity(ctx, output, approvedConfig, true, process.env);
    }
    failureStage = 'run_bounds';
    const maxNew = Number(process.env.DISCOVERY_MAX_NEW || 3), maxRequests = Number(process.env.DISCOVERY_MAX_REQUESTS || 20);
    if (![maxNew, maxRequests].every(n => Number.isInteger(n) && n >= 1 && n <= 100)) throw Error('Invalid run bounds');
    const maxCandidates = Math.min(maxNew, 3);
    const settings = ctx.store.settings.bind(ctx.store), sources = ctx.store.sources.bind(ctx.store);
    ctx.store.settings = async () => { const current = await settings(); return { ...current, max_new_companies_per_run: Math.min(current.max_new_companies_per_run, approvedAi ? 1 : maxNew) }; };
    ctx.store.sources = async () => (await sources()).map(s => ({ ...s,
      max_requests_per_run: Math.min(s.max_requests_per_run, maxRequests),
      config: ['workday-tenant-crawl', 'workday-tenant-wayback'].includes(s.id)
        // One archive attempt per run: preserve the real outage status instead of
        // spending the deadline in nested retries against the same busy service.
        ? { ...s.config, index_page_size: 1, index_candidate_limit: Math.max(30, plan.limit * 6), request_timeout_ms: s.id === 'workday-tenant-wayback' ? 65000 : 30000, index_retries: 0, http_retries: 0, index_fail_fast: true }
        : s.id === 'workday-site-resolver' ? { ...s.config, discovery_only: true, ...(identity || collectOnly ? { corporate_discovery: true } : {}) } : s.config }));
    // Discovery scores only companies touched by matching. Periodic full rescoring
    // remains the responsibility of the existing daily/rescore plans.
    const prepareScoreScope = discoveryScoreScope(ctx.store);
    summary = { ...plan, local_ai: localAi, approved_ai: approvedAi, collect_only: collectOnly, status: 'running', jobs: [] };
    save(summary);
    failureStage = 'source_preflight';
    const result = await executeDiscovery(ctx, async (...options) => {
      failureStage = options[1].plan;
      prepareScoreScope(options[1].plan);
      let report;
      if (identity && options[1].plan === 'match') {
        const config = approvedConfig ?? {
          ...identity.assertLocalIdentityMode({ execute, approved }, process.env),
          maxCandidates, maxChecks: 3 * maxCandidates,
        };
        try {
          options[1].localIdentity = await identity.prepareLocalDiscoveryIdentity(ctx, output, config, false, approvedAi ? process.env : null);
        } catch (error) {
          if (!localAi || !(error instanceof identity.IdentityModelUnavailable)) throw error;
          report = { jobs: [{ job: 'match', source_id: null, status: 'blocked', ms: 0, counts: { admission_deferred: 1 },
            blocked: 'local identity model unavailable' }] };
        }
      }
      report ??= options[1].plan === 'collect'
        ? await withSourceBudget(options[0], scoped => runPipeline(scoped, options[1]), sourceBudgetMs(options[1].source))
        : await runPipeline(...options);
      summary.jobs.push(...report.jobs.map(summarizeJob));
      summary.rollup = discoveryRollup(summary.jobs);
      save(summary);
      return report;
    }, plan);
    // Persist counts and statuses only; raw errors/provider payloads may contain private data.
    const jobs = result.reports.flatMap(r => r.jobs.map(summarizeJob));
    summary = { ...summary, status: result.status, jobs, rollup: discoveryRollup(jobs) };
    if (result.status !== 'succeeded') process.exitCode = 1;
  }
  save(summary);
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  save({ status: 'failed', failure_stage: failureStage, message: 'Preflight or execution failed; no successful run is claimed.' });
  // The cause goes only to a private local file next to summary.json, which is all the workflow uploads.
  appendFileSync(resolve(output, 'worker-error.log'), `${failureStage}: ${error?.stack ?? error}\n`, { mode: 0o600 });
  // Do not echo credentials, URLs or provider error bodies in unattended output.
  console.error('Discovery stopped. Check arguments, local database configuration, and required source integration.');
  process.exitCode = 1;
}
