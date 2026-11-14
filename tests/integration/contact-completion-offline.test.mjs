// Optional embedded PostgreSQL; never reads database URLs or connects to a service.
// PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js node --test tests/integration/contact-completion-offline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

test('offline PostgreSQL: migration, shared locks, unique claims, dedup and manual-edit CAS', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table companies(id uuid primary key default gen_random_uuid());
      create table pipeline_runs(id uuid primary key);
      create table contacts(id uuid primary key default gen_random_uuid(), company_id uuid references companies(id),
        name text, title text, linkedin_url text, source text, email text, email_status text, email_verified boolean default false,
        linkedin_status text, contact_sources jsonb, enriched_at timestamptz);
      create table paid_calls(idempotency_key text primary key, subject text, endpoint text);
    `);
    await db.exec(await readFile(new URL('../../supabase/migrations/202610310001_contact_research_pipeline.sql', import.meta.url), 'utf8'));
    const id = '00000000-0000-0000-0000-000000000001';
    const owner = '00000000-0000-0000-0000-000000000002';
    const legacy = '00000000-0000-0000-0000-000000000003';
    await db.query('insert into companies(id) values ($1), ($2)', [id, legacy]);
    await db.query("insert into contact_research_calls(company_id,request_key,endpoint,status) values ($1,'old','treg.people.email.find','running')", [legacy]);
    await db.query("update contact_research_jobs set status='succeeded' where company_id=$1", [id]);
    const historicalContact = '00000000-0000-0000-0000-000000000004';
    await db.query("insert into contacts(id,company_id,name) values ($1,$2,'Historical Contact')", [historicalContact, id]);
    await db.query("insert into paid_calls values ('old-paid',$1,'treg.people.email.find')", [historicalContact]);
    await db.exec(await readFile(new URL('../../supabase/migrations/202611130001_contact_completion.sql', import.meta.url), 'utf8'));
    const scalar = async (sql, args) => Object.values((await db.query(sql, args)).rows[0])[0];
    assert.equal(await scalar('select status from contact_research_jobs where company_id=$1', [id]), 'pending');
    assert.equal(await scalar("select status from contact_completion_calls where company_id=$1 and request_key='find:historical contact'", [id]), 'blocked');
    assert.equal(await scalar('select lock_contact_completion($1,$2)', [id, owner]), true);
    assert.equal(await scalar('select lock_contact_completion($1,$2)', [id, legacy]), false);
    assert.equal(await scalar('select lock_contact_completion($1,$2)', [legacy, owner]), false, 'legacy unresolved call blocks new worker');
    const contact = { name: 'Alex Person', title: 'HRIS Director', source: 'manual', email: null, contact_sources: { manual: true } };
    const contactId = await scalar('select insert_contact_if_absent($1,$2)', [id, contact]);
    assert.equal(await scalar('select insert_contact_if_absent($1,$2)', [id, { ...contact, name: ' ALEX  PERSON ' }]), contactId);
    assert.equal(await scalar('select save_researched_contact($1,$2)', [id, contact]), false);
    const snapshot = await scalar('select to_jsonb(c) from contacts c where id=$1', [contactId]);
    const patch = { email: 'alex@example.com', email_status: 'valid', email_verified: true, contact_sources: { ...snapshot.contact_sources, verification: true } };
    assert.equal(await scalar('select complete_contact_if_unchanged($1,$2,$3)', [contactId, snapshot, patch]), true);
    assert.equal(await scalar('select complete_contact_if_unchanged($1,$2,$3)', [contactId, snapshot, { ...patch, email: 'overwrite@example.com' }]), false);
    assert.equal(await scalar('select email from contacts where id=$1', [contactId]), 'alex@example.com');
    await db.query("insert into contact_completion_calls(company_id,request_key,endpoint,status) values ($1,'find:alex person','treg.people.email.find','running')", [id]);
    await assert.rejects(db.query("insert into contact_completion_calls(company_id,request_key,endpoint,status) values ($1,'find:alex person','treg.people.email.find','running')", [id]), /duplicate key/);
    assert.equal(await scalar("select has_function_privilege('anon', 'complete_contact_if_unchanged(uuid,jsonb,jsonb)', 'execute')"), false);
    assert.equal(await scalar("select has_function_privilege('service_role', 'complete_contact_if_unchanged(uuid,jsonb,jsonb)', 'execute')"), true);
  } finally { await db.close(); }
});
