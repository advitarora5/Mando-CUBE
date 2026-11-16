-- Durable section discovery checkpoints and many-to-many raw-evidence membership.
-- No work claims, leases, scoring changes, or duplicate-identity policy changes.
create table public.pipeline_section_manifests (
  version text primary key,
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  unique (version, snapshot_sha256)
);
alter table public.pipeline_section_manifests enable row level security;
revoke all on public.pipeline_section_manifests from anon, authenticated;
grant select, insert on public.pipeline_section_manifests to service_role;

create table public.pipeline_section_issuers (
  version text not null,
  cik bigint not null check (cik > 0),
  section integer not null check (section between 1 and 10),
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  company_name text not null,
  normalized_name text not null,
  status text not null default 'pending' check (status in ('pending', 'found', 'miss', 'retry')),
  probes integer not null default 0 check (probes >= 0),
  attempted_at timestamptz,
  next_attempt_at timestamptz,
  primary key (version, cik),
  unique (version, cik, section),
  foreign key (version, snapshot_sha256) references public.pipeline_section_manifests(version, snapshot_sha256)
);
create index pipeline_section_progress_idx on public.pipeline_section_issuers(version, section, status);

create function public.preserve_section_assignment() returns trigger language plpgsql as $$
begin
  if row(new.version, new.cik, new.section, new.snapshot_sha256, new.company_name, new.normalized_name)
    is distinct from row(old.version, old.cik, old.section, old.snapshot_sha256, old.company_name, old.normalized_name) then
    raise exception 'Section assignments are immutable; coordinate a new manifest version';
  end if;
  return new;
end;
$$;
create trigger section_assignment_immutable before update on public.pipeline_section_issuers
  for each row execute function public.preserve_section_assignment();

create table public.pipeline_section_captures (
  version text not null,
  cik bigint not null,
  section integer not null,
  capture_id uuid not null references public.raw_captures(id),
  primary key (version, cik, capture_id),
  foreign key (version, cik, section) references public.pipeline_section_issuers(version, cik, section) on delete cascade
);
create index pipeline_section_captures_scope_idx on public.pipeline_section_captures(version, section, capture_id);
alter table public.pipeline_section_issuers enable row level security;
alter table public.pipeline_section_captures enable row level security;
revoke all on public.pipeline_section_issuers, public.pipeline_section_captures from anon, authenticated;
grant all on public.pipeline_section_issuers, public.pipeline_section_captures to service_role;

-- A successful model response is not a checkpoint until its signals and structured completion
-- have been saved. Legacy pending_captures closes on either method; section recovery must not.
create view public.pipeline_section_pending_captures with (security_invoker = true) as
select c.* from public.raw_captures c where not exists (
  select 1 from public.extractions e where e.capture_id = c.id and e.method = 'structured' and e.status in ('done', 'dead_letter')
);
revoke all on public.pipeline_section_pending_captures from anon, authenticated;
grant select on public.pipeline_section_pending_captures to service_role;

-- Existing admission links all same-name sites. Section admission instead limits every attachment
-- to evidence membership, while preserving the original transaction and admission requirements.
create function public.pipeline_create_section_company(p_name text, p_domain text, p_employee_count integer,
  p_source text, p_run_id uuid, p_signal_ids uuid[], p_normalized_name text, p_version text, p_section integer)
returns uuid language plpgsql as $$
declare company uuid;
begin
  if coalesce(cardinality(p_signal_ids), 0) = 0 or exists (
    select 1 from unnest(p_signal_ids) requested(id)
    where not exists (
      select 1 from public.signals s
      join public.pipeline_section_captures c on c.capture_id = s.capture_id
      join public.pipeline_section_issuers a using (version, cik, section)
      where s.id = requested.id and c.version = p_version and c.section = p_section
        and a.normalized_name = p_normalized_name
    )
  ) then raise exception 'Company admission requires signals from this section'; end if;
  company := public.pipeline_create_company(p_name, p_domain, p_employee_count, p_source, p_run_id, p_signal_ids, null);
  update public.workday_sites s set company_id = company
  where s.company_id is null and s.normalized_name = p_normalized_name and exists (
    select 1 from public.pipeline_section_captures c where c.capture_id = s.capture_id and c.version = p_version and c.section = p_section
  );
  return company;
end;
$$;

create function public.pipeline_admit_section_review(p_item uuid, p_domain text, p_source text,
  p_existing_company uuid, p_run_id uuid, p_version text, p_section integer, p_signal_ids uuid[])
returns uuid language plpgsql as $$
declare item public.review_queue; company uuid;
begin
  select * into item from public.review_queue where id = p_item for update;
  if not found or item.status <> 'pending' or item.reason = 'similar_name' or nullif(p_domain, '') is null then
    raise exception 'Review is not eligible for section admission';
  end if;
  if coalesce(cardinality(p_signal_ids), 0) = 0 or exists (
    select 1 from unnest(p_signal_ids) requested(id) where not exists (
      select 1 from public.signals s
      join public.pipeline_section_captures c on c.capture_id = s.capture_id
      join public.pipeline_section_issuers a using (version, cik, section)
      where s.id = requested.id and s.review_item_id = p_item and s.company_id is null
        and c.version = p_version and c.section = p_section and a.normalized_name = item.normalized_name
    )
  ) then raise exception 'Review has no eligible section evidence'; end if;
  company := p_existing_company;
  if company is null then
    company := public.pipeline_create_section_company(item.candidate_name, p_domain, item.employee_count, p_source,
      p_run_id, p_signal_ids, item.normalized_name, p_version, p_section);
  else
    update public.signals set company_id = company where id = any(p_signal_ids) and company_id is null;
  end if;
  update public.workday_sites s set company_id = company
  where s.company_id is null and s.normalized_name = item.normalized_name and exists (
    select 1 from public.pipeline_section_captures c where c.capture_id = s.capture_id and c.version = p_version and c.section = p_section
  );
  update public.review_queue set status = case when p_existing_company is null then 'approved' else 'merged' end,
    resolved_company_id = company, candidate_domain = p_domain, decided_at = now(),
    decision_note = 'Automatically admitted after section-scoped company identity and Workday-source website corroboration.'
    where id = p_item;
  return company;
end;
$$;
revoke all on function public.pipeline_create_section_company(text,text,integer,text,uuid,uuid[],text,text,integer) from public, anon, authenticated;
revoke all on function public.pipeline_admit_section_review(uuid,text,text,uuid,uuid,text,integer,uuid[]) from public, anon, authenticated;
grant execute on function public.pipeline_create_section_company(text,text,integer,text,uuid,uuid[],text,text,integer) to service_role;
grant execute on function public.pipeline_admit_section_review(uuid,text,text,uuid,uuid,text,integer,uuid[]) to service_role;
