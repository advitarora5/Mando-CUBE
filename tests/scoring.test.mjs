import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { categories } from '../src/domain/contracts/company.ts';
import { rubric, tierThresholds, tierForTotal, goLiveBands, releaseBands, RUBRIC_VERSION } from '../src/domain/scoring/rubric.ts';
import { workdayRelease, firstReleaseOnOrAfter, releaseScore } from '../src/domain/scoring/releases.ts';
import { parseEvidence, formatEvidence } from '../src/domain/scoring/evidence.ts';
import { daysSince, goLiveScore } from '../src/domain/scoring/go-live.ts';
import { buildAssessment, goLiveTiming, releaseAlignment } from '../src/domain/scoring/assessment.ts';
import { assessSheet } from '../src/domain/scoring/assessment-sheet.ts';
const source = 'https://google.com/';
const entry = score => ({ score, source, reason: 'Fictional evidence reason.' });
const full = { authority: entry(25), reachability: entry(25), budget: entry(20), release: entry(15), timing: entry(15) };
test('rubric has five categories weighted 25/25/20/15/15 and tiers at 80 and 55', () => {
 assert.deepEqual(categories.map(c => rubric[c].weight), [25, 25, 20, 15, 15]);
 assert.equal(categories.reduce((sum, c) => sum + rubric[c].weight, 0), 100);
 assert.deepEqual(tierThresholds, { Qualified: 80, Maybe: 55 });
 assert.deepEqual([100, 80, 79, 55, 54, 0].map(tierForTotal), ['Qualified', 'Qualified', 'Maybe', 'Maybe', 'Disqualified', 'Disqualified']);
});
test('evidence round-trips a source link and a one-line reason', () => {
 assert.equal(formatEvidence(source, ' Two\nlines  here. '), 'https://google.com/ | Two lines here.');
 assert.deepEqual(parseEvidence('https://google.com/ | Two lines here.'), { source, reason: 'Two lines here.' });
 assert.deepEqual(parseEvidence(formatEvidence('https://example.com/a|b', 'Reason | with a bar.')), { source: 'https://example.com/a%7Cb', reason: 'Reason | with a bar.' });
 for (const [link, reason] of [[source, ''], [source, '  '], ['', 'reason'], [null, 'reason'], ['javascript:alert(1)', 'reason'], ['google.com', 'reason']]) assert.equal(formatEvidence(link, reason), null);
 assert.equal(parseEvidence('just a reason'), null);
});
test('days since go-live counts Chicago calendar days', () => {
 assert.equal(daysSince('2026-08-01', new Date('2026-10-04T18:00:00Z')), 64);
 assert.equal(daysSince('2026-08-01', new Date('2026-10-05T03:00:00Z')), 64); // still 4 October in Chicago
 assert.equal(daysSince('2026-10-04', new Date('2026-10-04T18:00:00Z')), 0);
 assert.equal(daysSince('2026-10-10', new Date('2026-10-04T18:00:00Z')), -6);
 assert.equal(daysSince(null), null);
 assert.equal(daysSince('not a date'), null);
});
test('Workday release dates use confirmed dates, then the usual Saturday pattern', () => {
 assert.deepEqual(workdayRelease(2026, 2), { name: '2026R2', date: '2026-09-19', confirmed: true });
 assert.deepEqual(workdayRelease(2025, 1), { name: '2025R1', date: '2025-03-15', confirmed: true });
 assert.deepEqual(workdayRelease(2027, 1), { name: '2027R1', date: '2027-03-13', confirmed: false });
 assert.deepEqual(workdayRelease(2027, 2), { name: '2027R2', date: '2027-09-18', confirmed: false });
 assert.equal(firstReleaseOnOrAfter('2026-09-19').name, '2026R2');
 assert.equal(firstReleaseOnOrAfter('2026-09-20').name, '2027R1');
 assert.equal(firstReleaseOnOrAfter('2026-01-01').name, '2026R1');
});
test('go-live score follows fixed bands around the go-live date, with inclusive edges', () => {
 const now = new Date('2026-10-04T18:00:00Z');
 const score = date => goLiveScore(date, now).score;
 assert.equal(score(null), 0);
 assert.deepEqual(['2027-04-03', '2027-04-02', '2026-10-05'].map(score), [6, 12, 12]); // 181, 180 and 1 days away
 assert.deepEqual(['2026-10-04', '2026-09-04'].map(score), [10, 10]); // days 0 and 30
 assert.deepEqual(['2026-09-03', '2026-07-06'].map(score), [15, 15]); // days 31 and 90
 assert.deepEqual(['2026-07-05', '2026-04-07'].map(score), [13, 13]); // days 91 and 180
 assert.deepEqual(['2026-04-06', '2025-10-04'].map(score), [6, 6]); // days 181 and 365
 assert.deepEqual(['2025-10-03', '2020-01-01'].map(score), [0, 0]); // day 366 and older
 assert.equal(goLiveScore('2026-11-01', now).reason, 'Workday go-live announced for 2026-11-01, 28 days away (announced, within 180 days).');
 assert.equal(goLiveScore('2026-07-05', now).reason, 'Went live on Workday 91 days ago (91-180 days post go-live).');
 assert.equal(goLiveScore('2026-10-03', now).reason, 'Went live on Workday 1 day ago (0-30 days post go-live).');
 assert.equal(Math.max(...goLiveBands.map(band => band.score)), rubric.timing.weight);
});
test('an assessment stores evidence with every category score', () => {
 const result = buildAssessment('company-1', full);
 assert.equal(result.ok, true);
 assert.equal(result.total, 100);
 assert.equal(result.tier, 'Qualified');
 assert.equal(result.row.company_id, 'company-1');
 assert.equal(result.row.rubric_version, RUBRIC_VERSION);
 assert.equal('total' in result.row, false); // generated by Postgres
 for (const c of categories) assert.equal(result.row[`${c}_evidence`], 'https://google.com/ | Fictional evidence reason.');
});
test('points without a source link and reason are rejected, as are out-of-range scores', () => {
 const noSource = buildAssessment('company-1', { ...full, budget: { score: 10, source: null, reason: 'No link.' } });
 assert.equal(noSource.ok, false);
 assert.match(noSource.errors.join(' '), /Customer Budget evidence/);
 const noReason = buildAssessment('company-1', { ...full, release: { score: 5, source, reason: '' } });
 assert.match(noReason.errors.join(' '), /Workday Release Alignment evidence/);
 const tooHigh = buildAssessment('company-1', { ...full, timing: entry(16) });
 assert.match(tooHigh.errors.join(' '), /Timing Trigger score must be between 0 and 15/);
 assert.equal(buildAssessment('company-1', { ...full, authority: entry(NaN) }).ok, false);
});
test('omitted and zero-point categories need no evidence, and tier rules still apply', () => {
 const partial = buildAssessment('company-1', { authority: entry(25), reachability: entry(25), budget: entry(10), timing: { score: 0, source: null, reason: null } });
 assert.equal(partial.ok, true);
 assert.equal(partial.row.release_score, 0);
 assert.equal(partial.row.release_evidence, '');
 assert.equal(partial.row.timing_evidence, '');
 assert.equal(partial.total, 60);
 assert.equal(partial.tier, 'Maybe');
 const timingOnly = buildAssessment('company-1', { timing: entry(15) });
 assert.equal(timingOnly.ok, true);
 assert.equal(timingOnly.tier, 'Disqualified');
});
test('go-live timing input feeds the Timing Trigger category', () => {
 const now = new Date('2026-10-04T18:00:00Z');
 const timing = goLiveTiming('2026-08-01', source, now);
 assert.deepEqual(timing, { score: 15, reason: 'Went live on Workday 64 days ago (31-90 days post go-live).', source });
 const result = buildAssessment('company-1', { ...full, timing });
 assert.equal(result.row.timing_score, 15);
 assert.equal(result.row.timing_evidence, 'https://google.com/ | Went live on Workday 64 days ago (31-90 days post go-live).');
 assert.equal(buildAssessment('company-1', { ...full, timing: goLiveTiming('2026-08-01', null, now) }).ok, false);
 assert.equal(buildAssessment('company-1', { ...full, timing: goLiveTiming(null, null, now) }).ok, true);
});
test('release score follows fixed bands before the next Workday release, with inclusive edges', () => {
 const score = date => releaseScore(new Date(`${date}T18:00:00Z`)).score;
 assert.deepEqual(['2026-09-19', '2026-09-06'].map(score), [3, 3]); // 0 and 13 days before 2026R2
 assert.deepEqual(['2026-09-05', '2026-08-09'].map(score), [9, 9]); // 14 and 41 days
 assert.deepEqual(['2026-08-08', '2026-06-27'].map(score), [15, 15]); // 42 and 84 days
 assert.deepEqual(['2026-06-26', '2026-05-16'].map(score), [10, 10]); // 85 and 126 days
 assert.deepEqual(['2026-05-15', '2026-09-20'].map(score), [5, 5]); // 127 days, and the day after release
 assert.equal(releaseScore(new Date('2026-08-08T18:00:00Z')).reason, 'Next Workday release 2026R2 is on 2026-09-19, 42 days away (6-12 weeks before release).');
 assert.equal(releaseScore(new Date('2026-10-04T18:00:00Z')).reason, 'Next Workday release 2027R1 is estimated for 2027-03-13, 160 days away (more than 18 weeks before release).');
 assert.equal(releaseScore(new Date('2026-09-19T18:00:00Z')).reason, 'Next Workday release 2026R2 is on 2026-09-19, today (under 2 weeks before release).');
 assert.equal(Math.max(...releaseBands.map(band => band.score)), rubric.release.weight);
});
test('release calendar input feeds the Release Alignment category', () => {
 const now = new Date('2026-08-08T18:00:00Z');
 const release = releaseAlignment(source, now);
 assert.deepEqual(release, { score: 15, reason: 'Next Workday release 2026R2 is on 2026-09-19, 42 days away (6-12 weeks before release).', source });
 const result = buildAssessment('company-1', { ...full, release });
 assert.equal(result.row.release_score, 15);
 assert.equal(result.row.release_evidence, 'https://google.com/ | Next Workday release 2026R2 is on 2026-09-19, 42 days away (6-12 weeks before release).');
 assert.equal(buildAssessment('company-1', { ...full, release: releaseAlignment(null, now) }).ok, false);
});
test('a sheet of reviewed scores becomes insert-ready rows, with Timing and Release calculated on request', () => {
 const now = new Date('2026-08-08T18:00:00Z');
 const companies = [{ id: 'A1', name: 'Acme  Corp', workday_signal_date: '2026-06-05' }, { id: 'b2', name: 'Beta', workday_signal_date: null }];
 const scored = { authority_score: '20', authority_source: source, authority_reason: 'HRIS director.', reachability_score: '15', reachability_source: source, reachability_reason: 'One degree away.' };
 const [acme, beta] = assessSheet([
  { company: ' acme corp ', ...scored, budget_score: '', timing_source: source, release_source: source },
  { company_id: 'B2', ...scored, timing_source: source, release_score: '4', release_source: source, release_reason: 'Reviewer override.' },
 ], companies, now);
 assert.deepEqual([acme.line, acme.company, acme.errors, acme.total, acme.tier], [2, 'Acme  Corp', [], 65, 'Maybe']);
 assert.equal(acme.row.company_id, 'A1');
 assert.equal(acme.row.budget_score, 0);
 assert.equal(acme.row.timing_evidence, 'https://google.com/ | Went live on Workday 64 days ago (31-90 days post go-live).');
 assert.equal(acme.row.release_score, 15);
 assert.deepEqual([beta.line, beta.total, beta.row.timing_score, beta.row.release_score], [3, 39, 0, 4]); // no go-live date on record
 assert.equal(beta.row.release_evidence, 'https://google.com/ | Reviewer override.');
});
test('sheet rows that cannot be matched or lack evidence are reported and produce no row', () => {
 const companies = [{ id: 'a1', name: 'Acme', workday_signal_date: null }, { id: 'a2', name: 'ACME', workday_signal_date: null }, { id: 'b2', name: 'Beta', workday_signal_date: null }];
 const results = assessSheet([
  { company: 'Gamma' }, { company: 'acme' }, {}, { company: 'Beta', authority_score: '10' }, { company_id: 'b2' }, { company_id: 'a1', budget_score: 'high', budget_source: source, budget_reason: 'x' }, { company_id: 'a2', authority_reason: 'Not assessed yet.' },
 ], companies);
 assert.deepEqual(results.map(r => r.errors[0]), [
  'No matching company in the database.', 'More than one company matches; use company_id.', 'Row needs a company_id or company name.',
  'Functional Authority evidence requires a source link and a one-line reason.', 'Company appears more than once in the sheet.', 'Customer Budget score must be between 0 and 20.', 'Row has no scores; remove it or fill it in.',
 ]);
 assert.equal(results.some(r => r.row), false);
});
test('saved rows fit the scores table: columns, required fields, score limits and tiers', () => {
 const sql = readFileSync(new URL('../supabase/migrations/202610020001_initial_schema.sql', import.meta.url), 'utf8');
 const columns = sql.match(/create table public\.scores \(([\s\S]*?)\n\);/)[1].split('\n').map(line => line.trim()).filter(line => /^[a-z_]+ (uuid|text|numeric|timestamptz)/.test(line));
 const name = line => line.split(' ')[0];
 const writable = columns.filter(line => !line.includes('generated always')).map(name);
 const required = columns.filter(line => line.includes('not null') && !line.includes('default')).map(name);
 const row = buildAssessment('company-1', full).row;
 assert.deepEqual(Object.keys(row).filter(key => !writable.includes(key)), []); // nothing the table lacks, and not the generated total
 assert.deepEqual(required.filter(key => !(key in row)), []); // id and assessed_at have database defaults
 for (const c of categories) assert.match(columns.find(line => name(line) === `${c}_score`), new RegExp(`between 0 and ${rubric[c].weight}\\)`));
 assert.match(columns.find(line => name(line) === 'tier'), /in \('Qualified', 'Maybe', 'Disqualified'\)/);
});
test('the demo sheet is valid for the nine seeded demo companies', () => {
 const [header, ...lines] = readFileSync(new URL('../scripts/assessments-demo.csv', import.meta.url), 'utf8').trim().split('\n').map(line => line.split(','));
 const rows = lines.map(cells => Object.fromEntries(header.map((key, i) => [key, cells[i]])));
 const companies = lines.map((_, i) => ({ id: `demo-${i + 1}`, name: `Demo Company ${i + 1}`, workday_signal_date: `2026-08-0${i + 1}` }));
 const results = assessSheet(rows, companies, new Date('2026-10-06T18:00:00Z'));
 assert.equal(results.length, 9);
 assert.deepEqual(results.flatMap(r => r.errors), []);
 assert.deepEqual(results.map(r => r.total), [83, 90, 86, 80, 75, 69, 63, 58, 48]); // Release 5 and Timing 15 are calculated
 assert.deepEqual(results.map(r => r.tier), ['Qualified', 'Qualified', 'Qualified', 'Qualified', 'Maybe', 'Maybe', 'Maybe', 'Maybe', 'Disqualified']);
});

