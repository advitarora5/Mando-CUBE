import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidatesForCompany, companyDomain, createTregClient, researchCompany, ResearchBudgetReached, verificationState } from '../scripts/contact-research.mjs';
import { runConfig, runContactResearch } from '../scripts/run-contact-research.mjs';

const company = { id: 'company-1', name: 'Example Inc', domain: 'example.com' };
const person = { name: 'Alex Research', title: 'Workday HRIS Director', company_domain: 'example.com', email: 'alex@example.com' };
const reply = (output, extra = {}) => ({ response: { output, ...extra }, provider: 'test-provider', call_id: 'test-call' });

function memoryCheckpoint() {
  const rows = new Map();
  return {
    rows,
    async get(companyId, key) { return rows.get(`${companyId}:${key}`); },
    async start(companyId, key, endpoint) {
      assert.ok(!rows.has(`${companyId}:${key}`));
      rows.set(`${companyId}:${key}`, { status: 'running', endpoint });
    },
    async finish(companyId, key, value) { rows.set(`${companyId}:${key}`, value); },
  };
}

function apiResponse(output, { status = 200, cost = '1000', extra = {}, headers = {} } = {}) {
  return new Response(JSON.stringify({ output, ...extra }), { status, headers: {
    'X-Treg-Cost-Micro': cost, 'X-Treg-Served-By': 'test-provider', 'X-Treg-Call-Id': 'call-1', ...headers,
  } });
}

test('corporate domains normalize; tenants, credentials and invalid domains are rejected', () => {
  assert.equal(companyDomain('https://www.example.com/careers'), 'example.com');
  for (const value of [null, '', 'localhost', 'https://user:secret@example.com', 'https://x.myworkdayjobs.com', 'linkedin.com', 'ftp://example.com']) {
    assert.throws(() => companyDomain(value));
  }
});

test('only named relevant contacts with employer evidence survive; duplicates and unrelated firms do not', () => {
  const results = candidatesForCompany([
    person, person, { ...person, name: 'Wrong Employer', company_domain: 'other.com' },
    { ...person, name: 'Wrong Role', title: 'Account Executive' },
    { name: 'No Employer', title: 'Workday Manager' },
    { name: 'Morgan Research', job_title: 'HRIS Director', company: { name: 'Example Inc' } },
    { ...person, name: 'Conflicting Domain', company_domain: 'other.com', company_name: 'Example Inc' },
    { ...person, name: 'Malformed Email', email: 'not an email' }, null,
  ], company, 3);
  assert.deepEqual(results.map(row => row.name), ['Alex Research', 'Morgan Research']);
  assert.equal(candidatesForCompany([person, { ...person, name: 'Second Person' }], company, 1).length, 1);
  assert.throws(() => candidatesForCompany({}, company, 3), /array/);
});

test('verification requires an explicit valid verdict and positive mailbox result', () => {
  assert.deepEqual(verificationState({ status: 'valid', valid: true }), { email_status: 'valid', email_verified: true });
  for (const output of [{ verified: true }, { status: 'valid' }, { status: 'valid', valid: false }, { status: 'unknown', valid: true }, {}]) {
    assert.equal(verificationState(output).email_verified, false);
  }
  assert.equal(verificationState({ status: 'accept_all', valid: true }).email_status, 'risky');
  assert.equal(verificationState({ status: 'invalid' }).email_status, 'invalid');
});

test('treg uses documented auth, routed endpoints, filter enforcement and cost ceilings', async () => {
  const checkpoint = memoryCheckpoint();
  const client = createTregClient({ token: 'synthetic-token', maxRunUsd: 1, maxCallUsd: 0.1, checkpoint,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://treg.to/call/treg.people.search');
      assert.equal(options.headers['X-Treg-Token'], 'synthetic-token');
      assert.equal(options.headers['X-Treg-Route-Max-Cost'], '0.1');
      assert.equal(options.headers['X-Treg-Route-Strict-Filters'], '1');
      assert.equal(options.redirect, 'error');
      return apiResponse({ people: [] });
    },
  });
  const first = await client.call(company.id, 'treg.people.search', { company_domain: 'example.com' });
  const second = await client.call(company.id, 'treg.people.search', { company_domain: 'example.com' });
  assert.deepEqual(first, second);
  assert.deepEqual(client.stats, { requests: 1, chargedMicro: 1000, unknownCharges: 0 });
});

