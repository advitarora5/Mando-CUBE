// Admission policy and local-only boundary regression tests; no live provider calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMatch } from '../../src/domain/ingestion/matching.ts';
import { assertLocalAdmissionUrl, assertLocalAdmissionStore, localIdentityAdmission, confirmedCorporateDomain } from '../../src/pipeline/local-identity-admission.ts';
import { SupabaseStore } from '../../src/pipeline/store/supabase.ts';

const candidate = { name: 'Example Industries', domain: 'example.com', domain_confirmed: true, best_confidence: 0.6 };
test('AI-confirmed parent and careers subdomain agree, while unrelated domains remain ambiguous', () => {
  assert.equal(confirmedCorporateDomain(['bankofamerica.com', 'careers.bankofamerica.com']), 'bankofamerica.com');
  assert.equal(confirmedCorporateDomain(['careers.bankofamerica.com', 'bankofamerica.com']), 'bankofamerica.com');
  assert.equal(confirmedCorporateDomain(['blackrock.com', 'blackstone.com']), null);
  assert.equal(confirmedCorporateDomain(['careers.example.com', 'investor.example.com']), null);
  assert.equal(confirmedCorporateDomain([]), null);
});
test('local AI policy admits a verified low-confidence discovery; default policy still holds it', () => {
  assert.equal(decideMatch(candidate, [], { canCreate: true }).reason, 'untrusted_signal');
  assert.equal(decideMatch(candidate, [], { canCreate: true, identityVerified: true }).action, 'create');
  // Do not raise the stored evidence confidence to manufacture eligibility.
  assert.equal(candidate.best_confidence, 0.6);
});
test('AI policy keeps duplicate review, run caps and unconfirmed-input holds', () => {
  const room = { canCreate: true, identityVerified: true };
  assert.equal(decideMatch({ ...candidate, domain_confirmed: false }, [], room).reason, 'no_website');
  assert.equal(decideMatch(candidate, [], { ...room, canCreate: false }).reason, 'over_run_cap');
  const known = [{ id: 'existing', name: 'Example Industries', domain: 'other.example' }];
  assert.equal(decideMatch(candidate, known, room).reason, 'similar_name');
  assert.equal(decideMatch(candidate, [{ ...known[0], domain: 'example.com' }], room).action, 'attach');
});
test('local admission rejects remote endpoints, embedded credentials and ambiguous loopback URLs', () => {
  for (const value of ['https://remote.supabase.co', 'http://localhost', 'http://user:pass@localhost:54321',
    'http://localhost:54321/other', 'http://localhost:54321/?override=1', 'http://localhost.attacker.com:54321']) {
    assert.throws(() => assertLocalAdmissionUrl(value));
  }
  assert.doesNotThrow(() => assertLocalAdmissionUrl('http://127.0.0.1:54321'));
  assert.throws(() => assertLocalAdmissionStore({ store: { kind: 'memory' } }));
  const remote = new SupabaseStore('https://experiment.supabase.co', 'test-key', 'experiment');
  assert.throws(() => assertLocalAdmissionStore({ store: remote }));
});
test('a remote Ollama endpoint is rejected before network calls or artifacts', async () => {
  const store = new SupabaseStore('http://127.0.0.1:54321', 'test-key');
  await assert.rejects(() => localIdentityAdmission({ store, fetch: () => { throw Error('unexpected network call'); } }, [{ name: 'Example' }],
    { host: 'https://hosted.example', model: 'qwen2.5:7b', maxChecks: 1, save: () => { throw Error('unexpected artifact'); } }));
});

test('identity request timeouts stay bounded and invalid limits fail before network calls', async () => {
  const store = new SupabaseStore('http://127.0.0.1:54321', 'test-key');
  for (const timeoutMs of [0, 999, 240001, NaN, Infinity]) {
    await assert.rejects(() => localIdentityAdmission({ store, fetch: () => { throw Error('unexpected network call'); } }, [{ name: 'Example' }],
      { host: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', maxChecks: 1, timeoutMs, save: () => {} }), /timeout/);
  }
});
