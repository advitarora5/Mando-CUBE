// Read-only Authority comparison. No pipeline runner, score writes or paid providers.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { employeeEvidenceSchema, employeeEvidenceForCompany } from '../src/pipeline/employee-evidence.ts';
import { authorityFromContacts, differentEmployer } from '../src/domain/ingestion/pipeline-score.ts';
import { normalizeDomain } from '../src/domain/ingestion/normalize.ts';
import { formatEvidence } from '../src/domain/scoring/evidence.ts';
import { evaluateTier } from '../src/domain/scoring/tier-rules.ts';

export function previewEmployeeEvidence(data, evidence, now) {
  return data.companies.filter(company => evidence.some(row => row.company_domain === normalizeDomain(company.domain)))
    .map(company => {
      const contacts = data.contacts.filter(contact => contact.company_id === company.id && !differentEmployer(contact));
      const scores = data.scores.filter(score => score.company_id === company.id);
      const current = scores.filter(score => Number.isFinite(Date.parse(score.assessed_at)) && Date.parse(score.assessed_at) <= now.getTime())
        .sort((a, b) => Date.parse(b.assessed_at) - Date.parse(a.assessed_at) || String(b.id).localeCompare(String(a.id)))[0];
      const employees = employeeEvidenceForCompany(evidence, company.domain, now);
      const result = { company: company.name, company_id: company.id, domain: company.domain,
        assessed_at: current?.assessed_at ?? null, rubric_version: current?.rubric_version ?? null,
        evidence_as_of: employees?.as_of ?? null, headcount: employees?.employee_count ?? null,
        source: employees?.source ?? null, contacts: contacts.length };
      if (!employees) return { ...result, status: 'held_stale_or_future_headcount' };
      if (!current) return { ...result, status: 'held_no_assessment' };
      if (scores.some(score => !Number.isFinite(Date.parse(score.assessed_at)))) return { ...result, status: 'held_invalid_assessment_date' };
      if (!current.rubric_version?.startsWith('mando-team-70:pipeline-')) return { ...result, status: 'held_different_scoring_policy' };
      const baseline = authorityFromContacts(contacts, { employee_count: null }, now);
      const afterAuthority = authorityFromContacts(contacts, { employee_count: employees.employee_count,
        employee_source: employees.source, employee_as_of: employees.as_of, employee_basis: employees.basis, employee_date_basis: employees.date_basis }, now);
      if (Number(current.authority_score) !== baseline.score) return { ...result, status: 'held_saved_authority_requires_review',
        saved_authority: current.authority_score, calculated_without_headcount: baseline.score,
        calculated_with_headcount: afterAuthority.score };
      const before = evaluateTier(current);
      const after = evaluateTier({ ...current, authority_score: afterAuthority.score,
        authority_evidence: formatEvidence(afterAuthority.source, afterAuthority.reason) ?? '' });
      return { ...result, status: afterAuthority.detail.size ? 'preview_ready' : 'no_size_bonus',
        authority_before: baseline.score, authority_after: afterAuthority.score,
        total_before: before.total, total_after: after.total, tier_before: before.tier, tier_after: after.tier,
        newly_qualified: before.tier !== 'Qualified' && after.tier === 'Qualified',
        authority_evidence_after: formatEvidence(afterAuthority.source, afterAuthority.reason),
        note: 'Authority-only comparison; other saved category scores are held constant. Verify current company/contact scope before applying.' };
    });
}

async function readTable(db, table, fields, ids) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let query = db.from(table).select(fields).order('id');
    if (ids) query = query.in('company_id', ids);
    const { data, error } = await query.range(from, from + 999);
    if (error) throw new Error(`Cannot read ${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

export async function main(args, env = process.env) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--evidence', '--input', '--as-of'].includes(key) || !args[i + 1] || options[key]) {
      throw new Error('Usage: preview-employee-evidence.mjs --evidence FILE [--input SNAPSHOT.json] [--as-of YYYY-MM-DD]');
    }
    options[key] = args[i + 1];
  }
  if (!options['--evidence']) throw new Error('--evidence is required');
  const evidence = employeeEvidenceSchema.parse(JSON.parse(readFileSync(options['--evidence'], 'utf8')));
  const now = options['--as-of'] ? new Date(`${options['--as-of']}T23:59:59.999Z`) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid --as-of date');
  let data;
  if (options['--input']) data = JSON.parse(readFileSync(options['--input'], 'utf8'));
  else {
    const url = env.SUPABASE_URL ?? env.PIPELINE_SUPABASE_URL;
    const key = env.SUPABASE_SECRET_KEY ?? env.PIPELINE_SUPABASE_KEY;
    if (!url || !key) throw new Error('Database access is unavailable. Supply the existing private environment file or --input with companies, contacts and scores arrays.');
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: {
      fetch: (url, init) => {
        if ((init?.method ?? 'GET').toUpperCase() !== 'GET') throw new Error('Preview permits GET requests only');
        return fetch(url, init);
      },
    } });
    const companies = (await readTable(db, 'companies', 'id,name,domain'))
      .filter(company => evidence.some(row => row.company_domain === normalizeDomain(company.domain)));
    const ids = companies.map(company => company.id);
    data = { companies, contacts: ids.length ? await readTable(db, 'contacts', '*', ids) : [],
      scores: ids.length ? await readTable(db, 'scores', '*', ids) : [] };
  }
  for (const key of ['companies', 'contacts', 'scores']) if (!Array.isArray(data[key])) throw new Error(`Input requires a ${key} array`);
  const results = previewEmployeeEvidence(data, evidence, now);
  const missingDomains = evidence.filter(row => !data.companies.some(company => normalizeDomain(company.domain) === row.company_domain))
    .map(row => row.company_domain);
  return { read_only: true, as_of: now.toISOString(), evidence_records: evidence.length,
    matched_companies: results.length, missing_domains: missingDomains,
    newly_qualified: results.filter(row => row.newly_qualified).length, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
