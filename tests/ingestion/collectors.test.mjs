// Collector contract tests on recorded responses (tests/fixtures/ingestion) and scripted failures.
// Every collector must stop cleanly and report, never crash or retry forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoliteHttp, parseRobots, robotsAllows } from '../../src/pipeline/http.ts';
import { WorkdayJobs, WorkdayResolver, sitesFromRobots, primarySites } from '../../src/pipeline/collectors/workday.ts';
import { SecCompanyList, TregReddit } from '../../src/pipeline/collectors/sources.ts';
import { MemoryStore, DEFAULT_SOURCES } from '../../src/pipeline/store/memory.ts';
import { fixture, fixtureJson, fakeFetch, response, makeCtx, clock, secFixture, worldFetch, fakeTreg } from './helpers.mjs';

const limits = { maxRequests: 50, maxItems: 20, minDelayMs: 1000, dryRun: false };
const source = id => DEFAULT_SOURCES.find(s => s.id === id);
const CAPTCHA_PAGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-platform">Verify you are human</div></body></html>';
const UNAVAILABLE_PAGE = '<!doctype html><html><body><h1>Workday is currently unavailable</h1><p>Scheduled maintenance.</p></body></html>';

test('a failed jobs endpoint rotates behind unchecked tenants on the next batch', async () => {
  const store = new MemoryStore();
  for (const tenant of ['aaa', 'bbb']) await store.upsertWorkdaySite({ tenant, pod: 'wd5', site: 'Careers', company_name: tenant, normalized_name: tenant, match_kind: 'full_name', discovered_from: 'test', capture_id: null });
  const fetch = fakeFetch([
    { match: /robots\.txt$/, respond: () => response(200, 'User-agent: *\nAllow: /') },
    { match: /aaa.*\/jobs$/, respond: () => response(500, 'temporary outage') },
    { match: /bbb.*\/jobs$/, respond: () => response(200, { jobPostings: [], total: 0 }) },
  ]);
  const ctx = makeCtx({ store, fetch });
  const config = { ...source('workday-career-sites'), config: { search_text: '' } };
  await new WorkdayJobs().collect(config, { ...limits, maxItems: 1 }, ctx);
  assert.equal(store.sites.find(s => s.tenant === 'aaa').last_status, 'errors');
  const before = fetch.calls.length;
  await new WorkdayJobs().collect(config, { ...limits, maxItems: 1 }, ctx);
  assert.ok(fetch.calls.slice(before).some(c => /bbb.*\/jobs$/.test(c.url)));
  assert.ok(fetch.calls.slice(before).every(c => !c.url.includes('aaa.')));
});

async function storeWithSite() {
  const store = new MemoryStore();
  await store.upsertWorkdaySite({ tenant: 'nvidia', pod: 'wd5', site: 'NVIDIAExternalCareerSite', company_name: 'NVIDIA CORP', normalized_name: 'nvidia', match_kind: 'full_name', discovered_from: 'workday-site-resolver', capture_id: null });
  return store;
}

