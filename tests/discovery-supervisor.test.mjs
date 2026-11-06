import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervise } from '../scripts/discovery-supervisor.mjs';

const worker = `const fs=require('fs'),path=require('path');fs.writeFileSync(path.join(process.env.DISCOVERY_OUTPUT,'summary.json'),JSON.stringify({status:'succeeded',jobs:[{status:'succeeded'}]}));`;

test('supervisor records successful run history and releases its lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mando-supervisor-'));
  try {
    const report = await supervise({ command: process.execPath, args: ['-e', worker], root, timeoutMs: 5000 });
    assert.equal(report.status, 'succeeded');
    assert.equal(existsSync(join(root, 'execution.lock')), false);
    assert.equal(JSON.parse(readFileSync(join(root, 'latest.json'))).run_id, report.run_id);
    assert.equal(JSON.parse(readFileSync(join(root, 'runs', report.run_id, 'summary.json'))).status, 'succeeded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('existing lock is never stolen or deleted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mando-supervisor-'));
  try {
    writeFileSync(join(root, 'execution.lock'), 'another owner');
    const report = await supervise({ command: 'must-not-launch', args: [], root, timeoutMs: 100 });
    assert.equal(report.status, 'overlap_blocked');
    assert.equal(readFileSync(join(root, 'execution.lock'), 'utf8'), 'another owner');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deadline terminates the worker, reports incomplete writes and permits a later run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mando-supervisor-'));
  try {
    const report = await supervise({ command: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'], root, timeoutMs: 100 });
    assert.equal(report.status, 'time_limit');
    assert.equal(report.interrupted_writes_may_have_completed, true);
    assert.equal(existsSync(join(root, 'execution.lock')), false);
    const next = await supervise({ command: process.execPath, args: ['-e', worker], root, timeoutMs: 5000 });
    assert.equal(next.status, 'succeeded');
    assert.notEqual(next.run_id, report.run_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a worker crash cannot claim success and raw stderr is not copied into reports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mando-supervisor-'));
  try {
    const report = await supervise({ command: process.execPath, args: ['-e', "console.error('secret-value');process.exit(1)"], root, timeoutMs: 5000 });
    assert.equal(report.status, 'failed');
    assert.ok(!JSON.stringify(report).includes('secret-value'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
