// Why new companies score 13, what filing evidence adds, and how a run reports it. Fictional companies only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFacts, lookupFinancials } from '../../src/pipeline/financials.ts';
import { matchStage, scoreStage } from '../../src/pipeline/stages.ts';
import { eligibleForFreeResearch } from '../../src/pipeline/enrich.ts';
import { defaultSettings } from '../../src/domain/ingestion/settings.ts';
import { clock, makeCtx, response } from './helpers.mjs';

const NOW = new Date('2026-10-26T12:00:00Z');
const NAME = 'Fernhollow Devices Inc';
const SEC_LIST = JSON.stringify({ 0: { title: 'FERNHOLLOW DEVICES INC', cik_str: 4242 }, 1: { title: 'SECOND FICTIONAL WORKS INC', cik_str: 4343 } });
const year = (end, val) => ({ start: `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`, end, val, form: '10-K', filed: `${end.slice(0, 4)}-12-31`, accn: '0000000001-26-000001' });
const usd = rows => ({ units: { USD: rows } });
const FILING = { 'us-gaap': {
  OperatingIncomeLoss: usd([year('2025-12-31', 500000000), year('2024-12-31', 400000000)]),
  Revenues: usd([year('2025-12-31', 2000000000), year('2024-12-31', 1800000000)]),
} };
const signal = extra => ({ type: 'known_customer', signal_date: null, source_url: 'https://fernhollow.example/careers', quote: 'Fernhollow careers on Workday.', confidence: 0.95, first_seen_at: NOW.toISOString(), last_seen_at: NOW.toISOString(), ...extra });
const hiring = signal({ type: 'hiring', signal_date: '2026-10-20', confidence: 0.6, source_url: 'https://fernhollow.wd5.myworkdayjobs.com/job/1', quote: 'Field Technician' });

async function world({ contact = 'pipeline@fictional.example', fetch, secList = SEC_LIST, now = NOW } = {}) {
  const calls = [];
  const ctx = makeCtx({ now: clock(now.toISOString()), fetch: async (url, init) => { calls.push(String(url)); return fetch(url, init); } });
  ctx.contact = contact;
  ctx.sleep = async () => {};
  if (secList) await ctx.store.saveCapture({ source: 'sec-company-list', url: 'https://www.sec.gov/files/company_tickers.json', fetched_at: now.toISOString(), http_status: 200, content_type: 'application/json', raw: secList, fingerprint: 'sec-fixture', meta: {} }, null);
  const id = ctx.store.addExistingCompany({ name: NAME, domain: 'fernhollow.example' });
  ctx.store.companyRows[0].pipeline = true;
  ctx.store.signalsForCompany = async () => [signal(), hiring];
  return { ctx, id, calls };
}
const filed = async () => response(200, { facts: FILING });

test('with no contacts or filing, a customer signal plus an ordinary posting is the 13-point floor, and the run says why', async () => {
  const { ctx, id } = await world({ contact: '', fetch: filed });
  const r = await scoreStage(ctx);
  const row = await ctx.store.latestScore(id);
  assert.deepEqual([row.authority_score, row.reachability_score, row.budget_score, row.release_score, row.timing_score], [0, 0, 0, 8, 5]);
  assert.equal(r.counts.financials_no_contact, 1);
  assert.equal(r.counts.without_contacts, 1);
  assert.deepEqual([r.counts.zero_authority, r.counts.zero_reachability, r.counts.zero_budget], [1, 1, 1]);
  assert.equal(r.counts.zero_release, undefined);
  assert.equal(r.requests, 0);
});

test('a 13-point company is still eligible for free contact research', () => {
  assert.equal(eligibleForFreeResearch([signal(), hiring], defaultSettings, NOW), true);
  const stale = new Date(NOW.getTime() + 15 * 86400000);
  assert.equal(eligibleForFreeResearch([signal(), hiring], defaultSettings, stale), false, 'eligibility lapses once signals go 14 days without a re-sighting');
});

