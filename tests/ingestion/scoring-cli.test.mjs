import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const contextUrl = new URL('src/pipeline/context.ts', root).href;
const helpersUrl = new URL('tests/ingestion/helpers.mjs', root).href;
const source = `
  import { makeCtx } from ${JSON.stringify(helpersUrl)};
  const ctx = makeCtx(); ctx.contact = '';
  if (process.env.SCORING_CLI_SCENARIO !== 'empty') ctx.store.addExistingCompany({ name: 'Fictional CLI issuer', domain: 'cli.example' });
  if (process.env.SCORING_CLI_SCENARIO === 'failure') ctx.store.failAfter.finishScoring = 0;
  export function databaseFromEnv() { return ctx.store; }
  export async function contextFromEnv() { return ctx; }
`;
const hook = `import { registerHooks } from 'node:module'; registerHooks({ load(url, context, next) {
  if (url === ${JSON.stringify(contextUrl)}) return { format: 'module', source: ${JSON.stringify(source)}, shortCircuit: true };
  return next(url, context);
} });`;
const args = (...argv) => ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, 'scripts/pipeline.mjs', 'scoring', ...argv];
const opts = scenario => ({ cwd: fileURLToPath(root), env: { PATH: process.env.PATH, SCORING_CLI_SCENARIO: scenario }, encoding: 'utf8', timeout: 10000 });

test('scoring CLI one-shot drains queued work and reports completion without research providers', () => {
  const run = spawnSync(process.execPath, args('work', '--limit', '2'), opts('success'));
  assert.ifError(run.error); assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).completed, 1);
});
test('scoring CLI reports an empty queue and returns failure when work needs retry', () => {
  const empty = spawnSync(process.execPath, args('work'), opts('empty'));
  assert.equal(empty.status, 0, empty.stderr); assert.equal(JSON.parse(empty.stdout).attempted, 0);
  const failed = spawnSync(process.execPath, args('work'), opts('failure'));
  assert.equal(failed.status, 1, failed.stderr); assert.equal(JSON.parse(failed.stdout).retry, 1);
});
test('scoring CLI status exposes counts without claim identifiers', () => {
  const run = spawnSync(process.execPath, args('status'), opts('success'));
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { pending: 1, running: 0, retry: 0, done: 0 });
});
test('watching scoring worker exits cleanly on Ctrl+C after processing its current company', async () => {
  const child = spawn(process.execPath, args('work', '--watch', '--poll-seconds', '1'), opts('success'));
  let stdout = '', stderr = '', signaled = false;
  child.stdout.on('data', data => { stdout += data; if (!signaled && stdout.includes('"completed": 1')) { signaled = true; child.kill('SIGINT'); } });
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
  assert.equal(signaled, true, stderr); assert.equal(code.signal, null, stderr); assert.equal(code.code, 0, stderr);
});
