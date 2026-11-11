import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { SupabaseStore, assertAllowedTarget } from '../../src/pipeline/store/supabase.ts';
let reachable = false;
const url = process.env.PIPELINE_SUPABASE_URL, key = process.env.PIPELINE_SUPABASE_KEY;
if (url && key) {
  try { assertAllowedTarget(url, undefined); reachable = (await fetch(`${url}/rest/v1/`, { headers: { apikey: key } })).status < 500; } catch { reachable = false; }
}
test('employee research RPCs claim once, reject stale completions and invalidate identity changes', {
  skip: reachable ? false : 'isolated local Supabase is unavailable',
}, async () => {
  const db = createClient(url, key, { auth: { persistSession: false } });
  const store = new SupabaseStore(url, key);
  const id = randomUUID();
  const { error } = await db.from('companies').insert({ id, name: `Employee Research ${id}`, domain: `${id}.example` });
  assert.ifError(error);
  try {
    const claims = await Promise.all([store.claimEmployeeResearch(id, `${id}.example`, 'pilot'), store.claimEmployeeResearch(id, `${id}.example`, 'pilot')]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean);
    assert.equal(await store.finishEmployeeResearch(id, randomUUID(), 'needs_review', null, 'stale'), false);
    const evidence = { employee_count: 3500, as_of: '2026-06-30', source: `https://${id}.example/about`, quote: 'Pilot employs 3500 employees.', basis: 'exact', date_basis: 'effective' };
    assert.equal(await store.finishEmployeeResearch(id, claim.lease_token, 'found', evidence, 'found'), true);
    assert.equal(await store.claimEmployeeResearch(id, `${id}.example`, 'pilot'), null);
    assert.equal((await store.employeeResearch(id)).evidence.employee_count, 3500);
    const changed = await store.claimEmployeeResearch(id, `other-${id}.example`, 'other');
    assert.equal(changed.evidence, null);
  } finally {
    const { error: cleanup } = await db.from('companies').delete().eq('id', id);
    assert.ifError(cleanup);
  }
});


test('employee startup readiness inspects storage and required permissions without claiming a lease', {
  skip: reachable ? false : 'isolated local Supabase is unavailable',
}, async () => {
  const store = new SupabaseStore(url,key);
  await store.checkEmployeeResearchStorage(AbortSignal.timeout(5000));
});
