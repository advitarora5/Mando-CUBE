import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkdayTenantCrawl, WorkdayTenantWayback } from '../../src/pipeline/collectors/crawl.ts';
import { DEFAULT_SOURCES } from '../../src/pipeline/store/memory.ts';
import { makeCtx, response } from './helpers.mjs';

const limits = { maxRequests: 20, maxItems: 2, minDelayMs: 0, dryRun: false };
const config = { pods: ['wd5', 'wd1'], http_retries: 0, index_retries: 0, index_fail_fast: true };

test('an unavailable Wayback service is reported once without retrying other pods', async () => {
  let calls = 0;
  const ctx = makeCtx({ fetch: async () => { calls++; return response(503, 'Service unavailable'); } });
  const source = { ...DEFAULT_SOURCES.find(s => s.id === 'workday-tenant-wayback'), config };
  const out = await new WorkdayTenantWayback().collect(source, limits, ctx);
  assert.equal(calls, 1);
  assert.equal(out.requests, 1);
  assert.equal(out.items.length, 0);
  assert.match(out.errors[0].message, /HTTP 503/);
  assert.equal(out.cache_hit, undefined);
});

test('a Common Crawl gateway failure preserves its HTTP status and stops enumeration', async () => {
  let calls = 0;
  const ctx = makeCtx({ fetch: async url => {
    calls++;
    return String(url).includes('collinfo') ? response(200, [{ 'cdx-api': 'https://index.commoncrawl.org/TEST-index' }])
      : response(504, 'Gateway Time-out');
  } });
  const source = { ...DEFAULT_SOURCES.find(s => s.id === 'workday-tenant-crawl'), config };
  const out = await new WorkdayTenantCrawl().collect(source, limits, ctx);
  assert.equal(calls, 2, 'catalog plus one index query');
  assert.equal(out.items.length, 0);
  assert.match(out.errors[0].message, /HTTP 504/);
});