const jobsWorld = overrides => fakeFetch([
  { match: /robots\.txt$/, respond: () => overrides.robots?.clone() ?? response(200, fixture('workday-robots-nvidia.txt')) },
  { match: /\/jobs$/, method: 'POST', respond: () => overrides.jobs?.clone() ?? response(200, fixture('workday-jobs-nvidia.json'), { 'content-type': 'application/json' }) },
  { match: /\/job\//, respond: url => overrides.detail?.(url) ?? response(200, JSON.stringify(fixtureJson('workday-job-details-nvidia.json').find(d => url.endsWith(d.url.slice(d.url.indexOf('/job/'))))?.body ?? fixtureJson('workday-job-details-nvidia.json')[0].body), { 'content-type': 'application/json' }) },
]);

test('robots parsing: longest match wins, Allow breaks ties, empty Disallow allows all, our agent group beats *', () => {
  const rules = parseRobots(fixture('workday-robots-nvidia.txt'), 'mando-cube-ingestion');
  assert.ok(robotsAllows(rules, '/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs'));
  assert.ok(!robotsAllows(rules, '/talentcommunity/x'));
  assert.ok(!robotsAllows(rules, '/NVIDIAExternalCareerSiteResearch/job/1'));
  assert.ok(robotsAllows(parseRobots('User-agent: *\nDisallow:\n', 'x'), '/anything'));
  const specific = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: mando-cube-ingestion\nAllow: /\n', 'mando-cube-ingestion/1.0');
  assert.ok(robotsAllows(specific, '/jobs'));
  assert.ok(!robotsAllows(parseRobots('User-agent: *\nDisallow: /*.json$\n', 'x'), '/files/a.json'));
});

test('robots.txt lists Workday site names; non-primary sites are skipped', () => {
  assert.deepEqual(sitesFromRobots(fixture('workday-robots-nvidia.txt'), 'nvidia', 'wd5'), ['NVIDIAExternalCareerSite']);
  assert.deepEqual(sitesFromRobots(fixture('workday-robots-target.txt'), 'target', 'wd5'), ['targetcareers']);
  assert.deepEqual(primarySites(['Workday', 'Workday_Early_Career', 'Workday_Executive_Site']), ['Workday']);
  assert.deepEqual(primarySites(['Futureforce_Internships']), ['Futureforce_Internships'], 'falls back when every site looks secondary');
});

test('regression (round 1): the main external career site is chosen over agency, campus, contractor and regional sites', () => {
  const seen = {
    amgen: [['agency', 'Careers'], 'Careers'], astrazeneca: [['Emerging-Talent', 'Careers'], 'Careers'], chevron: [['jobs', 'University'], 'jobs'],
    kla: [['AnnArbor', 'Search'], 'Search'], mastercard: [['ContractorConversion', 'CorporateCareers'], 'CorporateCareers'],
    novartis: [['Novartis_Careers', 'SwissRAVSwitzerlandCareerSite'], 'Novartis_Careers'], shell: [['Fasttrack', 'ShellCareers'], 'ShellCareers'],
    workday: [['Workday', 'Workday_Early_Career', 'Workday_Executive_Site', 'Workday_Jobs'], 'Workday'],
  };
  for (const [tenant, [sites, expected]] of Object.entries(seen)) assert.deepEqual(primarySites(sites), [expected], tenant);
});

test('happy path: Workday jobs collector returns one raw item per posting, exactly as received, paced at 1 request/second', async () => {
  const fetch = jobsWorld({});
  const slept = [];
  const ctx = makeCtx({ store: await storeWithSite(), fetch });
  ctx.sleep = async ms => { slept.push(ms); };
  const out = await new WorkdayJobs().collect({ ...source('workday-career-sites'), config: { max_jobs_per_site: 3 } }, limits, ctx);
  assert.equal(out.blocked, null);
  assert.equal(out.items.length, 3);
  const item = out.items[0];
  assert.match(item.url, /^https:\/\/nvidia\.wd5\.myworkdayjobs\.com\/wday\/cxs\/nvidia\/NVIDIAExternalCareerSite\/job\//);
  assert.ok(JSON.parse(item.raw).jobPostingInfo.jobDescription);
  assert.match(item.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(item.meta.company_name, 'NVIDIA CORP');
  const post = fetch.calls.find(c => c.method === 'POST');
  assert.deepEqual(JSON.parse(post.body), { appliedFacets: {}, limit: 20, offset: 0, searchText: 'Workday' });
  assert.equal(out.requests, 1 + 1 + 3, 'robots + one page + three details');
  assert.ok(slept.length >= 3 && slept.every(ms => ms <= 1000));
});

test('shared tenants prefer their branded external site without treating a first-word match as identity proof', () => {
  assert.deepEqual(primarySites(['AvanadeCareers', 'AccentureCareers'], 'accenture'), ['AccentureCareers']);
  assert.deepEqual(primarySites(['ACCENTURE_Careers', 'Careers', 'Accenture_Internal'], 'accenture'), ['ACCENTURE_Careers']);
  assert.deepEqual(primarySites(['AccenturesubsidiaryCareers', 'Careers'], 'accenture'), ['Careers']);
  assert.deepEqual(primarySites(['Careers', 'Acme_Internal'], 'acme'), ['Careers']);
  assert.deepEqual(primarySites(['Careers', 'RegionalCareers'], 'acme'), ['Careers']);
  assert.deepEqual(primarySites([], 'acme'), []);
  assert.deepEqual(primarySites(['WESTERN'], 'western'), ['WESTERN']);
});

test('resolver records the tenant-branded primary site from a shared robots capture', async () => {
  const store = new MemoryStore();
  await store.saveCapture({ source: 'sec-company-list', url: 'https://www.sec.gov/files/company_tickers.json', fetched_at: '2026-11-02T00:00:00Z', http_status: 200, content_type: 'application/json', raw: secFixture(['Accenture plc']), fingerprint: 'b'.repeat(64), meta: { kind: 'sec_company_list' } }, null);
  const robots = ['AvanadeCareers', 'AccentureCareers'].map(site => `Sitemap: https://accenture.wd5.myworkdayjobs.com/${site}/siteMap.xml`).join('\n');
  const fetch = fakeFetch([{ match: /robots\.txt$/, respond: () => response(200, robots) }]);
  const out = await new WorkdayResolver().collect(source('workday-site-resolver'), limits, makeCtx({ store, fetch }));
  assert.equal(out.items.length, 1);
  assert.deepEqual(out.items[0].meta.primary_sites, ['AccentureCareers']);
});

test('jobs collection uses the tenant-branded site even when a shorter sibling was saved first', async () => {
  const store = new MemoryStore();
  for (const site of ['AvanadeCareers', 'AccentureCareers']) {
    await store.upsertWorkdaySite({ tenant: 'accenture', pod: 'wd103', site, company_name: 'Accenture plc', normalized_name: 'accenture', match_kind: 'full_name', discovered_from: 'workday-site-resolver', capture_id: null });
  }
  const fetch = fakeFetch([
    { match: /robots\.txt$/, respond: () => response(200, 'User-agent: *\nAllow: /') },
    { match: /\/AccentureCareers\/jobs$/, method: 'POST', respond: () => response(200, JSON.stringify({ jobPostings: [], total: 0 }), { 'content-type': 'application/json' }) },
  ]);
  const out = await new WorkdayJobs().collect(source('workday-career-sites'), limits, makeCtx({ store, fetch }));
  assert.equal(out.errors.length, 0);
  assert.ok(fetch.calls.some(call => call.url.includes('/AccentureCareers/jobs')));
  assert.ok(fetch.calls.every(call => !call.url.includes('/AvanadeCareers/')));
});

test('regression (round 1): --limit counts companies (sites), each gets its postings, and sites rotate by last check', async () => {
  const store = new MemoryStore();
  for (const tenant of ['aaa', 'bbb', 'ccc']) await store.upsertWorkdaySite({ tenant, pod: 'wd5', site: 'Careers', company_name: tenant, normalized_name: tenant, match_kind: 'full_name', discovered_from: 'x', capture_id: null });
  const fetch = jobsWorld({});
  const ctx = makeCtx({ store, fetch });
  const out = await new WorkdayJobs().collect({ ...source('workday-career-sites'), config: { max_jobs_per_site: 3 } }, { ...limits, maxItems: 2 }, ctx);
  assert.deepEqual([...new Set(out.items.map(i => i.meta.tenant))], ['aaa', 'bbb'], 'two sites, all their postings');
  assert.equal(out.items.length, 6);
  const next = await new WorkdayJobs().collect({ ...source('workday-career-sites'), config: { max_jobs_per_site: 3 } }, { ...limits, maxItems: 2 }, ctx);
  assert.equal(next.items[0].meta.tenant, 'ccc', 'the site checked longest ago goes first');
});

test('empty result: no postings is a clean empty run', async () => {
  const out = await new WorkdayJobs().collect(source('workday-career-sites'), limits, makeCtx({ store: await storeWithSite(), fetch: jobsWorld({ jobs: response(200, { total: 0, jobPostings: [], facets: [] }) }) }));
  assert.deepEqual([out.items.length, out.blocked, out.errors.length], [0, null, 0]);
});

test('"unavailable" page: a 200 HTML notice where JSON was expected is a failed request, not data', async () => {
  const out = await new WorkdayJobs().collect(source('workday-career-sites'), limits, makeCtx({ store: await storeWithSite(), fetch: jobsWorld({ jobs: response(200, UNAVAILABLE_PAGE, { 'content-type': 'text/html' }) }) }));
  assert.equal(out.items.length, 0);
  assert.equal(out.errors[0].kind, 'unavailable');
  const wrongShape = await new WorkdayJobs().collect(source('workday-career-sites'), limits, makeCtx({ store: await storeWithSite(), fetch: jobsWorld({ jobs: response(200, { message: 'Service Unavailable' }) }) }));
  assert.equal(wrongShape.errors[0].kind, 'unavailable', 'JSON without jobPostings is not a job list');
});

test('CAPTCHA page stops the source; nothing is solved or retried', async () => {
  const fetch = jobsWorld({ jobs: response(200, CAPTCHA_PAGE, { 'content-type': 'text/html' }) });
  const out = await new WorkdayJobs().collect(source('workday-career-sites'), limits, makeCtx({ store: await storeWithSite(), fetch }));
  assert.match(out.blocked, /^captcha/);
  assert.equal(fetch.calls.filter(c => c.method === 'POST').length, 1);
});

test('429 backs off (honouring Retry-After, capped) and gives up after two retries; the source stops cleanly', async () => {
  const fetch = jobsWorld({ jobs: response(429, 'slow down', { 'retry-after': '120' }) });
  const ctx = makeCtx({ store: await storeWithSite(), fetch });
  const slept = []; ctx.sleep = async ms => { slept.push(ms); };
  const out = await new WorkdayJobs().collect(source('workday-career-sites'), limits, ctx);
  assert.match(out.blocked, /^rate_limited/);
  assert.equal(fetch.calls.filter(c => c.method === 'POST').length, 3);
  assert.ok(slept.includes(30000), 'Retry-After of 120 s is capped at 30 s');
});

test('403 stops the source as blocked', async () => {
  const out = await new WorkdayJobs().collect(source('workday-career-sites'), limits, makeCtx({ store: await storeWithSite(), fetch: jobsWorld({ jobs: response(403, 'Forbidden') }) }));
  assert.match(out.blocked, /^blocked/);
});

test('malformed JSON fails that request only', async () => {
  const out = await new WorkdayJobs().collect(source('workday-career-sites'), limits, makeCtx({ store: await storeWithSite(), fetch: jobsWorld({ jobs: response(200, '{"jobPostings": [', { 'content-type': 'application/json' }) }) }));
  assert.equal(out.errors[0].kind, 'malformed');
  assert.equal(out.blocked, null);
});

test('timeout retries twice then fails the request without hanging', async () => {
  const fetch = jobsWorld({ detail: () => 'timeout' });
  const out = await new WorkdayJobs().collect({ ...source('workday-career-sites'), config: { max_jobs_per_site: 2 } }, limits, makeCtx({ store: await storeWithSite(), fetch }));
  assert.equal(out.items.length, 0);
  assert.equal(out.errors.filter(e => e.kind === 'timeout').length, 2);
  assert.equal(fetch.calls.filter(c => c.url.includes('/job/')).length, 6, 'two postings x three attempts');
});

test('robots.txt disallow is respected; the request is never sent', async () => {
  const fetch = jobsWorld({ robots: response(200, 'User-agent: *\nDisallow: /wday/\n') });
  const out = await new WorkdayJobs().collect(source('workday-career-sites'), limits, makeCtx({ store: await storeWithSite(), fetch }));
  assert.equal(out.errors[0].kind, 'robots');
  assert.equal(fetch.calls.filter(c => c.url.includes('/wday/')).length, 0);
});

test('request cap is enforced across a run', async () => {
  const http = new PoliteHttp({ fetch: jobsWorld({}), sleep: async () => {}, now: clock(), contact: '' }, { maxRequests: 2, minDelayMs: 0 });
  const a = await http.request('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs', { method: 'POST', json: {}, expect: 'json' });
  const b = await http.request('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs', { method: 'POST', json: {}, expect: 'json' });
  assert.ok(a.ok); assert.equal(b.ok, false); assert.equal(b.kind, 'budget');
});

test('resolver: finds tenants from SEC names, records misses, and a 401 on one guessed tenant is a miss, not a block', async () => {
  const store = new MemoryStore();
  await store.saveCapture({ source: 'sec-company-list', url: 'https://www.sec.gov/files/company_tickers.json', fetched_at: '2026-10-13T00:00:00Z', http_status: 200, content_type: 'application/json', raw: secFixture(['Alder Robotics Inc', 'Apple Inc', 'Birchway Logistics Corp']), fingerprint: 'a'.repeat(64), meta: { kind: 'sec_company_list' } }, null);
  const world = worldFetch({ names: ['Alder Robotics Inc', 'Birchway Logistics Corp'], existingTenants: 2 });
  const fetch = async (url, init) => /apple\.wd/.test(String(url)) ? response(401, 'Unauthorized') : world(url, init);
  const out = await new WorkdayResolver().collect(source('workday-site-resolver'), { ...limits, maxRequests: 100, maxItems: 5 }, makeCtx({ store, fetch }));
  assert.equal(out.blocked, null, 'regression: a private tenant used to stop the whole resolver');
  assert.deepEqual(out.items.map(i => i.meta.tenant).sort(), ['alderrobotics', 'birchwaylogistics']);
  assert.equal(out.items[0].meta.match_kind, 'full_name');
  assert.ok(store.attempts.has('apple') && store.attempts.get('apple').found === false);
  const again = await new WorkdayResolver().collect(source('workday-site-resolver'), { ...limits, maxRequests: 100, maxItems: 5 }, makeCtx({ store, fetch }));
  assert.equal(again.items.length, 0, 'names already tried are not probed again');
});

test('SEC list: needs a contact (403 policy), validates the shape, and reads a local copy when no contact is set', async () => {
  const fetch = worldFetch({});
  const ok = await new SecCompanyList().collect(source('sec-company-list'), limits, makeCtx({ fetch }));
  assert.equal(ok.items.length, 1); assert.equal(ok.items[0].meta.rows, 120);
  const noContact = makeCtx({ fetch }); noContact.contact = '';
  const skipped = await new SecCompanyList().collect(source('sec-company-list'), limits, noContact);
  assert.equal(skipped.items.length, 0); assert.equal(skipped.errors[0].kind, 'skipped');
  const tiny = await new SecCompanyList().collect(source('sec-company-list'), limits, makeCtx({ fetch: fakeFetch([{ match: /robots/, respond: () => response(404, '') }, { match: /tickers/, respond: () => response(200, { 0: { title: 'x' } }) }]) }));
  assert.equal(tiny.errors[0].kind, 'unavailable');
  const blocked = await new SecCompanyList().collect(source('sec-company-list'), limits, makeCtx({ fetch: fakeFetch([{ match: /robots/, respond: () => response(403, 'Undeclared Automated Tool') }]) }));
  assert.match(blocked.blocked ?? '', /blocked/, 'regression: robots 403 is a block, not a silent disallow');
});

test('treg Reddit: skipped without budget, 402 stops paid work, success stores the feed as received', async () => {
  const src = { ...source('treg-reddit-workday'), enabled: true };
  const noBudget = await new TregReddit().collect(src, limits, makeCtx({ treg: fakeTreg({}), caps: { treg: 0 } }));
  assert.equal(noBudget.errors[0].message, 'budget');
  const ctx402 = makeCtx({ treg: fakeTreg({ 'tikhub.x.reddit-app-fetch-subreddit-feed': () => ({ ok: false, status: 402, error: 'treg HTTP 402', cost_usd: 0 }) }) });
  const out402 = await new TregReddit().collect(src, limits, ctx402);
  assert.equal(out402.blocked, 'treg 402');
  assert.equal(await ctx402.spend.allow('treg', 0.001, 'next'), false, 'paid work stays stopped for the run');
  const ok = await new TregReddit().collect(src, limits, makeCtx({ treg: fakeTreg({ 'tikhub.x.reddit-app-fetch-subreddit-feed': () => ({ ok: true, status: 200, body: { data: [] }, cost_usd: 0.001, call_id: 'r1' }) }) }));
  assert.equal(ok.items.length, 1); assert.equal(ok.spend_usd, 0.001);
});
