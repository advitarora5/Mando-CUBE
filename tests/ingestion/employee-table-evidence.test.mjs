import { test } from 'node:test';
import assert from 'node:assert/strict';
import { employeeEvidenceFromDocument as extract } from '../../src/pipeline/employee-document-evidence.ts';
const NOW = new Date('2026-11-10T18:00:00Z');
const source = 'https://cdn.example/annual-report.pdf';
const table = `Pilot Corporation annual report
Employee information March 31, 2026
Year\t2024\t2025\tAs of March
31, 2026
No. of
Employee
Direct staff\t1,000\t1,100\t1,200
Indirect staff\t2,000\t2,200\t2,400
Total\t3,000\t3,300\t3,600
Average age\t40\t41\t42`;
const run = (text = table, companyName = 'Pilot Corporation') => extract({ text, companyName, source }, NOW);
test('employee table aligns the explicitly dated column and reconciles components, retaining evidence', () => {
  const e = run().evidence;
  assert.equal(e.employee_count, 3600);
  assert.equal(e.as_of, '2026-03-31');
  assert.equal(e.date_basis, 'effective');
  assert.equal(e.basis, 'exact');
  assert.equal(e.source, source);
  assert.equal(e.observed_on, '2026-11-10');
  assert.match(e.quote, /Direct staff/);
  assert.match(e.quote, /Total\t3,000\t3,300\t3,600/);
  assert.equal(run(table.replaceAll('1,200','200').replaceAll('2,400','400').replaceAll('3,600','600')).evidence.employee_count, 600);
});
test('table dates, columns and totals must be unambiguous; never revive an older large number', () => {
  for (const text of [
    table.replace('3,600','3,601'), table.replace('3,300','3,301'),
    table.replace('1,200','1,200 1,300'), table.replace('1,200','1.2'),
    table.replace('1,200','1,20'), table.replace('1,200','~1,200'),
    table.replace('As of March\n31, 2026','2026'),
    table.replaceAll('March 31, 2026','March 31, 2027').replace('31, 2026','31, 2027'),
    table.replaceAll('March 31, 2026','March 31, 2020').replace('31, 2026','31, 2020'),
    table.replace('Year\t2024\t2025','Year\t2025\t2024'),
    table.replace('Employee information March 31, 2026','Employee information April 1, 2026'),
    table.replace('Direct staff','New hires'),
  ]) assert.equal(run(text).evidence, null, text);
});
test('employer/table scope cannot become a subsidiary, region, FTE, forecast or customer total', () => {
  assert.equal(run(table, 'Pilot Subsidiary').evidence, null);
  for (const qualifier of ['Subsidiary', 'Regional', 'Taiwan', 'Customer', 'Parent', 'FTE', 'Estimated', 'Group']) {
    assert.equal(run(table.replace('Employee information', `${qualifier} employee information`)).evidence, null, qualifier);
  }
  for (const heading of ['Regional operations', 'Germany', 'A different business unit']) assert.equal(run(table.replace('Employee information',heading+'\nEmployee information')).evidence, null);
  const group = table.replaceAll('Pilot Corporation','Pilot Group').replace('Employee information','Group employee information');
  assert.equal(run(group,'Pilot Group').evidence.employee_count,3600);
  assert.equal(run(group,'Pilot Corporation').evidence,null);
});
test('table evidence participates in same-date prose and table conflict detection', () => {
  assert.match(run(table+'\nAs of March 31, 2026 we have 4000 employees.').reason,/Conflicting/);
  assert.match(run(table+'\n'+table.replaceAll('3,600','3,700').replaceAll('1,200','1,300')).reason,/Conflicting/);
});

test('official annual-report excerpt yields the dated workforce total and a held saved-score discrepancy', async () => {
  const { readFileSync } = await import('node:fs');
  const { previewHeadcountAuthority } = await import('../../src/pipeline/employee-authority-preview.ts');
  const fixture = JSON.parse(readFileSync(new URL('../../fixtures/advantech-workforce-table.json',import.meta.url)));
  const e = extract(fixture,NOW).evidence;
  assert.equal(e.employee_count,9512);
  assert.equal(e.as_of,'2026-03-31');
  assert.equal(e.source,fixture.source);
  const contact = {name:'Test person',title:'HR Director',source:'https://pilot.example/team',linkedin_status:'confirmed'};
  const preview = score => previewHeadcountAuthority([contact],e,score,NOW);
  assert.equal(preview({authority_score:5}).authority_without_size,15);
  assert.equal(preview({authority_score:5}).authority_with_size,18);
  assert.equal(preview({authority_score:5}).authority_after,null);
  assert.equal(preview({authority_score:5}).comparison_status,'saved_authority_not_reproduced');
  assert.equal(preview({authority_score:25}).additional_points,0);
  assert.equal(preview({authority_score:18,authority_evidence:'role15 + size3'}).additional_points,0);
});
