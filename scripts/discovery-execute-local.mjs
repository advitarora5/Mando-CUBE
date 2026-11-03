import { resolve } from 'node:path';
import { supervise } from './discovery-supervisor.mjs';

try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--local-ai') || args.length > 1) throw Error('Unknown local execution option');
  const localAi = args.includes('--local-ai');
  // Fixed bounds for the first local operating configuration; no remote mode.
  const result = await supervise({ command: process.execPath,
    args: ['scripts/discovery.mjs', '--execute-local', '--limit', '2', ...(localAi ? ['--local-ai'] : [])],
    root: resolve('var/discovery'), timeoutMs: (localAi ? 10 : 5) * 60000,
    env: { DISCOVERY_MAX_NEW: localAi ? '1' : '3', DISCOVERY_MAX_REQUESTS: '20', PIPELINE_SEC_FILE: resolve('sec.json') } });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'succeeded') process.exitCode = 1;
} catch {
  console.error('Local discovery could not start. Check the local configuration and lock ownership.');
  process.exitCode = 1;
}
