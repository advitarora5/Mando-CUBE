// The Mando team scoring rubric (provisional revision of 2026-10-13, Qualified 70+) as applied by the ingestion pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCompany, authorityFromContacts, reachabilityFromContacts, budgetFromSignals, releaseFromSignals, timingFromSignals } from '../../src/domain/ingestion/pipeline-score.ts';
import { authorityBand } from '../../src/domain/ingestion/titles.ts';
import { hiringStrength } from '../../src/pipeline/extract.ts';
import { defaultSettings } from '../../src/domain/ingestion/settings.ts';
import { evaluateTier } from '../../src/domain/scoring/tier-rules.ts';
import { tierForTotal, tierThresholdsFor } from '../../src/domain/scoring/rubric.ts';

const NOW = new Date('2026-10-13T12:00:00Z');
const sig = (type, extra = {}) => ({ type, signal_date: null, source_url: `https://example.com/${type}`, quote: `evidence for ${type} here`, confidence: 0.9, first_seen_at: '2026-10-12T00:00:00Z', last_seen_at: '2026-10-12T00:00:00Z', project_type: null, ...extra });
const contact = extra => ({ name: 'Pat Lee', title: 'Director, HRIS', source: 'https://www.linkedin.com/in/pat', linkedin_url: 'https://www.linkedin.com/in/pat', email: null, email_status: null, phone: null, phone_status: null, mutual_connection: null, ...extra });
const found = { name_title_linkedin: { provider: 'quickenrich via treg' } };
const evidence = 'https://x.example | Assessment status: met. Reason.';

test('tiers: 70/55 for the team rubric and, since main unified the shared tiers, for older versions too', () => {
  assert.deepEqual(tierThresholdsFor('mando-team-70:pipeline-v2'), { Qualified: 70, Maybe: 55 });
  assert.deepEqual(tierThresholdsFor('week2-100'), { Qualified: 70, Maybe: 55 });
  assert.deepEqual([70, 69, 55, 54].map(t => tierForTotal(t, 'mando-team-70')), ['Qualified', 'Maybe', 'Maybe', 'Disqualified']);
  assert.deepEqual([70, 69].map(t => tierForTotal(t)), ['Qualified', 'Maybe']);
  const row = s => ({ authority_score: 20, reachability_score: 20, budget_score: s, release_score: 10, timing_score: 10, authority_evidence: evidence, reachability_evidence: evidence });
  assert.equal(evaluateTier({ ...row(10), rubric_version: 'mando-team-70:pipeline-v2' }).tier, 'Qualified', '70 total');
  assert.equal(evaluateTier({ ...row(9), rubric_version: 'mando-team-70:pipeline-v2' }).tier, 'Maybe', '69 total');
  assert.equal(evaluateTier({ ...row(10), rubric_version: 'week2-100' }).tier, 'Qualified', 'same 70 under the old version');
  assert.match(evaluateTier({ ...row(10), rubric_version: 'mando-team-70' }).tier_reason, /at least 70/);
});

test('authority: role bands 22/20/18/15/10/5/0 from the title; bonuses only for confirmed current contacts; cap 25', () => {
  const a = (title, extra = {}, company) => authorityFromContacts([contact({ title, ...extra })], company);
  assert.equal(a('VP, HRIS and Workday').score, 24, '22 + Workday owner 2');
  assert.equal(a('VP, HRIS and Workday', {}, { employee_count: 5000, employee_source: 'https://example.com/10k' }).score, 25, '22 + 3 + 2, capped');
  assert.equal(a('VP, HRIS and Workday', {}, { employee_count: 5000, employee_source: null }).score, 24, 'unsourced employee count: no size bonus');
  assert.equal(a('Senior Director, HRIS').score, 20);
  assert.equal(a('Chief Human Resources Officer').score, 18);
  assert.equal(a('HR Director').score, 15);
  assert.equal(a('Head of People').score, 15);
  assert.equal(a('HRIS Manager').score, 10);
  assert.equal(a('HRIS Analyst').score, 5);
  assert.deepEqual(authorityBand('VP Enterprise Applications'), { base: 22, label: 'executive over HRIS/HR ops/enterprise systems' });
  const unrelated = a('Chief Marketing Officer');
  assert.deepEqual([unrelated.score, unrelated.status], [0, 'not_met']);
  const unconfirmed = a('VP, HRIS and Workday', { contact_sources: found, linkedin_status: 'unconfirmed' });
  assert.deepEqual([unconfirmed.score, unconfirmed.status], [5, 'partial'], 'people-search result: current role unconfirmed');
  assert.match(unconfirmed.reason, /not yet confirmed/);
  assert.equal(a('VP, HRIS and Workday', { contact_sources: found, linkedin_status: 'confirmed' }).score, 24, 'confirmed by a person');
  assert.equal(authorityFromContacts([contact({ title: 'HRIS Analyst' }), contact({ title: 'VP, HRIS' })]).score, 22, 'best contact wins, no stacking');
  assert.equal(authorityFromContacts([]).status, 'unknown');
});

