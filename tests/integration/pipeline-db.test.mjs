// Integration on the isolated local database (npx supabase start). Network, model and treg are faked with
// recorded fixtures so the run is deterministic; the database, its constraints and RPCs are real.
// raw_captures is append-only, so each run uses fresh random fictional names instead of deleting rows.
// Run: npm run test:integration   (skips when PIPELINE_SUPABASE_URL is not a reachable local database)
import { test, after } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { normalizeName } from '../../src/domain/ingestion/normalize.ts';
import { matchStage } from '../../src/pipeline/stages.ts';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { SupabaseStore, assertAllowedTarget } from '../../src/pipeline/store/supabase.ts';
import { runPipeline } from '../../src/pipeline/runner.ts';
import { discoveryScoreScope } from '../../scripts/discovery-score-scope.mjs';
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
const cleanupCompanies = [];

test('local AI runner admits and scores a confirmed candidate, holds a mismatch and remains duplicate-safe', { skip }, async () => {
  const store = new SupabaseStore(url, key);
  const names = randomNames(2, seed + 9973);
  const created = [], rows = [];
  try {
    for (const name of names) {
      const normalized = normalizeName(name), tenant = worldTenant(name);
      const source = `https://${tenant}.wd5.myworkdayjobs.com/robots.txt`;
      const capture = await store.saveCapture({ source: 'workday-site-resolver', url: source, fetched_at: new Date().toISOString(), http_status: 200,
        content_type: 'text/plain', raw: `Fictional identity-runner fixture ${name}`, fingerprint: randomUUID().replaceAll('-', '').repeat(2), meta: { kind: 'website_test' } }, null);
      await store.saveExtraction({ capture_id: capture.id, run_id: null, method: 'structured', model: '', prompt_version: '', status: 'done', output: { diagnostic: true }, error: null, attempts: 1, cost_usd: 0 });
      const review = await store.addReviewItem({ candidate_name: name, normalized_name: normalized, candidate_domain: null, employee_count: null, suggested_company_id: null, reason: 'no_website' });
      rows.push({ review, normalized, name });
      const signal = await store.upsertSignal({ company_id: null, review_item_id: review.id, capture_id: capture.id, extraction_id: null, type: 'known_customer', signal_date: null,
        source_url: source, quote: `Fictional employer evidence for ${name}`, confidence: 0.6, company_name: name, products: null, project_type: null, role_seniority: null, timing_words: null, method: 'structured', seen_at: new Date().toISOString() });
      rows.at(-1).signal = signal;
    }
    const ctx = makeCtx({ store, now: () => new Date(), fetch: async () => { throw Error('No provider calls are allowed in this regression'); } });
    ctx.contact = '';
    const scope = discoveryScoreScope(store);
    const localIdentity = { names: new Set(rows.map(row => row.normalized)), resolve: async (_ctx, name) => {
      const confirmed = name === names[0];
      return { normalized_name: normalizeName(name), company_name: name, domain: confirmed ? domainOf(name) : null,
        status: confirmed ? 'confirmed' : 'unresolved', reason: confirmed ? 'fictional identity match' : 'fictional identity mismatch',
        input_signature: 'fictional-local-policy', checked_at: new Date().toISOString(), next_check_at: new Date().toISOString(), evidence: { candidates: [], checks: [] } };
    } };
    const options = { limit: 2, dryRun: false, trigger: 'manual' };
    scope('match');
    const matched = await runPipeline(ctx, { ...options, plan: 'match', localIdentity });
    assert.deepEqual(matched.jobs[0].errors, []);
    assert.equal(matched.jobs[0].counts.new_companies, 1);
    const reviews = await store.reviewItems();
    const accepted = reviews.find(review => review.id === rows[0].review.id);
    if (accepted.resolved_company_id) created.push(accepted.resolved_company_id);
    assert.equal(accepted.status, 'approved');
    assert.equal(reviews.find(review => review.id === rows[1].review.id).status, 'pending');
    scope('score');
    const scored = await runPipeline(ctx, { ...options, plan: 'score' });
    assert.deepEqual(scored.jobs[0].errors, []);
    assert.ok(await store.latestScore(accepted.resolved_company_id));
    scope('match');
    const again = await runPipeline(ctx, { ...options, plan: 'match', localIdentity });
    assert.equal(again.jobs[0].counts.new_companies || 0, 0);
    assert.equal((await db.from('companies').select('id').eq('domain', domainOf(names[0]))).data.length, 1);
  } finally {
    // Discover any committed admission even if an assertion failed before recording it.
    for (const row of rows) {
      const res = await db.from('review_queue').select('resolved_company_id').eq('id', row.review.id).single();
      if (res.data?.resolved_company_id) created.push(res.data.resolved_company_id);
      if (row.signal) await db.from('signals').delete().eq('id', row.signal.id);
      await db.from('review_queue').delete().eq('id', row.review.id);
    }
    for (const id of new Set(created)) await db.from('companies').delete().eq('id', id);
  }
});
after(async () => {
  if (disabled.length) await db.from('workday_sites').update({ enabled: true }).in('id', disabled);
  // The fictional tenants must never be crawled by a real run.
  if (testTenants.length) await db.from('workday_sites').update({ enabled: false }).in('tenant', testTenants);
  if (cleanupCompanies.length) await db.from('companies').delete().in('id', cleanupCompanies);
});

