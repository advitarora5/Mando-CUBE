import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdentity, identitySignature, reusableIdentity, evaluateIdentity, digest, groundIdentityAnswer, identityExcerpts, containsName, nameKey, IDENTITY_VERSION } from '../../src/pipeline/identity.ts';
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
  corporate_name: 'Western Digital', workday_name: 'Western Colorado University', shared_name: null,
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
    corporate_name: 'Cisco', workday_name: 'Cisco Systems, Inc.', shared_name: 'Cisco',
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
  p.sources[0].text = 'Western Digital\nWe manufacture data storage products for enterprise customers.';
  p.sources[1].text = 'Western Colorado University\nWe are a public university offering undergraduate education.';
  const output = { ...mismatch(), evidence: { corporate: [{ source_id: 'c', excerpt_index: 1 }], workday: [{ source_id: 'w', excerpt_index: 1 }] } };
  const { answer } = groundIdentityAnswer(p, output);
  assert.equal(answer.verdict, 'different_company');
  assert.equal(answer.evidence.workday[0].quote, 'We are a public university offering undergraduate education.');
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

// A same-industry pair with different names, like BlackRock / Blackstone. Uses invented names.
function sameIndustryPair() {
  const p = packet();
  p.target_name = 'Silverline';
  p.sources[0].text = 'Silverline is one of the largest asset management firms.\nSilverline provides investment management.';
  p.sources[1].text = 'Analyst\n{"name":"70040 Silverstone Alternative Asset Management LP","url":""}\nSilverstone is the largest alternative asset manager.';
  const answer = { ...mismatch(), verdict: 'same_company', corporate_identity: ['Silverline'],
    workday_identity: ['70040 Silverstone Alternative Asset Management LP'], corporate_name: 'Silverline', workday_name: 'Silverstone',
    shared_name: null, business: { corporate: 'Asset management', workday: 'Asset management' },
    supporting_factors: ['Both are asset managers'], contradictions: [], uncertainties: [],
    explanation: 'Consistent asset management business; different legal entities within the same organization.', evidence: {
      corporate: [{ source_id: 'c', quote: 'Silverline is one of the largest asset management firms.' }],
      workday: [{ source_id: 'w', quote: 'Silverstone is the largest alternative asset manager.' }],
    } };
  return { p, answer };
}

test('identity v7: business similarity alone cannot establish shared identity', async () => {
  const { p, answer } = sameIndustryPair();
  const result = await verifyIdentity(p, model(answer), 'v1', now);
  assert.equal(result.status, 'done');
  assert.equal(result.verdict, 'insufficient_evidence');
  assert.equal(result.answer.model_verdict, 'same_company');
  assert.equal(result.model_output.verdict, 'same_company');
  assert.match(result.answer.consistency_holds[0], /no name shared/);
  assert.match(result.answer.review_reasons[0], /same_company needs an employer name/);
});

test('identity v7: an industry phrase or look-alike name is not accepted as the shared name', async () => {
  for (const shared of ['asset management', 'Silverline', 'Silver', 'Holdings Inc']) {
    const { p, answer } = sameIndustryPair();
    answer.shared_name = shared;
    const result = await verifyIdentity(p, model(answer), 'v1', now);
    assert.equal(result.verdict, 'insufficient_evidence', shared);
    assert.equal(result.answer.consistency_holds.length, 1, shared);
  }
});

test('identity v7: a name the model attributes to the wrong side holds the verdict', async () => {
  // Like Workiva / Thomson Reuters: the model claims the Workday employer's name appears on the corporate side.
  const { p, answer } = sameIndustryPair();
  answer.corporate_identity = ['Silverline', 'Silverstone'];
  answer.shared_name = 'Silverstone';
  const result = await verifyIdentity(p, model(answer), 'v1', now);
  assert.equal(result.verdict, 'insufficient_evidence');
  assert.match(result.answer.consistency_holds.join(' '), /"Silverstone" is not written in the corporate sources/);
});

test('identity v7.1: a target name or site slug added to the name lists does not hold a real shared-brand match', async () => {
  // Like 3M Co / USA 3M Company: "Acme Co" and "AcmeCareers" are not written in the sources, "Acme" is.
  const { p, answer } = regionalEmployerPair();
  answer.corporate_identity = ['Acme Co'];
  answer.workday_identity.push('AcmeCareers');
  const result = await verifyIdentity(p, model(answer), 'v1', now);
  assert.equal(result.verdict, 'same_company');
  assert.deepEqual(result.answer.consistency_holds, []);
});

test('identity v7.1: the brand may appear in posting text while the legal employer is a regional entity', async () => {
  // Like Kraft Heinz France: the brand is in the posting text, the legal employer name is different.
  const { p, answer } = regionalEmployerPair();
  p.sources[1].text = 'Stage\n{"name":"3813 HJ Distribution SASU","url":""}\nA propos de Acme : nous recrutons.';
  p.sources.pop();
  answer.workday_identity = ['3813 HJ Distribution SASU'];
  answer.workday_name = '3813 HJ Distribution SASU';
  answer.evidence.workday = [{ source_id: 'w', quote: 'A propos de Acme : nous recrutons.' }];
  const result = await verifyIdentity(p, model(answer), 'v1', now);
  assert.equal(result.verdict, 'same_company');
});

