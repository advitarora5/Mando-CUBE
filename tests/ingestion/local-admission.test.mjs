// Admission policy and local-only boundary regression tests; no live provider calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMatch } from '../../src/domain/ingestion/matching.ts';
import { assertLocalAdmissionUrl, assertLocalAdmissionStore, localIdentityAdmission, confirmedCorporateDomain, namesakeGuess, targetNameWritten } from '../../src/pipeline/local-identity-admission.ts';
import { digest } from '../../src/pipeline/identity.ts';
import { SupabaseStore } from '../../src/pipeline/store/supabase.ts';
import { makeCtx } from './helpers.mjs';

const candidate = { name: 'Example Industries', domain: 'example.com', domain_confirmed: true, workday_verified: true };
test('AI-confirmed parent and careers subdomain agree, while unrelated domains remain ambiguous', () => {
  assert.equal(confirmedCorporateDomain(['bankofamerica.com', 'careers.bankofamerica.com']), 'bankofamerica.com');
  assert.equal(confirmedCorporateDomain(['careers.bankofamerica.com', 'bankofamerica.com']), 'bankofamerica.com');
  assert.equal(confirmedCorporateDomain(['blackrock.com', 'blackstone.com']), null);
  assert.equal(confirmedCorporateDomain(['careers.example.com', 'investor.example.com']), null);
  assert.equal(confirmedCorporateDomain([]), null);
});
test('admission is a yes/no on the verified Workday connection and corporate website', () => {
  assert.equal(decideMatch(candidate, [], { canCreate: true }).action, 'create');
  assert.equal(decideMatch({ ...candidate, workday_verified: false }, [], { canCreate: true }).reason, 'untrusted_signal');
});
test('admission keeps duplicate review, run caps and unconfirmed-input holds', () => {
  const room = { canCreate: true };
  assert.equal(decideMatch({ ...candidate, domain_confirmed: false }, [], room).reason, 'no_website');
  assert.equal(decideMatch(candidate, [], { ...room, canCreate: false }).reason, 'over_run_cap');
  const known = [{ id: 'existing', name: 'Example Industries', domain: 'other.example' }];
  assert.equal(decideMatch(candidate, known, room).reason, 'similar_name');
  assert.equal(decideMatch(candidate, [{ ...known[0], domain: 'example.com' }], room).action, 'attach');
});
test('local admission rejects remote endpoints, embedded credentials and ambiguous loopback URLs', () => {
  for (const value of ['https://remote.supabase.co', 'http://localhost', 'http://user:pass@localhost:54321',
    'http://localhost:54321/other', 'http://localhost:54321/?override=1', 'http://localhost.attacker.com:54321']) {
    assert.throws(() => assertLocalAdmissionUrl(value));
  }
  assert.doesNotThrow(() => assertLocalAdmissionUrl('http://127.0.0.1:54321'));
  assert.throws(() => assertLocalAdmissionStore({ store: { kind: 'memory' } }));
  const remote = new SupabaseStore('https://experiment.supabase.co', 'test-key', 'experiment');
  assert.throws(() => assertLocalAdmissionStore({ store: remote }));
});
test('a remote Ollama endpoint is rejected before network calls or artifacts', async () => {
  const store = new SupabaseStore('http://127.0.0.1:54321', 'test-key');
  await assert.rejects(() => localIdentityAdmission({ store, fetch: () => { throw Error('unexpected network call'); } }, [{ name: 'Example' }],
    { host: 'https://hosted.example', model: 'qwen2.5:7b', maxChecks: 1, save: () => { throw Error('unexpected artifact'); } }));
});

// ---- the real admission loop with frozen evidence and a fake local model; every name is fictional ----
const FETCHED = new Date('2026-10-13T12:00:00Z').toISOString();
const site = (name, extra = {}) => ({ id: name, tenant: 'fernhill', pod: 'wd5', site: name, normalized_name: 'fernhill electric', enabled: true, match_kind: 'full_name', review_item_id: null, ...extra });
function evidence(id, url, siteRow, corporateText, workdayText) {
  const source = (sourceId, side, sourceUrl, text) => ({ id: sourceId, side, url: sourceUrl, text, fetched_at: FETCHED, content_hash: digest(text), capture_id: null, identity_groups: [] });
  return { id, target_name: 'FERNHILL ELECTRIC CO', corporate_url: url, review_id: null, prepared_at: FETCHED, errors: [],
    site: { tenant: siteRow.tenant, pod: siteRow.pod, site: siteRow.site },
    sources: [source('c', 'corporate', url, corporateText),
      source('w', 'workday', `https://${siteRow.tenant}.${siteRow.pod}.myworkdayjobs.com/wday/cxs/${siteRow.tenant}/${siteRow.site}/job/Role_1`, workdayText)] };
}
const answer = (verdict, sources) => ({ corporate_identity: ['Fernhill'], workday_identity: ['Fernhill'], corporate_name: 'Fernhill', workday_name: 'Fernhill',
  shared_name: verdict === 'same_company' ? 'Fernhill' : null, business: { corporate: null, workday: null }, supporting_factors: [],
  contradictions: verdict === 'same_company' ? [] : ['Different organizations'], uncertainties: [], verdict, explanation: 'Fictional test verdict.',
  evidence: { corporate: [{ source_id: sources.find(s => s.side === 'corporate').id, excerpt_index: 0 }], workday: [{ source_id: sources.find(s => s.side === 'workday').id, excerpt_index: 0 }] } });
