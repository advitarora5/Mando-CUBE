-- Initial schema. No app authentication yet: RLS denies public client access.
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  domain text unique,
  industry text,
  headquarters text,
  employee_count integer check (employee_count >= 0),
  workday_signal_date date,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  title text,
  linkedin_url text,
  source text,
  mutual_connection text,
  created_at timestamptz not null default now()
);

-- Category evidence is ONE string per category: "https://source | one-line reason".
-- Append assessments; weekly snapshots preserve the referenced score row.
-- Timing maximum is intentionally not locked until the 10/15 discrepancy is resolved.
create table public.scores (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  assessed_at timestamptz not null default now(),
  rubric_version text not null,
  authority_score numeric not null check (authority_score between 0 and 25),
  authority_evidence text not null default '',
  reachability_score numeric not null check (reachability_score between 0 and 25),
  reachability_evidence text not null default '',
  budget_score numeric not null check (budget_score between 0 and 20),
  budget_evidence text not null default '',
  release_score numeric not null check (release_score between 0 and 15),
  release_evidence text not null default '',
  timing_score numeric not null check (timing_score between 0 and 15),
  timing_evidence text not null default '',
  total numeric generated always as (authority_score + reachability_score + budget_score + release_score + timing_score) stored,
  tier text not null check (tier in ('Qualified', 'Maybe', 'Disqualified')),
  unique (id, company_id)
);

create table public.company_insights (
  company_id uuid primary key references public.companies(id) on delete cascade,
  persona_generated text,
  persona_override text,
  level_generated text,
  level_override text,
  why_now_generated text,
  why_now_override text,
  generated_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.weekly_snapshots (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  company_id uuid not null references public.companies(id),
  score_id uuid not null,
  rank integer not null check (rank > 0),
  persona text,
  level text,
  why_now text,
  created_at timestamptz not null default now(),
  foreign key (score_id, company_id) references public.scores(id, company_id),
  unique (week_start, company_id),
  unique (week_start, rank)
);

create index contacts_company_idx on public.contacts(company_id);
create index scores_company_date_idx on public.scores(company_id, assessed_at desc);
create index snapshots_company_week_idx on public.weekly_snapshots(company_id, week_start desc);

create function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger companies_updated before update on public.companies for each row execute function public.touch_updated_at();
create trigger insights_updated before update on public.company_insights for each row execute function public.touch_updated_at();

alter table public.companies enable row level security;
alter table public.contacts enable row level security;
alter table public.scores enable row level security;
alter table public.company_insights enable row level security;
alter table public.weekly_snapshots enable row level security;
