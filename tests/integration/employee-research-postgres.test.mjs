// Real PostgreSQL migration/RPC test in a disposable database. The container must
// be dedicated to this test; no application credentials or shared database are used.
// EMPLOYEE_TEST_POSTGRES_CONTAINER=mando-headcount-test node --test tests/integration/employee-research-postgres.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const container = process.env.EMPLOYEE_TEST_POSTGRES_CONTAINER;
test('PostgreSQL migration enforces concurrent claims, retry schedules, tokens, identity and permissions', {
  skip: !container && 'set EMPLOYEE_TEST_POSTGRES_CONTAINER to a dedicated local PostgreSQL container',
}, async () => {
  assert.match(container, /^mando-headcount-test(?:-[a-z0-9]+)?$/);
  const database = `employee_test_${randomUUID().replaceAll('-', '')}`;
  const command = (args, input) => {
    const result = spawnSync('docker', ['exec', '-i', container, ...args], { input, encoding: 'utf8' });
    if (result.status !== 0) throw Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const sql = query => command(['psql', '-U', 'postgres', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1'], query);
  command(['createdb', '-U', 'postgres', database]);
  try {
    sql(`do $$ begin
      if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
    end $$;
    create table public.companies(id uuid primary key);`);
    // Prove the documented prerequisite, without touching an existing database.
    assert.equal(sql("select to_regclass('public.company_employee_research') is null;"), 't');
    assert.throws(() => sql('select * from company_employee_research;'), /does not exist/);
    assert.throws(() => sql("select * from claim_employee_research(gen_random_uuid(), 'pilot.example', 'pilot');"), /does not exist/);
    assert.throws(() => sql("select finish_employee_research(gen_random_uuid(), gen_random_uuid(), 'needs_review', null, 'fixture');"), /does not exist/);
    sql(readFileSync(new URL('../../supabase/migrations/202611080001_employee_research.sql', import.meta.url), 'utf8'));
    const id = randomUUID();
    sql(`insert into companies values ('${id}');`);
    const claim = `select lease_token from claim_employee_research('${id}', 'pilot.example', 'pilot');`;
    const concurrent = () => new Promise((resolve, reject) => {
      const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1']);
      let output = '', error = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { error += data; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(output.trim()) : reject(Error(error)));
      child.stdin.end(claim);
    });
    const claims = await Promise.all([concurrent(), concurrent()]);
    assert.equal(claims.filter(Boolean).length, 1);
    const first = claims.find(Boolean);
    assert.equal(sql(`select finish_employee_research('${id}','${randomUUID()}','needs_review',null,'stale');`), 'f');
    sql(`update company_employee_research set lease_until=now()-interval '1 second' where company_id='${id}';`);
    assert.equal(sql(`select finish_employee_research('${id}','${first}','needs_review',null,'expired');`), 'f');
    const token = sql(claim);
    assert.notEqual(token, first);
    assert.equal(sql(`select finish_employee_research('${id}','${first}','needs_review',null,'stale');`), 'f');
    const evidence = JSON.stringify({ employee_count: 3500, as_of: '2026-06-30', source: 'https://pilot.example/about', basis: 'exact', date_basis: 'effective', quote: 'Pilot has 3500 employees.' });
    assert.equal(sql(`set role service_role; select finish_employee_research('${id}','${token}','found','${evidence}','found');`).split('\n').at(-1), 't');
    assert.equal(sql(`select next_check_at between now()+interval '29 days' and now()+interval '31 days' from company_employee_research;`), 't');
    assert.equal(sql(claim), '');
    sql(`update company_employee_research set next_check_at=now()-interval '1 second';`);
    const refresh = sql(claim);
    sql(`select finish_employee_research('${id}','${refresh}','unavailable',null,'offline');`);
    assert.equal(sql(`select evidence->>'employee_count' from company_employee_research;`), '3500');
    assert.equal(sql(`select next_check_at between now()+interval '23 hours' and now()+interval '25 hours' from company_employee_research;`), 't');
    const changed = sql(`select lease_token from claim_employee_research('${id}', 'changed.example', 'changed');`);
    assert.ok(changed);
    assert.equal(sql('select evidence is null from company_employee_research;'), 't');
    sql(`select finish_employee_research('${id}','${changed}','needs_review',null,'unresolved');`);
    assert.equal(sql(`select next_check_at between now()+interval '6 days' and now()+interval '8 days' from company_employee_research;`), 't');
    for (const role of ['anon', 'authenticated']) {
      assert.throws(() => sql(`set role ${role}; select * from company_employee_research;`), /permission denied/);
      assert.throws(() => sql(`set role ${role}; ${claim}`), /permission denied/);
      assert.throws(() => sql(`set role ${role}; select finish_employee_research('${id}','${changed}','needs_review',null,'bad');`), /permission denied/);
    }
    assert.throws(() => sql(`select finish_employee_research('${id}','${changed}','running',null,'invalid');`), /Invalid employee research status/);
  } finally { command(['dropdb', '-U', 'postgres', database]); }
});
