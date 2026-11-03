import { resolve } from 'node:path';
import { assertApprovedTarget } from './discovery-plan.mjs';
import { supervise } from './discovery-supervisor.mjs';

try {
  assertApprovedTarget(process.env);
  const result = await supervise({ command: process.execPath,
    args: ['scripts/discovery.mjs', '--execute-approved', '--limit', '2'],
    root: resolve('var/discovery'), timeoutMs: 5 * 60000,
    env: { DISCOVERY_MAX_NEW: '3', DISCOVERY_MAX_REQUESTS: '20', PIPELINE_SEC_FILE: resolve('sec.json') } });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'succeeded') process.exitCode = 1;
} catch {
  console.error('Discovery execution is disabled or the approved target configuration is incomplete.');
  process.exitCode = 1;
}
