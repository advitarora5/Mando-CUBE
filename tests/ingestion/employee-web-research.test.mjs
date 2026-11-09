import { test } from 'node:test';
import assert from 'node:assert/strict';
import { employeeEvidenceFromDocument as extract, employeeEvidenceFromHtml, publishedDate } from '../../src/pipeline/employee-document-evidence.ts';
import { lookupEmployeeWebsite, researchEmployeeWebsite } from '../../src/pipeline/employee-web-research.ts';
import { scoreStage } from '../../src/pipeline/stages.ts';
import { makeCtx, clock, fakeFetch, response, fakeTreg } from './helpers.mjs';

const NOW = new Date('2026-11-08T12:00:00Z');
const source = 'https://pilot.example/about';
const company = { id: 'c1', name: 'Pilot Corp', domain: 'pilot.example' };
const page = text => `<title>Pilot Corp</title><p>${text}</p>`;
const extractText = (text, extra = {}) => extract({ text, companyName: company.name, source, ...extra }, NOW);
function context(html = page('As of December 31, 2025, Pilot employs 3,500 employees worldwide.')) {
  const fetch = fakeFetch([
    { match: /\/robots.txt$/, respond: () => response(200, '') },
    { match: /^https:\/\/pilot.example\//, respond: () => response(200, html, { 'content-type': 'text/html' }) },
  ]);
  const ctx = makeCtx({ now: clock(NOW.toISOString()), fetch });
  ctx.employeeWebResearch = true;
  return ctx;
}

test('workforce parsing preserves count, precision, date and original claim', () => {
  const result = extractText('As of December 31, 2025, Pilot employs more than 3,500 employees worldwide.');
  assert.equal(result.evidence.employee_count, 3500);
  assert.equal(result.evidence.basis, 'lower_bound');
  assert.equal(result.evidence.date_basis, 'effective');
  assert.equal(result.evidence.as_of, '2025-12-31');
  assert.match(result.evidence.quote, /Pilot employs more than 3,500/);
  assert.equal(extractText('On 31 December 2025 we have approximately 7 200 employees.').evidence.employee_count, 7200);
  assert.equal(extractText('As of 2026-06-30 we have 3.5 thousand employees.').evidence.employee_count, 3500);
});

test('historical counts, subsidiary counts, upper bounds, local workforces and conflicting figures are held', () => {
  for (const text of ['As of 2020-01-01 we employ 9000 employees.', 'As of 2027-01-01 we employ 9000 employees.',
    'In 2020 we had 9000 employees.', 'Our subsidiaries employ 9000 employees.',
    'We have up to 9000 employees.', 'We have between 2000 and 9000 employees.',
    'We have 9000 employees in Germany.', 'Our customers have 9000 employees.',
    'As of 2025-12-31 we have 3500 employees. As of 2025-12-31 we have 2000 employees.']) {
    assert.equal(extractText(text, { published: '2026-06-30' }).evidence, null, text);
  }
  assert.equal(extract({ text: 'Yokogawa Electric Corporation. Across the entire Yokogawa Group, we have 18,313 employees as of March 31, 2026.', companyName: 'Yokogawa Electric', source }, NOW).evidence, null);
});

test('publication date and observation date are distinguished and stale publications stay stale', () => {
  const dated = employeeEvidenceFromHtml('<meta property="article:published_time" content="2026-02-16"><p>Pilot has 3500 employees.</p>', company.name, 'https://pilot.example/news/announcement', NOW);
  assert.equal(dated.evidence.date_basis, 'publication');
  assert.equal(dated.evidence.as_of, '2026-02-16');
  const observed = employeeEvidenceFromHtml(page('We have 3500 employees worldwide.'), company.name, source, NOW);
  assert.equal(observed.evidence.date_basis, 'observed');
  assert.equal(observed.evidence.as_of, '2026-11-08');
  assert.equal(employeeEvidenceFromHtml(page('We have 3500 employees.'), company.name, 'https://pilot.example/annual-report-2020', NOW).evidence, null);
  assert.equal(employeeEvidenceFromHtml('<meta name="date" content="2020-01-01">'+page('We have 3500 employees.'), company.name, source, NOW).evidence, null);
  assert.equal(publishedDate('<footer>Copyright 2026</footer>'), null);
});

test('normal website research honors cache and retry dates and scores through the normal entry point', async () => {
  const ctx = context();
  const id = ctx.store.addExistingCompany({ name: company.name, domain: company.domain });
  ctx.store.companyRows[0].pipeline = true;
  await ctx.store.insertContact({ company_id: id, name: 'Pat Pilot', title: 'Director of HRIS',
    source: 'https://pilot.example/team', linkedin_status: 'confirmed', linkedin_url: null,
    email: null, email_status: null, phone: null, phone_status: null, mutual_connection: null });
  const result = await scoreStage(ctx);
  assert.equal(result.counts.employee_evidence_web, 1);
  assert.equal((await ctx.store.latestScore(id)).authority_score, 23);
  assert.equal((await ctx.store.employeeResearch(id)).status, 'found');
  const requests = ctx.fetch.calls.length;
  await scoreStage(ctx);
  assert.equal(ctx.fetch.calls.length, requests);
  assert.equal((await ctx.store.latestScore(id)).authority_score, 23);
});

test('observation date is labeled in the assessment and expires after 30 days', async () => {
  const ctx = context(page('We employ 3500 employees worldwide.'));
  const result = await lookupEmployeeWebsite(ctx, company);
  assert.equal(result.evidence.date_basis, 'observed');
  ctx.now.advanceDays(31);
  // A failed refresh must not keep an old observation current.
  ctx.fetch = async () => { throw new Error('offline'); };
  const next = await lookupEmployeeWebsite({ ...ctx }, company);
  assert.equal(next.evidence, null);
});

test('lease ownership prevents concurrent duplicate research and stale completions', async () => {
  const ctx = context();
  const first = await ctx.store.claimEmployeeResearch('c1', 'pilot.example', 'pilot');
  assert.ok(first.lease_token);
  assert.equal(await ctx.store.claimEmployeeResearch('c1', 'pilot.example', 'pilot'), null);
  ctx.now.advanceDays(1);
  const second = await ctx.store.claimEmployeeResearch('c1', 'pilot.example', 'pilot');
  assert.notEqual(second.lease_token, first.lease_token);
  assert.equal(await ctx.store.finishEmployeeResearch('c1', first.lease_token, 'needs_review', null, 'stale'), false);
  assert.equal(await ctx.store.finishEmployeeResearch('c1', second.lease_token, 'needs_review', null, 'current'), true);
});

test('unknown companies progress through bounded batches and domain changes invalidate cached evidence', async () => {
  const ctx = context(page('Welcome to Pilot.'));
  ctx.employeeWebMaxCompanies = 1;
  await lookupEmployeeWebsite(ctx, company);
  assert.equal((await lookupEmployeeWebsite(ctx, { ...company, id: 'c2' })).requests, 0);
  const next = { ...ctx };
  assert.ok((await lookupEmployeeWebsite(next, { ...company, id: 'c2' })).requests > 0);
  assert.equal((await lookupEmployeeWebsite({ ...ctx }, { ...company, domain: 'other.example' })).evidence, null);
});

test('search snippets confer no credit, and a zero-cost search can discover a readable official page', async () => {
  const ctx = context(page('Welcome.'));
  ctx.treg = fakeTreg({ 'tinyfish.web.search': () => ({ ok: true, status: 200, cost_usd: 0,
    body: { results: [{ url: 'https://evil.example/report', snippet: 'Pilot has 9999 employees' },
      { url: 'https://pilot.example/news/count' }] } }) });
  ctx.fetch = fakeFetch([
    { match: /\/robots.txt$/, respond: () => response(200, '') },
    { match: /\/news\/count$/, respond: () => response(200, page('As of 2026-06-30, we have 3500 employees.'), { 'content-type': 'text/html' }) },
    { match: /pilot.example\/$/, respond: () => response(200, page('Welcome.'), { 'content-type': 'text/html' }) },
  ]);
  const result = await researchEmployeeWebsite(ctx, company);
  assert.equal(result.evidence.employee_count, 3500);
  assert.equal(result.evidence.source, 'https://pilot.example/news/count');
  assert.equal(ctx.fetch.calls.some(call => call.url.includes('evil.example')), false);
  const call = ctx.treg.calls[0];
  assert.equal(call.opts.headers['X-Treg-Route-Max-Cost'], '0');
});

test('feature-disabled and unavailable storage leave ordinary scoring available', async () => {
  const ctx = context();
  ctx.employeeWebResearch = false;
  assert.equal((await lookupEmployeeWebsite(ctx, company)).requests, 0);
  assert.equal(ctx.fetch.calls.length, 0);
  ctx.employeeWebResearch = true;
  ctx.store.employeeResearch = async () => { throw new Error('migration missing'); };
  assert.equal((await lookupEmployeeWebsite(ctx, company)).evidence, null);
  assert.equal(ctx.fetch.calls.length, 0);
});

test('PDF reader extracts text from a real PDF and rejects malformed documents', async () => {
  const { employeePdfText } = await import('../../src/pipeline/employee-pdf.ts');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const content = 'BT /F1 12 Tf 20 700 Td (As of December 31, 2025, Pilot employs 3500 employees.) Tj ET';
  objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const text = await employeePdfText(new Uint8Array(Buffer.from(pdf)));
  assert.match(text, /Pilot employs 3500 employees/);
  assert.equal(extractText(text).evidence.employee_count, 3500);
  await assert.rejects(employeePdfText(new Uint8Array(Buffer.from('not a PDF'))));
});

test('publication timestamps and branded corporate pages retain dates and ownership', async () => {
  assert.equal(publishedDate('<meta property="article:published_time" content="2026-02-16T13:07:29+00:00">'), '2026-02-16');
  assert.equal(publishedDate('<h1>Pilot update</h1><p>16 February 2026</p><p>Pilot employs 3500 employees.</p>'), '2026-02-16');
  assert.equal(extractText('Pilot has 3,500+ employees.', { allowObserved: true }).evidence.basis, 'lower_bound');
  assert.equal(extractText('Pilot acquired Otherco, which has 3500 employees.', { allowObserved: true }).evidence, null);
  const ctx = context();
  ctx.treg = fakeTreg({ 'tinyfish.web.search': () => ({ ok: true, status: 200, cost_usd: 0,
    body: { results: [{ url: 'https://community.pilot.example/t/123' }] } }) });
  await researchEmployeeWebsite(ctx, company);
  assert.equal(ctx.fetch.calls.some(call => call.url.includes('community.')), false);
});

test('planned, negated, acquired, customer and partial workforces never earn evidence', () => {
  const claims = [
    'We plan to have 9000 employees.', 'We will employ 9000 employees by 2027.',
    'As of 2026-06-30 we do not have 9000 employees.', 'We never employed 9000 employees.',
    'We have 9000 employees as a target.', 'We have nearly 9000 employees.',
    'We have 2000–9000 employees.', 'We have 2000 to 9000 employees.',
    'We have 9000 employees at our German subsidiary.',
    'We have 9000 employees for our customers.', 'We have 9000 employees acquired from Otherco.',
    'We partner with Otherco, which employs 9000 employees.',
    'Our network of independent firms has 9000 employees.', 'Pilot Group has 9000 employees.', 'Our group has 9000 employees.',
    'We have 9000 full-time equivalents.', 'We have 3.000 employees.',
    'In 2024 we have 9000 employees.',
  ];
  for (const text of claims) assert.equal(extractText(text, { published: '2026-06-30', allowObserved: true }).evidence, null, text);
  assert.equal(extractText('We have 9000 employees.', { source: 'https://pilot.example/customers/otherco', allowObserved: true }).evidence, null);
  assert.equal(extractText('We have 9 thousand employees worldwide.', { allowObserved: true }).evidence.employee_count, 9000);
  assert.equal(extractText('Our 9,000-plus employees are based worldwide.', { allowObserved: true }).evidence.basis, 'lower_bound');
});

test('JSON-LD counts require the exact employer, integer employee units and an eligible date', () => {
  const html = node => page('Welcome.') + `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
  const org = { '@type': 'Organization', name: 'Pilot Corp', numberOfEmployees: { '@type': 'QuantitativeValue', value: 3500, unitText: 'employees' } };
  const run = (node, url = source) => employeeEvidenceFromHtml(html(node), company.name, url, NOW).evidence;
  assert.equal(run(org).employee_count, 3500);
  assert.equal(run(org).date_basis, 'observed');
  assert.equal(run({ ...org, name: 'Otherco' }), null);
  assert.equal(run({ ...org, name: 'Pilot Group' }), null);
  assert.equal(run({ ...org, numberOfEmployees: { value: 3.5, unitText: 'thousands' } }), null);
  assert.equal(run({ ...org, numberOfEmployees: { minValue: 2000, maxValue: 9000 } }), null);
  assert.equal(run({ ...org, numberOfEmployees: { value: 3500, maxValue: 9000 } }), null);
  assert.equal(run({ ...org, numberOfEmployees: { value: 3500, unitText: 'FTE' } }), null);
  assert.equal(run({ '@type': 'JobPosting', hiringOrganization: org }), null);
  assert.equal(run(org, 'https://pilot.example/news/undated'), null);
  const conflict = html(org) + '<p>We have 4500 employees.</p>';
  assert.match(employeeEvidenceFromHtml(conflict, company.name, source, NOW).reason, /Conflicting/);
});

 test('explicit, publication and observation dates remain separate; expired leases cannot complete', async () => {
  const dated = employeeEvidenceFromHtml('<meta property="article:published_time" content="2026-02-16">'+page('As of December 31, 2025, we have 3500 employees.'), company.name, source, NOW).evidence;
  assert.equal(dated.as_of, '2025-12-31');
  assert.equal(dated.published_on, '2026-02-16');
  assert.equal(dated.observed_on, '2026-11-08');
  assert.equal(extractText('As of 2025-12-31 we have 3500 employees.', { published: '2027-01-01' }).evidence, null);
  const ctx = context();
  const lease = await ctx.store.claimEmployeeResearch('c1','pilot.example','pilot');
  ctx.now.advanceDays(1);
  assert.equal(await ctx.store.finishEmployeeResearch('c1',lease.lease_token,'needs_review',null,'expired'),false);
});

test('reviewed metadata preserves publication labels and approximate counts cannot earn a size bonus', async () => {
  const { employeeEvidenceSchema, employeeEvidenceForCompany } = await import('../../src/pipeline/employee-evidence.ts');
  const { authorityFromContacts } = await import('../../src/domain/ingestion/pipeline-score.ts');
  const reviewed = employeeEvidenceSchema.parse([{ company_domain: company.domain, employee_count: 7500,
    as_of: '2026-02-16', source, basis: 'lower_bound', date_basis: 'publication' }]);
  const contact = { name: 'Pat', title: 'Director of HRIS', linkedin_status: 'confirmed', source };
  const scored = authorityFromContacts([contact], { employee_count: 7500, employee_source: source,
    employee_as_of: reviewed[0].as_of, employee_basis: reviewed[0].basis, employee_date_basis: reviewed[0].date_basis }, NOW);
  assert.match(scored.reason, /Headcount at least 7500 reported on 2026-02-16/);
  const approximate = authorityFromContacts([contact], { employee_count: 7500, employee_source: source,
    employee_as_of: '2026-02-16', employee_basis: 'approximate' }, NOW);
  assert.equal(approximate.detail.size, 0);
  const observations = employeeEvidenceSchema.parse([{ ...reviewed[0], as_of: '2026-10-01', date_basis: 'observed' }]);
  assert.equal(employeeEvidenceForCompany(observations, company.domain, NOW), null);
});
