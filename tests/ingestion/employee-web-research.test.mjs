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

test('beneficiary populations are not workforce counts', () => {
  for (const text of [
    'As the global leader in implantable hearing solutions, we have helped over 700,000 people to hear with one of our implantable solutions.',
    'We have supported 9000 people around the world.',
    'We have reached more than 9000 people.',
    'Our team has trained 9000 people.',
  ]) assert.equal(extractText(text, { allowObserved: true }).evidence, null, text);
  for (const text of ['We have 3500 people worldwide.', 'Our passionate team of 3500 people is dedicated to innovation.',
    'We’re 3500+ people across 38 countries.', 'We employ more than 3500 people worldwide.']) {
    assert.equal(extractText(text, { allowObserved: true }).evidence?.employee_count, 3500, text);
  }
});

test('local employer headings and symbolic approximations keep their scope and precision', () => {
  const local = extract({ text: 'Shell in The United States With more than 11,000 employees, Shell has been in the US for more than 100 years.',
    companyName: 'Shell', source, allowObserved: true }, NOW);
  assert.equal(local.evidence, null);
  for (const sign of ['~', '≈']) {
    const result = extractText(`We are helping our ${sign}56,000 employees develop their careers.`, { allowObserved: true });
    assert.equal(result.evidence?.employee_count, 56000);
    assert.equal(result.evidence?.basis, 'approximate');
    assert.equal(extractText(`We employ ${sign}56,000+ employees.`, { allowObserved: true }).evidence?.basis, 'approximate');
  }
});
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

test('corporate fact cards and contractions establish employer totals without a prose template', () => {
  const card = '<title>Pilot Newsroom</title><li><span>9K+</span><span>global employees</span></li>';
  const result = employeeEvidenceFromHtml(card, company.name, 'https://pilot.example/company-news', NOW);
  assert.equal(result.evidence.employee_count, 9000);
  assert.equal(result.evidence.basis, 'lower_bound');
  assert.equal(result.evidence.quote, '9K+ global employees');
  assert.equal(result.evidence.date_basis, 'observed');
  assert.equal(employeeEvidenceFromHtml(card.replace('employees','customers'), company.name, 'https://pilot.example/company-news', NOW).evidence, null);
  assert.equal(employeeEvidenceFromHtml(card.replace('Pilot Newsroom','Otherco Newsroom'), company.name, 'https://pilot.example/company-news', NOW).evidence, null);
  assert.equal(employeeEvidenceFromHtml(card, company.name, 'https://pilot.example/news/customer-story', NOW).evidence, null);
  assert.equal(employeeEvidenceFromHtml('<meta property="article:published_time" content="2027-01-01">'+card, company.name, source, NOW).evidence, null);
  assert.equal(extractText('We’re 800+ people across 38 countries.',{allowObserved:true}).evidence.employee_count,800);
  assert.equal(extractText('As of March 31, 2026, we had 9,021 full-time employees and 299,458 Customers.',{}).evidence.employee_count,9021);
  assert.equal(extractText('Our customers had 9,021 employees as of March 31, 2026.',{}).evidence,null);
});

test('annual-report headings identify generic Download links on external PDF hosts', async () => {
  const fetched = [];
  const ctx = context(page('Welcome.') + '<a href="/investor">Investor relations</a><a href="/sustainability/goals">Sustainability goals</a>');
  ctx.fetch = async url => {
    fetched.push(String(url));
    if (String(url).endsWith('/robots.txt')) return response(200, '');
    if (String(url).endsWith('/investor')) return response(200, page('Reports') + '<a href="/reports/annual">Annual reports</a>', {'content-type':'text/html'});
    if (String(url).endsWith('/reports/annual')) return response(200, page('Reports') + '<h2>2025 Annual Report</h2><h4><a href="https://cdn.example/115/1-en.pdf">Download<i></i></a></h4>', {'content-type':'text/html'});
    if (String(url).includes('cdn.example')) return response(404, '');
    return response(200, page('Welcome.') + '<a href="/investor">Investor relations</a><a href="/sustainability/goals">Sustainability goals</a>', {'content-type':'text/html'});
  };
  const result = await researchEmployeeWebsite(ctx, company);
  assert.ok(fetched.includes('https://cdn.example/115/1-en.pdf'));
  assert.ok(!fetched.includes('https://pilot.example/sustainability/goals') || fetched.indexOf('https://pilot.example/investor') < fetched.indexOf('https://pilot.example/sustainability/goals'));
  assert.ok(result.requests <= 18);
});

test('generic external Download links do not inherit a distant or unrelated report heading', async () => {
  for (const fragment of [
    '<h2>Customer tools</h2><a href="https://cdn.example/file.pdf">Download</a>',
    '<h2>Annual Report</h2>'+' '.repeat(1300)+'<a href="https://cdn.example/file.pdf">Download</a>',
    '<h2>Annual Report</h2><h3>Customer tools</h3><a href="https://cdn.example/file.pdf">Download</a>',
  ]) {
    const ctx = context(page('Welcome.')+fragment);
    await researchEmployeeWebsite(ctx,company);
    assert.ok(ctx.fetch.calls.every(c=>!c.url.includes('cdn.example')));
  }
});

test('headcount robots handling can reach a bounded terminal 404 without bypassing disallow or DNS checks', async () => {
  for (const mode of ['missing', 'deny', 'loop', 'private', 'endless']) {
    const ctx = context();let pages=0;
    ctx.fetch = async url => {
      const path = new URL(url).pathname;
      if (path.startsWith('/robots')) {
        const step = Number(path.match(/\d+$/)?.[0] ?? 0);
        if (mode === 'loop') return response(302,'',{location:'/robots.txt'});
        if (mode === 'private') return response(302,'',{location:'https://127.0.0.1/robots.txt'});
        if (step < 5 || mode === 'endless') return response(302,'',{location:`/robots-${step+1}`});
        return mode === 'deny' ? response(200,'User-agent: *\nDisallow: /') : response(404,'');
      }
      pages++;
      return response(200,page('As of March 31, 2026 we have 3500 employees.'),{'content-type':'text/html'});
    };
    const result = await researchEmployeeWebsite(ctx,company);
    assert.equal(pages,mode==='missing'?1:0,mode);
    assert.equal(!!result.evidence,mode==='missing',mode);
    assert.ok(result.requests<=18);
  }
});
