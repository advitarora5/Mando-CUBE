import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dataPath, validateResearch } from './research-data.mjs';

// No credentials, schema changes, generated scores, or historical-role contacts.
export function researchSql(data, { apply = false } = {}) {
  validateResearch(data);
  const checked = new Set(data.contact_evidence.filter(e => e.role_status === 'company_listed_role_checked').map(e => e.contact_id));
  const contacts = data.contacts.filter(c => checked.has(c.id));
  const payload = JSON.stringify({ companies: data.companies, contacts });
  if (payload.includes('$research_payload$')) throw new Error('Unsafe SQL delimiter');
  return `-- Nevin research import: insert missing companies and current-role contacts only.
-- Preview performs the same checks/inserts, then rolls back. Apply commits atomically.
begin;
lock table public.companies, public.contacts in share row exclusive mode;
create temporary table research_payload on commit drop as select $research_payload$${payload}$research_payload$::jsonb as data;
create temporary table research_companies on commit drop as
select * from jsonb_to_recordset((select data->'companies' from research_payload))
as x(id uuid,name text,domain text,industry text,headquarters text,employee_count integer,workday_signal_date date,source text);
create temporary table research_contacts on commit drop as
select * from jsonb_to_recordset((select data->'contacts' from research_payload))
as x(id uuid,company_id uuid,name text,title text,linkedin_url text,source text,mutual_connection text);
create temporary table research_matches on commit drop as
select r.id research_id, c.id existing_id from research_companies r join public.companies c
on lower(regexp_replace(trim(c.name),'\\s+',' ','g')) = lower(regexp_replace(trim(r.name),'\\s+',' ','g'))
or c.source = r.source;
do $$ begin
 if exists(select research_id from research_matches group by research_id having count(*)>1)
 or exists(select existing_id from research_matches group by existing_id having count(*)>1)
 then raise exception 'Ambiguous company match; review before importing'; end if;
 if exists(select 1 from research_companies r join public.companies c on c.id=r.id
 where not exists(select 1 from research_matches m where m.research_id=r.id and m.existing_id=c.id))
 then raise exception 'Company ID collision'; end if;
end $$;
create temporary table research_map on commit drop as
select r.id research_id,coalesce(m.existing_id,r.id) company_id from research_companies r
left join research_matches m on m.research_id=r.id;
create temporary table research_before on commit drop as select
(select count(*) from public.companies) companies,(select count(*) from public.contacts) contacts,
(select count(*) from public.scores) scores,(select count(*) from public.company_insights) insights,
(select count(*) from public.weekly_snapshots) snapshots;
insert into public.companies(id,name,domain,industry,headquarters,employee_count,workday_signal_date,source)
select r.* from research_companies r where not exists(select 1 from research_matches m where m.research_id=r.id);
do $$ begin
 if exists(select 1 from research_contacts r join research_map m on m.research_id=r.company_id
 join public.contacts c on lower(rtrim(c.linkedin_url,'/'))=lower(rtrim(r.linkedin_url,'/'))
 where c.company_id<>m.company_id)
 then raise exception 'Contact profile belongs to another company; review required'; end if;
 if exists(select 1 from research_contacts r join public.contacts c on c.id=r.id
 where lower(rtrim(coalesce(c.linkedin_url,''),'/'))<>lower(rtrim(r.linkedin_url,'/')))
 then raise exception 'Contact ID collision'; end if;
 if exists(select 1 from research_contacts r join research_map m on m.research_id=r.company_id
 join public.contacts c on c.company_id=m.company_id and lower(trim(c.name))=lower(trim(r.name))
 where lower(rtrim(coalesce(c.linkedin_url,''),'/'))<>lower(rtrim(r.linkedin_url,'/')))
 then raise exception 'Existing same-name contact has another profile; review required'; end if;
end $$;
insert into public.contacts(id,company_id,name,title,linkedin_url,source,mutual_connection)
select r.id,m.company_id,r.name,r.title,r.linkedin_url,r.source,r.mutual_connection
from research_contacts r join research_map m on m.research_id=r.company_id
where not exists(select 1 from public.contacts c where lower(rtrim(c.linkedin_url,'/'))=lower(rtrim(r.linkedin_url,'/')));
select '${apply ? 'APPLY' : 'PREVIEW — ROLLED BACK'}' mode,
(select count(*) from public.companies)-b.companies companies_added,
(select count(*) from public.contacts)-b.contacts contacts_added,
(select count(*) from research_matches) companies_preserved,
(select count(*) from public.companies) companies_total,
(select count(*) from public.contacts) contacts_total,
(select count(*) from public.scores)=b.scores scores_count_preserved,
(select count(*) from public.company_insights)=b.insights insights_count_preserved,
(select count(*) from public.weekly_snapshots)=b.snapshots snapshots_count_preserved
from research_before b;
${apply ? 'commit' : 'rollback'};
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const destination = process.argv[2];
  if (!destination) throw new Error('Usage: node scripts/research-supabase-sql.mjs OUTPUT.sql [--apply]');
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  await writeFile(destination, researchSql(data, { apply: process.argv.includes('--apply') }), 'utf8');
  console.log(`Wrote ${process.argv.includes('--apply') ? 'atomic import' : 'rollback preview'} SQL to ${destination}`);
}