async function admit({ sites, packets, verdicts, maxChecks = 3, http = null, corporate_urls, refs = [], name = 'FERNHILL ELECTRIC CO' }) {
  const store = new SupabaseStore('http://127.0.0.1:54321', 'test-key');
  const empty = { select: () => empty, eq: () => empty, gte: () => empty, order: () => empty, limit: async () => ({ data: [], error: null }) };
  Object.assign(store, { db: { from: () => empty }, workdaySites: async () => sites, reviewItems: async () => [], companies: async () => [], websiteResolution: async () => null });
  let calls = 0;
  const ctx = makeCtx({ store, fetch: async (url, init) => {
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b', digest: 'fictional' }] }));
    const verdict = verdicts[Math.min(calls++, verdicts.length - 1)];
    const { sources } = JSON.parse(JSON.parse(init.body).messages[1].content);
    return new Response(JSON.stringify({ message: { content: JSON.stringify(answer(verdict, sources)) } }));
  } });
  const policy = await localIdentityAdmission(ctx, [{ name, corporate_urls }], { host: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', maxChecks, packets, save: () => {} });
  return { result: await policy.resolve(ctx, name, sites, http, refs), calls: () => calls };
}
// Live evidence collection with fake pages. `pages` maps a URL to its HTML or to the error it fails with.
function fakeHttp(pages) {
  const fetched = [];
  return { fetched, page: async url => {
    fetched.push(url);
    const body = pages[url] ?? 'getaddrinfo ENOTFOUND';
    if (!body.startsWith('<')) throw Error(body);
    return { url, html: body };
  }, json: async (url, body) => {
    const data = body ? { jobPostings: [{ externalPath: '/job/Role_1' }] } : { jobPostingInfo: { title: 'Technician', jobDescription: 'Fernhill is hiring a technician.' } };
    return { url, raw: JSON.stringify(data), data };
  } };
}
const named = '<html><title>Fernhill Electric</title><body>Fernhill Electric builds switchgear.</body></html>';

test('first-word guess: a true site match does not admit a candidate whose name is not in the evidence', async () => {
  // Fictional version of a real pending case: an electric company guessed onto a college's Workday tenant.
  const row = site('Staff', { match_kind: 'first_word' });
  const { result } = await admit({ sites: [row], verdicts: ['same_company'], packets: [evidence('a', 'https://fernhill.example/', row,
    'Fernhill College offers undergraduate degrees.', 'Fernhill College is hiring an admissions officer.')] });
  assert.equal(result.status, 'unresolved'); assert.equal(result.domain, null);
  assert.match(result.reason, /first-word guess/);
});

test('first-word guess: admitted once the corporate page carries the candidate name', async () => {
  const row = site('Staff', { match_kind: 'first_word' });
  const { result } = await admit({ sites: [row], verdicts: ['same_company'], packets: [evidence('a', 'https://fernhill.example/', row, 'Fernhill Electric Company builds switchgear.', 'Fernhill is hiring a technician.')] });
  assert.equal(result.status, 'confirmed'); assert.equal(result.domain, 'fernhill.example');
});

test('first-word guess: the name on the Workday side alone does not tie a namesake website to the candidate', async () => {
  // Fictional version of a real false admission: a ministry's .org shared one word with the employer's postings.
  const row = site('Staff', { match_kind: 'first_word' });
  const { result } = await admit({ sites: [row], verdicts: ['same_company'], packets: [evidence('a', 'https://fernhill.example/', row, 'Fernhill International runs a charity.', 'Fernhill Electric Co is hiring a technician.')] });
  assert.equal(result.status, 'unresolved');
  assert.match(result.reason, /first-word guess/);
});

test('a same-name .org guess is skipped when the .com exists but blocks us, and tried when the .com does not exist', async () => {
  const urls = ['https://fernhill.com/', 'https://fernhill.org/'], org = 'https://fernhill.org/';
  const blocked = fakeHttp({ 'https://fernhill.com/': 'website HTTP 403', [org]: named });
  const held = await admit({ sites: [site('Staff')], verdicts: ['same_company'], http: blocked, corporate_urls: urls, name: 'Fernhill Health' });
  assert.equal(held.result.status, 'unresolved');
  assert.ok(!blocked.fetched.includes(org), 'the namesake was never read');
  assert.equal(held.calls(), 0);

  const missing = fakeHttp({ 'https://fernhill.com/': 'getaddrinfo ENOTFOUND fernhill.com', [org]: named });
  const found = await admit({ sites: [site('Staff')], verdicts: ['same_company'], http: missing, corporate_urls: urls, name: 'Fernhill Health' });
  assert.equal(found.result.status, 'confirmed'); assert.equal(found.result.domain, 'fernhill.org');
});

test('a guessed .org or .edu is never checked for a name with a legal form, even when the .com does not exist', async () => {
  // Fictional version of a real model error: it accepted a ministry's .org for a software company sharing one word.
  for (const suffix of ['org', 'edu']) {
    const url = `https://fernhill.${suffix}/`;
    const http = fakeHttp({ 'https://fernhill.com/': 'getaddrinfo ENOTFOUND fernhill.com', [url]: named });
    const { result, calls } = await admit({ sites: [site('Staff')], verdicts: ['same_company'], http, corporate_urls: ['https://fernhill.com/', url] });
    assert.equal(result.status, 'unresolved'); assert.equal(result.domain, null);
    assert.ok(!http.fetched.includes(url), 'the namesake was never read');
    assert.equal(calls(), 0);
  }
});

test('a legal-form name on an .org stays possible when evidence observed the site, not just guessed it', async () => {
  const http = fakeHttp({ 'https://fernhill.org/': named });
  const { result } = await admit({ sites: [site('Staff')], verdicts: ['same_company'], http, refs: [{ domain: 'fernhill.org', url: 'https://fernhill.org/', source_url: 'https://x.example/' }] });
  assert.equal(result.status, 'confirmed'); assert.equal(result.domain, 'fernhill.org');
});

test('the legal-form rule reads whole words: "co" inside a name is not a legal form', () => {
  assert.equal(namesakeGuess('https://cadence.org/', 'Cadence Design Systems Inc'), true);
  assert.equal(namesakeGuess('https://emerson.edu/', 'EMERSON ELECTRIC CO'), true);
  assert.equal(namesakeGuess('https://cadence.com/', 'Cadence Design Systems Inc'), false);
  assert.equal(namesakeGuess('https://allinahealth.org/', 'Allina Health'), false);
  assert.equal(namesakeGuess('https://costco.org/', 'Cocoa Costco Foundation'), false);
});

test('once a site is confirmed, remaining guesses are not checked', async () => {
  const http = fakeHttp({ 'https://fernhill.com/': named, 'https://fernhillelectric.com/': named });
  const { result, calls } = await admit({ sites: [site('Staff')], verdicts: ['same_company'], http, corporate_urls: ['https://fernhill.com/', 'https://fernhillelectric.com/'] });
  assert.equal(result.domain, 'fernhill.com');
  assert.equal(calls(), 1);
  assert.deepEqual(http.fetched, ['https://fernhill.com/']);
});

test('after a careers subdomain is confirmed, its parent is still checked and becomes the company domain', async () => {
  const http = fakeHttp({ 'https://careers.fernhill.com/': named, 'https://fernhill.com/': named });
  const refs = [{ domain: 'careers.fernhill.com' }];
  const { result, calls } = await admit({ sites: [site('Staff')], verdicts: ['same_company'], http, refs, corporate_urls: ['https://fernhill.com/'] });
  assert.equal(result.domain, 'fernhill.com');
  assert.equal(calls(), 2);
});

test('a careers host in the evidence leads to its parent even when no guess names it, and the parent becomes the company domain', async () => {
  // Fictional version of a real case: the company stored a jobs subdomain because nothing proposed the corporate site itself.
  const http = fakeHttp({ 'https://jobs.fernhillgroup.com/': named, 'https://fernhillgroup.com/': named });
  const { result, calls } = await admit({ sites: [site('Staff')], verdicts: ['same_company'], http, refs: [{ domain: 'jobs.fernhillgroup.com' }], corporate_urls: ['https://fernhill.com/'] });
  assert.equal(result.domain, 'fernhillgroup.com');
  assert.equal(calls(), 2);
});

test('a careers host stays the company domain only when its parent cannot be confirmed', async () => {
  const http = fakeHttp({ 'https://jobs.fernhillgroup.com/': named, 'https://fernhillgroup.com/': 'website HTTP 403' });
  const { result } = await admit({ sites: [site('Staff')], verdicts: ['same_company'], http, refs: [{ domain: 'jobs.fernhillgroup.com' }], corporate_urls: ['https://fernhill.com/'] });
  assert.equal(result.domain, 'jobs.fernhillgroup.com');
});

test('after a site is confirmed, its subdomains and unrelated posting links cost no model checks', async () => {
  for (const other of ['benefits.fernhill.com', 'www.eeoc.gov']) {
    const http = fakeHttp({ 'https://fernhill.com/': named, [`https://${other}/`]: named });
    // Only these two candidates fill the slots ahead of the joined-name guess, so the second one is really reached.
    const { result, calls } = await admit({ sites: [site('Staff')], verdicts: ['same_company'], http, refs: [{ domain: 'fernhill.com' }, { domain: other }], maxChecks: 3 });
    assert.equal(result.domain, 'fernhill.com', other);
    assert.equal(calls(), 1, other);
    assert.deepEqual(http.fetched, ['https://fernhill.com/'], other);
  }
});

test('a second observed site carrying the company name still makes the company ambiguous', async () => {
  const http = fakeHttp({ 'https://fernhill.com/': named, 'https://fernhillgroup.net/': named });
  const refs = [{ domain: 'fernhill.com' }, { domain: 'fernhillgroup.net' }];
  const { result } = await admit({ sites: [site('Staff')], verdicts: ['same_company'], http, refs });
  assert.equal(result.status, 'unresolved');
  assert.match(result.reason, /multiple corporate domains/);
});

test('a full-name or corporate-link site keeps the model verdict without the extra name check', async () => {
  for (const match_kind of ['full_name', 'careers_link']) {
    const row = site('Staff', { match_kind });
    const { result } = await admit({ sites: [row], verdicts: ['same_company'], packets: [evidence('a', 'https://fernhill.example/', row, 'Fernhill builds switchgear.', 'Fernhill is hiring a technician.')] });
    assert.equal(result.status, 'confirmed', match_kind);
  }
});

test('the check limit does not hold a domain already confirmed against every site, and still holds when none is', async () => {
  const sites = [site('One'), site('Two')];
  const packets = ['https://fernhill.example/', 'https://fernhill-other.example/'].flatMap((url, u) => sites.map((row, s) =>
    evidence(`u${u}s${s}`, url, row, 'Fernhill builds switchgear.', 'Fernhill is hiring a technician.')));
  const confirmed = await admit({ sites, packets, verdicts: ['same_company'] });
  assert.equal(confirmed.calls(), 3);
  assert.equal(confirmed.result.status, 'confirmed'); assert.equal(confirmed.result.domain, 'fernhill.example');
  const held = await admit({ sites, packets, verdicts: ['same_company', 'different_company', 'same_company'] });
  assert.equal(held.result.status, 'unresolved');
  assert.match(held.result.reason, /check limit/);
});

test('targetNameWritten compares whole words and accepts a joined slug, never a fragment', () => {
  const packet = evidence('a', 'https://fernhill.example/', site('Staff'), 'Welcome to Fernhill Electric, Inc. and M&T Bank.', 'Hiring now.');
  for (const name of ['FERNHILL ELECTRIC CO', 'Fernhill Electric', 'fernhillelectric', 'M&T BANK CORP /DE/']) assert.equal(targetNameWritten(packet, name), true, name);
  for (const name of ['Fern', 'Fernhill Electrical', 'Electric Fernhill', 'Fernhill Apparel', 'Hiring now', '']) assert.equal(targetNameWritten(packet, name), false, name);
});

test('identity request timeouts stay bounded and invalid limits fail before network calls', async () => {
  const store = new SupabaseStore('http://127.0.0.1:54321', 'test-key');
  for (const timeoutMs of [0, 999, 240001, NaN, Infinity]) {
    await assert.rejects(() => localIdentityAdmission({ store, fetch: () => { throw Error('unexpected network call'); } }, [{ name: 'Example' }],
      { host: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', maxChecks: 1, timeoutMs, save: () => {} }), /timeout/);
  }
});
