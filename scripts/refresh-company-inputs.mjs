import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectSignalDates, selectSignal } from './collect-signal-dates.mjs';
import { collectJobPostings, discoverBoards, mergePostings } from './collect-job-postings.mjs';

export function scoringInputs(company, signal, postings) {
  return { company_id: company.id, workday_signal_date: signal.date ?? company.workday_signal_date,
    release_evidence: signal.evidence, job_evidence_candidates: postings.filter(j => j.status === 'active').map(j => ({
      evidence: j.evidence, posting_url: j.posting_url, relevance: j.relevance, checked_at: j.checked_at,
      requires_internal_role_review: true,
    })) };
}

export async function applySignal(db, company, signal) {
  if (signal.status !== 'ready') return 'not_changed';
  if (!company.updated_at) return 'missing_version';
  const { data, error } = await db.from('companies').update({ workday_signal_date: signal.date })
    .eq('id', company.id).eq('updated_at', company.updated_at).is('workday_signal_date', null).select('id');
  if (error) return 'database_error';
  return data?.length === 1 ? 'applied' : 'concurrent_change';
}

export async function refresh(companies, { configs = {}, previous = [], fetchImpl = fetch, key, now = new Date() } = {}) {
  const allJobs = [], checks = [], results = [], effectiveCompanies = [];
  for (const company of companies) {
    const discovery = await discoverBoards(company, configs[company.id], { fetchImpl, key });
    effectiveCompanies.push({ ...company, domain: discovery.employer_domain ?? company.domain });
    const collected = await collectJobPostings(discovery.boards, { fetchImpl, now });
    allJobs.push(...collected.jobs, ...discovery.employerJobs);
    checks.push(...collected.checks);
    results.push({ company_id: company.id, name: company.name, original_signal_date: company.workday_signal_date,
      original_updated_at: company.updated_at ?? null, discovered_domain: discovery.employer_domain ?? null,
      domain_evidence: discovery.domain_evidence,
      discovery_leads: discovery.leads, coverage: discovery.boards.length || discovery.employerJobs.length ? 'supported_source' : 'no_supported_source' });
  }
  const candidates = await collectSignalDates(effectiveCompanies, { configs, fetchImpl, key, now });
  const ids = new Set(companies.map(c => c.id));
  const postings = [...previous.filter(j => !ids.has(j.company_id)),
    ...mergePostings(previous.filter(j => ids.has(j.company_id)), allJobs, checks)];
  for (const result of results) {
    result.signal = selectSignal(companies.find(c => c.id === result.company_id), candidates);
    result.scoring_inputs = scoringInputs(companies.find(c => c.id === result.company_id), result.signal,
      postings.filter(j => j.company_id === result.company_id));
  }
  return { version: 1, checked_at: now.toISOString(), mode: 'dry_run', companies: results, signal_candidates: candidates, postings, board_checks: checks };
}

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (['--apply', '--database'].includes(flag)) result[flag.slice(2)] = true;
    else if (['--companies', '--config', '--out', '--company-id'].includes(flag)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`);
      result[flag.slice(2)] = argv[++i];
    } else throw new Error(`Unknown argument ${flag}`);
  }
  if (!result.out || Boolean(result.database) === Boolean(result.companies) || (result.apply && !result.database)) {
    throw new Error('Usage: node scripts/refresh-company-inputs.mjs (--companies FILE | --database) --out FILE [--config FILE] [--company-id UUID] [--apply]');
  }
  return result;
}

async function save(file, report) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(report, null, 2) + '\n');
  await rename(`${file}.tmp`, file);
}

async function main() {
  const options = args(process.argv.slice(2));
  let db, companies;
  if (options.database) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) throw new Error('Database environment variables required');
    const { createClient } = await import('@supabase/supabase-js');
    db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    companies = [];
    for (let offset = 0; ; offset += 500) {
      let query = db.from('companies').select('id,name,domain,source,workday_signal_date,updated_at').order('id').range(offset, offset + 499);
      if (options['company-id']) query = query.eq('id', options['company-id']);
      const { data, error } = await query;
      if (error) throw new Error('Could not read companies');
      companies.push(...data);
      if (data.length < 500) break;
    }
  } else {
    const input = JSON.parse(await readFile(options.companies, 'utf8'));
    companies = Array.isArray(input) ? input : input.companies;
    if (options['company-id']) companies = companies.filter(c => c.id === options['company-id']);
  }
  if (!Array.isArray(companies) || !companies.length || companies.some(c => !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(c.id) || !c.name?.trim()) || new Set(companies.map(c => c.id)).size !== companies.length) throw new Error('Unique company UUIDs and names are required');
  const config = options.config ? JSON.parse(await readFile(options.config, 'utf8')) : {};
  const destination = resolve(options.out);
  if ([options.companies, options.config].filter(Boolean).some(p => resolve(p) === destination)) throw new Error('Output must not overwrite input');
  let previous = [];
  try { const prior = JSON.parse(await readFile(destination, 'utf8')); if (prior.version !== 1 || !Array.isArray(prior.postings)) throw new Error('Invalid previous report'); previous = prior.postings; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const report = await refresh(companies, { configs: config, previous });
  // Persist all supporting evidence before any database mutation.
  await save(destination, report);
  if (options.apply) {
    report.mode = 'apply';
    for (const row of report.companies) {
      row.apply_status = await applySignal(db, companies.find(c => c.id === row.company_id), row.signal);
      await save(destination, report);
    }
    if (report.companies.some(c => ['database_error', 'concurrent_change', 'missing_version'].includes(c.apply_status))) process.exitCode = 1;
  }
  const ready = report.companies.filter(c => c.signal.status === 'ready').length;
  console.log(JSON.stringify({ mode: report.mode, companies: companies.length, proposed_dates: ready,
    active_postings: report.postings.filter(j => j.status === 'active').length, output: destination,
    search_enabled: Boolean(process.env.BRAVE_SEARCH_API_KEY) }, null, 2));
  if (report.signal_candidates.some(c => ['unreachable', 'discovery_failed'].includes(c.date_type)) || report.board_checks.some(c => c.status !== 'ok')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
