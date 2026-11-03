// Integration on the isolated local database (npx supabase start). Network, model and treg are faked with
// recorded fixtures so the run is deterministic; the database, its constraints and RPCs are real.
// raw_captures is append-only, so each run uses fresh random fictional names instead of deleting rows.
// Run: npm run test:integration   (skips when PIPELINE_SUPABASE_URL is not a reachable local database)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { SupabaseStore, assertAllowedTarget } from '../../src/pipeline/store/supabase.ts';
import { runPipeline } from '../../src/pipeline/runner.ts';
import { makeCtx, clock, worldFetch, worldTreg, groundedModel, randomNames, worldTenant } from '../ingestion/helpers.mjs';

const url = process.env.PIPELINE_SUPABASE_URL, key = process.env.PIPELINE_SUPABASE_KEY;
let reachable = false;
if (url && key) {
  try { assertAllowedTarget(url, undefined); reachable = (await fetch(`${url}/rest/v1/`, { headers: { apikey: key } })).status < 500; } catch { reachable = false; }
}
const skip = reachable ? false : 'local Supabase is not running (npx supabase start) or PIPELINE_SUPABASE_URL is remote';
const seed = Date.now();
const db = reachable ? createClient(url, key, { auth: { persistSession: false } }) : null;
const domainOf = name => `${worldTenant(name)}.example`;
const count = async table => (await db.from(table).select('id', { count: 'exact', head: true })).count;

// Sites this test switches off so it only collects its own tenants; switched back on afterwards
// (regression: real sites in a shared local database used to stay disabled after the tests).
const disabled = [];
const testTenants = [];
after(async () => {
  if (disabled.length) await db.from('workday_sites').update({ enabled: true }).in('id', disabled);
  // The fictional tenants must never be crawled by a real run.
  if (testTenants.length) await db.from('workday_sites').update({ enabled: false }).in('tenant', testTenants);
});

async function freshWorld(names) {
  const tenants = names.map(worldTenant);
  testTenants.push(...tenants);
  const { data: others } = await db.from('workday_sites').select('id').eq('enabled', true).not('tenant', 'in', `(${tenants.join(',')})`);
  const ids = (others ?? []).map(s => s.id);
  if (ids.length) { await db.from('workday_sites').update({ enabled: false }).in('id', ids); disabled.push(...ids); }
  const store = new SupabaseStore(url, key);
  // Scope scoring and enrichment to this test's fictional companies (".example" websites). Regression: the shared local
  // database also holds real pipeline companies, and an unscoped test run wrote its fake email onto their contacts.
  const allCompanies = store.companies.bind(store);
  store.companies = async () => (await allCompanies()).filter(c => (c.domain ?? '').endsWith('.example'));
  const now = clock(new Date().toISOString());
  return { store, ctx: makeCtx({ store, now, fetch: worldFetch({ names }), llm: groundedModel(), treg: worldTreg() }) };
}

test('the store refuses remote projects unless explicitly allowed', () => {
  assert.throws(() => new SupabaseStore('https://fkhychihxpregusklggo.supabase.co', 'x'), /Refusing to write to remote Supabase project "fkhychihxpregusklggo"/);
  assert.equal(assertAllowedTarget('https://abc.supabase.co', 'abc'), 'https://abc.supabase.co');
  assert.equal(assertAllowedTarget('http://127.0.0.1:54321', undefined), 'http://127.0.0.1:54321');
});

