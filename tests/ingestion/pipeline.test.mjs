// Whole-pipeline behaviour on the in-memory store: flow, idempotency, failure injection, time travel,
// the scoring-scope boundary and spending caps. tests/integration repeats the key cases on a real database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../src/pipeline/store/memory.ts';
import { runPipeline } from '../../src/pipeline/runner.ts';
import { scoreStage, extractStage } from '../../src/pipeline/stages.ts';
import { enrichStage, readEmailAnswer, pickContacts } from '../../src/pipeline/enrich.ts';
import { importCsv, parseImportCsv } from '../../src/pipeline/import-csv.ts';
import { categories } from '../../src/domain/contracts/company.ts';
import { makeCtx, clock, worldFetch, worldTreg, groundedModel, fakeLLM, WORLD_NAMES } from './helpers.mjs';

const run = (ctx, plan = 'all', limit = 20) => runPipeline(ctx, { plan, limit, dryRun: false, trigger: 'manual' });

function world(opts = {}) {
  const now = opts.now ?? clock();
  const store = opts.store ?? new MemoryStore({ now });
  const ctx = makeCtx({ store, now, fetch: opts.fetch ?? worldFetch(opts.world ?? {}), llm: opts.llm === undefined ? groundedModel() : opts.llm, treg: opts.treg === undefined ? worldTreg(opts.tregOpts ?? {}) : opts.treg, caps: opts.caps });
  return { ctx, store, now };
}

function snapshotCounts(store) {
  return { captures: store.captures.length, signals: store.signals.length, companies: store.companyRows.length, scores: store.scores.length, reviews: store.reviews.length, sites: store.sites.length };
}

