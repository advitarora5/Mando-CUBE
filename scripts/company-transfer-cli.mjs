import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { assertAllowedTarget } from '../src/pipeline/store/supabase.ts';
import { exportReviewed, planTransfer, transferSql } from './company-transfer.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  manifest: { type: 'string' }, input: { type: 'string' }, out: { type: 'string' }, apply: { type: 'boolean', default: false },
} });
const command = positionals[0];
if (!['export', 'prepare'].includes(command) || positionals.length !== 1 || !values.out
  || (command === 'export' && (!values.manifest || values.apply)) || (command === 'prepare' && !values.input)) {
  throw new Error('Usage: npm run companies:transfer -- export --manifest reviewed.json --out package.json\n  npm run companies:transfer -- prepare --input package.json --out preview.sql [--apply]\n--apply generates COMMIT SQL; this command never executes SQL.');
}
// Only the explicitly configured pipeline environment is loaded by the npm command.
const url = process.env.PIPELINE_SUPABASE_URL, key = process.env.PIPELINE_SUPABASE_KEY;
if (!url || !key) throw new Error('Set PIPELINE_SUPABASE_URL and PIPELINE_SUPABASE_KEY');
assertAllowedTarget(url, command === 'export' ? undefined : process.env.PIPELINE_ALLOW_REMOTE);
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
if (command === 'export') {
  const data = await exportReviewed(db, await readJson(values.manifest), new URL(url).origin);
  await writeFile(values.out, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  console.log(`Exported ${data.companies.length} reviewed companies, ${data.captures.length} captures to ${values.out}`);
} else {
  const companies = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await db.from('companies').select('id,name,domain').order('id').range(start, start + 499);
    if (error) throw new Error(error.message);
    companies.push(...data); if (data.length < 500) break;
  }
  const plan = planTransfer(await readJson(values.input), companies);
  await writeFile(`${values.out}.report.json`, JSON.stringify({ target: new URL(url).origin, mapping: plan.mapping }, null, 2) + '\n', { mode: 0o600 });
  console.table(plan.mapping.map(({ name, action, why }) => ({ name, action, why })));
  // Invalidate an old output before refusing a newly held package.
  const blocked = plan.mapping.some(m => !['create', 'attach'].includes(m.action));
  await writeFile(values.out, blocked ? '-- BLOCKED: resolve held companies and prepare again. No import SQL generated.\n' : transferSql(plan, { apply: values.apply }), { mode: 0o600 });
  if (blocked) throw new Error(`Held companies need review. See ${values.out}.report.json`);
  console.log(`Wrote ${values.apply ? 'COMMIT' : 'ROLLBACK preview'} SQL to ${values.out}. No database writes performed.`);
}