test('filing evidence raises Budget by the rubric points and cites the filing; nothing else changes', async () => {
  const { ctx, id, calls } = await world({ fetch: filed });
  const r = await scoreStage(ctx);
  const row = await ctx.store.latestScore(id);
  assert.equal(row.budget_score, 12, '10 for positive operating income, +1 revenue growth, +1 operating income growth');
  assert.match(row.budget_evidence, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/4242\//);
  assert.deepEqual([row.authority_score, row.reachability_score, row.release_score, row.timing_score], [0, 0, 8, 5]);
  assert.equal(r.counts.financials_found, 1);
  assert.equal(r.requests, 1);
  assert.deepEqual(calls, ['https://data.sec.gov/api/xbrl/companyfacts/CIK0000004242.json']);
});

test('an unprofitable filer earns nothing and has a sourced answer, not an outage', async () => {
  const loss = { 'us-gaap': { OperatingIncomeLoss: usd([year('2025-12-31', -5000000)]) } };
  const { ctx, id } = await world({ fetch: async () => response(200, { facts: loss }) });
  const r = await scoreStage(ctx);
  assert.equal((await ctx.store.latestScore(id)).budget_score, 0);
  assert.equal(r.counts.financials_found, 1);
});

test('filings answer with a reason: no annual facts, no operating income tag, stale tag, under either standard', () => {
  assert.equal(classifyFacts({ dei: {} }, 1, NOW).status, 'no_filing_facts');
  assert.equal(classifyFacts({ 'ifrs-full': { ProfitLoss: usd([year('2025-12-31', 9)]) } }, 1, NOW).status, 'found', 'net income is the last-resort figure');
  assert.equal(classifyFacts({ 'ifrs-full': { ProfitLossFromOperatingActivities: usd([year('2021-12-31', 9)]) } }, 1, NOW).status, 'stale_filing', 'an old operating figure with nothing newer');
  assert.equal(classifyFacts({ 'ifrs-full': { ProfitLossFromOperatingActivities: { units: { EUR: [year('2025-12-31', 9)] } } } }, 1, NOW).status, 'found');
  assert.equal(classifyFacts({ 'us-gaap': { Revenues: usd([year('2025-12-31', 9)]) } }, 1, NOW).status, 'no_operating_income');
  assert.equal(classifyFacts({ 'us-gaap': { OperatingIncomeLoss: usd([year('2020-12-31', 9)]) } }, 1, NOW).status, 'stale_filing');
  assert.equal(classifyFacts(FILING, 1, NOW).status, 'found');
});

test('lookup reasons: no contact, no list, no match, and a 404 is an answer rather than an outage', async () => {
  const noContact = await world({ contact: '', fetch: filed });
  assert.equal((await lookupFinancials(noContact.ctx, NAME)).status, 'no_contact');
  const noList = await world({ fetch: filed, secList: null });
  assert.equal((await lookupFinancials(noList.ctx, NAME)).status, 'no_sec_list');
  assert.equal(noList.calls.length, 0);
  const noMatch = await world({ fetch: filed });
  assert.equal((await lookupFinancials(noMatch.ctx, 'Unlisted Fictional Co')).status, 'no_sec_match');
  const missing = await world({ fetch: async () => response(404, {}) });
  assert.equal((await lookupFinancials(missing.ctx, NAME)).status, 'no_filing_facts');
});

for (const [label, fetch] of [['HTTP 503', async () => response(503, {})], ['a network error', async () => { throw Error('socket closed'); }]]) {
  test(`after ${label}, the saved score is kept and no further SEC calls are made`, async () => {
    const first = await world({ fetch: filed });
    await scoreStage(first.ctx);
    const saved = await first.ctx.store.latestScore(first.id);
    assert.equal(saved.budget_score, 12);

    // Same store, new run, SEC down. A second listed company proves the stop.
    const later = makeCtx({ store: first.ctx.store, now: clock(NOW.toISOString()), fetch: async (url, init) => { calls.push(String(url)); return fetch(url, init); } });
    const calls = [];
    later.contact = 'pipeline@fictional.example'; later.sleep = async () => {};
    first.ctx.store.addExistingCompany({ name: 'Second Fictional Works Inc', domain: 'second.example' });
    first.ctx.store.companyRows[1].pipeline = true;
    const before = first.ctx.store.scores.length;
    const r = await scoreStage(later);
    assert.equal((await first.ctx.store.latestScore(first.id)).budget_score, 12, 'an outage must not lower Budget');
    assert.equal(first.ctx.store.scores.length, before + 1, 'only the never-scored company gets a row');
    assert.equal(r.counts.financials_deferred, 1);
    assert.equal(r.counts.financials_fetch_failed, 2);
    assert.equal(calls.length, 1, 'the first failure stops further SEC calls');
  });
}

test('a run without a contact does not undo filing evidence saved by an earlier run', async () => {
  const first = await world({ fetch: filed });
  await scoreStage(first.ctx);
  const later = makeCtx({ store: first.ctx.store, now: clock(NOW.toISOString()), fetch: filed });
  later.contact = '';
  const r = await scoreStage(later);
  assert.equal((await first.ctx.store.latestScore(first.id)).budget_score, 12);
  assert.equal(r.counts.financials_deferred, 1);
});

test('when the saved score has no capacity to lose, an outage does not block new evidence', async () => {
  const first = await world({ contact: '', fetch: filed });
  await scoreStage(first.ctx);
  const before = first.ctx.store.scores.length;
  first.ctx.store.signalsForCompany = async () => [signal(), signal({ type: 'hiring', signal_date: '2026-10-20', confidence: 0.9, source_url: 'https://fernhollow.wd5.myworkdayjobs.com/job/2', quote: 'Workday Analyst' })];
  const r = await scoreStage(first.ctx);
  assert.equal(first.ctx.store.scores.length, before + 1);
  assert.equal((await first.ctx.store.latestScore(first.id)).timing_score, 8);
  assert.equal(r.counts.financials_deferred, undefined);
});

test('a store failure while saving leaves the stage with no reported work, so it still fails', async () => {
  const { ctx } = await world({ contact: '', fetch: filed });
  ctx.store.insertScore = async () => { throw Error('database down'); };
  const r = await scoreStage(ctx);
  assert.deepEqual(r.counts, { error_score: 1 });
});

test('match reports one short hash per candidate and never the name', async () => {
  const ctx = makeCtx({ now: clock(NOW.toISOString()) });
  const groups = [{ id: 's1', company_name: 'Hash Fixture Works Inc', confidence: 0.6, type: 'hiring', source_url: 'https://hash.example/job', quote: 'x', last_seen_at: NOW.toISOString() }];
  ctx.store.unassignedSignals = async () => groups;
  ctx.store.assignSignals = async () => {};
  const r = await matchStage(ctx, { dryRun: true });
  assert.equal(r.counts.candidates, 1);
  assert.equal(r.candidate_keys.length, 1);
  assert.match(r.candidate_keys[0], /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(r.candidate_keys).toLowerCase().includes('hash fixture'));
});

test('a name the SEC list lacks falls through to nonprofit returns; a miss keeps the SEC answer; an SEC match never reaches them', async () => {
  const { nonprofitPacing } = await import('../../src/pipeline/financials-nonprofit.ts');
  const { pacing } = await import('../../src/pipeline/financials-foreign.ts');
  nonprofitPacing.ms = 0; pacing.gapMs = 0;
  const ret = (tax_prd, rev, exp) => ({ tax_prd, totrevenue: rev, totfuncexpns: exp, pdf_url: `https://example.org/${tax_prd}.pdf` });
  const answer = (orgs) => async (url) => String(url).includes('propublica')
    ? (String(url).includes('search.json') ? response(200, { organizations: orgs }) : response(200, { filings_with_data: [ret(202212, 8e9, 8.1e9), ret(202312, 9e9, 8.5e9)] }))
    : String(url).includes('filings.xbrl.org') ? response(200, { data: [] }) : response(404, {});
  const hit = await world({ fetch: answer([{ ein: 1, name: 'BANNER HEALTH' }]) });
  const found = await lookupFinancials(hit.ctx, 'Banner Health');
  assert.deepEqual([found.status, found.financials.surplus, found.financials.matched_name, found.financials.operating_income], ['found', true, 'BANNER HEALTH', 5e8]);
  assert.equal(found.requests, 2, 'the SEC list had no match, so only the nonprofit lookup made requests');
  const miss = await world({ fetch: answer([]) });
  assert.equal((await lookupFinancials(miss.ctx, 'Unlisted Fictional Co')).status, 'no_sec_match');
  const sec = await world({ fetch: filed });
  const viaSec = await lookupFinancials(sec.ctx, NAME);
  assert.equal(viaSec.status, 'found');
  assert.deepEqual(sec.calls, ['https://data.sec.gov/api/xbrl/companyfacts/CIK0000004242.json']);
});

test('non-SEC sources are asked for a new company, then not again until its saved score is due; a saved capacity is never dropped for it', async () => {
  const { nonprofitPacing } = await import('../../src/pipeline/financials-nonprofit.ts');
  const { universityPacing } = await import('../../src/pipeline/financials-university.ts');
  const { pacing } = await import('../../src/pipeline/financials-foreign.ts');
  nonprofitPacing.ms = 0; universityPacing.ms = 0; pacing.gapMs = 0;
  const external = url => /propublica|urban|xbrl\.org|wikidata/.test(String(url));
  let externalCalls = 0;
  const answer = async url => {
    if (!external(url)) return response(404, {});
    externalCalls++;
    return String(url).includes('propublica') ? response(200, { organizations: [] }) : String(url).includes('urban') ? response(200, { results: [] }) : response(200, { data: [] });
  };
  const w = await world({ fetch: answer, secList: JSON.stringify({ 0: { title: 'SOMEONE ELSE INC', cik_str: 1 } }) });
  const first = await scoreStage(w.ctx);
  assert.equal(first.counts.scored, 1);
  assert.ok(externalCalls > 0, 'a company with no saved score asks the non-SEC sources');
  const before = externalCalls;
  const second = await scoreStage(w.ctx);
  assert.equal(externalCalls, before, 'inside the 14-day window the non-SEC sources are not asked again');
  assert.equal(second.counts.financials_external_skipped, 1);
  assert.equal(second.counts.unchanged, 1, 'nothing changed, so no new score row');
});

test('lookupFinancials: skipExternal returns "external_skipped" (unavailable) only when the SEC list has no match', async () => {
  const { financialsUnavailable } = await import('../../src/pipeline/financials.ts');
  const a = await world({ fetch: async () => response(404, {}), secList: JSON.stringify({ 0: { title: 'OTHER INC', cik_str: 1 } }) });
  const skipped = await lookupFinancials(a.ctx, 'Unlisted Fictional Co', null, { skipExternal: true });
  assert.deepEqual([skipped.status, skipped.requests, skipped.financials], ['external_skipped', 0, null]);
  assert.equal(financialsUnavailable('external_skipped'), true);
  const b = await world({ fetch: filed });
  const viaSec = await lookupFinancials(b.ctx, NAME, null, { skipExternal: true });
  assert.equal(viaSec.status, 'found', 'an SEC match is looked up regardless');
});
