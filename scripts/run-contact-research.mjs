import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createTregClient, researchCompany, ResearchBudgetReached } from './contact-research.mjs';

export function runConfig(env, args) {
  if (args.some(arg => !['--apply', '--trigger=schedule', '--trigger=manual'].includes(arg))) throw new Error('Unknown argument. Use --apply and optionally --trigger=schedule.');
  const number = (name, fallback, maximum, integer = false) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value < 0.000001 || value > maximum || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const config = {
    apply: args.includes('--apply'), trigger: args.includes('--trigger=schedule') ? 'schedule' : 'manual',
    maxCompanies: number('CONTACT_RESEARCH_MAX_COMPANIES', 5, 100, true),
    maxContacts: number('CONTACT_RESEARCH_MAX_CONTACTS', 3, 10, true),
    maxRunUsd: number('CONTACT_RESEARCH_MAX_RUN_USD', 1, 100),
    maxCallUsd: number('CONTACT_RESEARCH_MAX_CALL_USD', 0.1, 1),
  };
  if (config.maxCallUsd > config.maxRunUsd) throw new Error('Call ceiling cannot exceed the run budget.');
  return config;
}

const checked = async query => {
  const { data, error } = await query;
  if (error) throw new Error(`Contact research database operation failed (${error.code ?? 'unknown'}).`);
  return data;
};

export async function runContactResearch({ db, env, config, log = console.log, fetchImpl }) {
  if (!config.apply) {
    const pending = await checked(db.from('contact_research_jobs').select('company_id').eq('status', 'pending').limit(config.maxCompanies));
    log(JSON.stringify({ mode: 'preview', pending_in_next_batch: pending.length, ...config }));
    return;
  }
  if (!env.TREG_TOKEN) throw new Error('TREG_TOKEN is required for --apply.');
  const [run] = await checked(db.from('pipeline_runs').insert({ job: 'contact_research', trigger: config.trigger }).select('id'));
  const client = createTregClient({
    token: env.TREG_TOKEN, maxRunUsd: config.maxRunUsd, maxCallUsd: config.maxCallUsd, fetchImpl,
    checkpoint: {
      get: async (companyId, requestKey) => checked(db.from('contact_research_calls').select('*').eq('company_id', companyId).eq('request_key', requestKey).maybeSingle()),
      start: async (companyId, requestKey, endpoint) => checked(db.from('contact_research_calls').insert({ company_id: companyId, request_key: requestKey, endpoint, status: 'running' })),
      finish: async (companyId, requestKey, result) => checked(db.from('contact_research_calls').update(result).eq('company_id', companyId).eq('request_key', requestKey)),
    },
  });
  const counts = { succeeded: 0, blocked: 0, deferred: 0, added: 0, verified: 0, unverified: 0 };
  let fatal = false;
  try {
    for (let index = 0; index < config.maxCompanies; index += 1) {
      const jobs = await checked(db.rpc('claim_contact_research', { p_run_id: run.id }));
      if (!jobs.length) break;
      const job = jobs[0];
      try {
        const company = await checked(db.from('companies').select('id,name,domain').eq('id', job.company_id).single());
        const existing = await checked(db.from('contacts').select('name,email,linkedin_url').eq('company_id', job.company_id));
        const summary = await researchCompany({
          company, existing, maxContacts: config.maxContacts, client,
          save: async (companyId, contact) => {
            const added = await checked(db.rpc('save_researched_contact', { p_company_id: companyId, p_contact: contact }));
            if (added) {
              counts.added += 1;
              counts[contact.email_verified ? 'verified' : 'unverified'] += 1;
            }
            return added;
          },
        });
        await checked(db.from('contact_research_jobs').update({ status: 'succeeded', finished_at: new Date().toISOString(), summary }).eq('company_id', job.company_id));
        counts.succeeded += 1;
      } catch (error) {
        const deferred = error instanceof ResearchBudgetReached;
        counts[deferred ? 'deferred' : 'blocked'] += 1;
        await checked(db.from('contact_research_jobs').update({
          status: deferred ? 'pending' : 'blocked', finished_at: new Date().toISOString(), error: error.message,
        }).eq('company_id', job.company_id));
        break;
      }
    }
  } catch {
    fatal = true;
  }
  await checked(db.from('pipeline_runs').update({
    status: fatal ? 'failed' : counts.blocked ? (counts.succeeded ? 'partial' : 'blocked') : 'succeeded',
    finished_at: new Date().toISOString(), requests_made: client.stats.requests,
    counts: { ...counts, charged_micro: client.stats.chargedMicro, unknown_charges: client.stats.unknownCharges },
    error: fatal || counts.blocked ? 'Contact research stopped; inspect job and call checkpoints.' : null,
  }).eq('id', run.id));
  log(JSON.stringify({ ...counts, ...client.stats }));
  if (fatal || counts.blocked) throw new Error('Contact research needs review. No automatic paid retries were made.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = runConfig(process.env, process.argv.slice(2));
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) throw new Error('Database credentials are required.');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    await runContactResearch({ db, env: process.env, config });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
