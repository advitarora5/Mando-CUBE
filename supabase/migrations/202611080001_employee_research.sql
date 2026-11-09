create table public.company_employee_research (
  company_id uuid primary key references public.companies(id) on delete cascade,
  company_domain text not null,
  company_name text not null,
  status text not null check (status in ('running', 'found', 'needs_review', 'unavailable')),
  evidence jsonb,
  checked_at timestamptz,
  next_check_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  reason text not null default '',
  check (status <> 'found' or evidence is not null)
);
alter table public.company_employee_research enable row level security;
revoke all on public.company_employee_research from public, anon, authenticated;
grant select, insert, update, delete on public.company_employee_research to service_role;

create function public.claim_employee_research(p_company uuid, p_domain text, p_name text)
returns setof public.company_employee_research language sql set search_path = public as $$
  insert into public.company_employee_research as r
    (company_id, company_domain, company_name, status, lease_token, lease_until)
  values (p_company, p_domain, p_name, 'running', gen_random_uuid(), now() + interval '2 minutes')
  on conflict (company_id) do update set
    company_domain = excluded.company_domain, company_name = excluded.company_name,
    status = 'running', lease_token = excluded.lease_token, lease_until = excluded.lease_until,
    evidence = case when r.company_domain = p_domain and r.company_name = p_name then r.evidence else null end
  where (r.lease_until is null or r.lease_until <= now())
    and (r.next_check_at <= now() or r.company_domain <> p_domain or r.company_name <> p_name)
  returning *;
$$;

create function public.finish_employee_research(p_company uuid, p_token uuid, p_status text, p_evidence jsonb, p_reason text)
returns boolean language plpgsql set search_path = public as $$
begin
  if p_status not in ('found', 'needs_review', 'unavailable') then raise exception 'Invalid employee research status'; end if;
  update public.company_employee_research set status = p_status,
    evidence = case when p_status = 'unavailable' then evidence else p_evidence end,
    checked_at = now(), next_check_at = now() + case p_status
      when 'found' then interval '30 days' when 'needs_review' then interval '7 days' else interval '1 day' end,
    lease_token = null, lease_until = null, reason = p_reason
  where company_id = p_company and lease_token = p_token and lease_until > now();
  return found;
end;
$$;
revoke execute on function public.claim_employee_research(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.finish_employee_research(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.claim_employee_research(uuid, text, text) to service_role;
grant execute on function public.finish_employee_research(uuid, uuid, text, jsonb, text) to service_role;
