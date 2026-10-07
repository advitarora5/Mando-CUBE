import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSignalDates, extractSignalCandidates, normalizeDate, selectSignal } from '../scripts/collect-signal-dates.mjs';
import { boardFromUrl, collectJobPostings, discoverBoards, employerDomainFromStory, mergePostings, relevance, structuredPostings } from '../scripts/collect-job-postings.mjs';
import { publicUrl, request, search } from '../scripts/input-automation/public-sources.mjs';
import { applySignal, refresh, scoringInputs, summarizeReport } from '../scripts/refresh-company-inputs.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const company = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Acme', source: 'https://www.workday.com/story', domain: 'acme.example', workday_signal_date: null, updated_at: '2026-10-05T00:00:00Z' };
const now = new Date('2026-10-06T12:00:00Z');
const options = { company, trusted: true, now };
const event = 'Acme went live with Workday HCM on March 4, 2024.';
function stub(pages) {
  return async url => {
    assert.ok(Object.hasOwn(pages, url), `Unexpected fetch: ${url}`);
    const value = pages[url];
    if (value instanceof Error) throw value;
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 });
  };
}

test('only explicit company-bound exact HCM go-live dates are eligible', () => {
  for (const date of ['March 4, 2024', '4 March 2024', '2024-03-04']) {
    const [row] = extractSignalCandidates(`<p>Acme went live with Workday HCM on ${date}.</p>`, company.source, options);
    assert.equal(row.candidate_date, '2024-03-04'); assert.equal(row.storable, true);
  }
});

test('reject unrelated, ambiguous, approximate, future, invalid, and non-HCM dates', () => {
  const cases = [
    'Published March 4, 2024. Acme uses Workday HCM.',
    'Acme selected Workday HCM on March 4, 2024.',
    'Acme went live with Workday HCM in 2024.',
    'Acme went live with Workday HCM on 03/04/2024.',
    'Acme went live with Workday Financial Management on March 4, 2024.',
    'Acme will have gone live with Workday HCM on March 4, 2027.',
    'Acme went live with Workday HCM on February 30, 2024.',
    'Acme went live with Workday HCM on March 4, 2027.',
    'Acme did not go live with Workday HCM on March 4, 2024.',
    'Acme subsidiary went live with Workday HCM on March 4, 2024.',
    'Acme went live with Workday HCM on March 4, 2024 or March 5, 2024.',
    'Beta went live with Workday HCM on March 4, 2024. Acme uses Workday.',
    'Acme went live with Workday HCM and Beta went live with Workday HCM on March 4, 2024.',
    '<script>Acme went live with Workday HCM on March 4, 2024.</script>',
  ];
  for (const html of cases) assert.ok(extractSignalCandidates(html, company.source, options).every(r => !r.storable), html);
  assert.ok(extractSignalCandidates(event, company.source, { ...options, trusted: false }).every(r => !r.storable));
  assert.equal(normalizeDate('2024-02-29'), '2024-02-29'); assert.equal(normalizeDate('2023-02-29'), null);
});

test('conflicting source dates and existing manual dates block updates', () => {
  const candidates = [{ company_id: company.id, storable: true, candidate_date: '2024-03-04', source_url: company.source, reason: 'Exact date' }];
  assert.equal(selectSignal(company, candidates).status, 'ready');
  assert.equal(selectSignal({ ...company, workday_signal_date: '2024-04-01' }, candidates).status, 'existing_date_conflict');
  assert.equal(selectSignal(company, [...candidates, { ...candidates[0], storable: false, candidate_date: '2025-01-01' }]).status, 'conflict');
});

test('checks every supplied source instead of stopping at the first readable page', async () => {
  const rows = await collectSignalDates([company], { now, key: '', configs: { [company.id]: { signal_urls: ['https://acme.example/news'] } },
    fetchImpl: stub({ [company.source]: 'No date here', 'https://acme.example/': 'Home', 'https://acme.example/news': event }) });
  assert.equal(selectSignal(company, rows).date, '2024-03-04');
});

test('search snippets never supply stored dates and LinkedIn results are excluded', async () => {
  const results = await search('Acme', { key: 'test-only', fetchImpl: async () => new Response(JSON.stringify({ web: { results: [
    { url: 'https://www.linkedin.com/post/1' }, { url: 'https://acme.example/news', title: event },
  ] } })) });
  assert.equal(results.length, 1); assert.equal(results[0].url, 'https://acme.example/news');
});