test('run cap defers before dispatch and cached calls do not reserve more credits', async () => {
  const client = createTregClient({ token: 'test', maxRunUsd: 0.1, maxCallUsd: 0.1, checkpoint: memoryCheckpoint(), fetchImpl: async () => apiResponse({ people: [] }) });
  await client.call(company.id, 'treg.people.search', {});
  await client.call(company.id, 'treg.people.search', {});
  await assert.rejects(client.call(company.id, 'treg.people.email.find', {}), ResearchBudgetReached);
  assert.equal(client.stats.requests, 1);
});

for (const scenario of [
  { status: 202, extra: { _treg: { outcome: 'pending' } } },
  { status: 402 }, { status: 429 }, { status: 500 },
  { extra: { _treg: { outcome: 'failed' } } },
  { headers: { 'X-Treg-Ignored-Filters': 'company_domain' } },
  { cost: '200000' }, { cost: 'invalid' },
]) {
  test(`unresolved or unsafe provider response is checkpointed and never automatically retried: ${JSON.stringify(scenario)}`, async () => {
    const checkpoint = memoryCheckpoint();
    const client = createTregClient({ token: 'test', maxRunUsd: 1, maxCallUsd: 0.1, checkpoint, fetchImpl: async () => apiResponse({}, scenario) });
    await assert.rejects(client.call(company.id, 'treg.people.search', {}));
    assert.equal([...checkpoint.rows.values()][0].status, 'blocked');
    assert.equal([...checkpoint.rows.values()][0].call_id, 'call-1');
    await assert.rejects(client.call(company.id, 'treg.people.search', {}), /unresolved/);
    assert.equal(client.stats.requests, 1);
  });
}

test('lost network response leaves a running checkpoint and prevents repeat billing', async () => {
  const checkpoint = memoryCheckpoint();
  const client = createTregClient({ token: 'test', maxRunUsd: 1, maxCallUsd: 0.1, checkpoint, fetchImpl: async () => { throw new Error('network'); } });
  await assert.rejects(client.call(company.id, 'treg.people.search', {}), /lost/);
  await assert.rejects(client.call(company.id, 'treg.people.search', {}), /unresolved/);
  assert.equal(client.stats.requests, 1);
  assert.equal(client.stats.unknownCharges, 1);
});

test('non-JSON response blocks with call ID retained', async () => {
  const checkpoint = memoryCheckpoint();
  const client = createTregClient({ token: 'test', maxRunUsd: 1, maxCallUsd: 0.1, checkpoint,
    fetchImpl: async () => new Response('invalid json', { headers: { 'X-Treg-Call-Id': 'bad-json', 'X-Treg-Cost-Micro': '1000' } }),
  });
  await assert.rejects(client.call(company.id, 'treg.people.search', {}));
  assert.equal([...checkpoint.rows.values()][0].call_id, 'bad-json');
  assert.equal([...checkpoint.rows.values()][0].status, 'blocked');
});

test('checkpoint must be durable before paid dispatch', async () => {
  let called = false;
  const client = createTregClient({ token: 'test', maxRunUsd: 1, maxCallUsd: 0.1,
    checkpoint: { get: async () => null, start: async () => { throw new Error('database down'); } },
    fetchImpl: async () => { called = true; },
  });
  await assert.rejects(client.call(company.id, 'treg.people.search', {}), /database down/);
  assert.equal(called, false);
});

test('research finds a missing email and independently verifies it before saving provenance', async () => {
  const calls = [], saved = [];
  const summary = await researchCompany({ company, existing: [], maxContacts: 3,
    client: { call: async (companyId, endpoint, body) => {
      calls.push({ companyId, endpoint, body });
      if (endpoint.endsWith('search')) return reply({ people: [{ ...person, email: null }] });
      if (endpoint.endsWith('find')) return reply({ email: 'alex@example.com', verified: true });
      return reply({ status: 'valid', valid: true });
    } },
    save: async (companyId, contact) => { saved.push({ companyId, contact }); return true; },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].body, { domain: 'example.com', full_name: 'Alex Research' });
  assert.equal(saved[0].contact.email_verified, true);
  assert.equal(saved[0].contact.contact_sources.email_verification.call_id, 'test-call');
  assert.equal(summary.verified, 1);
});

