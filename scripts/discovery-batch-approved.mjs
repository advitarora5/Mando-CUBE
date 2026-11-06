import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertApprovedTarget } from './discovery-plan.mjs';
import { supervise } from './discovery-supervisor.mjs';
import { runCandidateBatch, batchDeadline } from './discovery-batch.mjs';

// Preparation imports no provider or database clients and performs no writes.
const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ status: 'prepared', max_candidates: 5, max_minutes: 50, max_admissions: 5, paid_services: false, recurring_schedule: false }));
} else {
  let lock;
  const root = resolve('var/discovery'), lockPath = join(root, 'execution.lock');
  try {
    if (args.length !== 1 || args[0] !== '--execute' || process.env.DISCOVERY_BATCH_EXECUTION_ENABLED !== 'true' || process.env.DISCOVERY_BATCH_APPROVED_CANDIDATES !== '5') throw Error('Batch approval missing');
    assertApprovedTarget(process.env);
    const { assertApprovedIdentityMode } = await import('./discovery-local-identity.mjs');
    assertApprovedIdentityMode({ execute: true, approved: true }, process.env);
    mkdirSync(root, { recursive: true });
    lock = openSync(lockPath, 'wx');
    const id = randomUUID(), directory = join(root, 'batches', id);
    writeFileSync(lock, JSON.stringify({ batch_id: id, pid: process.pid, started_at: new Date().toISOString() }));
    mkdirSync(directory, { recursive: true });
    const save = summary => writeFileSync(join(directory, 'batch-summary.json'), JSON.stringify({ ...summary, batch_id: id }, null, 2));
    const result = await runCandidateBatch({ maxCandidates: 5, deadlineMs: batchDeadline(process.env.DISCOVERY_STOP_AT), save,
      run: (i, timeoutMs) => supervise({ command: process.execPath,
        args: ['scripts/discovery.mjs', '--execute-approved', '--approved-ai', '--limit', '5', ...(i ? ['--ai-admission-only'] : [])],
        root: directory, timeoutMs,
        // The last check of each batch goes to the oldest held candidate that is due, so holds are retried without blocking new names.
        env: { DISCOVERY_MAX_NEW: '1', DISCOVERY_MAX_REQUESTS: '60', PIPELINE_SEC_FILE: resolve('sec.json'), DISCOVERY_HELD_FIRST: i === 4 ? 'true' : 'false' } }) });
    console.log(JSON.stringify({ ...result, batch_id: id }, null, 2));
    if (!['completed', 'no_eligible_candidates'].includes(result.status)) process.exitCode = 1;
  } catch {
    console.error('Batch disabled, overlap blocked or execution failed. Inspect saved checkpoints before retrying; completed writes may remain.');
    process.exitCode = 1;
  } finally {
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}
