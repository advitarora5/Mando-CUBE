begin;

do $$
declare
  research_company_id uuid;
  research_run_id uuid;
  claimed public.contact_research_jobs;
  stored public.contacts;
begin
  if exists (select 1 from public.companies company left join public.contact_research_jobs job on job.company_id = company.id where job.company_id is null) then
    raise exception 'Existing company backfill is incomplete';
  end if;
  update public.contact_research_jobs set status = 'succeeded' where status = 'pending';
  insert into public.companies(name, domain) values ('Synthetic Research Test', 'synthetic-research.example') returning id into research_company_id;
  if not exists (select 1 from public.contact_research_jobs job where job.company_id = research_company_id and status = 'pending') then
    raise exception 'Company admission did not enqueue research';
  end if;
  insert into public.pipeline_runs(job, trigger) values ('contact_research', 'manual') returning id into research_run_id;
  select * into claimed from public.claim_contact_research(research_run_id);
  if claimed.company_id is distinct from research_company_id or claimed.status <> 'running' then
    raise exception 'Claim did not atomically mark the pending job running';
  end if;
  if exists (select 1 from public.claim_contact_research(research_run_id)) then
    raise exception 'Running job was claimed twice';
  end if;
  if not public.save_researched_contact(research_company_id, '{"name":"Alex Synthetic","title":"Workday Director","email":"alex@synthetic-research.example","email_verified":true,"email_status":"valid","contact_sources":{"research":{"source":"synthetic"}}}') then
    raise exception 'Contact insertion failed';
  end if;
  select * into stored from public.contacts contact where contact.company_id = research_company_id and name = 'Alex Synthetic';
  if not stored.email_verified or stored.enriched_at is null or stored.contact_sources->'research'->>'source' <> 'synthetic' then
    raise exception 'Verification or provenance not stored';
  end if;
  if public.save_researched_contact(research_company_id, '{"name":" ALEX  SYNTHETIC ","email":"changed@synthetic-research.example","email_verified":false}') then
    raise exception 'Normalized name duplicate was inserted';
  end if;
  if public.save_researched_contact(research_company_id, '{"name":"Different Name","email":"alex@synthetic-research.example","email_verified":false}') then
    raise exception 'Duplicate email was inserted';
  end if;
  perform public.save_researched_contact(research_company_id, '{"name":"Morgan Synthetic","email":"morgan@synthetic-research.example","email_verified":true}');
  if exists (select 1 from public.contacts contact where contact.company_id = research_company_id and name = 'Morgan Synthetic' and email_verified) then
    raise exception 'Missing valid verdict incorrectly marked verified';
  end if;
  if has_function_privilege('anon', 'public.claim_contact_research(uuid)', 'execute')
    or has_function_privilege('authenticated', 'public.save_researched_contact(uuid,jsonb)', 'execute') then
    raise exception 'Public roles can invoke privileged worker RPCs';
  end if;
  if not has_function_privilege('service_role', 'public.save_researched_contact(uuid,jsonb)', 'execute') then
    raise exception 'Service role cannot save contacts';
  end if;
end;
$$;

rollback;
