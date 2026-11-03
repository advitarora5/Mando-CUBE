import { mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// Local process lock, not a distributed database lease. Never steal an existing lock.
export async function supervise({ command, args, root, timeoutMs, env = {} }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw Error('Invalid execution deadline');
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, 'execution.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') return { status: 'overlap_blocked' }; throw error; }
  const id = randomUUID(), directory = join(root, 'runs', id);
  let timer, child;
  let stopReason;
  const interrupt = () => { stopReason = 'interrupted'; child?.kill('SIGKILL'); };
  try {
    writeFileSync(lock, JSON.stringify({ id, pid: process.pid, started_at: new Date().toISOString() }));
    mkdirSync(directory, { recursive: true });
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    child = spawn(command, args, { env: { ...process.env, ...env, DISCOVERY_OUTPUT: directory }, stdio: 'ignore', windowsHide: true });
    timer = setTimeout(() => { stopReason = 'time_limit'; child.kill('SIGKILL'); }, timeoutMs);
    const exit = await new Promise(resolve => {
      child.once('error', () => resolve(null));
      child.once('close', code => resolve(code));
    });
    let summary;
    try { summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8')); }
    catch { summary = { status: 'failed', jobs: [] }; }
    if (stopReason) summary.status = stopReason;
    else if (exit !== 0 && summary.status !== 'needs_attention') summary.status = 'failed';
    else if (exit === 0 && summary.status !== 'succeeded') summary.status = 'failed';
    const result = { ...summary, run_id: id, exit_code: exit,
      interrupted_writes_may_have_completed: Boolean(stopReason) };
    writeFileSync(join(directory, 'summary.json'), JSON.stringify(result, null, 2));
    writeFileSync(join(root, 'latest.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    closeSync(lock); unlinkSync(lockPath);
  }
}
