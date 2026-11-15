-- Shared, non-expiring locks: a crashed worker requires operator reconciliation.
create table public.contact_completion_locks (
  company_id uuid primary key references public.companies(id) on delete cascade,
  owner uuid not null,
  created_at timestamptz not null default now()
);
create table public.contact_completion_calls (
  company_id uuid not null references public.companies(id) on delete cascade,
  request_key text not null,
  endpoint text not null,
  status text not null check (status in ('running', 'succeeded', 'blocked')),
  response jsonb, provider text, call_id text,
  cost_micro bigint check (cost_micro >= 0),
  created_at timestamptz not null default now(),
  primary key (company_id, request_key)
);
alter table public.contact_completion_locks enable row level security;
alter table public.contact_completion_calls enable row level security;

create function public.lock_contact_completion(p_company_id uuid, p_owner uuid) returns boolean
language plpgsql set search_path = public as $$
begin
  insert into public.contact_completion_locks(company_id, owner) values (p_company_id, p_owner)
    on conflict do nothing;
  return found;
end;
$$;

-- Both insertion paths serialize on the company and use the same identity checks.
create function public.insert_contact_if_absent(p_company_id uuid, p_contact jsonb) returns uuid
language plpgsql set search_path = public as $$
declare contact_id uuid;
begin
  perform id from public.companies where id = p_company_id for update;
  if not found then raise exception 'Company no longer exists'; end if;
  select id into contact_id from public.contacts where company_id = p_company_id and (
    lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = lower(regexp_replace(trim(p_contact->>'name'), '\s+', ' ', 'g'))
    or (p_contact->>'linkedin_url' is not null and lower(rtrim(linkedin_url, '/')) = lower(rtrim(p_contact->>'linkedin_url', '/')))
    or (p_contact->>'email' is not null and lower(email) = lower(p_contact->>'email'))
  ) order by id limit 1;
  if contact_id is not null then return contact_id; end if;
  perform public.save_researched_contact(p_company_id, p_contact);
  select id into contact_id from public.contacts where company_id = p_company_id
    and lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = lower(regexp_replace(trim(p_contact->>'name'), '\s+', ' ', 'g'))
    order by id limit 1;
  return contact_id;
end;
$$;

-- Compare the read snapshot inside the update statement. A concurrent manual edit wins.
create function public.complete_contact_if_unchanged(p_id uuid, p_expected jsonb, p_patch jsonb) returns boolean
language plpgsql set search_path = public as $$
begin
  update public.contacts c set
    email = p_patch->>'email', email_status = p_patch->>'email_status',
    email_verified = coalesce((p_patch->>'email_verified')::boolean, false),
    contact_sources = p_patch->'contact_sources', enriched_at = now()
  where c.id = p_id and to_jsonb(c) @> p_expected;
  return found;
end;
$$;

-- Old pipeline records cannot be safely replayed as routed lookup responses. Retain a
-- conservative blocker shared by both workers, including calls whose update was lost.
insert into public.contact_completion_calls(company_id, request_key, endpoint, status, response)
select distinct on (c.company_id, lower(regexp_replace(trim(c.name), '\s+', ' ', 'g')))
  c.company_id, 'find:' || lower(regexp_replace(trim(c.name), '\s+', ' ', 'g')),
  'treg.people.email.find', 'blocked', jsonb_build_object('legacy_paid_call', p.idempotency_key)
from public.paid_calls p join public.contacts c on c.id::text = p.subject
where p.endpoint = 'treg.people.email.find'
on conflict do nothing;

revoke all on function public.lock_contact_completion(uuid, uuid) from public, anon, authenticated;
revoke all on function public.insert_contact_if_absent(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.complete_contact_if_unchanged(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.lock_contact_completion(uuid, uuid) to service_role;
grant execute on function public.insert_contact_if_absent(uuid, jsonb) to service_role;
grant execute on function public.complete_contact_if_unchanged(uuid, jsonb, jsonb) to service_role;

-- Unresolved legacy queued calls have opaque request hashes. Block the company until
-- an operator reconciles them; changing workers must not bypass these checkpoints.
insert into public.contact_completion_locks(company_id, owner)
select distinct company_id, '00000000-0000-0000-0000-000000000000'::uuid
from public.contact_research_calls where status <> 'succeeded'
on conflict do nothing;

-- Previous worker versions marked skipped existing contacts as succeeded. Make those
-- jobs eligible again without reopening blocked/running jobs or failed paid calls.
update public.contact_research_jobs j set status = 'pending', finished_at = null
where j.status = 'succeeded' and exists (
  select 1 from public.contacts c where c.company_id = j.company_id
    and (c.email is null or (not coalesce(c.email_verified, false) and coalesce(c.email_status, '') <> 'valid'))
    and coalesce(c.contact_sources->'role_review'->>'status', '') <> 'different_employer'
);
