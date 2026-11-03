import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, normalizeDomain, isSimilarName, nameSimilarity, tenantCandidates } from '../../src/domain/ingestion/normalize.ts';
import { canonicalJson, contentFingerprint, paidCallKey } from '../../src/domain/ingestion/fingerprint.ts';
import { verifyQuote, htmlToText } from '../../src/domain/ingestion/quote.ts';
import { groundExtraction } from '../../src/domain/ingestion/extraction-schema.ts';
import { decideMatch, sizeLabel, isExcludedCompany } from '../../src/domain/ingestion/matching.ts';
import { classifyTitle } from '../../src/domain/ingestion/titles.ts';
import { canSpend, sessionSpend } from '../../src/domain/ingestion/budget.ts';
import { scoreCompany } from '../../src/domain/ingestion/pipeline-score.ts';
import { defaultSettings } from '../../src/domain/ingestion/settings.ts';
import { displayTier, NEEDS_EVIDENCE } from '../../src/domain/scoring/display.ts';
import { isoDay } from '../../src/pipeline/extract.ts';
// Scoring-rule tests for the team rubric live in team-rubric.test.mjs.

const NOW = new Date('2026-10-13T12:00:00Z');

// ---------- normalization and dedupe ----------

test('names normalize legal suffixes, punctuation, case and SEC state tags', () => {
  assert.equal(normalizeName('NVIDIA CORP'), 'nvidia');
  assert.equal(normalizeName("Land O'Lakes, Inc."), 'land olakes');
  assert.equal(normalizeName('BROOKFIELD Corp /ON/'), 'brookfield');
  assert.equal(normalizeName('AT&T Inc.'), 'at and t');
  assert.equal(normalizeName('Société Générale SA'), 'societe generale');
  assert.equal(normalizeName('The Group'), 'the group', 'a name made only of filler words is kept');
});

test('websites normalize to a bare host; non-hosts are null', () => {
  assert.equal(normalizeDomain('https://www.Example.com/careers?x=1'), 'example.com');
  assert.equal(normalizeDomain('example.co.uk'), 'example.co.uk');
  assert.equal(normalizeDomain('WWW2.example.com'), 'example.com');
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain(''), null);
});

test('similar names: equal, whole-word prefix, or close spelling; different companies are not similar', () => {
  assert.ok(isSimilarName('Brookfield', 'Brookfield Asset Management'));
  assert.ok(isSimilarName('Marsh & McLennan Companies', 'Marsh and Mclennan'));
  assert.ok(isSimilarName('Rochester Regional Health', 'Rochester Regional Health System') );
  assert.ok(!isSimilarName('Target', 'Targa Resources'));
  assert.ok(!isSimilarName('Apple', 'Applied Materials'));
  assert.ok(nameSimilarity('abc', 'abc') === 1 && nameSimilarity('', 'x') === 0);
});

test('tenant candidates: full name first, first word only when it is distinctive', () => {
  assert.deepEqual(tenantCandidates('Marsh & McLennan Companies, Inc.').map(c => c.tenant), ['marshandmclennan', 'marsh']);
  assert.deepEqual(tenantCandidates('3M CO').map(c => c.tenant), ['3m']);
  assert.deepEqual(tenantCandidates('American Express Co').map(c => c.tenant), ['americanexpress']);
});

test('matching: exact website merges, similar name and missing website go to review, trusted new company is created', () => {
  const known = [{ id: 'c1', name: 'Brookfield Corporation', domain: 'brookfield.com' }];
  const base = { domain_confirmed: true, best_confidence: 0.95 };
  assert.deepEqual(decideMatch({ ...base, name: 'Totally Different', domain: 'https://www.brookfield.com' }, known, { canCreate: true }).action, 'attach');
  const similar = decideMatch({ ...base, name: 'Brookfield Corp', domain: 'brookfieldproperties.com' }, known, { canCreate: true });
  assert.equal(similar.action, 'review'); assert.equal(similar.reason, 'similar_name'); assert.equal(similar.suggested_company_id, 'c1');
  assert.equal(decideMatch({ ...base, name: 'Newco', domain: null }, known, { canCreate: true }).reason, 'no_website');
  assert.equal(decideMatch({ ...base, name: 'Newco', domain: 'newco.com', domain_confirmed: false }, known, { canCreate: true }).reason, 'no_website');
  assert.equal(decideMatch({ ...base, name: 'Newco', domain: 'newco.com', best_confidence: 0.6 }, known, { canCreate: true }).reason, 'untrusted_signal');
  assert.equal(decideMatch({ ...base, name: 'Newco', domain: 'newco.com' }, known, { canCreate: false }).reason, 'over_run_cap');
  assert.equal(decideMatch({ ...base, name: 'Newco', domain: 'newco.com' }, known, { canCreate: true }).action, 'create');
});