test('reachability: email+phone 20, either 15, confirmed LinkedIn only 10; bonuses for confirmed current relevant contacts', () => {
  const r = extra => reachabilityFromContacts([contact(extra)]);
  const both = { email: 'p@x.com', email_source: 'https://x.com/team', phone: '+1 555 0100', phone_source: 'https://x.com/team' };
  assert.equal(r(both).score, 20);
  assert.equal(r({ ...both, linkedin_status: 'confirmed' }).score, 23, '+3 matching LinkedIn alongside');
  assert.equal(r({ email: 'p@x.com', email_status: 'valid' }).score, 15, 'provider-verified work email');
  assert.equal(r({ email: 'p@x.com', email_status: 'risky' }).status, 'unknown', 'unverified, unpublished email is no route');
  assert.equal(r({ phone: '+1 555', phone_status: 'live' }).status, 'unknown', 'a live line is not a published direct phone');
  assert.equal(r({ linkedin_status: 'confirmed' }).score, 10);
  assert.equal(r({ linkedin_status: 'unconfirmed', contact_sources: found }).status, 'unknown', 'people-search LinkedIn is not a confirmed match');
  assert.equal(r({ email: 'p@x.com', email_status: 'valid', mutual_connection: 'Adi: willing to introduce' }).score, 20, '+5 willing introduction');
  assert.equal(r({ email: 'p@x.com', email_status: 'valid', mutual_connection: 'went to school with Adi' }).score, 15, 'connection without willingness');
  assert.equal(r({ email: 'p@x.com', email_status: 'valid', conviction: { source: 'https://rising.example/talk', reason: 'spoke', date: '2026-02-01' } }).score, 18, '+3 dated initiative');
  assert.equal(r({ email: 'p@x.com', email_status: 'valid', conviction: { source: 'https://rising.example/talk', reason: 'spoke', date: null } }).score, 15, 'undated initiative earns nothing');
  assert.equal(r({ email: 'p@x.com', email_status: 'valid', title: 'Chief Marketing Officer', mutual_connection: 'willing to introduce' }).score, 15, 'no bonuses for an unrelated role');
});

test('budget: capacity not collected (0) + the single highest investment band; labelled as a proxy', () => {
  assert.equal(budgetFromSignals([sig('budget_clue', { signal_date: '2026-05-01' })], NOW).score, 8);
  assert.equal(budgetFromSignals([sig('budget_clue', { signal_date: '2023-01-01' })], NOW).score, 3, 'older than 24 months');
  assert.equal(budgetFromSignals([sig('budget_clue')], NOW).score, 3, 'undated');
  assert.equal(budgetFromSignals([sig('hiring', { project_type: 'implementation' })], NOW).score, 6, 'active HR modernization');
  const best = budgetFromSignals([sig('budget_clue', { signal_date: '2026-05-01' }), sig('hiring', { project_type: 'implementation' }), sig('budget_clue')], NOW);
  assert.deepEqual([best.score, best.status], [8, 'partial'], 'highest band only, never summed');
  assert.match(best.reason, /operating income not collected/);
  assert.match(best.reason, /proxy/);
  assert.equal(budgetFromSignals([sig('known_customer'), sig('hiring')], NOW).status, 'unknown');
});

test('release: deployment first; higher bands need a confirmed next release AND public preparation; otherwise the 8 baseline', () => {
  const est = releaseFromSignals([sig('known_customer')], NOW);
  assert.equal(est.score, 8);
  assert.match(est.reason, /estimated/);
  assert.equal(releaseFromSignals([sig('release_planning')], NOW).score, 8, 'release preparation shows deployment');
  assert.equal(releaseFromSignals([sig('hiring')], NOW).status, 'unknown', 'hiring alone does not confirm deployment');
  const july = new Date('2026-07-20T17:00:00Z'); // 61 days before confirmed 2026R2 (2026-09-19)
  assert.equal(releaseFromSignals([sig('known_customer')], july).score, 8, 'inside the window but no public preparation');
  assert.match(releaseFromSignals([sig('known_customer')], july).reason, /No public release preparation/);
  assert.equal(releaseFromSignals([sig('known_customer'), sig('release_planning')], july).score, 15, 'documented preparation');
  const may = new Date('2026-05-20T17:00:00Z'); // 122 days before
  assert.equal(releaseFromSignals([sig('known_customer')], may).score, 8, '122 days before, unprepared');
  assert.equal(releaseFromSignals([sig('known_customer'), sig('release_planning')], may).score, 10, '122 days before, preparing');
  assert.equal(releaseFromSignals([], NOW).status, 'unknown');
});

