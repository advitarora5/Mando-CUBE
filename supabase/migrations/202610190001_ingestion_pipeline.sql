-- Ingestion pipeline, part 2. Additive only: no table, column or row is dropped or rewritten.
-- Two CHECK constraints are replaced by wider ones (new source types, dead-letter status); every existing value stays valid.

-- New source kinds: the SEC company list feeds the Workday resolver; treg sources are budget-gated; csv_import is the Import button.
alter table public.sources drop constraint sources_type_check;
alter table public.sources add constraint sources_type_check check (type in (
  'workday_career_site', 'workday_site_resolver', 'partner_client_list', 'greenhouse', 'lever',
  'sec_company_list', 'treg_reddit', 'treg_tech_lookup', 'csv_import'));

insert into public.sources (id, type, name, config, frequency, max_requests_per_run, min_delay_ms, enabled) values
  ('sec-company-list', 'sec_company_list', 'SEC EDGAR company list (names for the Workday resolver)', '{"url": "https://www.sec.gov/files/company_tickers.json"}', 'weekly', 2, 1000, true),
  ('treg-reddit-workday', 'treg_reddit', 'r/workday posts through treg (insight feed, not a company list)', '{"subreddit": "workday", "endpoint": "tikhub.x.reddit-app-fetch-subreddit-feed", "max_cost_usd": 0.002}', 'weekly', 2, 1000, false),
  ('treg-workday-users', 'treg_tech_lookup', 'Companies using Workday through treg (PredictLeads, $0.04 per record)', '{"technology": "workday", "endpoint": "predictleads.technologies.users", "limit": 10}', 'weekly', 1, 1000, false),
  ('csv-import', 'csv_import', 'Import button CSV rows', '{}', 'manual', 1, 0, true)
on conflict (id) do nothing;

-- Model-spend cap stays; treg spend is tracked separately per run.
alter table public.pipeline_runs add column if not exists treg_spend_usd numeric not null default 0 check (treg_spend_usd >= 0);

-- Collector context for reading a capture later (which site a job came from). Not evidence; the body stays exactly as received.
alter table public.raw_captures add column if not exists meta jsonb not null default '{}';

-- Workday career sites found by the resolver. One row per tenant site; the collector reads enabled rows.
create table public.workday_sites (
  id uuid primary key default gen_random_uuid(),
  tenant text not null check (tenant ~ '^[a-z0-9][a-z0-9-]*$'),
  pod text not null check (pod ~ '^wd[0-9]+$'),
  site text not null check (length(site) > 0),
  company_name text not null,
  normalized_name text not null,
  -- full_name: tenant equals the whole normalized name; first_word: a weaker guess that needs review.
  match_kind text not null check (match_kind in ('full_name', 'first_word', 'careers_link', 'manual')),
  company_id uuid references public.companies(id) on delete set null,
  review_item_id uuid references public.review_queue(id) on delete set null,
  discovered_from text references public.sources(id),
  capture_id uuid references public.raw_captures(id),
  enabled boolean not null default true,
  last_checked_at timestamptz,
  last_status text,
  created_at timestamptz not null default now(),
  unique (tenant, pod, site)
);
create index workday_sites_company_idx on public.workday_sites(company_id);

-- Names the resolver already probed, so a weekly run does not repeat misses.
create table public.workday_resolver_attempts (
  normalized_name text primary key,
  company_name text not null,
  found boolean not null,
  probes integer not null default 0,
  tried_at timestamptz not null default now()
);

-- Extraction: retry once, then dead-letter. prompt_version ties every model reading to a versioned prompt file.
alter table public.extractions drop constraint extractions_status_check;
alter table public.extractions add constraint extractions_status_check check (status in ('done', 'failed', 'dead_letter'));
alter table public.extractions add column if not exists attempts integer not null default 1 check (attempts >= 1);
alter table public.extractions add column if not exists prompt_version text not null default '';

-- Fixed-schema fields read from the source next to each signal. Null means the source did not say.
alter table public.signals add column if not exists company_name text;
alter table public.signals add column if not exists products text[];
alter table public.signals add column if not exists project_type text check (project_type in ('implementation', 'release_testing', 'integration', 'support'));
alter table public.signals add column if not exists role_seniority text;
alter table public.signals add column if not exists timing_words text[];
alter table public.signals add column if not exists method text check (method in ('structured', 'llm'));

-- Every paid call, keyed so the same contact and step is never paid for twice.
create table public.paid_calls (
  idempotency_key text primary key,
  provider text not null,
  endpoint text not null,
  subject text not null,
  step text not null,
  run_id uuid references public.pipeline_runs(id),
  cost_usd numeric not null default 0 check (cost_usd >= 0),
  outcome text not null,
  response jsonb,
  created_at timestamptz not null default now()
);

