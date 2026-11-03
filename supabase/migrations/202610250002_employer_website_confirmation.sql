-- Extend the audit wording to cover both reciprocal career links and employer links in
-- stored Workday postings. Existing review decisions and company records are not rewritten.
-- Bound the new evidence lookup to its recent job captures and indexed signal refresh times.
create index raw_captures_workday_website_idx on public.raw_captures ((meta->>'normalized_name'), fetched_at desc)
  where source_id = 'workday-career-sites' and http_status = 200 and meta->>'kind' = 'workday_job';
create index signals_capture_seen_idx on public.signals (capture_id, last_seen_at desc);

create or replace function public.pipeline_admit_review(p_item uuid, p_domain text, p_source text, p_existing_company uuid, p_run_id uuid)
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
    'Automatically admitted after independent company identity and Workday-source website corroboration; evidence in website_resolutions.');
  return company;
end;
$$;
revoke all on function public.pipeline_admit_review(uuid, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.pipeline_admit_review(uuid, text, text, uuid, uuid) to service_role;
