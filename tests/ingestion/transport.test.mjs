import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { createPipelineFetch } from '../../src/pipeline/transport.ts';
import { PoliteHttp } from '../../src/pipeline/http.ts';

// Exercise real request/response streams on loopback, with only TLS replaced.
async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const root = `http://127.0.0.1:${server.address().port}`;
  return (url, options, callback) => httpRequest(new URL(url.pathname + url.search, root), options, callback);
}
const workday = 'https://example.wd1.myworkdayjobs.com';
const unexpected = async () => { throw Error('Unexpected fallback'); };

test('Workday GET and JSON POST preserve headers, payload, status, and response URL', async t => {
  const seen = [];
  const request = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'application/json', 'x-test': 'ok' });
    res.end(JSON.stringify({ jobPostings: [], total: 0 }));
  });
  const fetch = createPipelineFetch(unexpected, request);
  const get = await fetch(`${workday}/robots.txt`, { headers: { 'user-agent': 'mando-cube-ingestion/1.0' } });
  assert.equal(get.url, `${workday}/robots.txt`);
  const payload = JSON.stringify({ limit: 20, offset: 0, searchText: 'Workday' });
  const post = await fetch(`${workday}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  assert.equal(post.headers.get('x-test'), 'ok');
  assert.equal((await post.json()).total, 0);
  assert.equal(seen[0].headers['user-agent'], 'mando-cube-ingestion/1.0');
  assert.equal(seen[1].method, 'POST');
  assert.equal(seen[1].body, payload);
  assert.equal(Number(seen[1].headers['content-length']), Buffer.byteLength(payload));
});

test('other providers and lookalike hostnames use the existing fetch', async () => {
  const seen = [];
  const fetch = createPipelineFetch(async input => { seen.push(String(input)); return new Response('fallback'); }, () => { throw Error('Unexpected HTTPS'); });
  for (const url of ['https://www.sec.gov/list', 'https://example.myworkdayjobs.com.evil.test/', 'http://example.myworkdayjobs.com/']) await fetch(url);
  assert.equal(seen.length, 3);
});

for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
  test(`compressed ${encoding} responses are decoded`, async t => {
    const request = await fixture(t, (req, res) => { res.writeHead(200, { 'content-encoding': encoding }); res.end(compress('Sitemap: https://example.test/siteMap.xml')); });
    const response = await createPipelineFetch(unexpected, request)(`${workday}/robots.txt`);
    assert.match(await response.text(), /^Sitemap:/);
    assert.equal(response.headers.get('content-encoding'), null);
  });
}

for (const [status, expectedMethod, expectedBody] of [[302, 'GET', ''], [303, 'GET', ''], [307, 'POST', 'payload'], [308, 'POST', 'payload']]) {
  test(`${status} redirect handles POST correctly and strips cross-origin credentials`, async t => {
    let received;
    const request = await fixture(t, async (req, res) => {
      if (req.url === '/start') { req.resume(); res.writeHead(status, { location: 'https://other.wd1.myworkdayjobs.com/end' }); res.end(); return; }
      const chunks = []; for await (const c of req) chunks.push(c);
      received = { method: req.method, body: Buffer.concat(chunks).toString(), headers: req.headers };
      res.end('done');
    });
    const response = await createPipelineFetch(unexpected, request)(`${workday}/start`, { method: 'POST', body: 'payload', headers: { authorization: 'test-only', cookie: 'test-only', 'content-type': 'text/plain' } });
    assert.equal(await response.text(), 'done');
    assert.equal(response.redirected, true);
    assert.equal(received.method, expectedMethod);
    assert.equal(received.body, expectedBody);
    assert.equal(received.headers.authorization, undefined);
    assert.equal(received.headers.cookie, undefined);
  });
}

test('manual redirects are returned, forbidden redirects fail, and loops are bounded', async t => {
  const request = await fixture(t, (req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); });
  const fetch = createPipelineFetch(unexpected, request);
  assert.equal((await fetch(`${workday}/loop`, { redirect: 'manual' })).status, 302);
  await assert.rejects(fetch(`${workday}/loop`, { redirect: 'error' }), /Redirect disallowed/);
  await assert.rejects(fetch(`${workday}/loop`), /Too many redirects/);
});

test('Workday recruiting hosts also use HTTPS and HEAD responses have no body to decompress', async t => {
  const request = await fixture(t, (req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(); });
  const response = await createPipelineFetch(unexpected, request)('https://wd1.myworkdaysite.com/recruiting/example/External', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('redirects to other providers return to fetch without forwarding credentials', async t => {
  const request = await fixture(t, (req, res) => { res.writeHead(302, { location: 'https://careers.example.test/jobs' }); res.end(); });
  let forwarded;
  const fetch = createPipelineFetch(async input => { forwarded = input; return new Response('external'); }, request);
  const response = await fetch(`${workday}/start`, { headers: { authorization: 'test-only', cookie: 'test-only' } });
  assert.equal(await response.text(), 'external');
  assert.equal(forwarded.url, 'https://careers.example.test/jobs');
  assert.equal(forwarded.headers.has('authorization'), false);
  assert.equal(forwarded.headers.has('cookie'), false);
});

test('abort during a response body cancels collection without hanging', async t => {
  const request = await fixture(t, (req, res) => { res.writeHead(200); res.write('partial'); });
  const controller = new AbortController();
  const promise = createPipelineFetch(unexpected, request)(`${workday}/slow`, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(promise, error => error.name === 'AbortError' || error.code === 'ECONNRESET');
});

test('HTTPS transport preserves challenge headers and PoliteHttp stops without retries', async t => {
  let calls = 0;
  const request = await fixture(t, (req, res) => { calls++; res.writeHead(429, { 'cf-mitigated': 'challenge' }); res.end('<html>challenge</html>'); });
  const http = new PoliteHttp({ fetch: createPipelineFetch(unexpected, request), now: () => new Date(), sleep: async () => {}, contact: '' }, { maxRequests: 10, minDelayMs: 0, maxRetries: 2 });
  const result = await http.robotsTxt(workday);
  assert.equal(result.kind, 'captcha');
  assert.equal(result.status, 429);
  assert.equal(calls, 1);
});
