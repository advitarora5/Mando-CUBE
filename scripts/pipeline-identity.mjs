// Shadow ownership evaluation only. Database access is read-only and restricted to local Supabase.
// prepare --input targets.json --output packets.json [--refresh-jobs]
// run --input packets.json --output results.json [--model llama3.1:8b] [--limit 25]
// evaluate --input results.json --labels labels.json
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { contextFromEnv } from '../src/pipeline/context.ts';
import { WebsiteHttp } from '../src/pipeline/website.ts';
import { OllamaProvider } from '../src/pipeline/llm.ts';
import { identityTargetSchema, prepareIdentityCase } from '../src/pipeline/identity-evidence.ts';
import { IDENTITY_MODEL_OPTIONS, identityCaseSchema, identityLabelSchema, verifyIdentity, reusableIdentity, evaluateIdentity } from '../src/pipeline/identity.ts';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
function save(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--input', '--output', '--labels', '--model', '--limit', '--refresh-jobs'].includes(key) || key in out) throw Error(`unknown or repeated flag ${key}`);
    if (key === '--refresh-jobs') out[key] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(`missing value for ${key}`); out[key] = argv[++i]; }
  }
  return out;
}
try {
  const [command, ...argv] = process.argv.slice(2), args = flags(argv);
  if (!['prepare', 'run', 'evaluate'].includes(command)) throw Error('usage: pipeline:identity prepare|run|evaluate --input file [--output file] [--labels file]');
  if (!args['--input'] || (command !== 'evaluate' && !args['--output'])) throw Error('--input and --output are required for prepare/run');
  if (args['--output'] === args['--input']) throw Error('input and output must be different files');
  const limit = Number(args['--limit'] ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('--limit must be an integer from 1 to 100');
  if (command === 'prepare') {
    const targets = z.array(identityTargetSchema).parse(read(args['--input']));
    if (new Set(targets.map(x => x.id)).size !== targets.length) throw Error('duplicate target IDs');
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(process.env.PIPELINE_SUPABASE_URL ?? '')) throw Error('prepare requires local Supabase');
    const ctx = await contextFromEnv(process.env, { dryRun: false, noLlm: true, noTreg: true, maxSpend: 0 });
    const packets = [], http = new WebsiteHttp(ctx, 500);
    for (const target of targets.slice(0, limit)) {
      const packet = await prepareIdentityCase(ctx, target, http, { refreshJobs: !!args['--refresh-jobs'] });
      packets.push(packet); save(args['--output'], packets);
      console.log(JSON.stringify({ case_id: packet.id, sources: packet.sources.length, errors: packet.errors }));
    }
  } else if (command === 'run') {
    const packets = z.array(identityCaseSchema).parse(read(args['--input']));
    if (new Set(packets.map(x => x.id)).size !== packets.length) throw Error('duplicate case IDs');
    // Local means local: never silently route a zero-spend run to a hosted model endpoint.
    const host = process.env.IDENTITY_OLLAMA_HOST ?? 'http://127.0.0.1:11434';
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(host)) throw Error('identity run requires a local Ollama endpoint');
    const model = args['--model'] ?? process.env.IDENTITY_OLLAMA_MODEL ?? 'llama3.1:8b';
    const response = await fetch(`${host.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error(`Ollama models HTTP ${response.status}`);
    const tag = (await response.json()).models?.find(m => m.name === model);
    if (!tag?.digest) throw Error(`model ${model} is not installed in Ollama`);
    const llm = new OllamaProvider({ host, model, timeoutMs: 120000, ...IDENTITY_MODEL_OPTIONS });
    const old = existsSync(args['--output']) ? read(args['--output']) : { results: [] };
    if (!Array.isArray(old.results)) throw Error('invalid existing shadow results');
    const selected = packets.slice(0, limit);
    const results = old.results.filter(r => packets.some(p => p.id === r.case_id && reusableIdentity(r, p, model, tag.digest)));
    for (const packet of selected) {
      const cached = old.results.find(r => r.case_id === packet.id && reusableIdentity(r, packet, model, tag.digest));
      const result = cached ?? await verifyIdentity(packet, llm, tag.digest);
      const previous = results.findIndex(r => r.case_id === packet.id);
      if (previous >= 0) results[previous] = result; else results.push(result);
      save(args['--output'], { mode: 'shadow', model, model_revision: tag.digest, results });
      console.log(JSON.stringify({ case_id: packet.id, status: result.status, verdict: result.verdict, ms: cached ? 0 : result.ms, cached: !!cached, error: result.error }));
      if (result.status === 'model_error') { process.exitCode = 1; break; }
    }
    if (results.some(r => r.status === 'invalid_output' || r.status === 'model_error')) process.exitCode = 1;
  } else {
    if (!args['--labels']) throw Error('evaluate requires --labels with independently reviewed answers');
    const labels = z.array(identityLabelSchema).parse(read(args['--labels']));
    const summary = evaluateIdentity(read(args['--input']).results, labels);
    console.log(JSON.stringify(summary, null, 2));
    if (args['--output']) save(args['--output'], summary);
  }
} catch (error) { console.error(`identity: ${error.message}`); process.exitCode = 1; }