test('directory emails are verified; catch-all addresses stay unverified', async () => {
  const saved = [];
  await researchCompany({ company, existing: [], maxContacts: 3,
    client: { call: async (companyId, endpoint) => endpoint.endsWith('search') ? reply({ people: [person] }) : reply({ status: 'accept_all', valid: true }) },
    save: async (companyId, contact) => { saved.push(contact); return true; },
  });
  assert.equal(saved[0].email_status, 'risky');
  assert.equal(saved[0].email_verified, false);
});

test('existing manual contacts are preserved without paid email research', async () => {
  let calls = 0;
  const summary = await researchCompany({ company, existing: [{ name: ' ALEX  RESEARCH ', email: 'manual@example.com' }], maxContacts: 3,
    client: { call: async () => { calls += 1; return reply({ people: [person] }); } },
    save: async () => { assert.fail('Must not replace manual contacts'); },
  });
  assert.equal(calls, 1);
  assert.equal(summary.preserved, 1);
});

for (const found of [reply({ email: 'alex@other.com' }), reply({ email: 'alex@example.com' }, { _treg: { domain_match: false } }), reply({ email: null })]) {
  test(`missing or mismatched email remains unverified: ${JSON.stringify(found.response)}`, async () => {
    const saved = [];
    const summary = await researchCompany({ company, existing: [], maxContacts: 3,
      client: { call: async (companyId, endpoint) => {
        if (endpoint.endsWith('search')) return reply({ people: [{ ...person, email: null }] });
        assert.ok(endpoint.endsWith('find'));
        return found;
      } },
      save: async (companyId, contact) => { saved.push(contact); return true; },
    });
    assert.equal(saved[0].email, null);
    assert.equal(saved[0].email_verified, false);
    assert.equal(summary.unverified, 1);
  });
}

test('preview performs no provider calls or database mutations and needs no treg token', async () => {
  let queried = false;
  const db = { from: table => {
    assert.equal(table, 'contact_research_jobs');
    return { select: () => ({ eq: () => ({ limit: async () => { queried = true; return { data: [], error: null }; } }) }) };
  } };
  await runContactResearch({ db, env: {}, config: runConfig({}, []), log: () => {}, fetchImpl: () => assert.fail('Preview cannot spend') });
  assert.equal(queried, true);
});

test('configuration rejects invalid caps and unknown flags', () => {
  assert.equal(runConfig({}, []).apply, false);
  assert.equal(runConfig({}, ['--apply', '--trigger=schedule']).trigger, 'schedule');
  assert.throws(() => runConfig({}, ['--force']));
  assert.throws(() => runConfig({ CONTACT_RESEARCH_MAX_RUN_USD: '0.01' }, []), /ceiling/);
  assert.throws(() => runConfig({ CONTACT_RESEARCH_MAX_CALL_USD: '0.00000001' }, []), /Invalid/);
  for (const value of ['0', '-1', 'NaN', 'Infinity', '101', '1.5']) {
    assert.throws(() => runConfig({ CONTACT_RESEARCH_MAX_COMPANIES: value }, []));
  }
});

function workerDatabase() {
  const tables = {
    contact_research_jobs: [{ company_id: company.id, status: 'pending' }],
    contact_research_calls: [], pipeline_runs: [], contacts: [], companies: [company],
  };
  return {
    tables,
    from(table) {
      const filters = [];
      let operation = 'select', payload, single = false, limit = Infinity;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        limit(value) { limit = value; return query; },
        insert(value) { operation = 'insert'; payload = value; return query; },
        update(value) { operation = 'update'; payload = value; return query; },
        maybeSingle() { single = true; return query; },
        single() { single = true; return query; },
        then(resolve) {
          let rows = tables[table].filter(row => filters.every(filter => filter(row))).slice(0, limit);
          if (operation === 'insert') {
            const inserted = { id: `row-${tables[table].length}`, ...payload };
            tables[table].push(inserted);
            rows = [inserted];
          }
          if (operation === 'update') for (const row of rows) Object.assign(row, payload);
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
        },
      };
      return query;
    },
    async rpc(name, args) {
      if (name === 'claim_contact_research') {
        const job = tables.contact_research_jobs.find(row => row.status === 'pending');
        if (job) Object.assign(job, { status: 'running', run_id: args.p_run_id });
        return { data: job ? [job] : [], error: null };
      }
      assert.equal(name, 'save_researched_contact');
      tables.contacts.push({ company_id: args.p_company_id, ...args.p_contact });
      return { data: true, error: null };
    },
  };
}