test('matching: an unconfirmed website suggestion cannot attach evidence to an existing company', () => {
  const decision = decideMatch({
    name: 'New Robotics Inc', domain: 'unrelated.example', domain_confirmed: false, best_confidence: 0.95,
  }, [{ id: 'unrelated', name: 'Independent Computing Services', domain: 'unrelated.example' }], { canCreate: true });
  assert.equal(decision.action, 'review');
  assert.equal(decision.reason, 'no_website');
  assert.equal(decision.suggested_company_id, null);
});

test('regression: Workday itself (the vendor) is never a lead, under any spelling', () => {
  const base = { domain: 'workday.com', domain_confirmed: true, best_confidence: 0.95 };
  for (const name of ['Workday, Inc.', 'WORKDAY INC', 'Workday']) {
    const decision = decideMatch({ ...base, name }, [], { canCreate: true });
    assert.equal(decision.action, 'skip', name);
  }
  assert.ok(isExcludedCompany('Workday, Inc.') && !isExcludedCompany('Workday Payroll Partners of Ohio'));
});

test('size: under 3,000 is labelled, not blocked; unknown size says so', () => {
  assert.equal(sizeLabel(null), 'size unknown');
  assert.match(sizeLabel(1200), /under 3,000/);
  assert.equal(sizeLabel(45000), '45,000 employees');
});

// ---------- fingerprints and quotes ----------

test('fingerprints ignore key order and listed volatile keys, but not content changes', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  const a = contentFingerprint('{"x":1,"postedOn":"Posted Today"}', ['postedOn']);
  assert.equal(a, contentFingerprint('{"postedOn":"Posted 3 Days Ago","x":1}', ['postedOn']));
  assert.notEqual(a, contentFingerprint('{"x":2,"postedOn":"Posted Today"}', ['postedOn']));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(contentFingerprint('a\r\nb'), contentFingerprint('a\nb'), 'line endings do not change a text fingerprint');
  assert.equal(paidCallKey('treg', 'email', 'ABC '), paidCallKey('treg', 'email', 'abc'));
});

test('quotes must be verbatim; only whitespace and quote/dash typography are forgiven; stored quote is the exact span', () => {
  const source = 'We are rolling out   “Workday HCM” in Q1 2027 — across all regions.';
  const ok = verifyQuote('rolling out "Workday HCM" in Q1 2027 - across', source);
  assert.ok(ok.ok); assert.equal(ok.quote, 'rolling out   “Workday HCM” in Q1 2027 — across'); assert.ok(source.includes(ok.quote));
  assert.equal(verifyQuote('rolling out Workday Financials in Q1', source).ok, false);
  assert.equal(verifyQuote('Rolling Out "Workday HCM"', source).ok, false, 'case must match');
  assert.equal(verifyQuote('Workday HCM', source).ok, false, 'too short');
  assert.equal(verifyQuote('', source).ok, false);
});

test('HTML job descriptions become plain text with entities decoded', () => {
  const text = htmlToText('<p>Lead the <b>Workday</b> rollout &amp; testing.</p><ul><li>Own R1/R2</li></ul><script>x()</script>');
  assert.match(text, /Lead the Workday rollout & testing\./);
  assert.match(text, /- Own R1\/R2/);
  assert.doesNotMatch(text, /x\(\)/);
});

test('grounding drops non-verbatim quotes and clears values that are not in the text', () => {
  const text = 'Acme Corp is hiring a Workday HCM analyst to support the active implementation of Workday Payroll.';
  const checked = groundExtraction({
    company_name: 'Acme Corp', workday_products: ['Workday Payroll', 'Workday Adaptive Planning'], project_type: 'implementation', role_seniority: 'individual',
    timing_words: ['next quarter'], signals: [
      { type: 'hiring', quote: 'hiring a Workday HCM analyst to support the active implementation', date_text: null },
      { type: 'go_live', quote: 'Acme went live on Workday in March 2026', date_text: 'March 2026' },
    ],
  }, text);
  assert.deepEqual(checked.output.workday_products, ['Workday Payroll']);
  assert.deepEqual(checked.output.timing_words, []);
  assert.equal(checked.signals.length, 1);
  assert.equal(checked.dropped.length, 3);
  assert.equal(groundExtraction({ company_name: 'Globex', workday_products: [], project_type: null, role_seniority: null, timing_words: [], signals: [] }, text).output.company_name, null);
});