test('timing: strongest single trigger 15/12/10/8/5, never stacked', () => {
  const t = (...signals) => timingFromSignals(signals, NOW);
  assert.equal(t(sig('go_live', { signal_date: '2026-12-15' })).score, 15, 'milestone within 6 months');
  assert.equal(t(sig('go_live', { signal_date: '2027-08-01' })).status, 'unknown', 'more than 6 months out');
  assert.equal(t(sig('go_live', { signal_date: '2026-07-01' })).score, 12, 'go-live within the previous 6 months');
  assert.equal(t(sig('go_live', { signal_date: '2026-02-01' })).score, 10, 'dated rollout within 12 months');
  assert.equal(t(sig('go_live', { signal_date: '2024-02-01' })).status, 'unknown', 'older than 12 months');
  assert.equal(t(sig('hiring', { signal_date: '2026-09-01', confidence: 0.9 })).score, 8, 'employer Workday hiring');
  assert.equal(t(sig('hiring', { signal_date: '2026-09-01', confidence: 0.6 })).score, 5, 'Workday as a listed skill: operations baseline');
  assert.equal(t(sig('known_customer')).score, 5);
  const undated = t(sig('go_live', { quote: 'Workday Student is scheduled to go live in October 2026' }));
  assert.deepEqual([undated.score, undated.source], [5, 'https://example.com/go_live']);
  assert.match(undated.reason, /without a day-precise date/);
  assert.equal(t(sig('known_customer'), sig('hiring', { signal_date: '2026-09-01' }), sig('go_live', { signal_date: '2026-07-01' })).score, 12, 'not stacked');
  assert.equal(t().status, 'unknown');
  assert.equal(hiringStrength('Compensation Business Partner', '- Expertise with analytics, Excel, PowerPoint, and Workday'), 'skill');
  assert.equal(hiringStrength('Sr Engineer - Workday', 'You will prototype, design, build, and support features in Workday.'), 'role');
});

test('company assessment: links and reasons of at most 240 characters, 14-day expiry, version, and the same tier under older versions', () => {
  const vp = contact({ title: 'VP, HRIS and Workday', email: 'p@x.com', email_source: 'https://x.com/team', phone: '+1 555', phone_source: 'https://x.com/team', linkedin_status: 'confirmed' });
  const longQuote = 'We go live on Workday HCM on December 1, 2026 across all regions and entities worldwide. '.repeat(5);
  const a = scoreCompany('c', [sig('known_customer'), sig('go_live', { signal_date: '2026-12-01', quote: longQuote }), sig('budget_clue', { signal_date: '2026-06-01' })], [vp], defaultSettings, NOW);
  assert.equal(a.result.row.rubric_version, 'mando-team-70:pipeline-v2');
  for (const cat of ['authority', 'reachability', 'budget', 'release', 'timing']) {
    const e = a.result.row[`${cat}_evidence`];
    assert.match(e, /^https?:\/\/\S+ \| Assessment status: \w+\. .+/, cat);
    assert.ok(e.slice(e.indexOf('. ') + 2).length <= 240, `${cat} reason over 240 characters`);
  }
  assert.equal(a.result.total, 24 + 23 + 8 + 8 + 15);
  assert.equal(a.result.tier, 'Qualified');
  assert.equal(evaluateTier({ ...a.result.row, rubric_version: 'week2-100' }).tier, 'Qualified');
  const stale = sig('hiring', { last_seen_at: '2026-09-28T11:00:00Z', signal_date: '2026-09-25' });
  assert.equal(scoreCompany('c', [stale], [], defaultSettings, NOW).result.row.timing_score, 0, 'expired after 14 days');
  assert.equal(scoreCompany('c', [sig('go_live', { signal_date: '2026-08-01', last_seen_at: '2025-01-01T00:00:00Z' })], [], defaultSettings, NOW).result.row.timing_score, 12, 'go-live keeps its date');
});

test('scores spread across companies; ready for contacts is Budget + Release + Timing >= 25', () => {
  const totals = [
    [], [sig('known_customer')], [sig('known_customer'), sig('hiring', { signal_date: '2026-10-01' })],
    [sig('known_customer'), sig('hiring', { signal_date: '2026-10-12', project_type: 'implementation' })],
    [sig('known_customer'), sig('go_live', { signal_date: '2026-12-01' }), sig('budget_clue', { signal_date: '2026-06-01' })],
  ].map(signals => scoreCompany('c', signals, [], defaultSettings, NOW).result.total);
  assert.equal(new Set(totals).size, totals.length, `totals ${totals}`);
  const ready = scoreCompany('c', [sig('known_customer'), sig('go_live', { signal_date: '2026-12-01' }), sig('budget_clue', { signal_date: '2026-06-01' })], [], defaultSettings, NOW);
  assert.equal(ready.result.row.budget_score + ready.result.row.release_score + ready.result.row.timing_score, 31);
  assert.ok(ready.ready_for_contacts);
  assert.equal(scoreCompany('c', [sig('known_customer'), sig('hiring', { signal_date: '2026-10-01' })], [], defaultSettings, NOW).ready_for_contacts, false, '0 + 8 + 8 = 16');
});
