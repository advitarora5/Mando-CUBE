import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedIdentityAdmission, localIdentityAdmission, assertIdentityAdmissionContext } from '../../src/pipeline/local-identity-admission.ts';
import { assertApprovedIdentityMode } from '../../scripts/discovery-local-identity.mjs';
import { SupabaseStore } from '../../src/pipeline/store/supabase.ts';
import { makeCtx } from './helpers.mjs';

const ref = 'a'.repeat(20), digest = '1'.repeat(64);
const approval = () => ({ DISCOVERY_EXECUTION_ENABLED: 'true', DISCOVERY_AI_EXECUTION_ENABLED: 'true', DISCOVERY_SINGLE_WRITER_CONFIRMED: 'true', DISCOVERY_SCHEMA_CONFIRMED: 'true',
  DISCOVERY_APPROVED_PROJECT_REF: ref, DISCOVERY_APPROVED_MODEL_DIGEST: digest, PIPELINE_ALLOW_REMOTE: ref, PIPELINE_SUPABASE_URL: `https://${ref}.supabase.co` });
const options = () => ({ host: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', maxChecks: 3, save: () => {} });
function context(revision = digest) {
  const store = new SupabaseStore(`https://${ref}.supabase.co`, 'fictional-key', ref);
  let calls = 0;
  const ctx = makeCtx({ store, fetch: async url => {
    assert.equal(url, 'http://127.0.0.1:11434/api/tags', 'only the fake local model preflight is permitted');
    calls++;
    return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b', digest: revision }] }));
  } });
  return { ctx, calls: () => calls };
}

test('every approval field is required before model or database calls', async () => {
  for (const key of Object.keys(approval())) {
    const env = approval(); delete env[key];
    const { ctx, calls } = context();
    await assert.rejects(() => approvedIdentityAdmission(ctx, [], options(), env), /Approved AI/);
    assert.equal(calls(), 0);
  }
  const { ctx } = context();
  await assert.rejects(() => localIdentityAdmission(ctx, [], options()), /loopback/);
});

test('approved capability is bound to its concrete store and cannot be cloned or retargeted', async () => {
  const { ctx, calls } = context();
  const policy = await approvedIdentityAdmission(ctx, [{ name: 'Fictional Example' }], options(), approval());
  assert.equal(calls(), 1);
  assert.doesNotThrow(() => assertIdentityAdmissionContext(ctx, policy));
  assert.throws(() => assertIdentityAdmissionContext(context().ctx, policy), /different database store/);
  assert.throws(() => assertIdentityAdmissionContext(ctx, { ...policy }), /loopback/);
  policy.names.add('outside');
  const result = await policy.resolve(ctx, 'Outside', [{}], null, []);
  assert.equal(result.status, 'unresolved');
  assert.match(result.reason, /outside identity admission scope/);
  assert.equal(calls(), 1, 'mutating the public name set cannot expand model/admission scope');
});

test('wrong target, provider configuration and expanded pilot bounds fail closed', async () => {
  for (const change of [{ PIPELINE_SUPABASE_URL: 'https://wrong.supabase.co' }, { PIPELINE_ALLOW_REMOTE: 'wrong' }]) {
    const { ctx, calls } = context();
    await assert.rejects(() => approvedIdentityAdmission(ctx, [], options(), { ...approval(), ...change }), /Approved AI/);
    assert.equal(calls(), 0);
  }
  const { ctx, calls } = context();
  ctx.treg = {};
  await assert.rejects(() => approvedIdentityAdmission(ctx, [], options(), approval()), /Approved AI/);
  ctx.treg = null;
  await assert.rejects(() => approvedIdentityAdmission(ctx, [{ name: 'One' }, { name: 'Two' }], options(), approval()), /one candidate/);
  await assert.rejects(() => approvedIdentityAdmission(ctx, [], { ...options(), maxChecks: 4 }, approval()), /three model checks/);
  await assert.rejects(() => approvedIdentityAdmission(ctx, [], { ...options(), host: 'https://model.invalid' }, approval()), /loopback/);
  assert.equal(calls(), 0);
});

test('changed model revision is rejected before evidence artifacts or model inference', async () => {
  const { ctx } = context('2'.repeat(64));
  let saved = 0;
  await assert.rejects(() => approvedIdentityAdmission(ctx, [], { ...options(), save: () => saved++ }, approval()), /approved revision/);
  assert.equal(saved, 0);
});

test('approved CLI configuration requires both execution modes and a loopback model', () => {
  assert.equal(assertApprovedIdentityMode({ execute: true, approved: true }, approval()).model, 'qwen2.5:7b');
  assert.throws(() => assertApprovedIdentityMode({ execute: true, approved: false }, approval()));
  assert.throws(() => assertApprovedIdentityMode({ execute: false, approved: true }, approval()));
  assert.throws(() => assertApprovedIdentityMode({ execute: true, approved: true }, { ...approval(), OLLAMA_HOST: 'https://model.invalid' }));
});