// A legitimate pair with coded legal and regional employers, like Airbus. Uses invented names.
function regionalEmployerPair() {
  const p = packet();
  p.target_name = 'Acme';
  p.sources[0].text = 'Acme designs and delivers commercial aircraft and helicopters.\nname: Acme';
  p.sources[1].text = 'Analyst\n{"name":"1568 Acme Americas, Inc.","url":""}\nAcme is committed to equal opportunity.';
  p.sources.push({ ...p.sources[1], id: 'w2', url: p.sources[1].url + '_2',
    text: 'Pilot\n{"name":"5552 Aerovance Corporation","url":""}\nThe Acme Helicopters program builds unmanned aircraft.' });
  p.sources[2].content_hash = digest(p.sources[2].text);
  const answer = { ...mismatch(), verdict: 'same_company', corporate_identity: ['Acme'],
    workday_identity: ['1568 Acme Americas, Inc.', '5552 Aerovance Corporation'], corporate_name: 'Acme', workday_name: 'Acme',
    shared_name: 'Acme', business: { corporate: 'Aircraft and helicopters', workday: 'Aerospace' },
    supporting_factors: ['Acme brand on the postings'], contradictions: [], uncertainties: [],
    explanation: 'The postings carry the Acme brand; coded legal employers are regional entities.', evidence: {
      corporate: [{ source_id: 'c', quote: 'Acme designs and delivers commercial aircraft and helicopters.' }],
      workday: [{ source_id: 'w', quote: 'Acme is committed to equal opportunity.' }],
    } };
  return { p, answer };
}

test('identity v7: legal, regional and coded employer names keep a same_company verdict', async () => {
  const { p, answer } = regionalEmployerPair();
  const result = await verifyIdentity(p, model(answer), 'v1', now);
  assert.equal(result.verdict, 'same_company');
  assert.deepEqual(result.answer.consistency_holds, []);
  assert.deepEqual(result.answer.review_reasons, []);
});

test('identity v7: legal or regional name variation alone cannot cause a rejection', async () => {
  const { p, answer } = regionalEmployerPair();
  answer.verdict = 'different_company';
  answer.explanation = 'The postings list distinct legal entities that are separate from Acme.';
  const held = await verifyIdentity(p, model(answer), 'v1', now);
  assert.equal(held.verdict, 'insufficient_evidence');
  assert.equal(held.answer.model_verdict, 'different_company');
  assert.match(held.answer.consistency_holds[0], /no contradiction was given/);
  // A concrete conflict the model names is still respected.
  answer.contradictions = ['The corporate site makes aircraft; the postings describe a hospital'];
  const rejected = await verifyIdentity(p, model(answer), 'v1', now);
  assert.equal(rejected.verdict, 'different_company');
});

test('identity v7: name checks ignore case and punctuation but need whole words', () => {
  assert.ok(containsName('Hiring at 1568 AIRBUS Americas Inc. today', 'Airbus Americas, Inc.'));
  assert.ok(containsName('Cisco Systems, Inc. is hiring', 'cisco'));
  assert.equal(containsName('BlackRock is an asset manager', 'Black'), false);
  assert.equal(containsName('Blackstone', 'BlackRock'), false);
  assert.equal(containsName('anything', '  '), false);
  assert.equal(nameKey('  Thomson  Reuters /CAN/ '), 'thomson reuters can');
});

test('identity v7: the version is identity-v7.1 and the verdict is generated after names and the shared name', () => {
  assert.equal(IDENTITY_VERSION, 'identity-v7.1');
  const { p, answer } = contextualPair();
  const llm = model(answer);
  return verifyIdentity(p, llm, 'v1', now).then(() => {
    const keys = Object.keys(llm.calls[0].schema.properties);
    assert.ok(keys.indexOf('shared_name') < keys.indexOf('verdict'));
    assert.ok(keys.indexOf('workday_identity') < keys.indexOf('verdict'));
    assert.doesNotMatch(llm.calls[0].system, /Airbus|BlackRock|Blackstone|Workiva|Thomson/);
  });
});

test('identity evaluation: consistency holds are counted separately from model output', () => {
  const results = [
    { case_id: 'held', verdict: 'insufficient_evidence', status: 'done', model_output: { verdict: 'same_company' },
      answer: { consistency_holds: ['same_company needs an employer name written on both sides'] } },
    { case_id: 'kept', verdict: 'different_company', status: 'done', model_output: { verdict: 'different_company' }, answer: { consistency_holds: [] } },
  ];
  const labels = [{ case_id: 'held', expected: 'different_company' }, { case_id: 'kept', expected: 'different_company' }];
  const summary = evaluateIdentity(results, labels);
  assert.equal(summary.consistencyHolds, 1);
  assert.equal(summary.rawFalseAccepts, 1);
  assert.equal(summary.falseAccepts, 0);
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
