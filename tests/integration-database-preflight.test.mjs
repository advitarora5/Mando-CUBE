import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { integrationDatabase } from './helpers/integration-database.mjs';

const local = { PIPELINE_SUPABASE_URL: 'http://127.0.0.1:54321', PIPELINE_SUPABASE_KEY: 'test-only-secret' };
const noConnection = () => { throw new Error('Must not connect'); };

function databaseReply(reply) {
  const calls = [];
  const db = {
    from(table) { calls.push(['table', table]); return this; },
    select(columns) { calls.push(['columns', columns]); return this; },
    limit(limit) { calls.push(['limit', limit]); return this; },
    async abortSignal(signal) { calls.push(['signal', signal]); return reply(); },
  };
  return { db, calls, connect: () => db };
}

test('optional local mode skips missing configuration without connecting', async () => {
  for (const env of [{}, { PIPELINE_SUPABASE_URL: local.PIPELINE_SUPABASE_URL }, { PIPELINE_SUPABASE_KEY: local.PIPELINE_SUPABASE_KEY }]) {
    const result = await integrationDatabase(env, noConnection);
    assert.equal(result.db, null);
    assert.match(result.skip, /set both PIPELINE_SUPABASE_URL and PIPELINE_SUPABASE_KEY/);
  }
});

test('CI and explicitly required runs fail instead of skipping missing configuration', async () => {
  for (const env of [{ CI: 'true' }, { CI: '1' }, { PIPELINE_REQUIRE_DATABASE_TESTS: '1' }, { CI: 'true', PIPELINE_REQUIRE_DATABASE_TESTS: '0' }]) {
    await assert.rejects(integrationDatabase(env, noConnection), /required and cannot be skipped/);
  }
});

test('remote or malformed targets are never contacted, even with a remote override', async () => {
  for (const url of ['https://production.supabase.co', 'not-a-url']) {
    const env = { ...local, PIPELINE_SUPABASE_URL: url, PIPELINE_ALLOW_REMOTE: 'production' };
    const result = await integrationDatabase(env, noConnection);
    assert.equal(result.db, null);
    assert.match(result.skip, /remote targets are refused/);
    await assert.rejects(integrationDatabase({ ...env, CI: 'true' }, noConnection), /remote targets are refused/);
  }
});

test('a successful authenticated table read enables the database suite', async () => {
  const fixture = databaseReply(() => ({ data: [], error: null }));
  const result = await integrationDatabase({ ...local, CI: 'true' }, (url, key, options) => {
    assert.equal(url, local.PIPELINE_SUPABASE_URL);
    assert.equal(key, local.PIPELINE_SUPABASE_KEY);
    assert.deepEqual(options.auth, { persistSession: false, autoRefreshToken: false });
    return fixture.db;
  });
  assert.equal(result.skip, false);
  assert.equal(result.db, fixture.db);
  assert.deepEqual(fixture.calls.slice(0, 3), [['table', 'companies'], ['columns', 'id'], ['limit', 1]]);
  assert.ok(fixture.calls[3][1] instanceof AbortSignal);
});

for (const [name, reply] of [
  ['invalid credentials', () => ({ data: null, error: { message: local.PIPELINE_SUPABASE_KEY } })],
  ['missing migrations', () => ({ data: null, error: { code: 'PGRST205', message: 'companies missing' } })],
  ['unexpected response', () => ({ data: null, error: null })],
  ['network failure', () => { throw new Error(local.PIPELINE_SUPABASE_KEY); }],
  ['timeout', () => { throw new DOMException('Timed out', 'TimeoutError'); }],
]) {
  test(`${name} fails required runs and produces a sanitized optional skip`, async () => {
    const fixture = databaseReply(reply);
    const result = await integrationDatabase(local, fixture.connect);
    assert.equal(result.db, null);
    assert.match(result.skip, /could not read companies/);
    assert.ok(!result.skip.includes(local.PIPELINE_SUPABASE_KEY));
    await assert.rejects(integrationDatabase({ ...local, PIPELINE_REQUIRE_DATABASE_TESTS: '1' }, fixture.connect), error => {
      assert.match(error.message, /required and cannot be skipped/);
      assert.ok(!error.message.includes(local.PIPELINE_SUPABASE_KEY));
      return true;
    });
  });
}

test('client initialization failures cannot produce a green required run', async () => {
  await assert.rejects(integrationDatabase({ ...local, CI: 'true' }, noConnection), /could not read companies/);
});

test('the real client checks the authenticated table endpoint, not just API availability', async () => {
  const requests = [];
  let status = 200;
  const server = createServer((request, response) => {
    requests.push({ url: request.url, key: request.headers.apikey, authorization: request.headers.authorization });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(status === 200 ? '[]' : JSON.stringify({ message: local.PIPELINE_SUPABASE_KEY }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { ...local, CI: 'true', PIPELINE_SUPABASE_URL: `http://127.0.0.1:${server.address().port}` };
    assert.equal((await integrationDatabase(env)).skip, false);
    assert.deepEqual(requests[0], {
      url: '/rest/v1/companies?select=id&limit=1', key: local.PIPELINE_SUPABASE_KEY,
      authorization: `Bearer ${local.PIPELINE_SUPABASE_KEY}`,
    });
    status = 401;
    await assert.rejects(integrationDatabase(env), /required and cannot be skipped/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

for (const required of [false, true]) {
  test(`the actual integration command ${required ? 'fails in CI' : 'skips locally'} without database configuration`, () => {
    const env = { ...process.env, CI: required ? 'true' : 'false' };
    for (const key of ['PIPELINE_SUPABASE_URL', 'PIPELINE_SUPABASE_KEY', 'PIPELINE_REQUIRE_DATABASE_TESTS', 'NODE_TEST_CONTEXT']) delete env[key];
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/integration/pipeline-db.test.mjs'], {
      cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    const output = result.stdout + result.stderr;
    if (required) {
      assert.notEqual(result.status, 0);
      assert.match(output, /Database tests are required and cannot be skipped/);
    } else {
      assert.equal(result.status, 0, output);
      assert.match(output, /# skipped [1-9]\d*/);
    }
  });
}
