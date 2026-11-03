import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdentity, identitySignature, reusableIdentity, evaluateIdentity, digest, groundIdentityAnswer, identityExcerpts } from '../../src/pipeline/identity.ts';
import { prepareIdentityCase, jobIdentityText, identityTargetSchema, boundedIdentityText } from '../../src/pipeline/identity-evidence.ts';
import { WebsiteHttp } from '../../src/pipeline/website.ts';
import { makeCtx, fakeFetch, response } from './helpers.mjs';

const now = new Date('2026-11-01T12:00:00Z');
function packet() {
  return { id: 'western', target_name: 'Western Digital', corporate_url: 'https://westerndigital.com/',
    site: { tenant: 'western', pod: 'wd1', site: 'WESTERN' }, review_id: null, prepared_at: now.toISOString(), errors: [],
    sources: [
      { id: 'c', side: 'corporate', url: 'https://westerndigital.com/', text: 'Western Digital develops data storage products for customers worldwide.' },
      { id: 'w', side: 'workday', url: 'https://western.wd1.myworkdayjobs.com/wday/cxs/western/WESTERN/job/Professor_1', text: 'Western Colorado University is hiring an assistant professor for its university campus.' },
    ].map(s => ({ ...s, fetched_at: now.toISOString(), content_hash: digest(s.text), capture_id: null })) };
}
const mismatch = () => ({ verdict: 'different_company', corporate_identity: ['Western Digital'], workday_identity: ['Western Colorado University'],
  business: { corporate: 'Data storage products', workday: 'Higher education' },
  supporting_factors: [], contradictions: ['Storage manufacturer versus university'], uncertainties: [],
  explanation: 'The sources describe different employers and different organization types.', evidence: {
    corporate: [{ source_id: 'c', quote: 'Western Digital develops data storage products' }],
    workday: [{ source_id: 'w', quote: 'Western Colorado University is hiring an assistant professor' }],
  } });
function model(answer = mismatch()) {
  const calls = [];
  return { name: 'ollama', model: 'local-test', worstCaseUsd: 0, calls,
    complete: async request => {
      calls.push(request);
      const sources = JSON.parse(request.user).sources, output = structuredClone(answer);
      for (const side of ['corporate', 'workday']) {
        output.evidence[side] = output.evidence[side].map(ref => {
          const source = sources.find(s => s.id === ref.source_id);
          const excerpt = source?.excerpts.find(e => e.text.includes(ref.quote));
          return { source_id: ref.source_id, excerpt_index: excerpt?.excerpt_index ?? 999 };
        });
      }
      return { ok: true, json: output, cost_usd: 0, ms: 1 };
    } };
}

