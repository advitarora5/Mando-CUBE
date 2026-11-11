// Reviewed discovery transfers. This module only builds artifacts; it never writes a database.
import { decideMatch } from '../src/domain/ingestion/matching.ts';
import { normalizeDomain } from '../src/domain/ingestion/normalize.ts';
import { companyAliases } from '../src/data/company-aliases.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pick = (row, fields) => Object.fromEntries(fields.split(',').map(k => [k, row[k] ?? null]));
const companyFields = 'id,name,domain,industry,headquarters,employee_count,workday_signal_date,source,created_at';
const captureFields = 'id,source_id,run_id,url,fetched_at,http_status,content_type,content_hash,body,meta';
const extractionFields = 'id,capture_id,run_id,method,model,status,output,error,cost_usd,created_at,attempts,prompt_version';
const signalFields = 'id,company_id,capture_id,extraction_id,type,signal_date,source_url,quote,confidence,first_seen_at,last_seen_at,company_name,products,project_type,role_seniority,timing_words,method';
const siteFields = 'id,company_id,tenant,pod,site,company_name,normalized_name,match_kind,discovered_from,capture_id,enabled,last_checked_at,last_status,created_at';
const identity = row => pick(row, 'id,name,domain');
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function unique(rows, label) {
  requireThat(Array.isArray(rows), `${label} must be an array`);
  requireThat(rows.every(r => uuid.test(r.id)) && new Set(rows.map(r => r.id)).size === rows.length, `${label} need unique UUIDs`);
}
function reviewed(review) {
  requireThat(review?.approved === true && typeof review.note === 'string' && review.note.trim()
    && Number.isFinite(Date.parse(review.reviewed_at)) && Array.isArray(review.evidence_urls)
    && review.evidence_urls.length > 0 && review.evidence_urls.every(u => /^https?:\/\//.test(u)),
  'Each selected company needs approved:true, a review note, reviewed_at, and evidence_urls');
}
export function validatePackage(data) {
  requireThat(data?.version === 1, 'Unsupported company transfer package version');
  requireThat(Array.isArray(data.companies) && data.companies.length > 0, 'Select at least one reviewed company');
  unique(data.companies.map(c => c.company), 'companies');
  for (const key of ['captures', 'extractions', 'sources']) requireThat(Array.isArray(data[key]), `${key} must be an array`);
  unique(data.captures, 'captures'); unique(data.extractions, 'extractions');
  const captures = new Set(data.captures.map(c => c.id)), extractions = new Map(data.extractions.map(e => [e.id, e]));
  const sources = new Set(data.sources.map(s => s.id));
  const allSignals = [], allSites = [], usedCaptures = new Set();
  for (const entry of data.companies) {
    reviewed(entry.review);
    requireThat(typeof entry.company.name === 'string' && entry.company.name.trim() && normalizeDomain(entry.company.domain), 'Company name and confirmed domain required');
    requireThat(Array.isArray(entry.signals) && entry.signals.length > 0 && Array.isArray(entry.sites) && entry.sites.length > 0, 'Each company needs signals and a verified Workday site');
    for (const s of entry.signals) {
      requireThat(s.company_id === entry.company.id && captures.has(s.capture_id), 'Signal ownership or capture is invalid');
      requireThat(!s.extraction_id || extractions.get(s.extraction_id)?.capture_id === s.capture_id, 'Signal extraction must belong to its capture');
      requireThat(Number.isFinite(Date.parse(s.first_seen_at)) && Date.parse(s.last_seen_at) >= Date.parse(s.first_seen_at), 'Invalid signal evidence dates');
      usedCaptures.add(s.capture_id); allSignals.push(s);
    }
    for (const s of entry.sites) {
      requireThat(s.company_id === entry.company.id && (!s.capture_id || captures.has(s.capture_id)) && (!s.discovered_from || sources.has(s.discovered_from)), 'Workday site ownership or provenance is invalid');
      if (s.capture_id) usedCaptures.add(s.capture_id);
      allSites.push(s);
    }
  }
  unique(allSignals, 'signals'); unique(allSites, 'sites');
  for (const e of data.extractions) requireThat(usedCaptures.has(e.capture_id), 'Unselected extraction in package');
  for (const c of data.captures) requireThat(usedCaptures.has(c.id) && sources.has(c.source_id) && Number.isFinite(Date.parse(c.fetched_at)), 'Unselected capture or invalid capture provenance');
  return data;
}

// Whitelists intentionally exclude assessments, contacts, queue state and provider configuration.
export function sanitizePackage(data) {
  validatePackage(data);
  return { version: 1, exported_at: data.exported_at, source_database: data.source_database,
    companies: data.companies.map(e => ({ company: { ...pick(e.company, companyFields), domain: normalizeDomain(e.company.domain) },
      review: pick(e.review, 'approved,note,reviewed_at,evidence_urls'), signals: e.signals.map(s => pick(s, signalFields)), sites: e.sites.map(s => pick(s, siteFields)) })),
    captures: data.captures.map(c => pick(c, captureFields)), extractions: data.extractions.map(e => pick(e, extractionFields)),
    sources: data.sources.map(s => pick(s, 'id,type,name')) };
}

export function planTransfer(input, targetCompanies) {
  const data = sanitizePackage(input), known = targetCompanies.map(identity), mapping = [];
  unique(known, 'target companies');
  for (const { company } of data.companies) {
    const matches = known.filter(c => normalizeDomain(c.domain) === company.domain);
    const decision = matches.length > 1 ? { action: 'review', why: 'Multiple target companies share this normalized domain' }
      : decideMatch({ name: company.name, domain: company.domain, domain_confirmed: true, workday_verified: true }, known, { canCreate: true }, companyAliases);
    // An alias with a different confirmed domain needs a human decision for a database transfer.
    if (decision.action === 'attach' && normalizeDomain(known.find(c => c.id === decision.company_id)?.domain) !== company.domain) {
      decision.action = 'review'; decision.why = 'Known alias has a different domain; review required';
    }
    if (decision.action === 'create' && known.some(c => c.id === company.id)) throw new Error(`Local company ID collision: ${company.id}`);
    mapping.push({ local_id: company.id, name: company.name, domain: company.domain, action: decision.action,
      target_id: decision.action === 'create' ? company.id : decision.action === 'attach' ? decision.company_id : null, why: decision.why });
    if (decision.action === 'create') known.push(identity(company));
  }
  return { data, expected: targetCompanies.map(identity), mapping };
}

export function transferSql(plan, { apply = false } = {}) {
  requireThat(plan.mapping.every(m => ['create', 'attach'].includes(m.action)), 'Resolve held/skipped companies and prepare a new package before generating SQL');
  const payload = JSON.stringify(plan);
  requireThat(!payload.includes('$company_transfer$'), 'Unsafe SQL delimiter');
  return `-- Reviewed company transfer. Run with psql -v ON_ERROR_STOP=1.
-- Generated SQL only; creating this file does not connect to or change any database.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.companies, public.sources, public.raw_captures, public.extractions,
 public.signals, public.workday_sites, public.company_origins IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE transfer_payload ON COMMIT DROP AS SELECT $company_transfer$${payload}$company_transfer$::jsonb AS body;
CREATE TEMP TABLE transfer_map(kind text, local_id uuid, target_id uuid, PRIMARY KEY(kind,local_id)) ON COMMIT DROP;
DO $transfer$
DECLARE p jsonb; entry jsonb; r jsonb; mapped uuid; owner uuid; cid uuid; cap uuid; ext uuid; import_run uuid;
BEGIN
 SELECT body INTO p FROM transfer_payload;
 -- Recheck under the write lock. A changed target requires preparing a fresh preview.
 IF EXISTS (
  SELECT 1 FROM jsonb_array_elements(p->'expected') e
  WHERE NOT EXISTS(SELECT 1 FROM public.companies c WHERE c.id=(e->>'id')::uuid AND c.name=e->>'name' AND c.domain IS NOT DISTINCT FROM e->>'domain')
 ) OR EXISTS (
  SELECT 1 FROM public.companies c WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(p->'expected') e WHERE c.id=(e->>'id')::uuid
  ) AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(p->'mapping') m WHERE m->>'action'='create' AND c.id=(m->>'target_id')::uuid
    AND c.name=m->>'name' AND c.domain=m->>'domain'
  )
 ) THEN RAISE EXCEPTION 'Target companies changed; prepare a fresh preview'; END IF;
 INSERT INTO public.pipeline_runs(job,trigger,status,finished_at,counts)
 VALUES('reviewed_company_import','manual','succeeded',now(),jsonb_build_object(
  'source_database',p->'data'->'source_database','exported_at',p->'data'->'exported_at','mapping',p->'mapping',
  'reviews',(SELECT jsonb_agg(jsonb_build_object('local_id',x->'company'->'id','review',x->'review')) FROM jsonb_array_elements(p->'data'->'companies') x))) RETURNING id INTO import_run;
 FOR r IN SELECT value FROM jsonb_array_elements(p->'data'->'sources') LOOP
  IF EXISTS(SELECT 1 FROM public.sources WHERE id=r->>'id' AND type<>r->>'type') THEN RAISE EXCEPTION 'Source type conflict'; END IF;
  INSERT INTO public.sources(id,type,name,frequency,max_requests_per_run,min_delay_ms,enabled)
   VALUES(r->>'id',r->>'type',r->>'name','manual',1,0,false) ON CONFLICT(id) DO NOTHING;
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(p->'data'->'companies') LOOP
  r := entry->'company';
  SELECT (m->>'target_id')::uuid INTO cid FROM jsonb_array_elements(p->'mapping') m WHERE m->>'local_id'=r->>'id';
  IF NOT EXISTS(SELECT 1 FROM public.companies WHERE id=cid) THEN
   INSERT INTO public.companies(id,name,domain,industry,headquarters,employee_count,workday_signal_date,source,created_at)
    SELECT cid,x.name,x.domain,x.industry,x.headquarters,x.employee_count,x.workday_signal_date,x.source,x.created_at
    FROM jsonb_populate_record(NULL::public.companies,r) x;
   INSERT INTO public.company_origins(company_id,origin,run_id) VALUES(cid,'pipeline',import_run);
  END IF;
  INSERT INTO transfer_map VALUES('company',(r->>'id')::uuid,cid);
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(p->'data'->'captures') LOOP
  SELECT id INTO mapped FROM public.raw_captures WHERE url=r->>'url' AND content_hash=r->>'content_hash';
  IF mapped IS NULL THEN
   INSERT INTO public.raw_captures(source_id,run_id,url,fetched_at,http_status,content_type,content_hash,body,meta)
    SELECT x.source_id,import_run,x.url,x.fetched_at,x.http_status,x.content_type,x.content_hash,x.body,
     coalesce(x.meta,'{}') || jsonb_build_object('import_local_capture_id',r->>'id','import_local_run_id',r->>'run_id')
    FROM jsonb_populate_record(NULL::public.raw_captures,r) x RETURNING id INTO mapped;
  ELSIF EXISTS(SELECT 1 FROM public.raw_captures WHERE id=mapped AND body<>r->>'body') THEN RAISE EXCEPTION 'Capture hash conflict'; END IF;
  INSERT INTO transfer_map VALUES('capture',(r->>'id')::uuid,mapped);
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(p->'data'->'extractions') LOOP
  SELECT target_id INTO cap FROM transfer_map WHERE kind='capture' AND local_id=(r->>'capture_id')::uuid;
  SELECT id INTO mapped FROM public.extractions WHERE capture_id=cap AND method=r->>'method' AND model=r->>'model';
  IF mapped IS NULL THEN
   INSERT INTO public.extractions(capture_id,run_id,method,model,status,output,error,cost_usd,created_at,attempts,prompt_version)
    SELECT cap,import_run,x.method,x.model,x.status,x.output,x.error,x.cost_usd,x.created_at,x.attempts,x.prompt_version
    FROM jsonb_populate_record(NULL::public.extractions,r) x RETURNING id INTO mapped;
  END IF;
  INSERT INTO transfer_map VALUES('extraction',(r->>'id')::uuid,mapped);
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(p->'data'->'companies') LOOP
  SELECT target_id INTO cid FROM transfer_map WHERE kind='company' AND local_id=(entry->'company'->>'id')::uuid;
  FOR r IN SELECT value FROM jsonb_array_elements(entry->'signals') LOOP
   SELECT target_id INTO cap FROM transfer_map WHERE kind='capture' AND local_id=(r->>'capture_id')::uuid;
   SELECT target_id INTO ext FROM transfer_map WHERE kind='extraction' AND local_id=(r->>'extraction_id')::uuid;
   SELECT id,company_id INTO mapped,owner FROM public.signals WHERE type=r->>'type' AND source_url=r->>'source_url' AND md5(quote)=md5(r->>'quote');
   IF mapped IS NOT NULL AND owner IS DISTINCT FROM cid THEN RAISE EXCEPTION 'Signal belongs to another company or pending review'; END IF;
   IF mapped IS NULL THEN
    INSERT INTO public.signals(company_id,capture_id,extraction_id,type,signal_date,source_url,quote,confidence,first_seen_at,last_seen_at,company_name,products,project_type,role_seniority,timing_words,method)
     SELECT cid,cap,ext,x.type,x.signal_date,x.source_url,x.quote,x.confidence,x.first_seen_at,x.last_seen_at,x.company_name,x.products,x.project_type,x.role_seniority,x.timing_words,x.method
     FROM jsonb_populate_record(NULL::public.signals,r) x;
   ELSE
    UPDATE public.signals SET first_seen_at=least(first_seen_at,(r->>'first_seen_at')::timestamptz),last_seen_at=greatest(last_seen_at,(r->>'last_seen_at')::timestamptz) WHERE id=mapped;
   END IF;
  END LOOP;
  FOR r IN SELECT value FROM jsonb_array_elements(entry->'sites') LOOP
   SELECT target_id INTO cap FROM transfer_map WHERE kind='capture' AND local_id=(r->>'capture_id')::uuid;
   SELECT id,company_id INTO mapped,owner FROM public.workday_sites WHERE tenant=r->>'tenant' AND pod=r->>'pod' AND site=r->>'site';
   IF mapped IS NOT NULL AND owner IS DISTINCT FROM cid THEN RAISE EXCEPTION 'Workday site belongs to another company or pending review'; END IF;
   IF mapped IS NULL THEN
    INSERT INTO public.workday_sites(company_id,tenant,pod,site,company_name,normalized_name,match_kind,discovered_from,capture_id,enabled,last_checked_at,last_status,created_at)
     SELECT cid,x.tenant,x.pod,x.site,x.company_name,x.normalized_name,x.match_kind,x.discovered_from,cap,x.enabled,x.last_checked_at,x.last_status,x.created_at
     FROM jsonb_populate_record(NULL::public.workday_sites,r) x;
   END IF;
  END LOOP;
 END LOOP;
END;
$transfer$;
SELECT '${apply ? 'APPLY' : 'PREVIEW - ROLLED BACK'}' AS mode, m->>'name' AS name,m->>'action' AS action,m->>'local_id' AS local_id,m->>'target_id' AS target_id
 FROM transfer_payload, jsonb_array_elements(body->'mapping') m;
${apply ? 'COMMIT' : 'ROLLBACK'};
`;
}

export async function exportReviewed(db, manifest, sourceDatabase) {
  requireThat(Array.isArray(manifest?.companies) && manifest.companies.length > 0, 'Manifest needs a companies array');
  const data = { version: 1, exported_at: new Date().toISOString(), source_database: sourceDatabase, companies: [], captures: [], extractions: [], sources: [] };
  async function rows(table, configure) {
    const result = [];
    for (let start = 0; ; start += 500) {
      const { data: page, error } = await configure(db.from(table).select('*')).order('id').range(start, start + 499);
      if (error) throw new Error(`${table}: ${error.message}`);
      result.push(...page); if (page.length < 500) return result;
    }
  }
  for (const selection of manifest.companies) {
    reviewed(selection.review); requireThat(uuid.test(selection.local_company_id), 'Invalid selected company ID');
    const companies = await rows('companies', q => q.eq('id', selection.local_company_id));
    requireThat(companies.length === 1, `Missing selected company ${selection.local_company_id}`);
    data.companies.push({ company: companies[0], review: selection.review,
      signals: await rows('signals', q => q.eq('company_id', selection.local_company_id)),
      sites: await rows('workday_sites', q => q.eq('company_id', selection.local_company_id)) });
  }
  const captureIds = new Set(data.companies.flatMap(e => [...e.signals, ...e.sites].map(s => s.capture_id).filter(Boolean)));
  for (const id of captureIds) {
    data.captures.push(...await rows('raw_captures', q => q.eq('id', id)));
    data.extractions.push(...await rows('extractions', q => q.eq('capture_id', id)));
  }
  const sourceIds = new Set([...data.captures.map(c => c.source_id), ...data.companies.flatMap(e => e.sites.map(s => s.discovered_from).filter(Boolean))]);
  for (const id of sourceIds) data.sources.push(...await rows('sources', q => q.eq('id', id)));
  return sanitizePackage(data);
}
