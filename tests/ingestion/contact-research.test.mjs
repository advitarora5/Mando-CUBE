import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleForFreeResearch, enrichStage, PEOPLE_SEARCH, EMAIL_FIND, FOCUSED_TITLE_PHRASES, TITLE_PHRASES } from '../../src/pipeline/enrich.ts';
import { contactReviewsSchema } from '../../src/pipeline/contact-review.ts';
import { CONTACT_EVIDENCE_SEARCH, reviewIndexedContact } from '../../src/pipeline/contact-verification.ts';
import { scoreStage } from '../../src/pipeline/stages.ts';
import { scoreCompany } from '../../src/domain/ingestion/pipeline-score.ts';
import { defaultSettings } from '../../src/domain/ingestion/settings.ts';
import { makeCtx, clock, fakeTreg, worldTreg } from './helpers.mjs';

const NOW = new Date('2026-10-13T12:00:00Z');
const signal = extra => ({ type: 'known_customer', signal_date: null, source_url: 'https://employer.example/workday', quote: 'Our company uses Workday HCM.', confidence: 0.95, first_seen_at: NOW.toISOString(), last_seen_at: NOW.toISOString(), ...extra });
async function world({ signals = [signal()], treg = worldTreg(), ready = false } = {}) {
  const ctx = makeCtx({ now: clock(NOW.toISOString()), treg, caps: { treg: 1, llm: 0 } });
  const id = ctx.store.addExistingCompany({ name: 'Research Company', domain: 'research.example' });
  ctx.store.companyRows[0].pipeline = true;
  ctx.store.signalsForCompany = async () => signals;
  if (ready) ctx.store.settingsRows = [{ key: 'ready_for_contacts_threshold', value: 0 }];
  const score = scoreCompany(id, signals, [], defaultSettings, NOW);
  await ctx.store.insertScore(score.result.row, NOW.toISOString());
  return { ctx, id };
}

test('fresh sourced customer/hiring evidence unlocks research at any stored confidence; stale, future or missing evidence does not', () => {
  assert.equal(eligibleForFreeResearch([signal()], defaultSettings, NOW), true);
  assert.equal(eligibleForFreeResearch([signal({ type: 'hiring' })], defaultSettings, NOW), true);
  assert.equal(eligibleForFreeResearch([signal({ confidence: 0.6 })], defaultSettings, NOW), true);
  for (const extra of [{ type: 'event' }, { confidence: 2 }, { source_url: 'https://' }, { quote: ' ' }, { last_seen_at: '2020-01-01' }, { last_seen_at: '2027-01-01' }, { last_seen_at: 'invalid' }]) {
    assert.equal(eligibleForFreeResearch([signal(extra)], defaultSettings, NOW), false, JSON.stringify(extra));
  }
});

test('below 25 points, free research finds unconfirmed contacts and rescoring retains source links without paid email', async () => {
  const { ctx, id } = await world();
  const first = await ctx.store.latestScore(id);
  assert.ok(first.budget_score + first.release_score + first.timing_score < 25);
  const result = await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(result.counts.contacts_added, 1);
  assert.equal(ctx.treg.calls.filter(c => c.endpoint === EMAIL_FIND).length, 0, 'even with an available $1 paid cap');
  const contacts = await ctx.store.contactsForCompany(id);
  assert.equal(contacts[0].linkedin_status, 'unconfirmed');
  const latest = await ctx.store.latestScore(id);
  assert.equal(latest.authority_score, 5);
  assert.equal(latest.reachability_score, 0);
  assert.match(latest.authority_evidence, /https:\/\/www.linkedin.com\/in\/pat-lee-test/);
  assert.equal(ctx.store.scores.length, 2);
  const calls = ctx.treg.calls.length;
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(ctx.treg.calls.length, calls, 'contact research is reused on repeat runs');
});

