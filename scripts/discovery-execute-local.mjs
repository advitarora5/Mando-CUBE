import { resolve } from 'node:path';
import { supervise } from './discovery-supervisor.mjs';

try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--local-ai', '--ai-admission-only', '--collect-only'].includes(arg)) || new Set(args).size !== args.length) throw Error('Unknown local execution option');
  const collectOnly = args.includes('--collect-only');
  if (collectOnly && (args.includes('--local-ai') || args.includes('--ai-admission-only'))) throw Error('Choose collection or admission');
  // Fixed bounds for the first local operating configuration; no remote mode.
  const result = await supervise({ command: process.execPath,
    args: ['scripts/discovery.mjs', '--execute-local', '--limit', '2', ...args],
    root: resolve('var/discovery'), timeoutMs: (collectOnly ? 5 : 15) * 60000,
    env: { DISCOVERY_MAX_NEW: '3', DISCOVERY_MAX_REQUESTS: '20', PIPELINE_SEC_FILE: resolve('sec.json') } });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'succeeded') process.exitCode = 1;
} catch {
  console.error('Local discovery could not start. Check the local configuration and lock ownership.');
  process.exitCode = 1;
}
