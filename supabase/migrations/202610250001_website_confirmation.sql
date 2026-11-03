-- Pipeline-only evidence/cache. No existing dashboard rows are rewritten.
create table public.website_resolutions (
  normalized_name text primary key,
  company_name text not null,
  domain text,
  status text not null check (status in ('confirmed', 'unresolved', 'error')),
  reason text not null,
  input_signature text not null,
  checked_at timestamptz not null,
  next_check_at timestamptz not null,
  evidence jsonb not null,
  check (status <> 'confirmed' or domain is not null)
);
alter table public.website_resolutions enable row level security;
revoke all on public.website_resolutions from anon, authenticated;
grant all on public.website_resolutions to service_role;

-- Recovered automatic reviews keep a real evidence URL on the company row. Human-only similar-name
-- reviews and resolved/rejected items cannot be admitted. Row locking prevents duplicate concurrent admission.
create function public.pipeline_admit_review(p_item uuid, p_domain text, p_source text, p_existing_company uuid, p_run_id uuid)
returns uuid language plpgsql set search_path = public as $$
declare item public.review_queue; company uuid;
begin
  select * into item from public.review_queue where id = p_item for update;
  if not found or item.status <> 'pending' or item.reason = 'similar_name' then
    raise exception 'review item % is not eligible for automatic admission', p_item;
  end if;
  if nullif(p_domain, '') is null or p_source !~ '^https://' then raise exception 'confirmed domain and source URL required'; end if;
  if p_existing_company is not null then
    select id into company from public.companies where id = p_existing_company and domain = p_domain;
    if company is null then raise exception 'existing company domain no longer matches'; end if;
  else
    company := public.pipeline_create_company(item.candidate_name, p_domain, item.employee_count, p_source, p_run_id, '{}', null);
  end if;
  update public.review_queue set candidate_domain = p_domain where id = p_item;
  perform public.review_resolve(p_item, company, case when p_existing_company is null then 'approved' else 'merged' end,
    'Automatically admitted after independent website identity and reciprocal Workday career-link verification; evidence in website_resolutions.');
  return company;
end;
$$;
revoke all on function public.pipeline_admit_review(uuid, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.pipeline_admit_review(uuid, text, text, uuid, uuid) to service_role;