test('unsafe sources and unsafe redirects are rejected', async () => {
  for (const url of ['http://acme.example', 'https://127.0.0.1', 'https://[::1]', 'https://a.linkedin.com/post', 'https://lnkd.in/test', 'https://user:secret@acme.example']) assert.throws(() => publicUrl(url));
  await assert.rejects(request('https://acme.example', { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://www.linkedin.com/' } }) }), /excluded/);
  await assert.rejects(request('https://acme.example', { maxBytes: 2, fetchImpl: async () => new Response('large') }), /too large/);
});

const board = { company_id: company.id, company: company.name, board: 'greenhouse', board_token: 'acme' };
const api = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true';
const job = { id: 1, title: 'HRIS Analyst', content: 'Configure and maintain Workday HCM.', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', requisition_id: 'R1' };

test('posting descriptions supply relevance, never signal dates', async () => {
  const result = await collectJobPostings([board], { now, fetchImpl: stub({ [api]: { jobs: [job, { ...job, id: 2, title: 'Barista', content: 'Coffee.' }], meta: { total: 2 } } }) });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].status, 'active'); assert.equal(result.jobs[0].requisition, 'R1');
  assert.match(result.jobs[0].evidence, /Configure and maintain Workday/);
  assert.equal(result.jobs[0].candidate_date, undefined);
  assert.equal(relevance('Workday Consultant', 'Implement for our clients').relevance, 'consulting_review');
  assert.equal(relevance('Barista', 'Apply through Workday').relevance, 'incidental_review');
});

test('Lever EU uses pagination and reads lists as well as description', async () => {
  const prefix = 'https://api.eu.lever.co/v0/postings/acme?mode=json&limit=100&skip=';
  const payload = Array.from({ length: 100 }, (_, i) => ({ id: i, text: 'Engineer', description: 'Code' }));
  const result = await collectJobPostings([{ ...board, board: 'lever', region: 'eu' }], { now, fetchImpl: stub({
    [`${prefix}0`]: payload, [`${prefix}100`]: [{ id: 'wd', text: 'HRIS Lead', lists: [{ text: 'Duties', content: 'Maintain Workday HCM' }], hostedUrl: 'https://jobs.eu.lever.co/acme/wd' }],
  }) });
  assert.equal(result.checks[0].posting_ids.length, 101); assert.equal(result.jobs.length, 1);
});

test('failed/malformed/incomplete board refreshes remain unknown, not expired', async () => {
  for (const payload of [new Error('offline'), {}, { jobs: [], meta: { total: 5 } }]) {
    const result = await collectJobPostings([board], { now, fetchImpl: stub({ [api]: payload }) });
    assert.equal(result.checks[0].status, 'unknown');
    const [old] = mergePostings([{ board_key: result.checks[0].board_key, posting_id: '1', status: 'active', evidence: 'saved' }], [], result.checks);
    assert.equal(old.status, 'unknown'); assert.equal(old.evidence, 'saved');
  }
});

test('only complete board absence marks an old posting expired', () => {
  const old = { board_key: 'board', posting_id: '1', status: 'active' };
  assert.equal(mergePostings([old], [], [{ board_key: 'board', status: 'ok', posting_ids: [] }])[0].status, 'expired');
  assert.equal(mergePostings([old], [], [{ board_key: 'board', status: 'ok', posting_ids: ['1'] }])[0].status, 'unknown');
  assert.equal(mergePostings([old], [], [{ board_key: 'board', status: 'ok', posting_ids: [], complete_inventory: false }])[0].status, 'unknown');
});

test('employer-linked Workday feed supplies live details without promoting posting dates', async () => {
  const url = 'https://acme.wd1.myworkdayjobs.com/en-US/External';
  const api = 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External';
  const wd = { ...boardFromUrl(url), company_id: company.id, company: company.name };
  const pages = { [url]: 'tenant: "acme", siteId: "External", appName: "cxs"',
    [`${api}/jobs`]: { total: 1, jobPostings: [{ externalPath: '/job/Remote/Workday-Analyst_R1' }] },
    [`${api}/job/Remote/Workday-Analyst_R1`]: { jobPostingInfo: { title: 'HRIS Analyst', jobDescription: 'Maintain Workday HCM.',
      externalUrl: 'https://acme.wd1.myworkdayjobs.com/External/job/Remote/Workday-Analyst_R1', jobReqId: 'R1', posted: true, canApply: true, startDate: '2026-09-01' } },
  };
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/jobs')) { assert.equal(options.method, 'POST'); assert.equal(JSON.parse(options.body).searchText, 'Workday'); }
    return stub(pages)(url);
  };
  const result = await collectJobPostings([wd], { now, fetchImpl });
  assert.equal(result.jobs.length, 1); assert.equal(result.jobs[0].status, 'active');
  assert.equal(result.jobs[0].requisition, 'R1'); assert.equal(result.jobs[0].workday_signal_date, undefined);
  assert.equal(result.checks[0].complete_inventory, false);
  const broken = await collectJobPostings([wd], { now, fetchImpl: stub({ [url]: 'tenant: "other", siteId: "External"' }) });
  assert.equal(broken.checks[0].status, 'unknown'); assert.equal(broken.jobs.length, 0);
});

test('automatic board mappings require links from employer-owned pages', async () => {
  const result = await discoverBoards(company, {}, { key: '', fetchImpl: stub({ 'https://acme.example/': '<a href="https://jobs.lever.co/acme">Careers</a>' }) });
  assert.equal(result.boards[0].board_token, 'acme'); assert.equal(result.boards[0].mapping_evidence, 'https://acme.example/');
  assert.equal(boardFromUrl('https://job-boards.greenhouse.io/acme/jobs/1').board, 'greenhouse');
  assert.equal(boardFromUrl('https://evil.example/acme'), null);
});

test('missing employer domains derive only from exact unambiguous story links', async () => {
  assert.equal(employerDomainFromStory('<a href="https://news.acme.example/news">News</a>', company.source, 'Acme'), 'acme.example');
  assert.equal(employerDomainFromStory('<a href="https://acme.example">One</a><a href="https://acme.com">Two</a>', company.source, 'Acme'), null);
  assert.equal(employerDomainFromStory('<a href="https://other.example">Website</a>', company.source, 'Acme'), null);
  const source = 'https://www.workday.com/en-us/customer-stories/acme.html';
  const result = await discoverBoards({ ...company, domain: null, source }, {}, { key: '', fetchImpl: stub({
    [source]: '<a href="https://acme.example/news">News</a>',
    'https://acme.example/': '<a href="https://jobs.lever.co/acme">Jobs</a>',
  }) });
  assert.equal(result.employer_domain, 'acme.example'); assert.equal(result.domain_evidence, source);
  assert.equal(result.boards.length, 1);
});

test('employer structured jobs require matching organization and actual URL', () => {
  const html = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
  const value = { '@type': 'JobPosting', hiringOrganization: { name: 'Acme' }, title: 'Workday Analyst', description: 'Maintain Workday HCM', url: '/jobs/1', validThrough: '2026-12-01' };
  assert.equal(structuredPostings(html(value), 'https://acme.example/jobs', company, now)[0].status, 'active');
  assert.equal(structuredPostings(html({ ...value, validThrough: undefined }), 'https://acme.example/jobs', company, now)[0].status, 'unknown');
  assert.equal(structuredPostings(html({ ...value, hiringOrganization: { name: 'Beta' } }), 'https://acme.example/jobs', company, now).length, 0);
  assert.equal(structuredPostings(html({ ...value, url: undefined }), 'https://acme.example/jobs', company, now).length, 0);
});

test('apply uses optimistic version check and only fills empty dates', async () => {
  const calls = [];
  const query = { update: value => { calls.push(value); return query; }, eq: (...args) => { calls.push(args); return query; },
    is: (...args) => { calls.push(args); return query; }, select: async () => ({ data: [], error: null }) };
  const db = { from: table => { assert.equal(table, 'companies'); return query; } };
  assert.equal(await applySignal(db, company, { status: 'ready', date: '2024-03-04' }), 'concurrent_change');
  assert.deepEqual(calls, [{ workday_signal_date: '2024-03-04' }, ['id', company.id], ['updated_at', company.updated_at], ['workday_signal_date', null]]);
  assert.equal(await applySignal(db, company, { status: 'conflict' }), 'not_changed');
});

test('full dry run returns scorer-shaped evidence without scores/history mutations', async () => {
  const report = await refresh([company], { now, key: '', fetchImpl: stub({ [company.source]: event, 'https://acme.example/': 'Home' }),
    previous: [{ company_id: 'other', board_key: 'other', posting_id: '1', status: 'active' }] });
  assert.equal(report.mode, 'dry_run'); assert.equal(report.companies[0].scoring_inputs.workday_signal_date, '2024-03-04');
  assert.match(report.companies[0].scoring_inputs.timing_evidence, /^https:.* \| /);
  assert.equal(report.companies[0].scoring_inputs.release_evidence, undefined);
  assert.equal(report.postings[0].status, 'active'); assert.equal(report.scores, undefined);
});

test('homepage fallback works without a supplied story or search key', async () => {
  const rows = await collectSignalDates([{ ...company, source: null }], {
    now, key: '', fetchImpl: stub({ 'https://acme.example/': event }),
  });
  assert.equal(selectSignal(company, rows).date, '2024-03-04');
});

test('career discovery uses the refresh clock for structured-job activity', async () => {
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
    hiringOrganization: { name: 'Acme' }, title: 'Workday Analyst', description: 'Maintain Workday HCM',
    url: '/jobs/1', validThrough: '2026-10-06T12:01:00Z' })}</script>`;
  const discovery = await discoverBoards(company, {}, { now, key: '', fetchImpl: stub({ 'https://acme.example/': html }) });
  assert.equal(discovery.employerJobs[0].status, 'active');
  assert.equal(discovery.employerJobs[0].checked_at, now.toISOString());
});

test('scorer handoff excludes incidental and unverified activity, retaining review flags', () => {
  const postings = [
    { status: 'active', relevance: 'incidental_review', evidence: 'incidental' },
    { status: 'unknown', relevance: 'workday_role_review', evidence: 'unknown' },
    { status: 'active', relevance: 'workday_role_review', evidence: 'https://acme.example/job | Maintain Workday' },
  ];
  const inputs = scoringInputs(company, { date: '2024-03-04', evidence: 'https://acme.example/news | Exact HCM go-live' }, postings);
  assert.equal(inputs.job_evidence_candidates.length, 1);
  assert.equal(inputs.job_evidence_candidates[0].requires_internal_role_review, true);
  assert.match(inputs.timing_evidence, /Exact HCM go-live/);
});

test('incremental reports preserve unvisited company postings and expose completion', async () => {
  const other = { ...company, id: 'a0000000-0000-4000-8000-000000000002', name: 'Beta' };
  const snapshots = [];
  const report = await refresh([company, other], { key: '', now,
    previous: [{ company_id: other.id, board_key: 'beta', posting_id: '1', status: 'active', evidence: 'retained' }],
    fetchImpl: stub({ [company.source]: event, 'https://acme.example/': 'Home' }),
    onProgress: async partial => snapshots.push(structuredClone(partial)),
  });
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].complete, false);
  assert.equal(snapshots[0].postings[0].status, 'active');
  assert.equal(report.complete, true);
  assert.equal(report.postings[0].status, 'unknown');
  assert.equal(report.postings[0].evidence, 'retained');
  assert.equal(summarizeReport(report).companies_without_job_sources, 2);
});

test('source failures preserve existing dates and appear in the report summary', async () => {
  const report = await refresh([{ ...company, workday_signal_date: '2023-01-01' }], { key: '', now,
    fetchImpl: stub({ [company.source]: new Error('offline'), 'https://acme.example/': new Error('offline') }),
  });
  assert.equal(report.companies[0].scoring_inputs.workday_signal_date, '2023-01-01');
  assert.equal(report.companies[0].signal.status, 'review');
  assert.equal(summarizeReport(report).source_failures, 3);
});

test('standalone preview commands execute and reject overwriting inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mando-inputs-'));
  try {
    const input = join(dir, 'input.json');
    const output = join(dir, 'output.json');
    await writeFile(input, '[]');
    for (const [script, flag, expected] of [
      ['collect-signal-dates.mjs', '--companies', []],
      ['collect-job-postings.mjs', '--boards', { jobs: [], checks: [] }],
    ]) {
      const run = spawnSync(process.execPath, [`scripts/${script}`, flag, input, '--out', output], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), expected);
      assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), expected);
      const rejected = spawnSync(process.execPath, [`scripts/${script}`, flag, input, '--out', input], { encoding: 'utf8' });
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /must not overwrite/);
      assert.equal(await readFile(input, 'utf8'), '[]');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
