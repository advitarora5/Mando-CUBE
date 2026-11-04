import { resolve } from 'node:path';
import { assertApprovedTarget } from './discovery-plan.mjs';
import { supervise } from './discovery-supervisor.mjs';

try {
  assertApprovedTarget(process.env);
  const args = process.argv.slice(2);
  if (args.some(arg => !['--approved-ai', '--ai-admission-only'].includes(arg)) || new Set(args).size !== args.length) throw Error('Unknown approved execution option');
  const ai = args.includes('--approved-ai');
  if (args.includes('--ai-admission-only') && !ai) throw Error('Admission-only requires approved AI');
  if (ai) {
    const { assertApprovedIdentityMode } = await import('./discovery-local-identity.mjs');
    assertApprovedIdentityMode({ execute: true, approved: true }, process.env);
  }
  const result = await supervise({ command: process.execPath,
    args: ['scripts/discovery.mjs', '--execute-approved', '--limit', '2', ...args],
    root: resolve('var/discovery'), timeoutMs: (ai ? 10 : 5) * 60000,
    env: { DISCOVERY_MAX_NEW: ai ? '1' : '3', DISCOVERY_MAX_REQUESTS: '20', PIPELINE_SEC_FILE: resolve('sec.json') } });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'succeeded') process.exitCode = 1;
} catch {
  console.error('Discovery execution is disabled or the approved target configuration is incomplete.');
  process.exitCode = 1;
}