test('worker completes an admitted unscored company and records verified contacts and spend', async () => {
  const db = workerDatabase();
  const config = runConfig({}, ['--apply', '--trigger=schedule']);
  await runContactResearch({ db, config, env: { TREG_TOKEN: 'test' }, log: () => {},
    fetchImpl: async url => url.endsWith('search') ? apiResponse({ people: [person] }) : apiResponse({ valid: true, status: 'valid' }),
  });
  assert.equal(db.tables.contact_research_jobs[0].status, 'succeeded');
  assert.equal(db.tables.contacts[0].email_verified, true);
  assert.equal(db.tables.pipeline_runs[0].status, 'succeeded');
  assert.equal(db.tables.pipeline_runs[0].trigger, 'schedule');
  assert.equal(db.tables.pipeline_runs[0].counts.verified, 1);
  assert.equal(db.tables.pipeline_runs[0].counts.charged_micro, 2000);
});

test('worker defers at its budget and resumes with cached search rather than paying twice', async () => {
  const db = workerDatabase();
  const config = runConfig({ CONTACT_RESEARCH_MAX_RUN_USD: '0.1' }, ['--apply']);
  const endpoints = [];
  const fetchImpl = async url => {
    endpoints.push(url);
    return url.endsWith('search') ? apiResponse({ people: [person] }) : apiResponse({ valid: true, status: 'valid' });
  };
  await runContactResearch({ db, config, env: { TREG_TOKEN: 'test' }, log: () => {}, fetchImpl });
  assert.equal(db.tables.contact_research_jobs[0].status, 'pending');
  assert.equal(db.tables.pipeline_runs[0].counts.deferred, 1);
  await runContactResearch({ db, config, env: { TREG_TOKEN: 'test' }, log: () => {}, fetchImpl });
  assert.equal(db.tables.contact_research_jobs[0].status, 'succeeded');
  assert.equal(endpoints.filter(url => url.endsWith('search')).length, 1);
  assert.equal(db.tables.contacts.length, 1);
});

test('worker blocks on credit errors with no contact inserts or retries', async () => {
  const db = workerDatabase();
  await assert.rejects(runContactResearch({ db, config: runConfig({}, ['--apply']), env: { TREG_TOKEN: 'test' }, log: () => {},
    fetchImpl: async () => apiResponse({}, { status: 402 }),
  }), /needs review/);
  assert.equal(db.tables.contact_research_jobs[0].status, 'blocked');
  assert.equal(db.tables.contacts.length, 0);
  assert.equal(db.tables.pipeline_runs[0].status, 'blocked');
  assert.equal(db.tables.pipeline_runs[0].requests_made, 1);
});

test('run counts include contacts saved before a mid-company budget pause', async () => {
  const db = workerDatabase();
  await runContactResearch({ db, config: runConfig({ CONTACT_RESEARCH_MAX_RUN_USD: '0.2' }, ['--apply']), env: { TREG_TOKEN: 'test' }, log: () => {},
    fetchImpl: async url => url.endsWith('search')
      ? apiResponse({ people: [person, { ...person, name: 'Morgan Research', email: 'morgan@example.com' }] })
      : apiResponse({ valid: true, status: 'valid' }),
  });
  assert.equal(db.tables.contact_research_jobs[0].status, 'pending');
  assert.equal(db.tables.contacts.length, 1);
  assert.equal(db.tables.pipeline_runs[0].counts.added, 1);
  assert.equal(db.tables.pipeline_runs[0].counts.verified, 1);
});

test('migration queues company admissions without score gates and restricts privileged RPCs', () => {
  const sql = readFileSync(new URL('../supabase/migrations/202610310001_contact_research_pipeline.sql', import.meta.url), 'utf8');
  assert.match(sql, /after insert on public\.companies/);
  assert.match(sql, /select id from public\.companies/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /alter table public.contact_research_calls enable row level security/);
  assert.match(sql, /revoke all on function public.save_researched_contact\(uuid, jsonb\) from public, anon, authenticated/);
  assert.doesNotMatch(sql, /ready_for_contacts_threshold|public\.scores|update public\.contacts/);
});