test('full flow: 12 new Workday companies created with origin pipeline, sourced signals and scores with reasons; run log written', async () => {
  const { ctx, store } = world();
  const report = await run(ctx);
  const pipelineCompanies = store.companyRows.filter(c => c.pipeline);
  assert.equal(pipelineCompanies.length, 12);
  assert.ok(pipelineCompanies.every(c => /\.example$/.test(c.domain)));
  assert.ok(store.signals.length > 12 && store.signals.every(s => /^https?:\/\//.test(s.source_url) && s.quote.trim().length > 0));
  for (const s of store.signals.filter(s => s.method === 'structured' && s.type === 'hiring')) {
    const capture = store.captures.find(c => c.id === s.capture_id);
    assert.ok(JSON.parse(capture.body).jobPostingInfo.jobDescription.length > 0);
  }
  assert.equal(store.scores.length, 12);
  for (const score of store.scores) for (const c of categories) {
    const evidence = score[`${c}_evidence`];
    assert.ok(score[`${c}_score`] === 0 || /^https?:\/\/\S+ \| .+/.test(evidence), `${c} points need a link and reason`);
    assert.ok(evidence.length > 0, `${c} evidence is never blank`);
  }
  assert.ok(store.runs.length >= 8 && store.runs.every(r => r.finished_at && r.status !== 'running'));
  assert.ok(report.jobs.find(j => j.job === 'match').counts.new_companies === 12);
  assert.deepEqual(store.duplicateCompanies(), []);
});

test('idempotency: the same batch twice adds no raw items, signals, companies, scores, review items or sites', async () => {
  const { ctx, store } = world();
  await run(ctx);
  const first = snapshotCounts(store);
  await run(ctx);
  assert.deepEqual(snapshotCounts(store), first);
  const extractions = store.extractions.length;
  await extractStage(ctx, { limit: 500 });
  assert.equal(store.extractions.length, extractions, 'finished captures are not re-read');
});

test('unchanged captures are skipped but keep their signals fresh', async () => {
  const now = clock();
  const { ctx, store } = world({ now });
  await run(ctx);
  const before = store.signals.find(s => s.type === 'hiring').last_seen_at;
  now.advanceDays(3);
  const report = await run(ctx, 'daily');
  const collect = report.jobs.find(j => j.job === 'collect' && j.source_id === 'workday-career-sites');
  assert.ok(collect.counts.unchanged_captures > 0 && !collect.counts.new_captures);
  assert.ok(store.signals.find(s => s.type === 'hiring').last_seen_at > before);
});

test('failure: source down -> the run finishes, the source is logged as failed, other stages still run', async () => {
  const { ctx, store } = world({ world: { jobsDown: true } });
  const report = await run(ctx);
  const jobs = report.jobs.find(j => j.job === 'collect' && j.source_id === 'workday-career-sites');
  assert.equal(jobs.status, 'blocked');
  assert.ok(report.jobs.find(j => j.job === 'score'));
  assert.equal(store.companyRows.filter(c => c.pipeline).length, 12, 'discovery still created companies');
  assert.ok(store.runs.every(r => r.finished_at));
});

test('failure: Ollama down -> captures stay queued (not dead-lettered); structured signals still saved; next run catches up', async () => {
  const llmDown = fakeLLM(() => ({ error: 'ollama unreachable: connect ECONNREFUSED' }));
  const { ctx, store } = world({ llm: llmDown });
  const report = await run(ctx);
  const extract = report.jobs.filter(j => j.job === 'extract').at(-1);
  assert.ok(extract.counts.llm_unavailable >= 1);
  assert.equal(store.extractions.filter(e => e.status === 'dead_letter').length, 0);
  assert.ok(store.signals.some(s => s.type === 'hiring' && s.method === 'structured'));
  assert.equal(llmDown.calls.length, 1, 'the model is not called again after it is found down');
  const queued = (await store.pendingCaptures(100)).length;
  assert.ok(queued > 0);
  ctx.llm = groundedModel();
  await extractStage(ctx, { limit: 100 });
  assert.equal((await store.pendingCaptures(100)).length, 0);
});

test('failure: model returns junk -> retried once, then dead-lettered; the run continues', async () => {
  const junk = fakeLLM(() => 'not json at all');
  const { ctx, store } = world({ llm: junk });
  await run(ctx);
  const dead = store.extractions.filter(e => e.status === 'dead_letter');
  assert.ok(dead.length > 0 && dead.every(e => e.attempts === 2));
  assert.equal(junk.calls.length, dead.length * 2);
  const wrongShape = fakeLLM(() => ({ company_name: 1, signals: 'x' }));
  const second = world({ llm: wrongShape });
  await run(second.ctx);
  assert.ok(second.store.extractions.some(e => e.status === 'dead_letter' && /schema/.test(e.error)));
});

test('failure: model invents quotes -> every non-verbatim signal is dropped', async () => {
  const liar = fakeLLM(() => ({ company_name: null, workday_products: ['Workday Quantum'], project_type: null, role_seniority: null, timing_words: [], signals: [{ type: 'go_live', quote: 'The company went live on Workday last month across all regions', date_text: null }] }));
  const { ctx, store } = world({ llm: liar });
  await run(ctx);
  assert.equal(store.signals.filter(s => s.method === 'llm').length, 0);
  const done = store.extractions.find(e => e.method === 'llm' && e.status === 'done');
  assert.ok(done.output.dropped.some(d => /verbatim/.test(d.reason)) && done.output.dropped.some(d => d.value === 'Workday Quantum'));
});

test('failure: database error mid-run -> run finishes, no half-written company, the next run completes the work', async () => {
  const { ctx, store } = world();
  store.failAfter = { createPipelineCompany: 5 };
  const report = await run(ctx);
  const match = report.jobs.filter(j => j.job === 'match').at(-1);
  assert.equal(match.status, 'partial');
  assert.equal(store.companyRows.length, 5);
  for (const company of store.companyRows) assert.ok(store.signals.some(s => s.company_id === company.id), 'every company has its signals');
  assert.ok(store.runs.every(r => r.finished_at));
  store.failAfter = {};
  await run(ctx, 'weekly');
  assert.equal(store.companyRows.filter(c => c.pipeline).length, 12);
  assert.deepEqual(store.duplicateCompanies(), []);
});

test('failure: treg 402 and treg timeout -> contact lookup is skipped, the run still scores; contacts stay pending', async () => {
  const t402 = worldTreg({ emailFind: () => ({ ok: false, status: 402, error: 'treg HTTP 402', cost_usd: 0 }) });
  const { ctx, store } = world({ treg: t402 });
  await run(ctx);
  for (const id of store.companyRows.map(c => c.id)) await store.setEnrichment(id, 'pending', 'test');
  const r = await enrichStage(ctx, { maxCompanies: 3 });
  assert.equal(r.counts.budget_skipped, 3, 'after the first 402 every company waits for budget');
  assert.equal(t402.calls.filter(c => c.endpoint === 'treg.people.email.find').length, 1);
  assert.ok(store.scores.length >= 12);
  const timeout = worldTreg({ emailFind: () => ({ ok: false, status: 0, error: 'treg timeout', cost_usd: 0 }), extra: { 'hunter.x.domain-finder': () => ({ ok: false, status: 0, error: 'treg timeout', cost_usd: 0 }) } });
  const second = world({ treg: timeout });
  const report = await run(second.ctx);
  assert.ok(report.jobs.every(j => j.status !== 'failed' || j.job === 'collect'));
  assert.equal(second.store.companyRows.length, 0, 'no website -> everything waits in review');
  assert.equal(second.store.reviews.length, 12);
  assert.ok(second.store.reviews.every(r => r.reason === 'no_website'));
});

test('time travel: a signal older than 14 days drops out of the score, and every company is rescored at the 2-week mark', async () => {
  const now = clock('2026-10-13T12:00:00Z');
  const { ctx, store } = world({ now });
  await run(ctx);
  const id = store.companyRows[0].id;
  const first = await store.latestScore(id);
  assert.ok(first.timing_score > 0);
  now.advanceDays(1);
  await scoreStage(ctx);
  assert.equal(store.scores.filter(s => s.company_id === id).length, 1, 'unchanged after a day: no new row');
  now.advanceDays(14);
  const r = await scoreStage(ctx);
  const latest = await store.latestScore(id);
  assert.equal(latest.timing_score, 0, 'hiring signal last seen 15 days ago no longer scores');
  assert.equal(latest.budget_score, 0);
  assert.match(latest.timing_evidence, /Needs evidence/);
  assert.equal(r.counts.rescored, 12);
  now.advanceDays(14);
  const due = await scoreStage(ctx);
  assert.equal(due.counts.rescored, 12, 'unchanged scores are still re-saved every 14 days');
});

test('every saved score records why: run, trigger, previous score and a summary of what changed', async () => {
  const now = clock('2026-10-13T12:00:00Z');
  const { ctx, store } = world({ now });
  await run(ctx);
  const id = store.companyRows[0].id;
  const first = store.scores.find(s => s.company_id === id);
  assert.deepEqual([store.scoreChanges.get(first.id).change_trigger, store.scoreChanges.get(first.id).change_summary, store.scoreChanges.get(first.id).previous_score_id], ['pipeline_run', 'First assessment.', null]);
  now.advanceDays(15);
  await scoreStage(ctx, { companyIds: [id], trigger: 'new_contacts' });
  const second = (await store.latestScore(id));
  const change = store.scoreChanges.get(second.id);
  assert.equal(change.previous_score_id, first.id, 'links back to the score it replaced');
  assert.equal(change.change_trigger, 'new_contacts', 'the caller that knew the reason is recorded');
  assert.match(change.change_summary, /Timing \d+ to 0: Needs evidence/, 'the expired hiring signal shows up as the reason for Timing');
  now.advanceDays(14);
  await scoreStage(ctx, { companyIds: [id] });
  const third = store.scoreChanges.get((await store.latestScore(id)).id);
  assert.equal(third.change_trigger, 'periodic_refresh', 'an unchanged score re-saved because it is due is a refresh');
  assert.equal(third.change_summary, 'Re-saved with no score change (periodic refresh).');
});

test('boundary: an existing company matched by website gets signals attached but its scores are untouched (scope pipeline_only)', async () => {
  const { ctx, store } = world();
  const existing = store.addExistingCompany({ name: 'Alder Robotics Incorporated', domain: 'alderrobotics.example' });
  store.scores.push({ id: 'old', company_id: existing, assessed_at: '2026-10-01T00:00:00Z', rubric_version: 'manual', tier: 'Maybe', authority_score: 20, authority_evidence: 'https://x.example | manual', reachability_score: 20, reachability_evidence: 'https://x.example | manual', budget_score: 10, budget_evidence: 'https://x.example | manual', release_score: 5, release_evidence: 'https://x.example | manual', timing_score: 5, timing_evidence: 'https://x.example | manual' });
  await run(ctx);
  assert.ok(store.signals.some(s => s.company_id === existing), 'signals attached');
  assert.deepEqual(store.scores.filter(s => s.company_id === existing).map(s => s.id), ['old'], 'no new score row');
  store.settingsRows = [{ key: 'scoring_scope', value: 'all' }];
  await scoreStage(ctx);
  assert.equal(store.scores.filter(s => s.company_id === existing).length, 2, 'scored once the scope is switched');
});

test('similar name to an existing company goes to review with a suggestion; approve/merge/reject work', async () => {
  const { ctx, store } = world({ tregOpts: { unconfirmed: ['Birchway Logistics Corp'] } });
  const existing = store.addExistingCompany({ name: 'Cedarline Health Systems LLC', domain: 'cedarline-health.org' });
  await run(ctx);
  const similar = store.reviews.find(r => r.reason === 'similar_name');
  assert.equal(similar.suggested_company_id, existing);
  const noSite = store.reviews.find(r => r.reason === 'no_website');
  assert.equal(noSite.candidate_name.startsWith('Birchway'), true);
  await store.resolveReview(similar.id, { action: 'merge', company_id: existing }, 'same company', null);
  assert.ok(store.signals.some(s => s.company_id === existing));
  const approved = await store.resolveReview(noSite.id, { action: 'approve', domain: 'birchway.example' }, 'checked', null);
  assert.ok(store.companyRows.find(c => c.id === approved && c.pipeline));
  await assert.rejects(store.resolveReview(noSite.id, { action: 'reject' }, 'again', null));
});

test('spend: the budget cap is enforced and an existing LinkedIn URL never triggers a paid lookup', async () => {
  const treg = worldTreg();
  const { ctx, store } = world({ treg, caps: { treg: 0.03 } });
  await run(ctx);
  const ids = store.companyRows.map(c => c.id);
  for (const id of ids) await store.setEnrichment(id, 'pending', 'test');
  // One company already has a contact with a LinkedIn URL.
  await store.insertContact({ company_id: ids[0], name: 'Known Person', title: 'VP HRIS', linkedin_url: 'https://www.linkedin.com/in/known', source: 'https://www.linkedin.com/in/known', email: null, email_status: null, phone: null, phone_status: null, mutual_connection: null });
  await enrichStage(ctx, { maxCompanies: 12, emailWorstCaseUsd: 0.02 });
  const paid = treg.calls.filter(c => c.endpoint === 'treg.people.email.find');
  // Each lookup reserves its $0.02 worst case but costs $0.006: 0 + .02 ok, .006 + .02 ok, .012 + .02 > .03 stops.
  assert.equal(paid.length, 2, 'spent + worst case never exceeds the $0.03 cap');
  assert.ok(ctx.spend.spent('treg') <= 0.03);
  assert.ok(treg.calls.every(c => !/linkedin/i.test(c.endpoint)), 'no LinkedIn-finding endpoint is ever called');
  assert.equal(treg.calls.filter(c => c.endpoint === 'quickenrich.people.search' && c.opts.body.company_url.include[0] === store.companyRows[0].domain).length, 0, 'a company with contacts is not searched again');
  assert.ok([...store.enrichment.values()].some(e => e.status === 'skipped_budget'));
  // Same contact and step is never paid twice.
  const before = treg.calls.length;
  for (const id of ids) await store.setEnrichment(id, 'pending', 'retry');
  ctx.spend = makeCtx({ caps: { treg: 1 } }).spend;
  await enrichStage(ctx, { maxCompanies: 1, emailWorstCaseUsd: 0.02 });
  const repeats = treg.calls.slice(before).filter(c => c.endpoint === 'treg.people.email.find' && c.opts.idempotencyKey === paid[0].opts.idempotencyKey);
  assert.equal(repeats.length, 0);
});

test('email answers: only "valid" is verified, risky is stored unverified, invalid is not stored, nothing is guessed', () => {
  const answer = (email, verdict) => readEmailAnswer({ output: { email }, _treg: { verification: { verdict, checked: true } } });
  assert.deepEqual([answer('a@b.co', 'valid').status, answer('a@b.co', 'catch_all').status, answer('a@b.co', 'invalid').email, answer(null, 'valid').status], ['valid', 'risky', null, 'not_found']);
  assert.equal(readEmailAnswer({ output: { email: 'a@b.co' }, _treg: { verification: { checked: false } } }).status, 'risky');
  assert.equal(pickContacts([{ first_name: 'A', last_name: 'B', title: 'Chef', employee_linkedin: 'https://www.linkedin.com/in/ab' }]).length, 0, 'unrelated titles are not contacts');
});

test('Import button CSV: rows are validated, matched and scored like collected data; repeat import adds nothing', async () => {
  const { ctx, store } = world();
  store.addExistingCompany({ name: 'Existing Co', domain: 'existing.example' });
  const csv = 'Company,Website,Employees,Source,Quote,Signal_Type,Signal_Date\n'
    + 'Quill Analytics,quill.example,4200,https://quill.example/news,Quill Analytics went live on Workday HCM in August,go_live,2026-08-03\n'
    + 'Existing Co,https://www.existing.example,,,,,\n'
    + ',nobody.example,,,,,\n'
    + 'Bad Link Co,bad.example,,not-a-link,quote here now,hiring,\n';
  assert.equal(parseImportCsv(csv).filter(r => r.errors.length).length, 2);
  const out = await importCsv(ctx, csv);
  assert.equal(out.counts.new_companies, 1);
  assert.equal(out.counts.matched_existing, 1);
  assert.equal(out.counts.invalid_rows, 2);
  const quill = store.companyRows.find(c => c.name === 'Quill Analytics');
  assert.equal((await store.latestScore(quill.id)).timing_score, 12, 'team rubric: completed go-live within the previous 6 months');
  const before = snapshotCounts(store);
  await importCsv(ctx, csv);
  assert.deepEqual(snapshotCounts(store), before);
});

test('alerts: a source that fails or finds nothing three runs in a row raises a logged alert', async () => {
  const { ctx, store } = world({ world: { jobsDown: true } });
  for (let i = 0; i < 3; i++) await run(ctx, 'daily');
  assert.deepEqual((await store.sourceAlerts()).map(a => a.source_id), ['workday-career-sites']);
  const report = await run(ctx, 'daily');
  assert.ok(report.alerts.some(a => a.includes('workday-career-sites')));
});

test('regression: the resolver reads the SEC list collected in this run, even when an older identical capture is reused', async () => {
  const now = clock();
  const { ctx, store } = world({ now });
  // Week 1 list A, week 2 a different list B, week 3 list A again (deduplicated to the week-1 row).
  await store.saveCapture({ source: 'sec-company-list', url: 'https://www.sec.gov/files/company_tickers.json', fetched_at: '2026-09-01T00:00:00Z', http_status: 200, content_type: 'application/json', raw: (await import('./helpers.mjs')).secFixture(), fingerprint: (await import('../../src/domain/ingestion/fingerprint.ts')).contentFingerprint((await import('./helpers.mjs')).secFixture()), meta: { kind: 'sec_company_list' } }, null);
  await store.saveCapture({ source: 'sec-company-list', url: 'https://www.sec.gov/files/company_tickers.json', fetched_at: '2026-10-01T00:00:00Z', http_status: 200, content_type: 'application/json', raw: (await import('./helpers.mjs')).secFixture(['Nobody Real Inc']), fingerprint: 'b'.repeat(64), meta: { kind: 'sec_company_list' } }, null);
  const report = await run(ctx, 'weekly');
  assert.ok(report.jobs.find(j => j.source_id === 'sec-company-list').counts.unchanged_captures === 1);
  assert.equal(store.companyRows.filter(c => c.pipeline).length, 12, 'names came from list A, collected this run');
});

test('regression (round 1): job signals from a site waiting in review join that review item; no company is created behind its back', async () => {
  const { ctx, store } = world({ tregOpts: { unconfirmed: ['Birchway Logistics Corp'] } });
  await run(ctx, 'weekly');
  const item = store.reviews.find(r => r.candidate_name.startsWith('Birchway'));
  assert.ok(item && item.status === 'pending');
  ctx.treg = worldTreg(); // the domain now resolves: still must not bypass the pending review
  await run(ctx, 'daily');
  assert.equal(store.companyRows.filter(c => c.name.startsWith('Birchway')).length, 0);
  const birchSignals = store.signals.filter(s => /birchway/i.test(s.company_name ?? ''));
  assert.ok(birchSignals.length > 1 && birchSignals.every(s => s.review_item_id === item.id && !s.company_id));
  const id = await store.resolveReview(item.id, { action: 'approve', domain: 'birchwaylogistics.example' }, 'ok', null);
  assert.equal(store.companyRows.filter(c => c.name.startsWith('Birchway')).length, 1);
  assert.ok(store.signals.filter(s => /birchway/i.test(s.company_name ?? '')).every(s => s.company_id === id));
});

test('dry run writes nothing to the given store', async () => {
  const { ctx, store } = world();
  await runPipeline(ctx, { plan: 'weekly', limit: 5, dryRun: true, trigger: 'manual' });
  assert.equal(store.companyRows.length, 0, 'match is not applied in a dry run');
  assert.equal(store.attempts.size, 0, 'resolver misses are not recorded');
});

test('world names are fictional', () => { assert.ok(WORLD_NAMES.every(n => !/nvidia|target/i.test(n))); });

// ---------- Round 2: edge cases from a fresh review ----------

test('round 2: a Reddit go-live without its own date never takes the post date as the go-live date', async () => {
  const { extractCapture } = await import('../../src/pipeline/extract.ts');
  const body = JSON.stringify({ data: [{ title: 'Go live went fine', selftext: 'We finally went live on Workday HCM after a long implementation project.', permalink: '/r/workday/comments/abc/x/', created_utc: 1791000000 }] });
  const llm = fakeLLM(() => ({ company_name: null, workday_products: ['HCM'], project_type: 'implementation', role_seniority: null, timing_words: [], signals: [{ type: 'go_live', quote: 'We finally went live on Workday HCM after a long implementation project.', date_text: null }, { type: 'known_customer', quote: 'We finally went live on Workday HCM after a long implementation project.', date_text: null }] }));
  const out = await extractCapture({ id: 'c', source_id: 'treg-reddit-workday', url: 'https://www.reddit.com/r/workday/new/', fetched_at: '', http_status: 200, content_type: 'application/json', content_hash: 'x', body, run_id: null, meta: { kind: 'reddit_feed' } }, llm, 'prompt');
  assert.equal(out.signals.find(s => s.type === 'go_live').signal_date, null);
  assert.ok(out.signals.find(s => s.type === 'known_customer').signal_date, 'non-go-live signals keep the publication date');
});

test('round 2: a capture whose reader throws is dead-lettered once, not retried on every run', async () => {
  const { ctx, store } = world();
  await store.saveCapture({ source: 'workday-career-sites', url: 'https://x.wd5.myworkdayjobs.com/wday/cxs/x/X/job/1', fetched_at: '2026-10-13T00:00:00Z', http_status: 200, content_type: 'application/json', raw: '<html>not json</html>', fingerprint: 'f'.repeat(64), meta: { kind: 'workday_job' } }, null);
  const first = await extractStage(ctx, { limit: 10 });
  assert.equal(first.counts.error_extract, 1);
  assert.equal((await store.pendingCaptures(10)).length, 0);
  assert.equal(store.extractions.find(e => e.status === 'dead_letter').method, 'structured');
});

test('round 2: an unconfirmed website guess is not stored on the review item, so approving cannot create a wrong website', async () => {
  const { ctx, store } = world({ tregOpts: { unconfirmed: ['Birchway Logistics Corp'] } });
  await run(ctx, 'weekly');
  const item = store.reviews.find(r => r.candidate_name.startsWith('Birchway'));
  assert.equal(item.candidate_domain, null);
});

test('round 2: the daily plan does not run weekly sources (paid treg feeds keep their frequency)', async () => {
  const treg = worldTreg({ extra: { 'tikhub.x.reddit-app-fetch-subreddit-feed': () => ({ ok: true, status: 200, body: { data: [] }, cost_usd: 0.001, call_id: 'r' }) } });
  const { ctx, store } = world({ treg });
  store.sourceRows.find(s => s.id === 'treg-reddit-workday').enabled = true;
  await run(ctx, 'daily');
  assert.equal(treg.calls.filter(c => c.endpoint.startsWith('tikhub')).length, 0);
  await run(ctx, 'weekly');
  assert.equal(treg.calls.filter(c => c.endpoint.startsWith('tikhub')).length, 1);
});

test('round 2: runs left "running" by a crash are closed as failed at the next start, so health shows the truth', async () => {
  const now = clock();
  const { ctx, store } = world({ now });
  await store.startRun({ job: 'collect', source_id: 'workday-career-sites', trigger: 'manual' });
  now.advanceDays(1);
  await run(ctx, 'score');
  const stale = store.runs[0];
  assert.equal(stale.status, 'failed');
  assert.match(stale.error, /did not finish/);
});
