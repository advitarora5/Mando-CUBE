import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCapture, isWorkdaySoftwareMention, needsModelText, workdaySentence } from '../../src/pipeline/extract.ts';

// Short verbatim examples from the November 1 production review audit. Full captures stay outside Git.
const ordinary = [
  ['Abbott', 'Pre-Analytical Laboratory Technician II', '- Ability to work seated for approximately 75% of a typical workday.'],
  ['Abbott', 'Regional Manager Medical Safety', 'Keyboard use (greater or equal to 50% of the workday)'],
  ['Cisco', 'Engineering Product Manager', '- Build intelligent workplace experiences that help people work together, make better use of spaces, and feel more supported in their workday.'],
  ['Cisco', 'Software Engineer', 'We are a diverse and inclusive team collaborating worldwide with a dynamic and flexible workday.'],
];

const capture = (company, title, text) => ({
  id: 'fixture', source_id: 'workday-jobs', url: 'https://example.com/job',
  fetched_at: '2026-11-01T12:00:00Z', http_status: 200, content_type: 'application/json',
  content_hash: 'fixture', run_id: null,
  meta: { kind: 'workday_job', company_name: company },
  body: JSON.stringify({ jobPostingInfo: { title, jobDescription: text, startDate: '2026-10-12', externalUrl: 'https://example.com/job' } }),
});

test('audited ordinary-word examples produce neither software signals nor model calls', async () => {
  for (const [company, title, text] of ordinary) {
    assert.equal(isWorkdaySoftwareMention(text), false, company);
    assert.equal(workdaySentence(text), null, company);
    assert.equal(needsModelText('job posting', title, text), false, company);
    const out = await extractCapture(capture(company, title, text), { complete() { throw new Error('should not call model'); } }, 'prompt');
    assert.deepEqual(out.signals, [], company);
  }
});

test('valid product references survive, including lowercase technical usage and title-only evidence', async () => {
  for (const text of ['The Workday Architect supports US Payroll.', 'Maintain workday HCM integrations.', 'Proficiency with HRIS platforms, such as Workday or similar systems.', 'Use your Workday account.', 'Workday HCM supports a flexible workday.']) {
    assert.equal(isWorkdaySoftwareMention(text), true, text);
    assert.ok(workdaySentence(text), text);
    const out = await extractCapture(capture('Example', 'HR Specialist', text), null, 'prompt');
    assert.equal(out.signals[0]?.type, 'hiring', text);
  }
  const out = await extractCapture(capture('Example', 'Workday HCM Analyst', 'Configure payroll.'), null, 'prompt');
  assert.equal(out.signals[0]?.quote, 'Workday HCM Analyst');
  assert.equal(isWorkdaySoftwareMention('Have an enjoyable workday.'), false);
  assert.equal(workdaySentence('Enjoy a flexible workday. Maintain Workday payroll.'), 'Maintain Workday payroll.');
});
