// Exercise the real CLI in child processes. Only its context factory is replaced:
// stages, reporting and exit handling run unchanged against the offline fixture world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const contextUrl = new URL('src/pipeline/context.ts', root).href;
const helpersUrl = new URL('tests/ingestion/helpers.mjs', root).href;
const contextSource = `
  import { makeCtx, worldFetch, worldTreg, groundedModel } from ${JSON.stringify(helpersUrl)};
  export async function contextFromEnv() {
    const scenario = process.env.PIPELINE_CLI_SCENARIO;
    globalThis.fetch = async () => { throw new Error('Unexpected live network request'); };
    const ctx = makeCtx({
      fetch: worldFetch({ jobsDown: scenario === 'blocked' }),
      llm: groundedModel(),
      treg: scenario === 'review' ? null : worldTreg(),
      caps: scenario === 'budget' ? { treg: 0, llm: 0 } : undefined,
    });
    if (scenario === 'budget') ctx.store.settingsRows = [{ key: 'ready_for_contacts_threshold', value: 0 }];
    // No usable website evidence in this scenario. Disabling Treg alone no longer
    // prevents confirmation directly from a saved employer link.
    if (scenario === 'review') ctx.store.websiteEvidenceCaptures = async () => [];
    if (scenario === 'failed') ctx.store.pendingCaptures = async () => { throw new Error('injected extraction failure'); };
    if (scenario === 'partial') {
      const save = ctx.store.saveCapture.bind(ctx.store);
      let injected = false;
      ctx.store.saveCapture = async (...args) => {
        if (!injected && args[0].source === 'workday-site-resolver') {
          injected = true;
          throw new Error('injected capture write failure');
        }
        return save(...args);
      };
    }
    return ctx;
  }
`;
const hook = `
  import { registerHooks } from 'node:module';
  registerHooks({ load(url, context, nextLoad) {
    if (url === ${JSON.stringify(contextUrl)}) return { format: 'module', source: ${JSON.stringify(contextSource)}, shortCircuit: true };
    return nextLoad(url, context);
  }});
`;

function runCli(scenario, plan = 'all') {
  const child = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(hook)}`,
    'scripts/pipeline.mjs', 'run', '--plan', plan,
  ], {
    cwd: fileURLToPath(root), encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, PIPELINE_CLI_SCENARIO: scenario },
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr);
  return { ...child, report: JSON.parse(child.stdout) };
}

test('CLI: a complete fixture run exits zero and reports newly admitted companies', () => {
  const { status, report } = runCli('success');
  assert.equal(status, 0);
  assert.equal(report.status, 'succeeded');
  assert.ok(report.jobs.some(j => j.counts.new_companies > 0));
  assert.ok(report.jobs.every(j => j.status === 'succeeded'));
});

test('CLI: clean empty collection exits zero', () => {
  const { status, report } = runCli('empty', 'daily');
  assert.equal(status, 0);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.jobs.find(j => j.source === 'workday-career-sites').counts.items, 0);
});

test('CLI: a blocked source exits one, retains its reason, and lets later stages finish', () => {
  const { status, report, stderr } = runCli('blocked');
  assert.equal(status, 1);
  assert.equal(report.status, 'failed');
  const job = report.jobs.find(j => j.source === 'workday-career-sites');
  assert.equal(job.status, 'blocked');
  assert.ok(job.blocked);
  assert.ok(job.errors.length);
  assert.equal(report.jobs.at(-1).job, 'enrich');
  assert.match(stderr, /workday-career-sites.*blocked/);
});

test('CLI: an extraction crash exits one without suppressing the stage report', () => {
  const { status, report } = runCli('failed');
  assert.equal(status, 1);
  assert.equal(report.status, 'failed');
  const job = report.jobs.find(j => j.job === 'extract');
  assert.equal(job.status, 'failed');
  assert.match(job.errors.join(' '), /injected extraction failure/);
  assert.ok(report.jobs.some(j => j.job === 'score'));
});

test('CLI: partial collection exits one even when other captures succeed', () => {
  const { status, report } = runCli('partial', 'weekly');
  assert.equal(status, 1);
  const job = report.jobs.find(j => j.source === 'workday-site-resolver');
  assert.equal(job.status, 'partial');
  assert.ok(job.counts.new_captures > 0);
  assert.match(job.errors.join(' '), /injected capture write failure/);
});

test('CLI: candidates awaiting website review are a successful outcome', () => {
  const { status, report } = runCli('review');
  assert.equal(status, 0);
  assert.ok(report.jobs.some(j => j.counts.review_no_website > 0));
});

test('CLI: ordinary contact budget skips do not fail the run', () => {
  const { status, report } = runCli('budget');
  assert.equal(status, 0);
  assert.equal(report.status, 'succeeded');
  assert.ok(report.jobs.find(j => j.job === 'enrich').counts.budget_skipped > 0);
});
