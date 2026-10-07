import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToken, validToken, passwordMatches, SESSION_SECONDS } from '../src/server/auth/token.ts';
const secret = 'test-only-secret-with-at-least-32-characters';
const password = 'test-only-password';
const now = 1791310000000;
test('shared password comparison is exact', () => {
  assert.equal(passwordMatches(password, password), true);
  assert.equal(passwordMatches('wrong', password), false);
  assert.equal(passwordMatches(password + ' ', password), false);
});
test('signed sessions reject forgery, expiry and changed credentials', () => {
  const token = createToken(secret, password, now);
  assert.equal(validToken(token, secret, password, now), true);
  assert.equal(validToken(token, secret, password, now + SESSION_SECONDS * 1000), false);
  assert.equal(validToken(token, secret, 'new-password', now), false);
  assert.equal(validToken(token, 'new-secret', password, now), false);
  assert.equal(validToken(token.slice(0, -1) + '!', secret, password, now), false);
  for (const value of [undefined, '', 'true', '123.fake.signature', token + '.extra', token.split('.').slice(0, 2).join('.') + '.' + 'é'.repeat(43), 'x'.repeat(300)]) {
    assert.equal(validToken(value, secret, password, now), false);
  }
});
test('session token contains neither password nor secret and uses independent nonces', () => {
  const token = createToken(secret, password, now);
  assert.ok(!token.includes(password));
  assert.ok(!token.includes(secret));
  assert.notEqual(token, createToken(secret, password, now));
});
