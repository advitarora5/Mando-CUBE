// Why discovery ran dry: the archive query stopped within the first tenants, and every batch walked them alphabetically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceBudgetMs } from '../../scripts/discovery-source-budget.mjs';
import { secNamesByTenant, waybackUrl, WAYBACK_PODS, WorkdayTenantWayback } from '../../src/pipeline/collectors/crawl.ts';
import { DEFAULT_SOURCES } from '../../src/pipeline/store/memory.ts';
import { WORKDAY_PODS } from '../../src/pipeline/collectors/workday.ts';
import { fakeFetch, makeCtx, response } from './helpers.mjs';

const limits = { maxRequests: 200, maxItems: 20, minDelayMs: 1000, dryRun: false };
const wayback = { ...DEFAULT_SOURCES.find(s => s.id === 'workday-tenant-wayback'), config: { pods: ['wd5'] } };
const robots = tenant => `Sitemap: https://${tenant}.wd5.myworkdayjobs.com/Careers/siteMap.xml`;
const sec = titles => JSON.stringify(Object.fromEntries(titles.map((title, i) => [i, { title, cik_str: i + 1 }])));

const collectFrom = async (tenants, titles, { live = tenants, maxItems = limits.maxItems } = {}) => {
  const fetch = fakeFetch([
    { match: /web\.archive\.org/, respond: () => response(200, tenants.map(t => `https://${t}.wd5.myworkdayjobs.com/`).join('\n')) },
    ...live.map(t => ({ match: new RegExp(`//${t}\\.wd5.*robots\\.txt`), respond: () => response(200, robots(t)) })),
  ]);
  const ctx = makeCtx({ fetch });
  ctx.store.latestCapture = async id => (id === 'sec-company-list' && titles ? { body: sec(titles) } : null);
  const out = await new WorkdayTenantWayback().collect(wayback, { ...limits, maxItems }, ctx);
  return { out, ctx };
};

test('the wayback query asks for one line per tenant, not every captured URL', () => {
  const url = new URL(waybackUrl('wd108', 2000));
  assert.equal(url.searchParams.get('url'), '*.wd108.myworkdayjobs.com');
  // The index key is "com,myworkdayjobs,wd108,tenant": the collapse must reach past the pod, into the tenant name.
  assert.equal(url.searchParams.get('collapse'), `urlkey:${'com,myworkdayjobs,wd108,'.length + 16}`);
  assert.equal(url.searchParams.get('limit'), '2000');
});

test('wayback holds every pod but leaves the three that time out until last', () => {
  assert.deepEqual([...WAYBACK_PODS].sort(), [...WORKDAY_PODS].sort());
  assert.deepEqual(WAYBACK_PODS.slice(-3), ['wd3', 'wd1', 'wd5']);
});

test('a slug that is exactly one public company\'s full name maps to its SEC title', () => {
  const names = secNamesByTenant(sec(['TRANE TECHNOLOGIES PLC', 'QUALCOMM INC/DE', 'Zebra Technologies Corp']));
  assert.equal(names.get('tranetechnologies'), 'TRANE TECHNOLOGIES PLC');
  assert.equal(names.get('qualcomm'), 'QUALCOMM INC/DE');
  assert.equal(names.has('zebra'), false, 'a first-word match is not a full name');
});

test('two companies compacting to one slug map to neither; share classes of one company still map', () => {
  const names = secNamesByTenant(sec(['Fern Hill Corp', 'Fernhill Inc', 'Oakmont Corp', 'OAKMONT CORP /DE/']));
  assert.equal(names.has('fernhill'), false);
  assert.equal(names.get('oakmont'), 'Oakmont Corp');
  assert.equal(secNamesByTenant('not json').size, 0);
});

test('public companies are checked first and carry the SEC title, still needing their name on the website', async () => {
  const { out } = await collectFrom(['aaa', 'bbb', 'zebrafin'], ['Zebrafin Corp']);
  assert.deepEqual(out.items.map(i => i.meta.tenant), ['zebrafin', 'aaa', 'bbb']);
  assert.equal(out.items[0].meta.company_name, 'Zebrafin Corp');
  assert.equal(out.items[0].meta.normalized_name, 'zebrafin');
  assert.equal(out.items[0].meta.match_kind, 'first_word', 'the SEC title does not make a slug guess trusted');
  assert.equal(out.items[1].meta.company_name, 'Aaa', 'other tenants keep the slug name');
});

test('a small item limit reaches the public company even when it sorts last', async () => {
  const { out } = await collectFrom(['aaa', 'zebrafin'], ['Zebrafin Corp'], { maxItems: 1 });
  assert.deepEqual(out.items.map(i => i.meta.tenant), ['zebrafin']);
});

test('a hit is remembered under the SEC name; a miss only under the slug, so the resolver can still find that company', async () => {
  const { ctx } = await collectFrom(['tranetechnologies', 'fernhillgroup'], ['Trane Technologies plc', 'Fernhill Group Inc'], { live: ['tranetechnologies'] });
  const tried = await ctx.store.resolverAttempts(['trane technologies', 'tranetechnologies', 'fernhill group', 'fernhillgroup']);
  assert.deepEqual([...tried].sort(), ['fernhillgroup', 'trane technologies']);
});

test('with no SEC list, tenants are still collected under their slug names', async () => {
  const { out } = await collectFrom(['aaa'], null);
  assert.deepEqual(out.items.map(i => i.meta.company_name), ['Aaa']);
});

test('source budgets leave room for a slow archive query and a full request allowance', () => {
  assert.ok(sourceBudgetMs('workday-tenant-wayback') > 65000, 'longer than one index request');
  assert.ok(sourceBudgetMs('workday-tenant-crawl') > 65000);
  assert.ok(sourceBudgetMs('workday-site-resolver') >= 60000, 'at least 60 requests at one a second');
  assert.ok(sourceBudgetMs('workday-career-sites') >= 60000);
});