async function freshWorld(names) {
  const tenants = names.map(worldTenant);
  testTenants.push(...tenants);
  const { data: others } = await db.from('workday_sites').select('id').eq('enabled', true).not('tenant', 'in', `(${tenants.join(',')})`);
  const ids = (others ?? []).map(s => s.id);
  if (ids.length) { await db.from('workday_sites').update({ enabled: false }).in('id', ids); disabled.push(...ids); }
  const store = new SupabaseStore(url, key);
  // Include only this run's fixture domains. Older .example companies can otherwise
  // consume enrichment slots and receive new fake scores/contacts on repeated runs.
  const fixtureDomains = new Set(names.map(domainOf));
  const fixtureNames = new Set(names.map(normalizeName));
  const allCompanies = store.companies.bind(store);
  store.companies = async () => (await allCompanies()).filter(c => fixtureDomains.has(c.domain));
  const reviews = store.reviewItems.bind(store), signals = store.unassignedSignals.bind(store);
  store.reviewItems = async status => (await reviews(status)).filter(row => fixtureNames.has(row.normalized_name));
  store.unassignedSignals = async () => (await signals()).filter(row => fixtureNames.has(normalizeName(row.company_name)));
  const dueAttempts = store.dueResolverAttempts.bind(store), sites = store.workdaySites.bind(store);
  store.dueResolverAttempts = async (cutoffs, limit) => (await dueAttempts(cutoffs, limit)).filter(row => fixtureNames.has(row.normalized_name));
  store.workdaySites = async enabled => (await sites(enabled)).filter(row => fixtureNames.has(row.normalized_name));
  const captures = new Set(), saveCapture = store.saveCapture.bind(store);
  store.saveCapture = async (...args) => { const saved = await saveCapture(...args); captures.add(saved.id); return saved; };
  store.pendingCaptures = async (limit, sourceIds) => {
    if (!captures.size) return [];
    let query = db.from('pending_captures').select('*').in('id', [...captures]).order('fetched_at').limit(limit);
    if (sourceIds) query = query.in('source_id', sourceIds);
    const { data, error } = await query;
    if (error) throw Error(error.message);
    return data;
  };
  // Real database assessments need real ordering: a frozen clock gives the initial and
  // contact-enriched rows identical timestamps, making latestScore ambiguous in Postgres.
  const now = () => new Date();
  return { store, ctx: makeCtx({ store, now, fetch: worldFetch({ names }), llm: groundedModel(), treg: worldTreg() }) };
}

