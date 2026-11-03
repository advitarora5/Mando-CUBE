import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareIdentityCase } from '../../src/pipeline/identity-evidence.ts';
import { linkedFallbackCandidates, filingHostCandidates, secCik, FALLBACK_MAX_PAGES, FALLBACK_MAX_REQUESTS } from '../../src/pipeline/corporate-fallback.ts';
import { identitySignature } from '../../src/pipeline/identity.ts';
import { WebsiteHttp } from '../../src/pipeline/website.ts';
import { makeCtx, fakeFetch, response } from './helpers.mjs';

const now = new Date('2026-11-02T12:00:00Z');
const html = body => response(200, `<html><body>${body}</body></html>`, { 'content-type': 'text/html' });
const investorPage = '<h1>Acme Corp Investor Relations</h1><p>' + 'Acme Corp designs industrial sensors and reports quarterly results to its shareholders. '.repeat(4) + '</p>';
const target = { id: 'fallback-1', target_name: 'Acme Corp', corporate_url: 'https://acme.com/', site: { tenant: 'acme', pod: 'wd1', site: 'External' }, review_id: null };
const noJobs = { match: /\/jobs$/, method: 'POST', respond: () => response(200, { jobPostings: [] }) };
const fetchedUrls = ctx => ctx.fetch.calls.map(call => call.url);

test('corporate fallback: an investor page linked from the thin corporate page is used, with its provenance recorded', async () => {
  const ctx = makeCtx({ now: () => now, fetch: fakeFetch([
    { match: /^https:\/\/acme\.com\/$/, respond: () => html('<div id="app"></div><a href="https://investors.acme.com/">Investors</a>') },
    { match: /^https:\/\/investors\.acme\.com\/$/, respond: () => html(investorPage) },
    noJobs,
  ]) });
  const out = await prepareIdentityCase(ctx, target, new WebsiteHttp(ctx), { refreshJobs: true, corporateFallback: { secRows: null } });
  const corporate = out.sources.filter(s => s.side === 'corporate');
  assert.equal(corporate.length, 1);
  assert.equal(corporate[0].url, 'https://investors.acme.com/');
  assert.match(corporate[0].text, /Acme Corp designs industrial sensors/);
  assert.equal(out.corporate_url, 'https://acme.com/');
  assert.deepEqual(out.corporate_fallback, [{ url: 'https://investors.acme.com/', provenance: 'corporate_link', via: 'https://acme.com/', error: null }]);
});

test('corporate fallback: without provenance no other host is tried, even when the page is blocked', async () => {
  const ctx = makeCtx({ now: () => now, fetch: fakeFetch([
    { match: /^https:\/\/acme\.com\/robots\.txt$/, respond: () => response(403, 'forbidden') },
    { match: /acme-investors\.example\.net/, respond: () => html(investorPage) },
    noJobs,
  ]) });
  const out = await prepareIdentityCase(ctx, target, new WebsiteHttp(ctx), { refreshJobs: true, corporateFallback: { secRows: null } });
  assert.equal(out.sources.filter(s => s.side === 'corporate').length, 0);
  assert.ok(fetchedUrls(ctx).every(url => !url.includes('example.net')));
  assert.deepEqual(out.corporate_fallback, []);
  assert.match(out.errors.join(' '), /corporate: website robots unavailable: HTTP 403/);
  assert.match(out.errors.join(' '), /corporate fallback: no provenance-verified readable page/);
});

test('corporate fallback: a filing host counts only when the filing also names the corporate domain', () => {
  const filing = 'Acme Corp. Our website is acme.com. Investor information is at investor.acme.com and at acme.gcs-web.com for investors. Contact ir@acme.com. Unrelated vendor portal at portal.vendor-example.com.';
  const urls = filingHostCandidates(filing, 'acme.com', 'filing').map(c => c.url);
  assert.deepEqual(urls, ['https://investor.acme.com/', 'https://acme.gcs-web.com/']);
  // A filing that never names the corporate domain cannot vouch for any host.
  assert.deepEqual(filingHostCandidates('Investor information is at investor.othercorp.com.', 'acme.com', 'filing'), []);
  // Look-alike domains are not the corporate domain.
  assert.deepEqual(filingHostCandidates('See notacme.com and investor.notacme.com for investors.', 'acme.com', 'filing'), []);
});

test('corporate fallback: SEC route uses the issuer filing that names the corporate domain', async () => {
  const secRows = { 0: { cik_str: 12345, ticker: 'ACME', title: 'ACME CORP' }, 1: { cik_str: 999, ticker: 'OTH', title: 'Other Co' } };
  const ctx = makeCtx({ now: () => now, fetch: fakeFetch([
    { match: /^https:\/\/acme\.com\/$/, respond: () => response(503, 'unavailable') },
    { match: /data\.sec\.gov\/submissions\/CIK0000012345\.json$/, respond: () => response(200, { filings: { recent: {
      form: ['4', '8-K'], accessionNumber: ['0000012345-26-000001', '0000012345-26-000002'], primaryDocument: ['form4.xml', 'acme-8k.htm'] } } }) },
    { match: /\/Archives\/edgar\/data\/12345\/000001234526000002\/acme-8k\.htm$/, respond: () => html('<p>Acme Corp (acme.com) posts presentations on its investor website investor.acme.com.</p>') },
    { match: /^https:\/\/investor\.acme\.com\/$/, respond: () => html(investorPage) },
    noJobs,
  ]) });
  const out = await prepareIdentityCase(ctx, target, new WebsiteHttp(ctx), { refreshJobs: true, corporateFallback: { secRows } });
  assert.equal(out.sources.find(s => s.side === 'corporate').url, 'https://investor.acme.com/');
  assert.deepEqual(out.corporate_fallback.map(a => [a.provenance, a.error]), [['sec_issuer_record', null], ['sec_filing', null], ['sec_filing', null]]);
  assert.equal(out.corporate_fallback[2].via, 'https://www.sec.gov/Archives/edgar/data/12345/000001234526000002/acme-8k.htm');
  assert.ok(fetchedUrls(ctx).every(url => !url.includes('form4.xml')));
});