test('paid lookup still requires readiness and budget; raising readiness eligibility later resumes deferred work', async () => {
  const { ctx } = await world();
  await enrichStage(ctx, { maxCompanies: 1 });
  ctx.store.settingsRows = [{ key: 'ready_for_contacts_threshold', value: 0 }];
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(ctx.treg.calls.filter(c => c.endpoint === EMAIL_FIND).length, 1);
});

test('eligible research with no provider stays pending; scope, terminal status and zero-item cap are respected', async () => {
  const { ctx, id } = await world({ treg: null });
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(await ctx.store.enrichmentStatus(id), 'pending');
  assert.equal((await ctx.store.contactsForCompany(id)).length, 0);
  for (const state of ['out_of_scope', 'done', 'no_contacts_found', 'zero_cap']) {
    const { ctx, id } = await world();
    if (state === 'out_of_scope') ctx.store.companyRows[0].pipeline = false;
    else if (state !== 'zero_cap') await ctx.store.setEnrichment(id, state, 'fixture');
    await enrichStage(ctx, { maxCompanies: state === 'zero_cap' ? 0 : 1 });
    assert.equal(ctx.treg.calls.length, 0, state);
  }
});

test('temporary provider errors remain pending and succeed on a later run', async () => {
  const { ctx, id } = await world({ treg: worldTreg({ extra: { [PEOPLE_SEARCH]: () => ({ ok: false, status: 503, cost_usd: 0, error: 'temporary outage' }) } }) });
  const first = await enrichStage(ctx, { maxCompanies: 1 });
  assert.ok(first.errors.length);
  assert.equal(await ctx.store.enrichmentStatus(id), 'pending');
  ctx.treg = worldTreg();
  const second = await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(second.counts.contacts_added, 1);
});

test('auth/rate errors and nonzero-cost free responses stop further calls and save no contacts', async () => {
  for (const response of [{ ok: false, status: 401, cost_usd: 0, error: 'auth' }, { ok: false, status: 429, cost_usd: 0, error: 'rate limit' }, { ok: true, status: 200, cost_usd: 0.01, body: { data: [] }, call_id: 'unexpected' }]) {
    const { ctx, id } = await world({ treg: worldTreg({ extra: { [PEOPLE_SEARCH]: () => response } }) });
    const result = await enrichStage(ctx, { maxCompanies: 2 });
    assert.ok(result.blocked);
    assert.equal((await ctx.store.contactsForCompany(id)).length, 0);
    assert.equal(await ctx.store.enrichmentStatus(id), 'pending');
    assert.equal(ctx.treg.calls.filter(c => c.endpoint === PEOPLE_SEARCH).length, 1);
  }
});

test('free calls request zero cost and no paid fallback; zero budget still permits research but not email', async () => {
  const { ctx } = await world({ ready: true });
  ctx.spend = makeCtx({ caps: { treg: 0, llm: 0 } }).spend;
  const result = await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(result.counts.contacts_added, 1);
  const call = ctx.treg.calls.find(c => c.endpoint === PEOPLE_SEARCH);
  assert.equal(call.opts.headers['X-Treg-Route-Max-Cost'], '0');
  assert.equal(call.opts.headers['X-Treg-Route-Waterfall'], '0');
  assert.equal(ctx.treg.calls.filter(c => c.endpoint === EMAIL_FIND).length, 0);
});

const profile = slug => `https://www.linkedin.com/in/${slug}`;
const person = (last_name, title) => ({ first_name: 'Pat', last_name, title, employee_linkedin: profile(last_name) });
const review = (slug, result) => ({
  company_domain: 'research.example', linkedin_url: profile(slug),
  reviewed_on: '2026-10-13', source: 'https://research.example/speakers', ...result,
});
const peopleResult = data => ({ ok: true, status: 200, body: { data }, cost_usd: 0, call_id: 'free' });
const indexedResult = results => ({ ok: true, status: 200, body: { results }, cost_usd: 0, call_id: 'index' });
const workdayPost = date => `https://www.linkedin.com/posts/workday_conference-activity-${BigInt(Date.parse(date)) << 22n}-abc`;

