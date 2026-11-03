// Offline validation only: no browser, model calls, credentials, or database writes.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { captureBatchSchema } from '../../src/data/ingestion/contracts.ts';

export function validateCapture(input) {
  const result = captureBatchSchema.safeParse(input);
  if (!result.success) return { ok: false, errors: result.error.issues.map(issue => `${issue.path.join('.') || 'batch'}: ${issue.message}`) };
  const batch = result.data;
  const warnings = [];
  if (!batch.captures.length) warnings.push('No captures: this run supplies no material for extraction.');
  if (batch.failures.length) warnings.push(`${batch.failures.length} collection failure(s); review before extraction.`);
  if (batch.captures.some(capture => !capture.published_date)) warnings.push('Some publication dates are unknown; do not substitute collection dates.');
  if ((Date.parse(batch.finished_at) - Date.parse(batch.brief.started_at)) / 60000 > batch.brief.max_minutes) warnings.push('Run exceeded its time budget.');
  return { ok: true, run_id: batch.brief.run_id, captures: batch.captures.length, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/ingestion/validate-capture.mjs <batch.json>');
    const report = validateCapture(JSON.parse(await readFile(process.argv[2], 'utf8')));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