test('the store refuses remote projects unless explicitly allowed', () => {
  assert.throws(() => new SupabaseStore('https://fkhychihxpregusklggo.supabase.co', 'x'), /Refusing to write to remote Supabase project "fkhychihxpregusklggo"/);
  assert.equal(assertAllowedTarget('https://abc.supabase.co', 'abc'), 'https://abc.supabase.co');
  assert.equal(assertAllowedTarget('http://127.0.0.1:54321', undefined), 'http://127.0.0.1:54321');
});

test('archive candidate cache persists using existing captures and stays separate from live evidence', { skip }, async () => {
  const store = new SupabaseStore(url, key);
  const raw = JSON.stringify({ signature: `cache-test-${randomUUID()}`, tenants: [{ tenant: 'cachefixture', pod: 'wd5' }] });
  const saved = await store.saveCapture({ source: 'workday-tenant-crawl', url: `https://index.commoncrawl.org/collinfo.json#${randomUUID()}`,
    fetched_at: new Date().toISOString(), http_status: 200, content_type: 'application/json', raw,
    fingerprint: createHash('sha256').update(raw).digest('hex'), meta: { kind: 'workday_index_cache' } }, null);
  const cached = await store.tenantIndexCache('workday-tenant-crawl');
  assert.equal(cached.id, saved.id);
  assert.equal(cached.body, raw);
  assert.equal((await store.captureById(saved.id)).source_id, 'workday-tenant-crawl');
});

test('due resolver attempts: persisted timestamps honor separate refresh and miss cutoffs', { skip }, async () => {
  const store = new SupabaseStore(url, key);
  const prefix = `retry-check-${seed}`;
  const attempts = [
    { normalized_name: `${prefix}-found-due`, found: true, tried_at: '2020-01-01T00:00:00Z' },
    { normalized_name: `${prefix}-found-fresh`, found: true, tried_at: '2020-01-09T00:00:00Z' },
    { normalized_name: `${prefix}-miss-due`, found: false, tried_at: '2019-12-01T00:00:00Z' },
    { normalized_name: `${prefix}-miss-fresh`, found: false, tried_at: '2019-12-30T00:00:00Z' },
  ];
  const keys = attempts.map(a => a.normalized_name);
  try {
    for (const a of attempts) await store.saveResolverAttempt({ ...a, company_name: a.normalized_name, probes: 1 });
    const cutoffs = { foundBefore: attempts[0].tried_at, missBefore: attempts[2].tried_at };
    const due = (await store.dueResolverAttempts(cutoffs, 100)).filter(a => keys.includes(a.normalized_name));
    assert.deepEqual(due.map(a => a.normalized_name), [keys[0], keys[2]], 'inclusive cutoffs, with known-site refresh before misses');
    assert.equal(Date.parse(due[0].tried_at), Date.parse(attempts[0].tried_at));
    const limited = await store.dueResolverAttempts(cutoffs, 1);
    assert.equal(limited.length, 1);
    assert.equal(limited[0].found, true);
    assert.deepEqual(await store.dueResolverAttempts(cutoffs, 0), []);
  } finally {
    const { error } = await db.from('workday_resolver_attempts').delete().in('normalized_name', keys);
    assert.equal(error, null);
  }
});

