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
  assert.deepEqual(identityCorporateUrls(links, guesses, ['fernhill']), ['https://careers.fernhill.example/', 'https://fernhill.example/', 'https://fernhill.com/']);
  const unnamed = ['https://www.eeoc.gov/', 'https://fernhill.example/'];
  assert.deepEqual(identityCorporateUrls(unnamed, guesses, ['fernhill']), ['https://fernhill.example/', 'https://fernhill.com/', 'https://www.eeoc.gov/']);
});

test('a careers host brings its parent domain along as a hypothesis, for any depth of domain', () => {
  // Fictional versions of real cases: the company name is not always in the host, and not every top-level domain has two labels.
  assert.deepEqual(identityCorporateUrls(['https://jobs.fernhillgroup.example/us/en'], ['https://fernhill.com/'], ['fernhill']),
    ['https://jobs.fernhillgroup.example/us/en', 'https://fernhillgroup.example/', 'https://fernhill.com/']);
  assert.deepEqual(identityCorporateUrls(['https://search-careers.fh.example/'], ['https://fernhillmotors.com/'], ['fernhillmotors']),
    ['https://fernhillmotors.com/', 'https://search-careers.fh.example/', 'https://fh.example/']);
  assert.deepEqual(identityCorporateUrls(['https://careers.fernhill.co.uk/'], [], ['fernhill']), ['https://careers.fernhill.co.uk/', 'https://fernhill.co.uk/']);
});

test('only careers hosts get a parent: other subdomains and bare careers domains do not', () => {
  assert.deepEqual(identityCorporateUrls(['https://shop.fernhill.example/'], [], ['fernhill']), ['https://shop.fernhill.example/']);
  assert.deepEqual(identityCorporateUrls(['https://careers.example/'], [], ['example']), ['https://careers.example/']);
});

test('a short name term must be a whole host label', () => {
  assert.deepEqual(identityCorporateUrls(['https://marketing.example/', 'https://ing.example/'], ['https://ing.com/'], ['ing']),
    ['https://ing.example/', 'https://ing.com/', 'https://marketing.example/']);
});

test('document and sign-in links cannot take an employer website slot', () => {
  const links = ['https://docs.google.com/', 'https://accounts.google.com/', 'https://drive.google.com/', 'https://google.com/'];
  assert.deepEqual(identityCorporateUrls(links, []), ['https://google.com/']);
});

test('candidate URL ordering remains deduplicated, HTTPS only and capped at three', () => {
  assert.deepEqual(identityCorporateUrls(['http://bad.example/', 'https://user:pass@bad.example/',
    'https://bad.example:8443/', 'not a url', 'https://official.example/', 'https://official.example/'],
  ['https://official.example/', 'https://second.example/', 'https://third.example/', 'https://fourth.example/']),
  ['https://official.example/', 'https://second.example/', 'https://third.example/']);
});
