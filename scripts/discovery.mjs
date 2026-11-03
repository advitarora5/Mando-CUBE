import { mkdirSync, writeFileSync } from 'node:fs';
import { discoveryPlan, assertLocalTarget, executeDiscovery } from './discovery-plan.mjs';

const args = process.argv.slice(2);
try {
  let limit = 10, execute = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execute-local') execute = true;
    else if (args[i] === '--limit') limit = Number(args[++i]);
    else throw Error(`Unknown argument: ${args[i]}`);
  }
  const plan = discoveryPlan(limit);
  let summary = { status: 'prepared', ...plan };
  if (execute) {
    assertLocalTarget(process.env.PIPELINE_SUPABASE_URL);
    const { contextFromEnv } = await import('../src/pipeline/context.ts');
    const { runPipeline } = await import('../src/pipeline/runner.ts');
    const ctx = await contextFromEnv({ ...process.env, PIPELINE_ALLOW_REMOTE: '', TREG_BUDGET_USD: '0', PIPELINE_LLM_BUDGET_USD: '0' },
      { dryRun: false, noLlm: true, noTreg: true, maxSpend: 0 });
    const result = await executeDiscovery(ctx, runPipeline, plan);
    // Persist counts and statuses only; raw errors/provider payloads may contain private data.
    summary = { ...plan, status: result.status, jobs: result.reports.flatMap(r => r.jobs.map(j =>
      ({ job: j.job, source: j.source_id, status: j.status, ms: j.ms, counts: j.counts }))) };
    if (result.status !== 'succeeded') process.exitCode = 1;
  }
  mkdirSync('var/discovery', { recursive: true });
  writeFileSync('var/discovery/summary.json', JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} catch {
  mkdirSync('var/discovery', { recursive: true });
  writeFileSync('var/discovery/summary.json', JSON.stringify({ status: 'failed', message: 'Preflight or execution failed; no successful run is claimed.' }, null, 2) + '\n');
  // Do not echo credentials, URLs or provider error bodies in unattended output.
  console.error('Discovery stopped. Check arguments, local database configuration, and required source integration.');
  process.exitCode = 1;
}