test('automatic evidence promotes a leader below the title cutoff and removes a stale employer before selecting three', async () => {
  const leader = person('leader', 'VP of Global HR Service Delivery');
  const former = { ...person('former', 'SVP Workday Technology'), employee_linkedin: profile('former-123ab45') };
  const contacts = [...Array.from({ length: 21 }, (_, i) => person(`architect-${i}`, 'Workday Architect')), former, leader];
  const treg = fakeTreg({
    [PEOPLE_SEARCH]: () => peopleResult(contacts),
    [CONTACT_EVIDENCE_SEARCH]: ({ query }) => indexedResult(
      query.query.startsWith('"pat leader"') ? [
        { url: profile('leader'), title: 'Pat Leader - Research', snippet: 'VP of Global HR Service Delivery at Research Company.' },
        { url: workdayPost('2026-09-12'), title: 'Conference | Workday', snippet: 'Pat Leader, VP, Global HR Service Delivery at Research Company, will speak.' },
      ] : query.query.startsWith('"pat former"') ? [
        { url: profile('former'), title: 'Pat Former - New Employer', snippet: 'Chicago · Director of Technology · New Employer. Research Company Jun 2020 - Apr 2022.' },
      ] : []),
  });
  const { ctx, id } = await world({ treg });
  const result = await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(result.counts.people_candidates, 23);
  assert.equal(result.counts.contacts_auto_verified, 1);
  assert.equal(result.counts.contacts_employer_mismatch, 1);
  assert.equal(treg.calls.filter(call => call.endpoint === CONTACT_EVIDENCE_SEARCH).length, 5);
  const saved = await ctx.store.contactsForCompany(id);
  assert.equal(saved.length, 3);
  assert.equal(saved[0].linkedin_url, profile('leader'));
  assert.equal(saved[0].contact_sources.role_review.method, 'public_search_index');
  assert.ok(!saved.some(contact => contact.linkedin_url === former.employee_linkedin));
  const latest = await ctx.store.latestScore(id);
  assert.deepEqual([latest.authority_score, latest.reachability_score], [18, 10]);
});

test('indexed role confirmation needs an exact profile and recent independent attribution', () => {
  const candidate = { name: 'Pat Leader', title: 'VP of Global HR Service Delivery', profile: profile('leader') };
  const company = { name: 'Research Company', domain: 'research.example' };
  const own = { url: candidate.profile, title: 'Pat Leader - Research', snippet: 'VP of Global HR Service Delivery at Research Company.' };
  const post = { url: workdayPost('2026-09-12'), title: 'Conference | Workday', snippet: 'Pat Leader, VP, Global HR Service Delivery at Research Company, will speak.' };
  for (const results of [
    [own], [post], [{ ...own, url: profile('somebody-else') }, post],
    [own, { ...post, url: workdayPost('2024-09-12') }],
    [own, { ...post, url: post.url.replace('/workday_', '/pat-leader_') }],
    [own, { ...post, snippet: 'Pat Leader will join VP, Global HR Service Delivery at Research Company.' }],
  ]) assert.equal(reviewIndexedContact({ results }, candidate, company, NOW), null);
  const owns = { ...post, snippet: 'Pat Leader, VP, Global HR Service Delivery at Research Company, where they lead the Workday roadmap.' };
  const verified = reviewIndexedContact({ results: [own, owns] }, candidate, company, NOW);
  assert.equal(verified?.workday_source, owns.url);
});

