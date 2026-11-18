import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailVerificationState, completeContact } from '../../scripts/contact-completion.mjs';
const verified = () => ({ status: 'succeeded', provider: 'orbisearch.people.email.verify', call_id: 'saved-fixture', response: {
  output: { status: 'safe', valid: true, score: 98 },
  raw: { status: 'safe', substatus: 'deliverable', is_domain_catch_all: false, is_disposable: false, is_role_account: false },
  _treg: { served_by: 'orbisearch.people.email.verify' },
} });
test('OrbiSearch native safe/deliverable maps to valid; a secure gateway does not contradict mailbox proof', () => {
  const result = verified(); result.response.raw.is_secure_email_gateway = true;
  assert.deepEqual(emailVerificationState(result), { email_status: 'valid', email_verified: true });
});
test('catch-all, unknown provider, contradictory or missing proof remains risky', () => {
  for (const mutate of [
    value => { value.response.raw.is_domain_catch_all = true; },
    value => { delete value.response.raw.is_domain_catch_all; },
    value => { value.response.output.valid = false; },
    value => { delete value.response.raw; },
    value => { value.response.raw.substatus = 'catch_all'; },
    value => { value.response.raw.is_disposable = true; },
    value => { value.response.raw.is_role_account = true; },
    value => { value.provider = 'other'; value.response._treg.served_by = 'other'; },
  ]) {
    const value = verified(); mutate(value);
    assert.deepEqual(emailVerificationState(value), { email_status: 'risky', email_verified: false });
  }
});
test('saved evidence can correct an existing email without another find or verify purchase', async () => {
  const contact = { id: 'fixture', name: 'Pat Example', email: 'pat@example.com', email_status: 'risky', email_verified: false, linkedin_status: 'unconfirmed', contact_sources: {} };
  const calls = [];
  const patch = await completeContact({ company: { id: 'company', domain: 'example.com' }, contact, call: async (_company, endpoint) => { calls.push(endpoint); return verified(); } });
  assert.deepEqual(calls, ['treg.people.email.verify']);
  assert.equal(patch.email, contact.email);
  assert.equal(patch.email_verified, true);
  assert.equal(patch.linkedin_status, undefined);
  assert.equal(contact.email_verified, false, 'input snapshot stays unchanged for compare-and-set');
});
