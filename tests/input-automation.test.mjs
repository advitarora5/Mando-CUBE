import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSignalCandidates, collectSignalDates } from '../scripts/collect-signal-dates.mjs';
import { collectJobPostings } from '../scripts/collect-job-postings.mjs';

const STORY = 'https://www.workday.com/en-us/customer-stories/acme.html';
const stubFetch = (pages) => async (url) => {
  if (!Object.hasOwn(pages, url)) throw new Error(`unexpected fetch: ${url}`);
  if (pages[url] instanceof Error) throw pages[url];
  return { ok: true, text: async () => pages[url] };
};

test('exact go-live date beside an HCM statement is storable', () => {
  const html = '<p>Acme went live with Workday Human Capital Management on March 4, 2024 across 5,000 employees.</p>';
  const [row] = extractSignalCandidates(html, STORY);
  assert.equal(row.candidate_date, 'March 4, 2024');
  assert.equal(row.date_type, 'exact');
  assert.equal(row.storable, true);
});

test('announcement, finance-only, and approximate dates are never storable', () => {
  const cases = [
    '<p>Acme announced it selected Workday on March 4, 2024; implementation begins next year.</p>',
    '<p>Acme went live with Workday Financial Management on March 4, 2024.</p>',
    '<p>Acme went live with Workday HCM in March 2024.</p>',
    '<p>Acme went live with Workday HCM in 2025.</p>',
  ];
  for (const html of cases) {
    const rows = extractSignalCandidates(html, STORY);
    assert.ok(rows.length > 0);
    for (const row of rows) assert.equal(row.storable, false, html);
  }
});

test('pages without go-live language, unreachable pages, and missing URLs stay reviewable', async () => {
  assert.equal(extractSignalCandidates('<p>Acme careers page.</p>', STORY)[0].date_type, 'none');
  const rows = await collectSignalDates([
    { name: 'Unreachable Co', source: STORY },
    { name: 'Mystery Co' },
  ], { fetchImpl: stubFetch({ [STORY]: new Error('no network') }) });
  assert.equal(rows[0].date_type, 'unreachable');
  assert.equal(rows[1].date_type, 'skipped');
  assert.ok(rows.every((row) => row.storable === false));
const NOW = new Date('2026-10-06T12:00:00Z');
const jsonFetch = (payloads) => async (url) => {
  if (!Object.hasOwn(payloads, url)) throw new Error(`unexpected fetch: ${url}`);
  if (payloads[url] instanceof Error) throw payloads[url];
  return { ok: true, json: async () => payloads[url] };
};

test('greenhouse and lever workday postings are recorded with reviewer fields', async () => {
  const rows = await collectJobPostings([
    { company: 'Greenhouse Co', board: 'greenhouse', board_token: 'greenhouseco' },
    { company: 'Lever Co', board: 'lever', board_token: 'leverco' },
  ], {
    now: NOW,
    fetchImpl: jsonFetch({
      'https://boards-api.greenhouse.io/v1/boards/greenhouseco/jobs?content=true': {
        jobs: [
          { id: 1, title: 'Workday HCM Analyst', absolute_url: 'https://boards.greenhouse.io/greenhouseco/jobs/1', requisition_id: 'REQ-1', location: { name: 'Chicago, IL' }, content: 'Own Workday.' },
          { id: 2, title: 'Barista', absolute_url: 'https://boards.greenhouse.io/greenhouseco/jobs/2', content: 'Coffee.' },
        ],
      },
      'https://api.lever.co/v0/postings/leverco?mode=json': [
        { id: 'abc', text: 'HRIS Workday Lead', hostedUrl: 'https://leverco.lever.co/abc', categories: { location: 'Remote', department: 'People' }, descriptionPlain: 'Lead Workday.' },
      ],
    }),
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].posting_url, 'https://boards.greenhouse.io/greenhouseco/jobs/1');
  assert.equal(rows[0].requisition, 'REQ-1');
  assert.equal(rows[0].checked_at, '2026-10-06');
  assert.equal(rows[1].employer, 'Lever Co (People)');
  assert.ok(rows.every((row) => row.active === true));
});

test('empty boards, bad tokens, and missing mappings stay reviewable without scores', async () => {
  const rows = await collectJobPostings([
    { company: 'Quiet Co', board: 'greenhouse', board_token: 'quietco' },
    { company: 'Broken Co', board: 'lever', board_token: 'brokenco' },
    { company: 'Unmapped Co' },
  ], {
    now: NOW,
    fetchImpl: jsonFetch({
      'https://boards-api.greenhouse.io/v1/boards/quietco/jobs?content=true': { jobs: [] },
      'https://api.lever.co/v0/postings/brokenco?mode=json': new Error('HTTP 404'),
    }),
  });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.title === null && row.active === false));
  assert.match(rows[0].note, /No Workday postings/);
  assert.match(rows[1].note, /unreadable/);
  assert.match(rows[2].note, /never guessed/);
});

});