test('regression (round 1): with type checks, a signal whose quote does not support its type is dropped', () => {
  const text = 'Partner with the HRIS team to implement, test, and define requirements for Workday performance modules. Experience leading APAC HR operations in a hyper-growth company.';
  const out = { company_name: null, workday_products: [], project_type: null, role_seniority: null, timing_words: [], signals: [
    { type: 'go_live', quote: 'implement, test, and define requirements for Workday performance modules', date_text: null },
    { type: 'known_customer', quote: 'Experience leading APAC HR operations in a hyper-growth company', date_text: null },
    { type: 'release_planning', quote: 'implement, test, and define requirements for Workday performance modules', date_text: null },
  ] };
  const loose = groundExtraction(out, text);
  assert.equal(loose.signals.length, 3, 'extract-v1 grounding keeps verbatim quotes of any type');
  const strict = groundExtraction(out, text, { typeEvidence: true });
  assert.deepEqual(strict.signals.map(s => s.type), []);
  assert.ok(strict.dropped.every(d => /does not support/.test(d.reason)));
  const ok = groundExtraction({ ...out, signals: [{ type: 'go_live', quote: 'The HCM, FIN and Payroll implementation went live successfully in July 2024', date_text: 'July 2024' }] }, 'The HCM, FIN and Payroll implementation went live successfully in July 2024.', { typeEvidence: true });
  assert.equal(ok.signals.length, 1);
});

test('round 2: a "quote" longer than 60 words (e.g. the whole posting) is not evidence and is dropped', () => {
  const long = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ') + ' Workday';
  const out = { company_name: null, workday_products: [], project_type: null, role_seniority: null, timing_words: [], signals: [{ type: 'known_customer', quote: long, date_text: null }] };
  assert.equal(groundExtraction(out, long, { typeEvidence: true }).signals.length, 0);
});

test('regression (round 1): v2 grounding clears company values that are descriptions, not names', () => {
  const text = 'We are partnering with a client is a globally recognized sports and entertainment organization. As a Partner AI Advisor (oCFO) you support Workday. Acme Corp uses Workday.';
  const out = name => groundExtraction({ company_name: name, workday_products: [], project_type: null, role_seniority: null, timing_words: [], signals: [] }, text, { typeEvidence: true }).output.company_name;
  assert.equal(out('a globally recognized sports and entertainment organization'), null);
  assert.equal(out('oCFO'), null);
  assert.equal(out('Acme Corp'), 'Acme Corp');
  assert.equal(groundExtraction({ company_name: 'oCFO', workday_products: [], project_type: null, role_seniority: null, timing_words: [], signals: [] }, text).output.company_name, 'oCFO', 'v1 grounding unchanged');
});

// ---------- freshness and decay ----------

// ---------- scoring rules ----------

test('no evidence is "Needs evidence" (status unknown, no URL), never a silent 0 or Disqualified on screen', () => {
  const a = scoreCompany('c', [], [], defaultSettings, NOW);
  assert.ok(a.result.ok);
  for (const cat of ['authority', 'reachability', 'budget', 'release', 'timing']) {
    assert.equal(a.result.row[`${cat}_score`], 0);
    assert.match(a.result.row[`${cat}_evidence`], /^Assessment status: unknown\. Needs evidence: /);
    assert.doesNotMatch(a.result.row[`${cat}_evidence`], /https?:/);
  }
  assert.equal(displayTier(a.result.row), NEEDS_EVIDENCE);
});

// ---------- titles and budget ----------

test('contact titles: function, seniority and Workday ownership come from the title text only', () => {
  assert.deepEqual(classifyTitle('Senior Director, HRIS'), { functional: 10, functionLabel: 'HR systems / Workday', seniority: 5, seniorityLabel: 'Director', ownsWorkday: 2 });
  assert.equal(classifyTitle('VP Enterprise Applications').functional, 9);
  assert.equal(classifyTitle('Chief Human Resources Officer').seniority, 8);
  assert.equal(classifyTitle('Workday Payroll Analyst').ownsWorkday, 4);
  assert.equal(classifyTitle('IT Operations Manager').functional, 6);
  assert.deepEqual([classifyTitle('Plant Manager').functional, classifyTitle(null).seniority], [0, 0]);
});