test('full flow on the database: raw rows, sourced signals, pipeline companies, scored with reasons, run log; repeat adds nothing', { skip }, async () => {
  const names = randomNames(15, seed);
  const { ctx } = await freshWorld(names);
  // Simulate a pipeline company left by a previous local test. It must not be
  // scored or researched by this batch, even though its domain is fictional too.
  const unrelatedId = await ctx.store.createPipelineCompany({ name: `Unrelated prior fixture ${seed}`, domain: `unrelated${seed}.example`, employee_count: null,
    source: `https://unrelated${seed}.example/evidence` }, null, { signal_ids: [], normalized_name: null });
  cleanupCompanies.push(unrelatedId);
  // An existing (non-pipeline) company whose website matches one tenant: boundary case.
  const boundaryDomain = domainOf(names[3]);
  const { data: existing } = await db.from('companies').insert({ name: `Boundary ${seed} Holdings`, domain: boundaryDomain }).select('id').single();
  await db.from('scores').insert({ company_id: existing.id, rubric_version: 'manual', tier: 'Maybe', authority_score: 20, authority_evidence: 'https://x.example | manual', reachability_score: 20, reachability_evidence: 'https://x.example | manual', budget_score: 10, budget_evidence: 'https://x.example | manual', release_score: 5, release_evidence: 'https://x.example | manual', timing_score: 5, timing_evidence: 'https://x.example | manual' });

  const report = await runPipeline(ctx, { plan: 'all', limit: 20, dryRun: false, trigger: 'manual' });
  assert.equal(await ctx.store.latestScore(unrelatedId), null, 'older fictional companies are not scored');
  assert.deepEqual(await ctx.store.contactsForCompany(unrelatedId), [], 'older fictional companies are not researched');
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
  assert.equal(scores.length, 22, 'initial and contact-enriched scores for each new company');
  assert.equal((await ctx.store.latestScore(ids[0])).authority_score, 5, 'latest assessment includes the unconfirmed researched contact');
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

test('website DB: persisted cache, recovered admission, atomic failure, duplicate protection and human-decision guard', { skip }, async () => {
  const store = new SupabaseStore(url, key);
  const db = store.db;
  const name = randomNames(1, Date.now())[0], normalized = normalizeName(name), tenant = worldTenant(name);
  const domain = `${tenant}.example`, source = `https://${tenant}.wd5.myworkdayjobs.com/robots.txt`;
  const now = clock();
  const capture = await store.saveCapture({ source: 'workday-site-resolver', url: source, fetched_at: now().toISOString(), http_status: 200, content_type: 'text/plain', raw: `Synthetic ${name} Workday site`, fingerprint: randomUUID().replaceAll('-', '').repeat(2), meta: { kind: 'website_test' } }, null);
  const jobCapture = await store.saveCapture({ source: 'workday-career-sites', url: `https://${tenant}.wd5.myworkdayjobs.com/wday/cxs/${tenant}/${tenant}Careers/job/test`, fetched_at: now().toISOString(), http_status: 200, content_type: 'application/json', raw: JSON.stringify({ jobPostingInfo: { jobDescription: `<a href="https://${domain}/benefits">Benefits</a>` } }), fingerprint: randomUUID().replaceAll('-', '').repeat(2), meta: { kind: 'workday_job', normalized_name: normalized, tenant, pod: 'wd5', site: `${tenant}Careers` } }, null);
  for (const row of [capture, jobCapture]) await store.saveExtraction({ capture_id: row.id, run_id: null, method: 'structured', model: '', prompt_version: '', status: 'done', output: { diagnostic: true }, error: null, attempts: 1, cost_usd: 0 });
  assert.equal((await store.websiteEvidenceCaptures(normalized, 20))[0].id, jobCapture.id);
  const item = await store.addReviewItem({ candidate_name: name, normalized_name: normalized, candidate_domain: null, employee_count: null, suggested_company_id: null, reason: 'no_website' });
  const signal = await store.upsertSignal({ company_id: null, review_item_id: item.id, capture_id: capture.id, extraction_id: null, type: 'known_customer', signal_date: null, source_url: source, quote: `Synthetic Workday evidence for ${name}`, confidence: 0.95, company_name: name, products: null, project_type: null, role_seniority: null, timing_words: null, method: 'structured', seen_at: now().toISOString() });
  const site = await store.upsertWorkdaySite({ tenant, pod: 'wd5', site: `${tenant}Careers`, company_name: name, normalized_name: normalized, match_kind: 'full_name', capture_id: capture.id, discovered_from: 'workday-site-resolver' });
  let companyId;
  try {
    // A nonexistent run FK fails after the company insert: the entire RPC must roll back.
    await assert.rejects(store.admitReview(item.id, domain, source, null, randomUUID()));
    assert.equal((await db.from('companies').select('id').eq('domain', domain)).data.length, 0);
    assert.equal((await db.from('review_queue').select('status').eq('id', item.id).single()).data.status, 'pending');
    assert.equal((await db.from('signals').select('company_id').eq('id', signal.id).single()).data.company_id, null);

    // Restrict the stage to this test's candidate without changing any other operational rows.
    const realReviews = store.reviewItems.bind(store), realUnassigned = store.unassignedSignals.bind(store);
    store.reviewItems = async () => (await realReviews()).filter(r => r.id === item.id);
    store.unassignedSignals = async () => (await realUnassigned()).filter(s => s.id === signal.id);
    const world = worldFetch({ names: [name] });
    const fetch = async (url, init) => new URL(url).hostname === domain && new URL(url).pathname === '/' ? new Response(`<title>${name}</title>`, { headers: { 'content-type': 'text/html' } }) : world(url, init);
    const ctx = makeCtx({ store, now, fetch, treg: worldTreg() });
    const result = await matchStage(ctx);
    assert.deepEqual(result.errors, []); assert.equal(result.counts.recovered_reviews, 1);
    const cached = await store.websiteResolution(normalized);
    assert.equal(cached.status, 'confirmed'); assert.equal(cached.domain, domain);
    assert.equal(cached.evidence.checks[0].employer_link.capture_id, jobCapture.id);
    const review = (await db.from('review_queue').select('*').eq('id', item.id).single()).data;
    assert.equal(review.status, 'approved'); assert.match(review.decision_note, /Workday-source website corroboration/); companyId = review.resolved_company_id;
    const company = (await db.from('companies').select('source,domain,company_origins(origin)').eq('id', companyId).single()).data;
    assert.equal(company.source, source); assert.equal(company.domain, domain); assert.equal(company.company_origins.origin, 'pipeline');
    assert.equal((await db.from('signals').select('company_id').eq('id', signal.id).single()).data.company_id, companyId);
    assert.equal((await db.from('workday_sites').select('company_id').eq('id', site.id).single()).data.company_id, companyId);
    const providerCalls = ctx.treg.calls.length; // Employer-link proof may require zero provider lookups.
    await matchStage(ctx);
    assert.equal(ctx.treg.calls.length, providerCalls, 'repeat admission/cache check makes no additional provider calls');
    await assert.rejects(store.admitReview(item.id, domain, source, null, null), /not eligible/);
    for (const reason of ['similar_name', 'no_website']) {
      const protectedItem = await store.addReviewItem({ candidate_name: `${name} ${reason}`, normalized_name: `${normalized}-${reason}`, candidate_domain: null, employee_count: null, suggested_company_id: null, reason });
      try {
        if (reason === 'no_website') await store.resolveReview(protectedItem.id, { action: 'reject' }, 'human rejection', null);
        const filled = await store.fillReviewWebsite(protectedItem.id, domain);
        assert.equal(filled, reason === 'similar_name');
        assert.equal(await store.fillReviewWebsite(protectedItem.id, 'different.example'), false, 'never overwrite a human website or rejected decision');
        await assert.rejects(store.admitReview(protectedItem.id, domain, source, companyId, null), /not eligible/);
      } finally { await db.from('review_queue').delete().eq('id', protectedItem.id); }
    }
  } finally {
    // Remove only rows created by this test. Raw captures remain append-only.
    await db.from('signals').delete().eq('id', signal.id);
    await db.from('workday_sites').delete().eq('id', site.id);
    await db.from('review_queue').delete().eq('id', item.id);
    if (companyId) await db.from('companies').delete().eq('id', companyId);
    await db.from('website_resolutions').delete().eq('normalized_name', normalized);
  }
});