test('focused search ranks independently reviewed leadership above title matches and excludes a former employee', async () => {
  const people = [
    person('former', 'VP Workday'), person('one', 'Workday Manager'),
    person('two', 'Workday Architect'), person('three', 'Lead Workday Analyst'),
    person('reviewed', 'VP Human Resources'),
  ];
  const treg = fakeTreg({ [PEOPLE_SEARCH]: () => peopleResult(people) });
  const { ctx, id } = await world({ treg });
  ctx.contactReviews = contactReviewsSchema.parse([
    review('former', { status: 'different_employer' }),
    review('reviewed', { status: 'confirmed', title: 'Vice President, HR Service Delivery' }),
  ]);
  const result = await enrichStage(ctx, { maxCompanies: 1 });
  assert.deepEqual(treg.calls.filter(call => call.endpoint === PEOPLE_SEARCH).map(call => call.opts.body.title.include), [FOCUSED_TITLE_PHRASES]);
  assert.equal(result.counts.contacts_confirmed, 1);
  const contacts = await ctx.store.contactsForCompany(id);
  assert.equal(contacts.length, 3);
  assert.ok(!contacts.some(contact => contact.linkedin_url === profile('former')));
  assert.equal(contacts[0].linkedin_url, profile('reviewed'));
  const latest = await ctx.store.latestScore(id);
  assert.deepEqual([latest.authority_score, latest.reachability_score], [18, 10]);
  assert.match(latest.authority_evidence, /research\.example\/speakers/);
});

test('an empty focused search falls back to broad titles and later reviews update only the matched contacts', async () => {
  const treg = fakeTreg({ [PEOPLE_SEARCH]: ({ body }) => peopleResult(body.title.include === FOCUSED_TITLE_PHRASES
    ? [] : [person('reviewed', 'HR Manager'), person('former', 'VP Workday')]) });
  const { ctx, id } = await world({ treg });
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.deepEqual(treg.calls.filter(call => call.endpoint === PEOPLE_SEARCH).map(call => call.opts.body.title.include), [FOCUSED_TITLE_PHRASES, TITLE_PHRASES]);
  ctx.contactReviews = contactReviewsSchema.parse([
    review('former', { status: 'different_employer' }),
    review('reviewed', { status: 'confirmed', title: 'Director, HRIS' }),
  ]);
  ctx.treg = null;
  const second = await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(second.counts.contacts_confirmed, 1);
  assert.equal(second.counts.contacts_employer_mismatch, 1);
  const latest = await ctx.store.latestScore(id);
  assert.deepEqual([latest.authority_score, latest.reachability_score], [20, 10]);
  const count = ctx.store.scores.length;
  await enrichStage(ctx, { maxCompanies: 1 });
  assert.equal(ctx.store.scores.length, count);
  const contacts = await ctx.store.contactsForCompany(id);
  const expired = scoreCompany(id, [], contacts, defaultSettings, new Date('2027-01-12T12:00:00Z'));
  assert.deepEqual([expired.categories.authority.score, expired.categories.reachability.score], [5, 0]);
});

test('24 readiness points suppress email, while 25 permit a budgeted verified route and immediate rescore', async () => {
  for (const budget of [11, 12]) {
    const { ctx, id } = await world();
    ctx.contact = 'fixture@example.com';
    ctx.store.latestCapture = async () => ({ body: JSON.stringify({ 0: { title: 'Research Company', cik_str: 123 } }) });
    const fact = (year, val) => ({ start: `${year}-01-01`, end: `${year}-12-31`, val, form: '10-K', filed: '2026-02-01', accn: '0000000123-26-000001' });
    ctx.fetch = async () => Response.json({ facts: { 'us-gaap': {
      OperatingIncomeLoss: { units: { USD: [fact(2025, 100), fact(2024, budget === 12 ? 90 : 110)] } },
      Revenues: { units: { USD: [fact(2025, 200), fact(2024, 190)] } },
    } } });
    await scoreStage(ctx);
    const previous = await ctx.store.latestScore(id);
    assert.equal(previous.budget_score + previous.release_score + previous.timing_score, budget + 13);
    const result = await enrichStage(ctx, { maxCompanies: 1 });
    assert.equal(ctx.treg.calls.filter(call => call.endpoint === EMAIL_FIND).length, budget === 12 ? 1 : 0);
    assert.equal(result.counts.email_valid ?? 0, budget === 12 ? 1 : 0);
    assert.equal((await ctx.store.latestScore(id)).reachability_score, budget === 12 ? 15 : 0);
  }
});
