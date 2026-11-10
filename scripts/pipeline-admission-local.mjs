// Explicit local experiment: discovery -> signal collection -> AI admission.
// No score, enrich, paid provider, schedule or production mode exists here.
// npm run pipeline:admission:local -- --input candidates.json --output var/admission-run [--collect-only|--admission-only]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { contextFromEnv } from '../src/pipeline/context.ts';
import { normalizeName } from '../src/domain/ingestion/normalize.ts';
import { runPipeline } from '../src/pipeline/runner.ts';
import { matchStage } from '../src/pipeline/stages.ts';
import { assertLocalAdmissionUrl, localIdentityAdmission } from '../src/pipeline/local-identity-admission.ts';
import { identityCaseSchema } from '../src/pipeline/identity.ts';

const flags = {};
try {
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (!['--input', '--output', '--collect-only', '--admission-only', '--max-checks', '--packets', '--reuse-results'].includes(key) || key in flags) throw Error(`Unknown or repeated argument ${key}`);
    if (key === '--admission-only' || key === '--collect-only') flags[key] = true;
    else { const value = process.argv[++i]; if (!value || value.startsWith('--')) throw Error(`Missing value for ${key}`); flags[key] = value; }
  }
  if (!flags['--input'] || !flags['--output']) throw Error('--input and --output are required');
  const collectOnly = flags['--collect-only'];
  if (collectOnly && (flags['--admission-only'] || flags['--max-checks'] || flags['--packets'] || flags['--reuse-results'])) {
    throw Error('--collect-only cannot use admission options');
  }
  assertLocalAdmissionUrl(process.env.PIPELINE_SUPABASE_URL ?? '');
  if (process.env.PIPELINE_ALLOW_REMOTE) throw Error('Unset PIPELINE_ALLOW_REMOTE for the local admission experiment');
  const root = path.resolve('var'), output = path.resolve(flags['--output']);
  if (!output.startsWith(root + path.sep) || fs.existsSync(output)) throw Error('--output must be a new directory under var/');
  const raw = fs.readFileSync(flags['--input']);
  const input = JSON.parse(raw);
  const candidates = z.array(z.object({ name: z.string().min(1).max(200), corporate_urls: z.array(z.url()).max(3).optional() }).strict()).min(1).max(25)
    .parse(Array.isArray(input) ? input : Object.values(input).map(row => ({ name: row.title })));
  const allowed = new Set(candidates.map(c => normalizeName(c.name)));
  if (allowed.size !== candidates.length || allowed.has('')) throw Error('Candidate names must be distinct after normalization');
  const maxChecks = Number(flags['--max-checks'] ?? 50);
  if (!Number.isInteger(maxChecks) || maxChecks < 1 || maxChecks > 100) throw Error('--max-checks must be 1–100');
  if (flags['--packets'] && !flags['--admission-only']) throw Error('--packets requires --admission-only so discovery cannot change the comparison batch');
  const frozenPackets = flags['--packets'] ? z.array(identityCaseSchema).max(100).parse(JSON.parse(fs.readFileSync(flags['--packets'], 'utf8'))) : undefined;
  if (frozenPackets && new Set(frozenPackets.map(p => p.id)).size !== frozenPackets.length) throw Error('Duplicate frozen packet IDs');
  if (flags['--reuse-results'] && !frozenPackets) throw Error('--reuse-results requires --packets');
  const cachedResults = flags['--reuse-results'] ? JSON.parse(fs.readFileSync(flags['--reuse-results'], 'utf8')).results : undefined;
  if (cachedResults && !Array.isArray(cachedResults)) throw Error('Invalid cached identity results');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const save = (name, value) => {
    const dest = path.join(output, name + '.json');
    fs.writeFileSync(dest + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(dest + '.tmp', dest);
  };
  save('selected-candidates', candidates);
  if (frozenPackets) save('frozen-input-packets', frozenPackets);
  const state = { started_at: new Date().toISOString(), mode: collectOnly ? 'local_collection' : 'local_ai_admission',
    input_sha256: createHash('sha256').update(raw).digest('hex'), selected: candidates, max_checks: maxChecks,
    scoring: false, contact_research: false, paid_services: false, direct_link_required: false,
    signal_confidence_gate: false, accuracy: 'not measured; independent reference labels required', stages: [] };
  save('summary', state);
  const ctx = await contextFromEnv(process.env, { dryRun: false, noLlm: true, noTreg: true, maxSpend: 0 });
  const original = ctx.store, captured = new Set();
  const baseline = { companies: await original.companies(), reviews: await original.reviewItems(), sites: await original.workdaySites(false) };
  save('baseline', baseline);
  // This wrapper only scopes the local run. Source settings are never changed in the DB.
  ctx.store = new Proxy(original, {
    get(target, key) {
      if (key === 'sources') return async () => (await target.sources()).map(source => source.id === 'workday-site-resolver'
        ? { ...source, config: { ...source.config, corporate_discovery: true, names_per_site: 1,
          corporate_websites: { ...source.config.corporate_websites, ...Object.fromEntries(candidates.filter(c => c.corporate_urls).map(c => [normalizeName(c.name), c.corporate_urls])) } } } : source);
      if (key === 'workdaySites') return async enabled => (await target.workdaySites(enabled)).filter(s => allowed.has(s.normalized_name));
      if (key === 'resolverAttempts') return async names => {
        const tried = await target.resolverAttempts(names);
        // Existing attempts for selected names may be retried in this explicit experiment.
        return new Set(names.filter(n => !allowed.has(n) || tried.has(n) && baseline.sites.some(s => s.enabled && s.normalized_name === n)));
      };
      if (key === 'dueResolverAttempts') return async () => [];
      if (key === 'saveCapture') return async (...args) => { const saved = await target.saveCapture(...args); captured.add(saved.id); return saved; };
      if (key === 'pendingCaptures') return async limit => {
        if (!captured.size) return [];
        const { data, error } = await target.db.from('pending_captures').select('*').in('id', [...captured]).order('fetched_at').limit(limit);
        if (error) throw Error(error.message); return data;
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  if (!flags['--admission-only']) {
    const sec = JSON.parse(fs.readFileSync(process.env.PIPELINE_SEC_FILE ?? 'sec.json', 'utf8'));
    const selected = Object.fromEntries(Object.entries(sec).filter(([, row]) => allowed.has(normalizeName(row.title))));
    if (new Set(Object.values(selected).map(row => normalizeName(row.title))).size !== allowed.size) throw Error('Discovery names must exist in the saved SEC snapshot; use --admission-only for existing non-SEC candidates');
    // The SEC collector validates a complete company-list snapshot. Retain that
    // input unchanged; resolverAttempts above scopes probes to the frozen names.
    save('selected-sec', selected);
    for (const [plan, source] of [['collect', 'sec-company-list'], ['collect', 'workday-site-resolver'], ['extract'], ['collect', 'workday-career-sites'], ['extract']]) {
      const report = await runPipeline(ctx, { plan, source, limit: candidates.length, dryRun: false, trigger: 'manual' });
      state.stages.push(report); save('summary', state);
      if (report.jobs.some(j => j.blocked || j.status === 'failed')) throw Error('Discovery stage failed or blocked; inspect saved stages before continuing');
    }
  }
  if (!collectOnly) {
    // A failed model preflight leaves the collected sites and signals available for admission-only.
    const identity = await localIdentityAdmission(ctx, candidates, { host: process.env.IDENTITY_OLLAMA_HOST ?? 'http://127.0.0.1:11434', model: 'qwen2.5:7b', maxChecks, packets: frozenPackets, cachedResults, save });
    const runId = await original.startRun({ job: 'match', source_id: null, trigger: 'manual' }); ctx.runId = runId;
    try {
      const report = await matchStage(ctx, { localIdentity: identity });
      state.admission = report;
      await original.finishRun(runId, { status: report.errors.length ? 'partial' : 'succeeded', counts: report.counts, requests: report.requests,
        treg_spend_usd: 0, llm_spend_usd: 0, error: report.errors.join('; ') || null });
    } catch (error) {
      await original.finishRun(runId, { status: 'failed', counts: {}, requests: 0, treg_spend_usd: 0, llm_spend_usd: 0, error: error.message }); throw error;
    } finally { ctx.runId = null; }
  }
  const sites = await original.workdaySites(false), reviews = await original.reviewItems(), companies = await original.companies();
  const reviewSignals = (await Promise.all(reviews.filter(r => allowed.has(r.normalized_name)).map(r => original.signalsForReview(r.id)))).flat();
  const companySignals = (await Promise.all(companies.filter(c => allowed.has(normalizeName(c.name))).map(c => original.signalsForCompany(c.id)))).flat();
  const signals = [...await original.unassignedSignals(), ...reviewSignals, ...companySignals].filter(s => allowed.has(normalizeName(s.company_name)));
  save('signals', [...new Map(signals.map(s => [s.id, s])).values()]);
  state.candidate_outcomes = candidates.map(c => ({ name: c.name,
    sites: sites.filter(s => s.enabled && s.normalized_name === normalizeName(c.name)),
    pending_reviews: reviews.filter(r => r.status === 'pending' && r.normalized_name === normalizeName(c.name)),
    companies: companies.filter(row => normalizeName(row.name) === normalizeName(c.name)) }));
  state.counts = { selected: candidates.length,
    names_with_sites: state.candidate_outcomes.filter(c => c.sites.length).length,
    names_without_sites: state.candidate_outcomes.filter(c => !c.sites.length).length,
    new_companies: state.admission?.counts.new_companies ?? 0,
    attached_existing: state.admission?.counts.attached_existing ?? 0,
    pending_reviews: state.candidate_outcomes.reduce((n, c) => n + c.pending_reviews.length, 0) };
  const identityResults = collectOnly ? [] : JSON.parse(fs.readFileSync(path.join(output, 'identity-results.json'))).results;
  state.identity_counts = { pairs: identityResults.length,
    model_decisions: identityResults.filter(r => r.status === 'done').length,
    same_company: identityResults.filter(r => r.status === 'done' && r.verdict === 'same_company').length,
    different_company: identityResults.filter(r => r.status === 'done' && r.verdict === 'different_company').length,
    model_uncertain: identityResults.filter(r => r.status === 'done' && r.verdict === 'insufficient_evidence').length,
    input_unavailable: identityResults.filter(r => r.status === 'insufficient_input').length,
    model_or_output_errors: identityResults.filter(r => ['model_error', 'invalid_output'].includes(r.status)).length };
  state.finished_at = new Date().toISOString(); save('summary', state);
  console.log(JSON.stringify({ output, counts: state.counts, admission: state.admission }, null, 2));
  if (state.admission?.errors.length) process.exitCode = 1;
} catch (error) { console.error(`Local AI admission: ${error.message}`); process.exitCode = 1; }