test('identity: business comparison reaches the model and its contextual judgment is preserved', async () => {
  const p = packet(), before = JSON.stringify(p), llm = model();
  const result = await verifyIdentity(p, llm, 'digest-1', now);
  assert.equal(result.verdict, 'different_company'); assert.equal(result.status, 'done');
  assert.equal(JSON.stringify(p), before);
  assert.deepEqual(result.answer.business, { corporate: 'Data storage products', workday: 'Higher education' });
  assert.match(llm.calls[0].system, /target name is a hypothesis/);
  assert.match(llm.calls[0].system, /employer's business from the job function/);
  assert.match(llm.calls[0].user, /Western Colorado University/);
});

test('identity: missing, stale, future, duplicate or wrong-site input never calls the model', async () => {
  for (const mutate of [
    p => p.sources.pop(),
    p => { p.sources[1].text = ''; },
    p => { p.sources[1].fetched_at = '2026-09-01T00:00:00Z'; },
    p => { p.sources[1].fetched_at = '2027-01-01T00:00:00Z'; },
    p => { p.sources[1].url = p.sources[1].url.replace('/WESTERN/', '/Other/'); },
    p => { p.sources[1].url = p.sources[1].url.replace('western.wd1', 'other.wd1'); },
    p => { p.sources[1].id = 'c'; },
    p => { p.sources[0].url = 'https://other.example/'; },
  ]) {
    const p = packet(), llm = model(); mutate(p);
    const result = await verifyIdentity(p, llm, 'v1', now);
    assert.equal(result.status, 'insufficient_input'); assert.equal(result.verdict, 'insufficient_evidence'); assert.equal(llm.calls.length, 0);
  }
});

test('identity: invented citations, missing sides, wrong source roles and malformed output fail closed', async () => {
  for (const mutate of [
    a => { a.evidence.workday[0].quote = 'This text was invented by the model'; },
    a => { a.evidence.workday[0].source_id = 'invented'; },
    a => { a.evidence.workday = []; },
    a => { a.evidence.workday[0].source_id = 'c'; },
    a => { a.workday_identity = 'scalar instead of a list'; },
    a => { a.extra = 'unexpected'; },
  ]) {
    const answer = mismatch(); mutate(answer);
    const result = await verifyIdentity(packet(), model(answer), 'v1', now);
    assert.equal(result.status, 'invalid_output'); assert.equal(result.verdict, 'insufficient_evidence');
  }
});

test('identity: model outage and nonzero cost fail closed; paid providers refused before calling', async () => {
  const llm = model(); llm.complete = async () => ({ ok: false, error: 'ollama timeout', cost_usd: 0, ms: 1 });
  assert.equal((await verifyIdentity(packet(), llm, 'v1', now)).status, 'model_error');
  llm.complete = async () => ({ ok: true, json: mismatch(), cost_usd: 1, ms: 1 });
  assert.equal((await verifyIdentity(packet(), llm, 'v1', now)).verdict, 'insufficient_evidence');
  await assert.rejects(verifyIdentity(packet(), { ...llm, name: 'openai' }, 'v1', now), /local Ollama/);
});

function contextualPair() {
  const p = packet();
  p.target_name = 'Cisco Systems, Inc.';
  p.sources[0].text = 'Cisco designs networking equipment and security products for enterprise customers.';
  p.sources[1].text = 'Cisco Systems, Inc. is hiring to build networking equipment and security products.';
  p.sources[1].identity_groups = [{ kind: 'workday_employer', names: [{ field: 'hiringOrganization.name', value: 'Cisco Systems, Inc.' }] }];
  const answer = { ...mismatch(), verdict: 'same_company', corporate_identity: ['Cisco'], workday_identity: ['Cisco Systems, Inc.'],
    business: { corporate: 'Enterprise networking and security', workday: 'Enterprise networking and security' },
    supporting_factors: ['Distinctive Cisco brand and consistent networking products'], contradictions: [], uncertainties: [],
    explanation: 'The brand, employer description and product context support the same organization.', evidence: {
      corporate: [{ source_id: 'c', quote: 'Cisco designs networking equipment and security products' }],
      workday: [{ source_id: 'w', quote: 'Cisco Systems, Inc. is hiring to build networking equipment' }],
    } };
  return { p, answer };
}

test('identity: a contextual brand/legal-name match needs no link, formal alias declaration or ownership sentence', async () => {
  const { p, answer } = contextualPair();
  const result = await verifyIdentity(p, model(answer), 'v1', now);
  assert.equal(result.verdict, 'same_company');
  assert.deepEqual(result.answer.observed_identities.workday, ['Cisco Systems, Inc.']);
  assert.deepEqual(result.answer.review_reasons, []);
  assert.equal(result.model_output.verdict, result.verdict);
});

test('identity: multiple legal employers and citations can jointly support a business comparison', async () => {
  const { p, answer } = contextualPair();
  p.sources.push({ ...p.sources[1], id: 'w2', url: p.sources[1].url + '_2', text: 'Cisco Regional Services supports our enterprise networking customers.',
    identity_groups: [{ kind: 'workday_employer', names: [{ field: 'hiringOrganization.name', value: 'Cisco Regional Services' }] }] });
  answer.workday_identity.push('Cisco Regional Services');
  answer.evidence.workday.push({ source_id: 'w2', quote: 'Cisco Regional Services supports our enterprise networking customers' });
  const result = await verifyIdentity(p, model(answer), 'v1', now);
  assert.equal(result.verdict, 'same_company');
  assert.deepEqual(result.answer.workday_identity, ['Cisco Systems, Inc.', 'Cisco Regional Services']);
  assert.equal(result.answer.evidence.workday.length, 2);
  assert.deepEqual(result.answer.observed_identities.workday, ['Cisco Systems, Inc.', 'Cisco Regional Services']);
});

test('identity: names need not occur literally within a single cited business excerpt', () => {
  const p = packet();
  p.sources[0].text = 'We manufacture data storage products for enterprise customers.';
  p.sources[1].text = 'We are a public university offering undergraduate education.';
  const output = { ...mismatch(), evidence: { corporate: [{ source_id: 'c', excerpt_index: 0 }], workday: [{ source_id: 'w', excerpt_index: 0 }] } };
  const { answer } = groundIdentityAnswer(p, output);
  assert.equal(answer.verdict, 'different_company');
  assert.equal(answer.evidence.workday[0].quote, p.sources[1].text);
  output.evidence.workday[0].source_id = 'c';
  assert.throws(() => groundIdentityAnswer(p, output), /wrong side/);
});

test('identity: missing business labels and short branding are not automatic holds', async () => {
  const { p, answer } = contextualPair();
  p.sources[0].text = 'Cisco'; answer.business.corporate = null;
  answer.evidence.corporate = [{ source_id: 'c', quote: 'Cisco' }];
  const result = await verifyIdentity(p, model(answer), 'v1', now);
  assert.equal(result.verdict, 'same_company');
  assert.equal(result.answer.business.corporate, null);
});

test('identity: broad industry similarity does not cause code to override an unrelated-company verdict', async () => {
  const p = packet(), answer = mismatch();
  answer.business = { corporate: 'Financial services', workday: 'Financial services' };
  answer.contradictions = ['Different employers despite the shared broad industry'];
  const result = await verifyIdentity(p, model(answer), 'v1', now);
  assert.equal(result.verdict, 'different_company');
});

test('identity: uncertainty comes from the model context assessment rather than a name-comparison override', async () => {
  const answer = mismatch(); answer.verdict = 'insufficient_evidence';
  answer.uncertainties = ['The available employer descriptions do not establish the connection.'];
  answer.evidence = { corporate: [], workday: [] };
  const result = await verifyIdentity(packet(), model(answer), 'v1', now);
  assert.equal(result.status, 'done'); assert.equal(result.verdict, 'insufficient_evidence');
  assert.deepEqual(result.answer.review_reasons, answer.uncertainties);
});

test('identity: cache invalidates on source, identity observations, target, site, model, revision, age or error', async () => {
  const p = packet(), result = await verifyIdentity(p, model(), 'v1', now);
  assert.ok(reusableIdentity(result, p, 'local-test', 'v1', now));
  for (const mutate of [
    p => { p.target_name = 'Other'; }, p => { p.site.site = 'Other'; }, p => { p.sources[1].text += ' changed'; },
    p => { p.sources[0].identity_groups = [{ kind: 'corporate_organization', names: [{ field: 'name', value: 'Additional name' }] }]; },
  ]) {
    const changed = structuredClone(p); mutate(changed);
    assert.equal(reusableIdentity(result, changed, 'local-test', 'v1', now), false);
    assert.notEqual(identitySignature(changed, 'local-test', 'v1'), result.signature);
  }
  assert.equal(reusableIdentity(result, p, 'other-model', 'v1', now), false);
  assert.equal(reusableIdentity(result, p, 'local-test', 'v2', now), false);
  assert.equal(reusableIdentity({ ...result, signature: 'old-version-signature' }, p, 'local-test', 'v1', now), false);
  assert.ok(reusableIdentity(result, p, 'local-test', 'v1', new Date(+now + 86400001)));
  assert.equal(reusableIdentity(result, p, 'local-test', 'v1', new Date(+now + 15 * 86400000)), false);
  const refreshed = structuredClone(p); refreshed.prepared_at = new Date(+now + 1000).toISOString();
  refreshed.sources[0].fetched_at = refreshed.prepared_at;
  assert.equal(identitySignature(refreshed, 'local-test', 'v1'), result.signature);
  assert.equal(reusableIdentity({ ...result, status: 'model_error' }, p, 'local-test', 'v1', now), false);
});

test('identity evidence: identity and business selection preserve middle employer context without new collection', () => {
  const business = 'Our company manufactures precision instruments for hospital laboratories.';
  const text = 'Company introduction\n' + ('Daily technical responsibilities and requirements.\n'.repeat(100)) + business + '\n' + ('More daily technical responsibilities.\n'.repeat(100)) + 'Company footer';
  const bounded = boundedIdentityText(text);
  assert.ok(bounded.length <= 5000); assert.ok(bounded.includes(business));
  assert.ok(identityExcerpts(bounded).some(e => e.includes(business)));
});

test('identity evidence: exact-site jobs retain first-party employer names and industry information without filtering by Workday', async () => {
  const target = identityTargetSchema.strip().parse(packet());
  const ctx = makeCtx({ now: () => now, fetch: fakeFetch([
    { match: /robots.txt$/, respond: () => response(200, 'User-agent: *\nAllow: /') },
    { match: /^https:\/\/westerndigital.com\/$/, respond: () => response(200, '<title>Western Digital</title><script type="application/ld+json">{"@type":"Corporation","name":"Western Digital","legalName":"Western Digital Corporation","industry":"Digital storage"}</script><p>Western Digital develops data storage products for customers worldwide.</p>', { 'content-type': 'text/html' }) },
    { match: /\/jobs$/, method: 'POST', respond: (url, init) => { assert.equal(JSON.parse(init.body).searchText, ''); return response(200, { jobPostings: [{ externalPath: '/job/Professor_1' }] }); } },
    { match: /\/job\/Professor_1$/, respond: () => response(200, { hiringOrganization: { name: 'Western Colorado University', url: '' }, jobPostingInfo: { title: 'Assistant Professor', jobDescription: '<p>Western Colorado University is hiring an assistant professor for its university campus.</p>' } }) },
  ]) });
  let reads = 0; ctx.store = { async websiteEvidenceCaptures() { reads++; return []; } };
  const out = await prepareIdentityCase(ctx, target, new WebsiteHttp(ctx));
  assert.equal(out.sources.length, 2); assert.deepEqual(out.errors, []);
  assert.match(out.sources[1].text, /Western Colorado University/); assert.doesNotMatch(out.sources[1].text, /Western Digital/);
  assert.match(out.sources[0].text, /industry: Digital storage/);
  assert.deepEqual(out.sources[1].identity_groups[0].names, [{ field: 'hiringOrganization.name', value: 'Western Colorado University' }]);
  assert.equal(reads, 1); assert.throws(() => jobIdentityText('{}'), /job description/);
});

test('identity evidence: unsafe job paths and JSON redirects never fetch outside the exact site', async () => {
  const target = identityTargetSchema.strip().parse(packet());
  for (const path of ['/job/../../Other/job/X', '//evil.example/job/X', '/job/%2e%2e/Other', '/job/X?other=1']) {
    const ctx = makeCtx({ now: () => now, fetch: fakeFetch([
      { match: /robots.txt$/, respond: () => response(200, '') },
      { match: /westerndigital.com/, respond: () => response(403, 'blocked') },
      { match: /\/jobs$/, respond: () => response(200, { jobPostings: [{ externalPath: path }] }) },
    ]) });
    const out = await prepareIdentityCase(ctx, target, new WebsiteHttp(ctx));
    assert.equal(out.sources.length, 0); assert.match(out.errors.join(' '), /invalid Workday job path/);
    assert.equal(ctx.fetch.calls.filter(c => /\/job\//.test(c.url)).length, 0);
  }
  const ctx = makeCtx({ fetch: fakeFetch([
    { match: /robots.txt$/, respond: () => response(200, '') },
    { match: /\/jobs$/, respond: () => response(302, '', { location: 'https://other.example/' }) },
  ]) });
  await assert.rejects(new WebsiteHttp(ctx).json('https://western.wd1.myworkdayjobs.com/wday/cxs/western/WESTERN/jobs'), /HTTP 302/);
  assert.ok(ctx.fetch.calls.every(c => !c.url.includes('other.example')));
});

test('identity names: old frozen packets retain original employer observations as context, not name gates', async () => {
  const { p, answer } = contextualPair();
  delete p.sources[1].identity_groups;
  p.sources[1].text = 'Network Engineer\n{"name":"Cisco Systems, Inc.","url":""}\nCisco designs networking products for enterprise customers.';
  answer.evidence.workday = [{ source_id: 'w', quote: 'Cisco designs networking products for enterprise customers' }];
  const result = await verifyIdentity(p, model(answer), 'v1', now);
  assert.equal(result.verdict, 'same_company');
  assert.deepEqual(result.answer.observed_identities.workday, ['Cisco Systems, Inc.']);
});

test('identity evaluation: abstentions, errors and missing labels do not inflate accuracy', () => {
  const results = [
    { case_id: 'match', verdict: 'insufficient_evidence', status: 'invalid_output' },
    { case_id: 'wrong', verdict: 'same_company', status: 'done' },
    { case_id: 'caught', verdict: 'different_company', status: 'done' },
    { case_id: 'unlabeled', verdict: 'same_company', status: 'done' },
  ];
  const labels = [{ case_id: 'match', expected: 'same_company' }, { case_id: 'wrong', expected: 'different_company' }, { case_id: 'caught', expected: 'different_company' }, { case_id: 'missing', expected: 'same_company' }];
  const summary = evaluateIdentity(results, labels);
  assert.equal(summary.falseAccepts, 1); assert.equal(summary.falseHolds, 1);
  assert.equal(summary.correct, 1); assert.equal(summary.tested, 3); assert.equal(summary.missing, 1);
  assert.equal(summary.coverage, 2 / 3); assert.equal(summary.decisiveAccuracy, 1 / 2);
  assert.equal(summary.errors, 1); assert.equal(summary.unlabeledResults, 1);
  assert.equal(summary.modelEvaluated, 2); assert.equal(summary.accuracy, 1 / 2);
  const failed = evaluateIdentity([{ case_id: 'bad', verdict: 'insufficient_evidence', status: 'invalid_output' }], [{ case_id: 'bad', expected: 'insufficient_evidence' }]);
  assert.equal(failed.correct, 0); assert.equal(failed.accuracy, null);
  assert.throws(() => evaluateIdentity([...results, results[0]], labels), /duplicate/);
});
