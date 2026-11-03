// Common Crawl tenant source: lists tenants, probes robots.txt, skips known and already-tried ones, survives index failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkdayTenantCrawl, tenantsFromIndex, tenantName } from '../../src/pipeline/collectors/crawl.ts';
import { extractCapture } from '../../src/pipeline/extract.ts';
import { MemoryStore, DEFAULT_SOURCES } from '../../src/pipeline/store/memory.ts';
import { fixture, fakeFetch, response, makeCtx } from './helpers.mjs';

const limits = { maxRequests: 200, maxItems: 20, minDelayMs: 1000, dryRun: false };
const source = { ...DEFAULT_SOURCES.find(s => s.id === 'workday-tenant-crawl'), config: { pods: ['wd5'] } };
const line = host => JSON.stringify({ url: `https://${host}/careers/job/x_1` });
const INDEX = ['nvidia.wd5', 'nvidia.wd5', 'target.wd5', 'ghost.wd5', 'acme-impl.wd5', 'known.wd5'].map(h => line(`${h}.myworkdayjobs.com`)).join('\n');

const world = ({ page = () => response(200, INDEX) } = {}) => fakeFetch([
  { match: /collinfo\.json/, respond: () => response(200, [{ 'cdx-api': 'https://index.commoncrawl.org/CC-TEST-index' }]) },
  { match: /showNumPages/, respond: () => response(200, { pages: 1 }) },
  { match: /CC-TEST-index.*page=0/, respond: page },
  { match: /nvidia\.wd5.*robots\.txt/, respond: () => response(200, fixture('workday-robots-nvidia.txt')) },
  { match: /target\.wd5.*robots\.txt/, respond: () => response(200, fixture('workday-robots-target.txt')) },
]);

test('index lines collapse to distinct tenants; tenant slugs become provisional names', () => {
  assert.deepEqual(tenantsFromIndex(INDEX + '\nnot json\n').map(t => `${t.tenant}.${t.pod}`), ['nvidia.wd5', 'target.wd5', 'ghost.wd5', 'acme-impl.wd5', 'known.wd5']);
  assert.equal(tenantName('air-products'), 'Air Products');
});

test('finds live tenants, records misses, skips known and test tenants, and does not re-probe on the next run', async () => {
  const store = new MemoryStore();
  await store.upsertWorkdaySite({ tenant: 'known', pod: 'wd5', site: 'Careers', company_name: 'Known Co', normalized_name: 'known', match_kind: 'full_name', discovered_from: 'workday-site-resolver', capture_id: null });
  const fetch = world();
  const out = await new WorkdayTenantCrawl().collect(source, limits, makeCtx({ store, fetch }));
  assert.deepEqual(out.items.map(i => i.meta.tenant).sort(), ['nvidia', 'target']);
  assert.ok(out.items.every(i => i.meta.kind === 'workday_robots' && i.meta.match_kind === 'first_word' && i.meta.discovered_via === 'commoncrawl'));
  const probed = fetch.calls.filter(c => /robots\.txt/.test(c.url)).map(c => c.url);
  assert.equal(probed.length, 3, 'nvidia, target and the ghost miss; known and acme-impl are never probed');
  assert.ok(!probed.some(u => /known|acme-impl/.test(u)));
  assert.equal(out.errors.length, 0);
  assert.equal((await store.resolverAttempts(['ghost'])).has('ghost'), true, 'a miss is remembered');

  const again = world();
  const second = await new WorkdayTenantCrawl().collect(source, limits, makeCtx({ store, fetch: again }));
  assert.equal(second.items.length, 0);
  assert.equal(again.calls.filter(c => /robots\.txt/.test(c.url)).length, 0, 'tried tenants are not probed again');
});

test('a raw item reads through extraction into an untrusted site and a known-customer signal', async () => {
  const [item] = (await new WorkdayTenantCrawl().collect(source, limits, makeCtx({ fetch: world() }))).items.filter(i => i.meta.tenant === 'nvidia');
  const read = await extractCapture({ id: 'c1', source_id: item.source, url: item.url, body: item.raw, meta: item.meta }, null, '');
  assert.equal(read.sites[0].match_kind, 'first_word');
  assert.equal(read.sites[0].company_name, 'Nvidia');
  assert.equal(read.signals[0].type, 'known_customer');
  assert.ok(read.signals[0].confidence < 0.9, 'a guessed name never reaches the auto-admit threshold alone');
});

test('a busy index (504 twice, then 200) is retried instead of losing the page', async () => {
  let n = 0;
  const out = await new WorkdayTenantCrawl().collect(source, limits, makeCtx({ fetch: world({ page: () => (++n < 3 ? response(504, 'Gateway Time-out') : response(200, INDEX)) }) }));
  assert.equal(n, 3);
  assert.equal(out.items.length, 2);
});

test('a failing index page is reported and the run still ends cleanly; dry run writes no attempts', async () => {
  const store = new MemoryStore();
  const failing = await new WorkdayTenantCrawl().collect(source, limits, makeCtx({ store, fetch: world({ page: () => response(504, 'Gateway Time-out') }) }));
  assert.equal(failing.items.length, 0);
  assert.ok(failing.errors.some(e => /504/.test(e.message)));

  const dry = await new WorkdayTenantCrawl().collect(source, { ...limits, dryRun: true }, makeCtx({ store, fetch: world() }));
  assert.equal(dry.items.length, 2);
  assert.equal((await store.resolverAttempts(['nvidia', 'target', 'ghost'])).size, 0);
});

// ---- Wayback Machine as a second tenant source ----
import { WorkdayTenantWayback, waybackTenants } from '../../src/pipeline/collectors/crawl.ts';

test('wayback: robots.txt captures become distinct tenants; the URL-encoding artifact is stripped', () => {
  const body = ['http://2fbrown.wd5.myworkdayjobs.com/robots.txt', 'https://adobe.wd5.myworkdayjobs.com/robots.txt', 'http://2525252foregon.wd5.myworkdayjobs.com/robots.txt', 'https://adobe.wd5.myworkdayjobs.com/robots.txt'].join('\n');
  assert.deepEqual(waybackTenants(body).map(t => t.tenant), ['brown', 'adobe', 'oregon']);
});

test('wayback: lists tenants from the CDX index and verifies each with robots.txt like the Common Crawl source', async () => {
  const cdx = ['https://nvidia.wd5.myworkdayjobs.com/robots.txt', 'https://ghost.wd5.myworkdayjobs.com/robots.txt'].join('\n');
  const fetch = fakeFetch([
    { match: /web\.archive\.org\/cdx\/search\/cdx/, respond: () => response(200, cdx) },
    { match: /nvidia\.wd5.*robots\.txt/, respond: () => response(200, fixture('workday-robots-nvidia.txt')) },
  ]);
  const wayback = { ...DEFAULT_SOURCES.find(s => s.id === 'workday-tenant-wayback'), config: { pods: ['wd5'] } };
  const out = await new WorkdayTenantWayback().collect(wayback, limits, makeCtx({ fetch }));
  assert.deepEqual(out.items.map(i => i.meta.tenant), ['nvidia']);
  assert.equal(out.items[0].meta.discovered_via, 'commoncrawl', 'shared item shape');
});
