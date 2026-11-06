// Small live-network probe of task 1, restricted to the disposable validation project.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contextFromEnv } from '../src/pipeline/context.ts';
import { runPipeline } from '../src/pipeline/runner.ts';
import { discoveryPlan, executeDiscovery } from './discovery-plan.mjs';

export function assertValidationTarget(env) {
  if (env.PIPELINE_SUPABASE_URL !== 'http://127.0.0.1:55321' || env.PIPELINE_ALLOW_REMOTE) {
    throw Error('Only the isolated validation database at port 55321 is permitted');
  }
}

export async function liveProbe(env) {
  assertValidationTarget(env);
  const directory = resolve('var/live-discovery', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(directory, { recursive: true });
  const summary = { status: 'running', limit: 2, max_new: 3, max_minutes: 5, paid_services: false, jobs: [] };
  const save = () => writeFileSync(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  save();
  const started = Date.now();
  const ctx = await contextFromEnv({ ...env, TREG_BUDGET_USD: '0', PIPELINE_LLM_BUDGET_USD: '0' },
    { dryRun: false, noLlm: true, noTreg: true, maxSpend: 0 });
  const store = ctx.store;
  const before = {};
  for (const table of ['companies', 'contacts', 'scores', 'weekly_snapshots']) {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const result = await store.db.from(table).select('*').order('id').range(offset, offset + 999);
      if (result.error) throw Error(`Cannot snapshot ${table}`);
      rows.push(...result.data);
      if (result.data.length < 1000) break;
    }
    before[table] = rows;
  }
  // Preserve baseline rows in memory; never print keys or full company/contact records.
  const newCaptures = new Set(), names = new Set(), created = new Set();
  const sources = store.sources.bind(store), settings = store.settings.bind(store);
  store.sources = async () => (await sources()).map(s => ({ ...s,
    max_requests_per_run: Math.min(s.max_requests_per_run, s.id === 'workday-site-resolver' ? 16 : s.id === 'workday-career-sites' ? 20 : 8),
    config: { ...s.config, pods: ['wd5'], crawls: 1, limit: 50, max_jobs_per_site: 2 },
  }));
  store.settings = async () => ({ ...await settings(), max_new_companies_per_run: 3, scoring_scope: 'pipeline_only' });
  const capture = store.saveCapture.bind(store);
  store.saveCapture = async (item, runId) => {
    const saved = await capture(item, runId);
    if (saved.inserted) newCaptures.add(saved.id);
    if (item.meta?.normalized_name) names.add(item.meta.normalized_name);
    return saved;
  };
  const pending = store.pendingCaptures.bind(store), signals = store.unassignedSignals.bind(store), reviews = store.reviewItems.bind(store);
  store.pendingCaptures = async (limit, sourceIds) => (await pending(10000, sourceIds)).filter(c => newCaptures.has(c.id)).slice(0, limit);
  store.unassignedSignals = async () => (await signals()).filter(s => newCaptures.has(s.capture_id));
  store.reviewItems = async status => (await reviews(status)).filter(r => r.status !== 'pending' || names.has(r.normalized_name));
  const sites = store.workdaySites.bind(store);
  const create = store.createPipelineCompany.bind(store), admit = store.admitReview.bind(store);
  store.createPipelineCompany = async (...args) => {
    if (created.size >= 3) throw Error('Local admission cap reached');
    const id = await create(...args); created.add(id); return id;
  };
  store.admitReview = async (...args) => {
    if (created.size >= 3 && !args[3]) throw Error('Local admission cap reached');
    const id = await admit(...args);
    if (!before.companies.some(c => c.id === id)) created.add(id);
    return id;
  };
  const companies = store.companies.bind(store);
  for (const method of ['insertContact', 'updateContact', 'resolveReview']) {
    store[method] = async () => { throw Error(`${method} disabled during live probe`); };
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5 * 60000);
  const fetch = ctx.fetch;
  ctx.fetch = (url, options = {}) => fetch(url, { ...options,
    signal: options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal });
  const sleep = ctx.sleep;
  ctx.sleep = async ms => { if (abort.signal.aborted) throw Error('Probe time limit reached'); await sleep(Math.min(ms, 5000)); };
  ctx.contact = ''; // Use the checked-in SEC name list; no live financial refresh.
  const oldSec = process.env.PIPELINE_SEC_FILE;
  process.env.PIPELINE_SEC_FILE = resolve('sec.json');
  try {
    const result = await executeDiscovery(ctx, async (context, options) => {
      if (abort.signal.aborted) throw Error('Probe time limit reached');
      store.workdaySites = options.source === 'workday-career-sites'
        ? async enabled => (await sites(enabled)).filter(s => newCaptures.has(s.capture_id)) : sites;
      store.companies = options.plan === 'score' ? async () => (await companies()).filter(c => created.has(c.id)) : companies;
      const report = await runPipeline(context, options);
      summary.jobs.push(...report.jobs.map(j => ({ job: j.job, source: j.source_id, status: j.status, ms: j.ms, counts: j.counts,
        blocked: Boolean(j.blocked), error_count: j.errors.length })));
      save();
      return report;
    }, discoveryPlan(2));
    summary.status = result.status;
  } catch {
    summary.status = abort.signal.aborted ? 'time_limit' : 'failed';
  } finally {
    clearTimeout(timer);
    if (oldSec === undefined) delete process.env.PIPELINE_SEC_FILE; else process.env.PIPELINE_SEC_FILE = oldSec;
  }
  summary.original_rows_unchanged = {};
  for (const [table, rows] of Object.entries(before)) {
    let unchanged = true;
    for (let offset = 0; offset < rows.length; offset += 100) {
      const batch = rows.slice(offset, offset + 100);
      const result = await store.db.from(table).select('*').in('id', batch.map(r => r.id));
      if (result.error || result.data.length !== batch.length) { unchanged = false; break; }
      const canonical = row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
      if (!batch.every(r => result.data.some(a => a.id === r.id && canonical(a) === canonical(r)))) { unchanged = false; break; }
    }
    summary.original_rows_unchanged[table] = unchanged;
  }
  summary.elapsed_seconds = Math.round((Date.now() - started) / 1000);
  summary.admitted = created.size;
  summary.company_ids = [...created];
  summary.paid_spend = ctx.spend.spent('treg');
  if (Object.values(summary.original_rows_unchanged).some(v => !v)) summary.status = 'preservation_failed';
  save();
  console.log(`LIVE_PROBE ${JSON.stringify({ ...summary, directory })}`);
  return summary;
}
