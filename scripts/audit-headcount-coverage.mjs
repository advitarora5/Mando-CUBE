// GET-only headcount audit. Never import the pipeline runner or mutation store.
import { writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { normalizeName } from '../src/domain/ingestion/normalize.ts';
import { parseSecEmployeeEvidence, savedSecEmployeeEvidence } from '../src/pipeline/sec-employee-evidence.ts';
import { lookupEmployeeWorkday } from '../src/pipeline/employee-workday-evidence.ts';
import { researchEmployeeWebsite } from '../src/pipeline/employee-web-research.ts';
import { previewHeadcountAuthority } from '../src/pipeline/employee-authority-preview.ts';

export function getOnlyFetch(url, init) {
  const method = init?.method ?? (url instanceof Request ? url.method : 'GET');
  if (method.toUpperCase() !== 'GET') throw new Error('Headcount audit permits GET only');
  return fetch(url, init);
}

async function all(db, table, fields = '*') {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(fields).order('id').range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.code}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

export async function main(args, env = process.env) {
  // No --apply, output snapshots, provider credentials or manual-evidence inputs.
  if (args.length !== 2 || args[0] !== '--output') {
    throw new Error('Usage: audit-headcount-coverage.mjs --output PRIVATE_RESULT.json');
  }
  const url = env.SUPABASE_URL ?? env.PIPELINE_SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY ?? env.PIPELINE_SUPABASE_KEY;
  const expected = env.HEADCOUNT_AUDIT_PROJECT;
  if (!url || !key || !expected || new URL(url).hostname !== `${expected}.supabase.co`) {
    throw new Error('Supply existing private Supabase configuration and HEADCOUNT_AUDIT_PROJECT');
  }
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: getOnlyFetch },
  });
  const now = new Date();
  const companies = await all(db, 'companies', 'id,name,domain');
  const contacts = await all(db, 'contacts');
  const scores = await all(db, 'scores');
  const sites = await all(db, 'workday_sites');
  const metadata = await all(db, 'raw_captures', 'id,source_id,url,meta,fetched_at,http_status');
  const sec = [];
  for (const row of metadata.filter(row => row.http_status === 200 && /companyfacts\/CIK\d+\.json/.test(row.url))
    .sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))) {
    const { data, error } = await db.from('raw_captures').select('body').eq('id', row.id).single();
    if (error) throw new Error(`SEC capture: ${error.code}`);
    try { sec.push({ body: JSON.parse(data.body), cik: Number(row.url.match(/CIK(\d+)/)[1]) }); }
    catch { /* malformed saved responses establish no employee evidence */ }
  }
  const summary = {
    checked_at: now.toISOString(), read_only: true, company_count: companies.length,
    contact_count: contacts.length, score_count: scores.length, site_count: sites.length,
    capture_count: metadata.length,
    capture_sources: Object.fromEntries([...new Set(metadata.map(row => row.source_id))]
      .map(source => [source, metadata.filter(row => row.source_id === source).length])),
    automatic_mode: 'existing_SEC_responses_and_saved_bound_Workday_then_bounded_direct_official_sites_no_search_no_manual_evidence',
    // Existing SEC payloads only: no additional companyfacts fetch or invented SEC coverage.
    sec_responses: sec.length, results: [],
  };
  const save = () => writeFileSync(args[1], JSON.stringify(summary, null, 2), { mode: 0o600 });
  const ctx = {
    now: () => new Date(), employeeWebResearch: true, fetch: getOnlyFetch,
    lookupHost: host => lookup(host, { all: true }), treg: null, contact: '',
    log: { info() {}, warn() {}, error() {} },
    spend: { spent: () => 0, record: async () => { throw new Error('No spend writes'); }, allow: async () => false },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), runId: null,
    store: {
      workdaySites: async () => sites.filter(site => site.enabled),
      websiteEvidenceCaptures: async (name, limit) => {
        const { data, error } = await db.from('raw_captures').select('*, signals(last_seen_at)')
          .eq('source_id', 'workday-career-sites').eq('meta->>kind', 'workday_job')
          .eq('meta->>normalized_name', name).eq('http_status', 200)
          .order('fetched_at', { ascending: false }).order('id').limit(limit);
        if (error) throw new Error(`Workday captures: ${error.code}`);
        return data.map(({ signals, ...capture }) => ({ ...capture,
          last_seen_at: signals.reduce((latest, signal) => signal.last_seen_at > latest
            ? signal.last_seen_at : latest, capture.fetched_at) }));
      },
    },
  };
  async function audit(company) {
    const current = scores.filter(score => score.company_id === company.id
      && Date.parse(score.assessed_at) <= now.getTime())
      .sort((a, b) => Date.parse(b.assessed_at) - Date.parse(a.assessed_at)
        || String(b.id).localeCompare(String(a.id)))[0];
    let evidence = null, source = null;
    const diagnostics = { sec_existing_responses: sec.length,
      workday_bound_sites: sites.filter(site => site.enabled && site.company_id === company.id
        && site.normalized_name === normalizeName(company.name)).length };
    for (const response of sec) {
      evidence = parseSecEmployeeEvidence(response.body, company.name, response.cik, now);
      if (evidence) { source = 'SEC_existing_response'; break; }
    }
    if (!evidence) {
      evidence = savedSecEmployeeEvidence(current?.authority_evidence, now);
      if (evidence) source = 'SEC_retained_assessment';
    }
    if (!evidence) {
      evidence = await lookupEmployeeWorkday(ctx, company);
      if (evidence) source = 'saved_company_bound_Workday';
    }
    if (!evidence) {
      const web = await researchEmployeeWebsite(ctx, company);
      diagnostics.web = web;
      evidence = web.evidence;
      if (evidence) source = 'bounded_direct_official_site';
    }
    summary.results.push({ company: company.name, company_id: company.id, domain: company.domain,
      evidence, source, diagnostics, saved_authority: current?.authority_score ?? null,
      saved_assessed_at: current?.assessed_at ?? null,
      ...previewHeadcountAuthority(contacts.filter(contact => contact.company_id === company.id), evidence, current ?? null, now) });
    save();
    console.error(`${summary.results.length}/${companies.length}: ${company.name}: ${source ?? 'unresolved'}`);
  }
  let index = 0;
  async function worker() { while (index < companies.length) await audit(companies[index++]); }
  // Independent company workers; each collector retains its own 45s/18-request/six-page limit.
  await Promise.all(Array.from({ length: 16 }, worker));
  summary.results.sort((a, b) => a.company.localeCompare(b.company));
  save();
  return { company_count: companies.length, found: summary.results.filter(row => row.evidence).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