test('corporate fallback: SEC issuer lookup refuses ambiguous or unknown names', () => {
  const rows = { 0: { cik_str: 1, title: 'Acme Corp' }, 1: { cik_str: 2, title: 'ACME CORP' }, 2: { cik_str: 3, title: 'Beta Inc' } };
  assert.equal(secCik(rows, 'Acme Corp'), null);
  assert.equal(secCik(rows, 'Beta Inc'), '0000000003');
  assert.equal(secCik(rows, 'Gamma LLC'), null);
  assert.equal(secCik(null, 'Beta Inc'), null);
});

test('corporate fallback: robots.txt is respected and every attempt is recorded', async () => {
  const ctx = makeCtx({ now: () => now, fetch: fakeFetch([
    { match: /^https:\/\/acme\.com\/$/, respond: () => html('<a href="https://investors.acme.com/">Investors</a><a href="https://acme.com/about">About us</a>') },
    { match: /^https:\/\/investors\.acme\.com\/robots\.txt$/, respond: () => response(200, 'User-agent: *\nDisallow: /') },
    { match: /^https:\/\/acme\.com\/about$/, respond: () => html('<p>short</p>') },
    noJobs,
  ]) });
  const out = await prepareIdentityCase(ctx, target, new WebsiteHttp(ctx), { refreshJobs: true, corporateFallback: { secRows: null } });
  assert.deepEqual(out.corporate_fallback.map(a => [a.url, a.error]), [
    ['https://investors.acme.com/', 'website disallowed by robots.txt'],
    ['https://acme.com/about', 'too little readable text'],
  ]);
  assert.ok(fetchedUrls(ctx).every(url => url !== 'https://investors.acme.com/'));
  // The thin original page is kept when no fallback page is readable.
  assert.equal(out.sources.find(s => s.side === 'corporate').url, 'https://acme.com/');
});

test('corporate fallback: page attempts and requests are capped', async () => {
  let links = '';
  for (let i = 0; i < 10; i++) links += `<a href="https://investors${i}.acme.com/">Investors ${i}</a>`;
  assert.equal(linkedFallbackCandidates(links, 'https://acme.com/').length, 10);
  const ctx = makeCtx({ now: () => now, fetch: fakeFetch([
    { match: /^https:\/\/acme\.com\/$/, respond: () => html(links) },
    { match: /^https:\/\/investors\d\.acme\.com\/$/, respond: () => response(500, 'error') },
    noJobs,
  ]) });
  const out = await prepareIdentityCase(ctx, target, new WebsiteHttp(ctx), { refreshJobs: true, corporateFallback: { secRows: null } });
  assert.equal(out.corporate_fallback.length, FALLBACK_MAX_PAGES);
  const fallbackRequests = fetchedUrls(ctx).filter(url => /investors\d\.acme\.com/.test(url)).length;
  assert.ok(fallbackRequests <= FALLBACK_MAX_REQUESTS);
  assert.equal(fallbackRequests, FALLBACK_MAX_PAGES * 2); // one robots.txt and one page per attempted host
  assert.ok(out.corporate_fallback.every(a => a.error === 'website HTTP 500'));
});

test('corporate fallback: off by default, and the attempt log never changes the identity signature', async () => {
  const ctx = makeCtx({ now: () => now, fetch: fakeFetch([
    { match: /^https:\/\/acme\.com\/$/, respond: () => html('<a href="https://investors.acme.com/">Investors</a>') },
    noJobs,
  ]) });
  const out = await prepareIdentityCase(ctx, target, new WebsiteHttp(ctx), { refreshJobs: true });
  assert.equal(out.corporate_fallback, undefined);
  assert.ok(fetchedUrls(ctx).every(url => !url.includes('investors.acme.com')));
  const logged = { ...out, corporate_fallback: [{ url: 'https://x.acme.com/', provenance: 'corporate_link', via: 'https://acme.com/', error: 'website HTTP 500' }] };
  assert.equal(identitySignature(logged, 'qwen2.5:7b', 'rev'), identitySignature(out, 'qwen2.5:7b', 'rev'));
});

test('corporate fallback: reads the latest periodic report first, then the latest 8-K, within the filing cap', async () => {
  const secRows = { 0: { cik_str: 12345, title: 'Acme Corp' } };
  const ctx = makeCtx({ now: () => now, fetch: fakeFetch([
    { match: /^https:\/\/acme\.com\/$/, respond: () => response(503, 'unavailable') },
    { match: /data\.sec\.gov\/submissions\//, respond: () => response(200, { filings: { recent: {
      form: ['8-K', '10-Q', '8-K', '10-K'],
      accessionNumber: ['0000012345-26-000004', '0000012345-26-000003', '0000012345-26-000002', '0000012345-26-000001'],
      primaryDocument: ['new-8k.htm', 'q3.htm', 'old-8k.htm', 'annual.htm'] } } }) },
    { match: /\/Archives\//, respond: () => html('<p>No website named here.</p>') },
    noJobs,
  ]) });
  const out = await prepareIdentityCase(ctx, target, new WebsiteHttp(ctx), { refreshJobs: true, corporateFallback: { secRows } });
  const filings = out.corporate_fallback.filter(a => a.provenance === 'sec_filing').map(a => a.url.split('/').pop());
  assert.deepEqual(filings, ['q3.htm', 'new-8k.htm']);
  assert.match(out.errors.join(' '), /no provenance-verified readable page/);
});
