import test from 'node:test';
import assert from 'node:assert/strict';
import { identityCorporateUrls } from '../src/pipeline/local-identity-admission.ts';

test('observed employer URLs are considered before three guessed domains', () => {
  assert.deepEqual(identityCorporateUrls(['https://official.example/'],
    ['https://tenant.com/', 'https://tenant.org/', 'https://tenant.edu/']),
  ['https://official.example/', 'https://tenant.com/', 'https://tenant.org/']);
});

test('posting links that do not carry the company name wait behind .com guesses', () => {
  const links = ['https://www.eeoc.gov/', 'https://cnn.com/', 'https://careers.fernhill.example/'];
  const guesses = ['https://fernhill.com/', 'https://fernhill.org/'];
  assert.deepEqual(identityCorporateUrls(links, guesses, ['fernhill']), ['https://careers.fernhill.example/', 'https://fernhill.com/', 'https://www.eeoc.gov/']);
});

test('a short name term must be a whole host label', () => {
  assert.deepEqual(identityCorporateUrls(['https://marketing.example/', 'https://ing.example/'], ['https://ing.com/'], ['ing']),
    ['https://ing.example/', 'https://ing.com/', 'https://marketing.example/']);
});

test('candidate URL ordering remains deduplicated, HTTPS only and capped at three', () => {
  assert.deepEqual(identityCorporateUrls(['http://bad.example/', 'https://user:pass@bad.example/',
    'https://bad.example:8443/', 'not a url', 'https://official.example/', 'https://official.example/'],
  ['https://official.example/', 'https://second.example/', 'https://third.example/', 'https://fourth.example/']),
  ['https://official.example/', 'https://second.example/', 'https://third.example/']);
});