test('ledger math: spent + worst case must stay under the cap and the known balance; free calls always pass', () => {
  const entries = [{ session: 's', cost_usd: 0.3 }, { session: 's', cost_usd: 0.15 }, { session: 'other', cost_usd: 9 }];
  assert.equal(sessionSpend(entries, 's'), 0.45);
  assert.equal(canSpend({ spent: 0.45, capUsd: 0.5, worstCaseUsd: 0.05 }).ok, true);
  assert.equal(canSpend({ spent: 0.45, capUsd: 0.5, worstCaseUsd: 0.051 }).ok, false);
  assert.equal(canSpend({ spent: 0, capUsd: 0.5, worstCaseUsd: 0.05, balanceUsd: 0.04 }).ok, false, 'balance below the cap binds');
  assert.equal(canSpend({ spent: 0, capUsd: 0, worstCaseUsd: 0.01 }).ok, false);
  assert.equal(canSpend({ spent: 0, capUsd: 0, worstCaseUsd: 0 }).ok, true);
  assert.equal(canSpend({ spent: 0, capUsd: 1, worstCaseUsd: NaN }).ok, false);
});

test('regression: no control characters (e.g. a backspace that silently replaced a regex \b) in pipeline source files', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = dir => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = ['src/pipeline', 'src/domain/ingestion', 'scripts', 'tests/ingestion'].flatMap(walk).filter(f => /\.(ts|mjs|md)$/.test(f));
  const bad = files.filter(f => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(bad, []);
});

test('regression (round 1): display names keep acronyms and legal suffixes readable', async () => {
  const { displayName } = await import('../../src/pipeline/stages.ts');
  assert.equal(displayName('ASML HOLDING NV', null), 'ASML Holding NV');
  assert.equal(displayName('MARSH & MCLENNAN COMPANIES, INC.', null), 'Marsh & Mclennan Companies, Inc.');
  assert.equal(displayName('3M CO', null), '3M Co');
  assert.equal(displayName('NVIDIA CORP', 'NVIDIA'), 'NVIDIA');
  assert.equal(displayName('Land O\'Lakes, Inc.', null), 'Land O\'Lakes, Inc.');
});

// ---------- Round 3: code review ----------

test('round 3: hexadecimal HTML entities are decoded in job text', () => {
  assert.equal(htmlToText('<p>Workday&#x27;s &#X2F; HRIS &#39;team&#39;</p>'), "Workday's / HRIS 'team'");
});

test('round 2 (live data): an org phrase like "Office of the CIO" does not make a director C-level', () => {
  const c = classifyTitle('Executive Director Information Systems, Office of the CIO');
  assert.equal(c.seniority, 5);
  assert.equal(c.functional, 6, 'information systems is IT operations-level relevance, not unknown');
  assert.equal(classifyTitle('CIO').seniority, 8);
});

test('round 2 (live data): a job duty mentioning "budget" is not a budget clue; an approved or funded budget is', () => {
  const ground = quote => groundExtraction({ company_name: null, workday_products: [], project_type: null, role_seniority: null, timing_words: [], signals: [{ type: 'budget_clue', quote, date_text: null }] }, quote, { typeEvidence: true }).signals.length;
  assert.equal(ground('Monitor and manage budget for the HR systems team'), 0);
  assert.equal(ground('The board approved budget for the Workday Financials expansion'), 1);
  assert.equal(ground('We selected Opkey to automate Workday regression testing'), 1);
});

test('isoDay: a year-less date takes its year from the publication date only when that is within 6 months', () => {
  assert.equal(isoDay('July 1', '2019-02-14'), '2019-07-01', 'planned launch announced in February');
  assert.equal(isoDay('July 1', '2019-07-11'), '2019-07-01', 'recent past');
  assert.equal(isoDay('December 15', '2019-01-10'), '2018-12-15', 'across a year boundary');
  assert.equal(isoDay('July 1', '2019-12-01'), '2019-07-01', 'exactly one candidate in range');
  assert.equal(isoDay('July 1'), null, 'no publication date: stay null');
  assert.equal(isoDay('Feb 30', '2019-02-01'), null, 'abbreviations and impossible days are not guessed');
  assert.equal(isoDay('July 1, 2020', '2019-02-14'), '2020-07-01', 'a stated year always wins');
  assert.equal(isoDay('June 2023', '2021-03-11'), null, 'month only stays a note, never a day');
});
