create table public.contact_research_jobs (
  company_id uuid primary key references public.companies(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'blocked')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  run_id uuid references public.pipeline_runs(id),
  summary jsonb not null default '{}',
  error text
);

create table public.contact_research_calls (
  company_id uuid not null references public.contact_research_jobs(company_id) on delete cascade,
  request_key text not null,
  endpoint text not null,
  status text not null check (status in ('running', 'succeeded', 'blocked')),
  response jsonb,
  provider text,
  call_id text,
  cost_micro bigint check (cost_micro >= 0),
  created_at timestamptz not null default now(),
  primary key (company_id, request_key)
);

create function public.enqueue_contact_research() returns trigger language plpgsql
set search_path = public as $$
begin
  insert into public.contact_research_jobs(company_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger companies_contact_research after insert on public.companies
for each row execute function public.enqueue_contact_research();

insert into public.contact_research_jobs(company_id) select id from public.companies on conflict do nothing;

create function public.claim_contact_research(p_run_id uuid) returns setof public.contact_research_jobs
language sql set search_path = public as $$
  update public.contact_research_jobs set status = 'running', started_at = now(),
    finished_at = null, run_id = p_run_id, error = null
  where company_id = (
    select company_id from public.contact_research_jobs where status = 'pending'
    order by created_at, company_id for update skip locked limit 1
  ) returning *;
$$;

create function public.save_researched_contact(p_company_id uuid, p_contact jsonb) returns boolean
language plpgsql set search_path = public as $$
begin
  perform id from public.companies where id = p_company_id for update;
  if not found then raise exception 'Company no longer exists'; end if;
  if exists (
    select 1 from public.contacts where company_id = p_company_id and (
      lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = lower(regexp_replace(trim(p_contact->>'name'), '\s+', ' ', 'g'))
      or (p_contact->>'linkedin_url' is not null and lower(rtrim(linkedin_url, '/')) = lower(rtrim(p_contact->>'linkedin_url', '/')))
      or (p_contact->>'email' is not null and lower(email) = lower(p_contact->>'email'))
    )
  ) then return false; end if;
  insert into public.contacts (
    company_id, name, title, linkedin_url, source, email, email_verified,
    email_status, linkedin_status, contact_sources, enriched_at
  ) values (
    p_company_id, p_contact->>'name', p_contact->>'title', p_contact->>'linkedin_url',
    p_contact->>'source', p_contact->>'email', coalesce((p_contact->>'email_verified')::boolean
      and p_contact->>'email_status' = 'valid' and p_contact->>'email' is not null, false),
    p_contact->>'email_status', p_contact->>'linkedin_status', p_contact->'contact_sources', now()
  );
  return true;
end;
$$;

create index contact_research_pending_idx on public.contact_research_jobs(created_at) where status = 'pending';
alter table public.contact_research_jobs enable row level security;
alter table public.contact_research_calls enable row level security;
revoke all on function public.enqueue_contact_research() from public, anon, authenticated;
revoke all on function public.claim_contact_research(uuid) from public, anon, authenticated;
revoke all on function public.save_researched_contact(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.claim_contact_research(uuid) to service_role;
grant execute on function public.save_researched_contact(uuid, jsonb) to service_role;