test('full flow on the database: raw rows, sourced signals, pipeline companies, scored with reasons, run log; repeat adds nothing', { skip }, async () => {
  const names = randomNames(15, seed);
  const { ctx } = await freshWorld(names);
  // An existing (non-pipeline) company whose website matches one tenant: boundary case.
  const boundaryDomain = domainOf(names[3]);
  const { data: existing } = await db.from('companies').insert({ name: `Boundary ${seed} Holdings`, domain: boundaryDomain }).select('id').single();
  await db.from('scores').insert({ company_id: existing.id, rubric_version: 'manual', tier: 'Maybe', authority_score: 20, authority_evidence: 'https://x.example | manual', reachability_score: 20, reachability_evidence: 'https://x.example | manual', budget_score: 10, budget_evidence: 'https://x.example | manual', release_score: 5, release_evidence: 'https://x.example | manual', timing_score: 5, timing_evidence: 'https://x.example | manual' });

  const report = await runPipeline(ctx, { plan: 'all', limit: 20, dryRun: false, trigger: 'manual' });
  assert.equal(report.jobs.filter(j => j.status === 'failed').length, 0, JSON.stringify(report.jobs.map(j => [j.job, j.status, j.errors.slice(0, 2)])));

  const { data: created } = await db.from('companies').select('id, name, domain, company_origins(origin)').in('domain', names.slice(0, 12).map(domainOf));
  const pipeline = created.filter(c => c.domain !== boundaryDomain);
  assert.equal(pipeline.length, 11, '12 tenants exist; the boundary one is matched by website, not created');
  assert.ok(pipeline.every(c => c.company_origins?.origin === 'pipeline'));
  const ids = pipeline.map(c => c.id);

  const { data: signals } = await db.from('signals').select('id, type, source_url, quote, company_id, capture_id').in('company_id', ids);
  assert.ok(signals.length >= 22, `${signals.length} signals`);
  assert.ok(signals.every(s => /^https?:\/\//.test(s.source_url) && s.quote.trim()));
  assert.ok(ids.every(id => signals.some(s => s.company_id === id)), 'every new company has at least one sourced signal');
  const captureIds = [...new Set(signals.map(s => s.capture_id))];
  const { data: captures } = await db.from('raw_captures').select('id').in('id', captureIds);
  assert.equal(captures.length, captureIds.length, 'every signal points at a stored raw item');

  const { data: scores } = await db.from('scores').select('*').in('company_id', ids);
  assert.equal(scores.length, 11);
  for (const s of scores) for (const c of ['authority', 'reachability', 'budget', 'release', 'timing']) {
    const e = s[`${c}_evidence`];
    assert.ok(s[`${c}_score`] > 0 ? /^https?:\/\/\S+ \| .+/.test(e) : e.includes('Needs evidence') || /^https?:/.test(e), `${c}: ${e}`);
  }

  const { count: boundarySignals } = await db.from('signals').select('id', { count: 'exact', head: true }).eq('company_id', existing.id);
  const { data: boundaryScores } = await db.from('scores').select('id').eq('company_id', existing.id);
  assert.ok(boundarySignals > 0, 'existing company got signals');
  assert.equal(boundaryScores.length, 1, 'existing company scores untouched');

  const { data: runs } = await db.from('pipeline_runs').select('job, status, finished_at').gte('started_at', new Date(Date.now() - 600000).toISOString());
  assert.ok(runs.length >= 8 && runs.every(r => r.finished_at), 'run log written and closed');

  const before = { raw: await count('raw_captures'), signals: await count('signals'), companies: await count('companies'), scores: await count('scores'), review: await count('review_queue'), sites: await count('workday_sites') };
  await runPipeline(ctx, { plan: 'all', limit: 20, dryRun: false, trigger: 'manual' });
  const after = { raw: await count('raw_captures'), signals: await count('signals'), companies: await count('companies'), scores: await count('scores'), review: await count('review_queue'), sites: await count('workday_sites') };
  assert.deepEqual(after, before, 'second identical run adds nothing');
});

test('a database error part-way leaves no half-written company (atomic create), and a rerun finishes', { skip }, async () => {
  const names = randomNames(15, seed + 7919);
  const { store, ctx } = await freshWorld(names);
  let calls = 0;
  const real = store.createPipelineCompany.bind(store);
  store.createPipelineCompany = async (...args) => { if (++calls === 3) throw new Error('injected: connection reset'); return real(...args); };
  const report = await runPipeline(ctx, { plan: 'weekly', limit: 20, dryRun: false, trigger: 'manual' });
  assert.equal(report.jobs.find(j => j.job === 'match').status, 'partial');
  const { data: partial } = await db.from('companies').select('id, company_origins(origin), signals(id)').in('domain', names.map(domainOf));
  assert.equal(partial.length, 11, '11 of 12 created; the failed one left nothing behind');
  for (const c of partial) { assert.ok(c.company_origins, 'origin row exists'); assert.ok(c.signals.length > 0, 'signals attached'); }
  store.createPipelineCompany = real;
  await runPipeline(ctx, { plan: 'weekly', limit: 20, dryRun: false, trigger: 'manual' });
  const { data: all } = await db.from('companies').select('name').in('domain', names.map(domainOf));
  assert.equal(all.length, 12);
  assert.equal(new Set(all.map(c => c.name)).size, 12, 'no duplicates after the rerun');
});

test('review functions on the database: one pending item per name; approve creates a pipeline company; decisions are final', { skip }, async () => {
  const store = new SupabaseStore(url, key);
  const name = randomNames(1, seed + 31)[0];
  const item = await store.addReviewItem({ candidate_name: name, normalized_name: name.toLowerCase(), candidate_domain: null, employee_count: null, suggested_company_id: null, reason: 'no_website' });
  const again = await store.addReviewItem({ candidate_name: name, normalized_name: name.toLowerCase(), candidate_domain: null, employee_count: null, suggested_company_id: null, reason: 'no_website' });
  assert.equal(again.id, item.id);
  const id = await store.resolveReview(item.id, { action: 'approve', domain: `review${seed}.example` }, 'test', null);
  const { data: company } = await db.from('companies').select('domain, company_origins(origin)').eq('id', id).single();
  assert.equal(company.domain, `review${seed}.example`);
  assert.equal(company.company_origins.origin, 'pipeline');
  await assert.rejects(store.resolveReview(item.id, { action: 'reject' }, 'twice', null), /not pending/);
  const health = await store.health();
  for (const k of ['review_queue_pending', 'new_companies_7d', 'last_run_at', 'dead_letters']) assert.ok(k in health, k);
});

test('round 2: reads past the API row limit (1,000): every company is visible to matching and scoring', { skip }, async () => {
  const { count: before } = await db.from('companies').select('id', { count: 'exact', head: true });
  const need = Math.max(0, 1005 - before);
  const tag = `pagetest${seed}`;
  for (let i = 0; i < need; i += 500) {
    const rows = Array.from({ length: Math.min(500, need - i) }, (_, j) => ({ name: `${tag} ${i + j}`, domain: `${tag}-${i + j}.example` }));
    const { error } = await db.from('companies').insert(rows);
    assert.equal(error, null);
  }
  const store = new SupabaseStore(url, key);
  const all = await store.companies();
  const { count } = await db.from('companies').select('id', { count: 'exact', head: true });
  assert.ok(count > 1000);
  assert.equal(all.length, count, 'no company is silently cut off at 1,000');
});

test('review rejection atomically disables unassigned sites, preserves evidence and rejects invalid decisions', { skip }, async () => {
  const store = new SupabaseStore(url, key);
  const normalized = `reject${seed}`;
  const { id } = await store.addReviewItem({ candidate_name: normalized, normalized_name: normalized, candidate_domain: null, employee_count: null, suggested_company_id: null, reason: 'untrusted_signal' });
  const site = { tenant: normalized, pod: 'wd1', site: 'Careers', company_name: normalized, normalized_name: normalized, match_kind: 'first_word', discovered_from: 'workday-site-resolver', capture_id: null };
  testTenants.push(normalized);
  const { id: siteId } = await store.upsertWorkdaySite(site);
  await store.linkWorkdaySites(normalized, { review_item_id: id });
  const { data: existing, error: companyError } = await db.from('companies').insert({ name: 'Verified fixture', domain: `${normalized}.example` }).select('id').single();
  assert.equal(companyError, null);
  const { error: verifiedSiteError } = await db.from('workday_sites').insert({ ...site, site: 'Verified', company_id: existing.id, review_item_id: id });
  assert.equal(verifiedSiteError, null);
  const { id: captureId } = await store.saveCapture({ source: 'csv-import', url: `https://${normalized}.example`, fetched_at: new Date().toISOString(), http_status: 200, content_type: 'text/plain', raw: 'Unverified Workday association', fingerprint: 'e'.repeat(64), meta: {} }, null);
  const { data: signal, error: signalError } = await db.from('signals').insert({ capture_id: captureId, review_item_id: id, type: 'known_customer', source_url: `https://${normalized}.example`, quote: 'Unverified Workday association', confidence: 0.5 }).select('id').single();
  assert.equal(signalError, null);
  for (const [status, company] of [['approved', null], ['merged', null], ['rejected', existing.id], ['pending', null], [null, null]]) {
    const { error } = await db.rpc('review_resolve', { p_item: id, p_company: company, p_status: status, p_note: 'Invalid' });
    assert.ok(error, `must reject ${status}/${company}`);
    assert.ok((await store.reviewItems('pending')).some(item => item.id === id));
  }
  await store.resolveReview(id, { action: 'reject' }, 'Wrong employer association', null);
  const { data: sites, error: sitesError } = await db.from('workday_sites').select('id, enabled, company_id, review_item_id').eq('review_item_id', id);
  assert.equal(sitesError, null);
  assert.equal(sites.find(row => row.id === siteId).enabled, false);
  assert.equal(sites.find(row => row.company_id === existing.id).enabled, true);
  const { data: evidence, error: evidenceError } = await db.from('signals').select('company_id, review_item_id').eq('id', signal.id).single();
  assert.equal(evidenceError, null);
  assert.deepEqual(evidence, { company_id: null, review_item_id: id });
  assert.equal((await store.upsertWorkdaySite(site)).inserted, false);
  const { data: rediscovered } = await db.from('workday_sites').select('enabled').eq('id', siteId).single();
  assert.equal(rediscovered.enabled, false);
  await assert.rejects(store.resolveReview(id, { action: 'approve' }, 'Already decided', null), /not pending/);
});

test('regression: integration runs never write test data onto real (non-.example) companies or their contacts', { skip }, async () => {
  const { data: fakeOnReal } = await db.from('contacts').select('id, email, companies!inner(domain)').like('email', '%.example').not('companies.domain', 'like', '%.example');
  assert.deepEqual(fakeOnReal, []);
});
