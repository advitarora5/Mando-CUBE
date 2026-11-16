-- Exact confirmed-host admission, plus a coalescing scoring queue. Discovery assignments stay unchanged.
create function public.pipeline_domain_key(value text) returns text
language plpgsql immutable as $$
declare host text;
begin
  host := regexp_replace(lower(btrim(coalesce(value, ''))), '^[a-z]+://', '');
  host := regexp_replace(host, '[/?#].*$', '');
  host := regexp_replace(host, '^.*@', '');
  host := regexp_replace(host, ':[0-9]+$', '');
  host := regexp_replace(regexp_replace(host, '^www[0-9]?\.', ''), '\.$', '');
  if host !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then return null; end if;
  return host;
end;
$$;

-- Conservative same-name guard for races between different websites. It never merges on name.
create function public.pipeline_name_key(value text) returns text language sql immutable as $$
  with words as (
    select btrim(regexp_replace(regexp_replace(replace(replace(lower(normalize(coalesce(value, ''), NFKD)), '&', ' and '), '''', ''), U&'[\0300-\036f]', '', 'g'), '[^a-z0-9]+', ' ', 'g')) as name
  ), kept as (
    select string_agg(word, ' ' order by position) as name from words,
      unnest(string_to_array(name, ' ')) with ordinality as tokens(word, position)
    where word <> all(array['inc','incorporated','corp','corporation','co','company','companies','ltd','limited','llc','llp','lp','plc','holdings','holding','group','sa','ag','nv','se','bv','gmbh','spa','the','de','class','a','b','com'])
  ) select coalesce(nullif(kept.name, ''), words.name) from words cross join kept;
$$;
create index companies_pipeline_domain_idx on public.companies(public.pipeline_domain_key(domain));
create index companies_pipeline_name_idx on public.companies(public.pipeline_name_key(name));

-- Also protect direct inserts/imports. Historical duplicates are not rewritten by this migration.
create function public.guard_pipeline_company_domain() returns trigger language plpgsql as $$
declare key text;
begin
  key := public.pipeline_domain_key(new.domain);
  if key is null then return new; end if;
  if tg_op = 'UPDATE' and key is not distinct from public.pipeline_domain_key(old.domain) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('mando:company-admission', 0));
  if exists (select 1 from public.companies c where c.id <> new.id and public.pipeline_domain_key(c.domain) = key) then
    raise exception using errcode = '23505', message = 'Company website already exists; match the canonical company before importing';
  end if;
  return new;
end;
$$;
create trigger companies_domain_guard before insert or update of domain on public.companies
  for each row execute function public.guard_pipeline_company_domain();

create function public.pipeline_assign_signals(p_ids uuid[],p_company uuid,p_review uuid) returns void language plpgsql as $$
begin
  if (p_company is null) = (p_review is null) then raise exception 'Choose exactly one evidence target'; end if;
  perform 1 from public.signals where id=any(p_ids) order by id for update;
  if p_company is not null and exists(select 1 from public.signals where id=any(p_ids) and company_id is not null and company_id<>p_company) then
    raise exception 'Company identity requires review: evidence already belongs to another company';
  end if;
  if p_company is not null then update public.signals set company_id=p_company where id=any(p_ids) and company_id is null;
  else update public.signals set review_item_id=p_review where id=any(p_ids) and company_id is null; end if;
end;
$$;
revoke all on function public.pipeline_assign_signals(uuid[],uuid,uuid) from public,anon,authenticated;
grant execute on function public.pipeline_assign_signals(uuid[],uuid,uuid) to service_role;

create or replace function public.pipeline_create_company(p_name text, p_domain text, p_employee_count integer,
  p_source text, p_run_id uuid, p_signal_ids uuid[] default '{}', p_normalized_name text default null)
returns uuid language plpgsql as $$
declare company uuid; key text; matches integer;
begin
  key := public.pipeline_domain_key(p_domain);
  if nullif(btrim(coalesce(p_domain, '')), '') is not null and key is null then raise exception 'Invalid company website'; end if;
  if key is not null then
    -- Serialize only this short database admission, never discovery or external research.
    -- One lock also makes parent/subdomain ambiguity checks reliable across different hosts.
    perform pg_advisory_xact_lock(hashtextextended('mando:company-admission', 0));
    select count(*), (array_agg(id order by id))[1] into matches, company
      from public.companies where public.pipeline_domain_key(domain) = key;
    if matches > 1 then raise exception 'Company identity requires review: multiple existing website matches'; end if;
    if company is null and exists (
      select 1 from public.companies c where key like '%.' || public.pipeline_domain_key(c.domain)
        or public.pipeline_domain_key(c.domain) like '%.' || key
    ) then raise exception 'Company identity requires review: related parent or subdomain'; end if;
    if company is null and exists (
      select 1 from public.companies where public.pipeline_name_key(name) = public.pipeline_name_key(p_name)
    ) then raise exception 'Company identity requires review: same name with a different website'; end if;
  end if;
  if company is null then
    insert into public.companies(name, domain, employee_count, source)
      values(p_name, key, p_employee_count, p_source) returning id into company;
    insert into public.company_origins(company_id, origin, run_id) values(company, 'pipeline', p_run_id);
  end if;
  -- Never overwrite an existing company's fields/origin or move evidence already assigned elsewhere.
  if exists (select 1 from public.signals where id = any(p_signal_ids) and company_id is not null and company_id <> company) then
    raise exception 'Company identity requires review: evidence already belongs to another company';
  end if;
  update public.signals set company_id = company where id = any(p_signal_ids) and company_id is null;
  if p_normalized_name is not null then
    update public.workday_sites set company_id = company where normalized_name = p_normalized_name and company_id is null;
  end if;
  return company;
end;
$$;

-- Section review retries remain final for rejected/human-only reviews. Concurrent callers of the
-- same already-admitted review receive the existing ID, without resolving unrelated evidence.
create or replace function public.pipeline_admit_section_review(p_item uuid, p_domain text, p_source text,
  p_existing_company uuid, p_run_id uuid, p_version text, p_section integer, p_signal_ids uuid[])
returns uuid language plpgsql as $$
declare item public.review_queue; company uuid;
begin
  select * into item from public.review_queue where id = p_item for update;
  if not found or item.reason = 'similar_name' or item.status = 'rejected' then raise exception 'Review is not eligible for section admission'; end if;
  if not exists (select 1 from public.pipeline_section_issuers where version=p_version and section=p_section and normalized_name=item.normalized_name) then
    raise exception 'Review has no eligible section evidence';
  end if;
  if public.pipeline_domain_key(p_domain) is null or p_source !~ '^https://' then raise exception 'Confirmed website and HTTPS evidence required'; end if;
  if item.status in ('approved','merged') then
    select id into company from public.companies where id=item.resolved_company_id and public.pipeline_domain_key(domain)=public.pipeline_domain_key(p_domain);
    if company is null then raise exception 'Review is not eligible for section admission'; end if;
    if exists (
      select 1 from unnest(p_signal_ids) requested(id) where not exists (
        select 1 from public.signals s join public.pipeline_section_captures c on c.capture_id=s.capture_id
        join public.pipeline_section_issuers a using(version,cik,section)
        where s.id=requested.id and s.review_item_id=p_item and (s.company_id is null or s.company_id=company)
          and c.version=p_version and c.section=p_section and a.normalized_name=item.normalized_name
      )
    ) then raise exception 'Review has no eligible section evidence'; end if;
    update public.signals set company_id=company where id=any(p_signal_ids) and company_id is null;
    update public.workday_sites s set company_id=company where s.company_id is null and s.normalized_name=item.normalized_name
      and exists(select 1 from public.pipeline_section_captures c where c.capture_id=s.capture_id and c.version=p_version and c.section=p_section);
    return company;
  end if;
  if coalesce(cardinality(p_signal_ids),0)=0 or exists (
    select 1 from unnest(p_signal_ids) requested(id) where not exists (
      select 1 from public.signals s join public.pipeline_section_captures c on c.capture_id=s.capture_id
      join public.pipeline_section_issuers a using(version,cik,section)
      where s.id=requested.id and s.review_item_id=p_item and s.company_id is null
        and c.version=p_version and c.section=p_section and a.normalized_name=item.normalized_name
    )
  ) then raise exception 'Review has no eligible section evidence'; end if;
  if p_existing_company is not null and not exists (
    select 1 from public.companies where id=p_existing_company and public.pipeline_domain_key(domain)=public.pipeline_domain_key(p_domain)
  ) then raise exception 'Existing company website no longer matches'; end if;
  company := public.pipeline_create_section_company(item.candidate_name,p_domain,item.employee_count,p_source,p_run_id,p_signal_ids,item.normalized_name,p_version,p_section);
  update public.review_queue set status=case when exists(select 1 from public.company_origins where company_id=company and run_id=p_run_id) then 'approved' else 'merged' end,
    resolved_company_id=company, candidate_domain=public.pipeline_domain_key(p_domain), decided_at=now(),
    decision_note='Automatically admitted after section-scoped company identity and Workday-source website corroboration.' where id=p_item;
  return company;
end;
$$;

create table public.company_scoring_jobs (
  company_id uuid primary key references public.companies(id) on delete cascade,
  requested_version bigint not null default 1,
  completed_version bigint not null default 0,
  status text not null default 'pending' check(status in ('pending','running','retry','done')),
  requested_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  attempts integer not null default 0,
  claimed_version bigint,
  claim_token uuid,
  locked_until timestamptz,
  last_error text,
  check(completed_version >= 0 and requested_version >= completed_version)
);
create index company_scoring_ready_idx on public.company_scoring_jobs(available_at,requested_at) where status <> 'done';
alter table public.company_scoring_jobs enable row level security;
revoke all on public.company_scoring_jobs from anon, authenticated;
grant all on public.company_scoring_jobs to service_role;

create function public.enqueue_company_scoring(p_company uuid) returns void language plpgsql as $$
begin
  insert into public.company_scoring_jobs(company_id) values(p_company)
  on conflict(company_id) do update set requested_version=company_scoring_jobs.requested_version+1,
    requested_at=now(), available_at=now(), last_error=null,
    status=case when company_scoring_jobs.status='running' and company_scoring_jobs.locked_until>clock_timestamp() then 'running' else 'pending' end;
end;
$$;
create function public.queue_company_score_change() returns trigger language plpgsql as $$
begin
  if tg_table_name='companies' then
    perform public.enqueue_company_scoring(new.id);
  else
    if tg_op <> 'INSERT' and old.company_id is not null and exists(select 1 from public.companies where id=old.company_id) then perform public.enqueue_company_scoring(old.company_id); end if;
    if tg_op <> 'DELETE' and new.company_id is not null and (tg_op='INSERT' or new.company_id is distinct from old.company_id) then perform public.enqueue_company_scoring(new.company_id); end if;
  end if;
  return null;
end;
$$;
create trigger companies_score_queue after insert or update of name,domain,employee_count,source on public.companies for each row execute function public.queue_company_score_change();
create trigger signals_score_queue after insert or update or delete on public.signals for each row execute function public.queue_company_score_change();
create trigger contacts_score_queue after insert or update or delete on public.contacts for each row execute function public.queue_company_score_change();

create function public.claim_company_scoring(p_company uuid default null) returns jsonb language plpgsql as $$
declare job public.company_scoring_jobs;
begin
  select * into job from public.company_scoring_jobs
  where requested_version>completed_version and (p_company is null or company_id=p_company)
    and ((status in ('pending','retry') and available_at<=clock_timestamp()) or (status='running' and locked_until<=clock_timestamp()))
  order by requested_at,company_id for update skip locked limit 1;
  if not found then return null; end if;
  update public.company_scoring_jobs set status='running', claimed_version=requested_version,
    claim_token=gen_random_uuid(), locked_until=clock_timestamp()+interval '5 minutes', attempts=attempts+1
    where company_id=job.company_id returning * into job;
  return jsonb_build_object('company_id',job.company_id,'version',job.claimed_version,'token',job.claim_token);
end;
$$;

-- Score insertion and acknowledgement commit together; newer evidence is never acknowledged by an older pass.
create function public.finish_company_scoring(p_company uuid,p_token uuid,p_version bigint,p_score jsonb,p_assessed_at timestamptz,p_change jsonb)
returns void language plpgsql as $$
declare job public.company_scoring_jobs; assessment public.scores;
begin
  select * into job from public.company_scoring_jobs where company_id=p_company for update;
  if not found or job.status<>'running' or job.claim_token is distinct from p_token or job.claimed_version<>p_version or job.locked_until<=clock_timestamp() then raise exception 'Scoring claim is no longer current'; end if;
  if p_score is not null then
    assessment := jsonb_populate_record(null::public.scores,p_score);
    if assessment.company_id is distinct from p_company then raise exception 'Score company differs from claimed company'; end if;
    insert into public.scores(company_id,assessed_at,rubric_version,tier,authority_score,authority_evidence,reachability_score,reachability_evidence,budget_score,budget_evidence,release_score,release_evidence,timing_score,timing_evidence,run_id,change_trigger,previous_score_id,change_summary)
    values(p_company,p_assessed_at,assessment.rubric_version,assessment.tier,assessment.authority_score,assessment.authority_evidence,assessment.reachability_score,assessment.reachability_evidence,assessment.budget_score,assessment.budget_evidence,assessment.release_score,assessment.release_evidence,assessment.timing_score,assessment.timing_evidence,
      (p_change->>'run_id')::uuid,p_change->>'change_trigger',(p_change->>'previous_score_id')::uuid,p_change->>'change_summary');
  end if;
  update public.company_scoring_jobs set completed_version=p_version,
    status=case when requested_version>p_version then 'pending' else 'done' end,
    available_at=now(),claim_token=null,claimed_version=null,locked_until=null,last_error=null,attempts=0 where company_id=p_company;
end;
$$;
create function public.fail_company_scoring(p_company uuid,p_token uuid,p_version bigint,p_reason text) returns void language plpgsql as $$
begin
  update public.company_scoring_jobs set status='retry', last_error=case when p_reason='financials_deferred' then p_reason else 'score_failed' end,
    available_at=clock_timestamp()+make_interval(secs=>least(300,15*power(2,least(attempts-1,4)))::integer),claim_token=null,claimed_version=null,locked_until=null
    where company_id=p_company and status='running' and claim_token=p_token and claimed_version=p_version;
end;
$$;
revoke all on function public.enqueue_company_scoring(uuid), public.claim_company_scoring(uuid), public.finish_company_scoring(uuid,uuid,bigint,jsonb,timestamptz,jsonb), public.fail_company_scoring(uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.enqueue_company_scoring(uuid), public.claim_company_scoring(uuid), public.finish_company_scoring(uuid,uuid,bigint,jsonb,timestamptz,jsonb), public.fail_company_scoring(uuid,uuid,bigint,text) to service_role;
