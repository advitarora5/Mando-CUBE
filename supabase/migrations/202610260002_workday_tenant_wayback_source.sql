-- Second tenant-discovery source: robots.txt captures of Workday career-site hosts in the Wayback Machine CDX index. Additive only.
alter table public.sources drop constraint sources_type_check;
alter table public.sources add constraint sources_type_check check (type in (
  'workday_career_site', 'workday_site_resolver', 'partner_client_list', 'greenhouse', 'lever',
  'sec_company_list', 'treg_reddit', 'treg_tech_lookup', 'csv_import', 'workday_tenant_crawl', 'workday_tenant_wayback'));

insert into public.sources (id, type, name, config, frequency, max_requests_per_run, min_delay_ms, enabled) values
  ('workday-tenant-wayback', 'workday_tenant_wayback', 'Workday tenants from the Wayback Machine CDX index (free)', '{"limit": 2000}', 'weekly', 500, 1000, true)
on conflict (id) do nothing;