-- Contact lookup state per company. Lookups never block a run: no budget means pending.
create table public.enrichment_requests (
  company_id uuid primary key references public.companies(id) on delete cascade,
  status text not null check (status in ('pending', 'skipped_budget', 'searching', 'done', 'no_contacts_found')),
  reason text not null,
  updated_at timestamptz not null default now()
);
create trigger enrichment_requests_updated before update on public.enrichment_requests for each row execute function public.touch_updated_at();

-- Creates a pipeline company, its origin row, and attaches its waiting signals and Workday sites in one transaction,
-- so a failure part-way never leaves a half-written company.
create function public.pipeline_create_company(p_name text, p_domain text, p_employee_count integer, p_source text, p_run_id uuid,
  p_signal_ids uuid[] default '{}', p_normalized_name text default null)
returns uuid language plpgsql as $$
declare new_id uuid;
begin
  insert into public.companies (name, domain, employee_count, source)
    values (p_name, nullif(p_domain, ''), p_employee_count, p_source)
    returning id into new_id;
  insert into public.company_origins (company_id, origin, run_id) values (new_id, 'pipeline', p_run_id);
  update public.signals set company_id = new_id where id = any(p_signal_ids) and company_id is null;
  if p_normalized_name is not null then
    update public.workday_sites set company_id = new_id where normalized_name = p_normalized_name and company_id is null;
  end if;
  return new_id;
end;
$$;

-- Captures still waiting for a finished extraction (done or dead-lettered). This is the work queue.
create view public.pending_captures with (security_invoker = true) as
select c.* from public.raw_captures c
where not exists (select 1 from public.extractions e where e.capture_id = c.id and e.status in ('done', 'dead_letter'));

-- Review decisions. Each one moves the item's waiting signals and Workday sites to the resolved company atomically.
create function public.review_resolve(p_item uuid, p_company uuid, p_status text, p_note text)
returns void language plpgsql as $$
begin
  update public.review_queue set status = p_status, resolved_company_id = p_company, decision_note = p_note, decided_at = now()
    where id = p_item and status = 'pending';
  if not found then raise exception 'review item % is not pending', p_item; end if;
  update public.signals set company_id = p_company where review_item_id = p_item and company_id is null;
  update public.workday_sites set company_id = p_company where review_item_id = p_item and company_id is null;
end;
$$;

-- approve: create the company as a pipeline company, then resolve.
create function public.review_approve(p_item uuid, p_domain text, p_note text, p_run_id uuid)
returns uuid language plpgsql as $$
declare item public.review_queue; new_id uuid;
begin
  select * into item from public.review_queue where id = p_item and status = 'pending' for update;
  if not found then raise exception 'review item % is not pending', p_item; end if;
  new_id := public.pipeline_create_company(item.candidate_name, coalesce(nullif(p_domain, ''), item.candidate_domain), item.employee_count, 'review_queue', p_run_id, '{}', null);
  perform public.review_resolve(p_item, new_id, 'approved', p_note);
  return new_id;
end;
$$;

-- Health panel: last run, new pipeline companies this week, review queue size.
create view public.pipeline_health with (security_invoker = true) as
select
  (select max(started_at) from public.pipeline_runs) as last_run_at,
  (select status from public.pipeline_runs order by started_at desc limit 1) as last_run_status,
  (select count(*) from public.company_origins where created_at >= now() - interval '7 days') as new_companies_7d,
  (select count(*) from public.review_queue where status = 'pending') as review_queue_pending,
  (select count(*) from public.extractions where status = 'dead_letter') as dead_letters,
  (select coalesce(sum(treg_spend_usd), 0) + coalesce(sum(llm_spend_usd), 0) from public.pipeline_runs where started_at >= now() - interval '7 days') as spend_usd_7d;

-- A source alerts when its last three finished runs all failed, were blocked or found nothing.
create view public.source_alerts with (security_invoker = true) as
with recent as (
  select source_id, status, coalesce((counts->>'items')::int, 0) as items,
    row_number() over (partition by source_id order by started_at desc) as n
  from public.pipeline_runs where source_id is not null and finished_at is not null
)
select source_id,
  count(*) filter (where status in ('failed', 'blocked')) as failed_runs,
  count(*) filter (where items = 0) as empty_runs
from recent where n <= 3
group by source_id
having count(*) = 3 and count(*) filter (where status in ('failed', 'blocked') or items = 0) = 3;

create index signals_capture_idx on public.signals(capture_id);
create index review_queue_status_idx on public.review_queue(status, created_at desc);

alter table public.workday_sites enable row level security;
alter table public.workday_resolver_attempts enable row level security;
alter table public.paid_calls enable row level security;
alter table public.enrichment_requests enable row level security;

-- Functions run as the caller (RLS applies); only the server key should call them.
revoke execute on function public.pipeline_create_company(text, text, integer, text, uuid, uuid[], text) from public, anon, authenticated;
revoke execute on function public.review_resolve(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.review_approve(uuid, text, text, uuid) from public, anon, authenticated;
