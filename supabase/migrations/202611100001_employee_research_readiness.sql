-- Read-only startup probe. Never claim a lease or write a sentinel row to test access.
create function public.employee_research_ready()
returns boolean language plpgsql stable security invoker set search_path = public as $$
declare
  cache_oid oid := to_regclass('public.company_employee_research');
  claim_oid oid := to_regprocedure('public.claim_employee_research(uuid,text,text)');
  finish_oid oid := to_regprocedure('public.finish_employee_research(uuid,uuid,text,jsonb,text)');
  bypass boolean;
begin
  if cache_oid is null or claim_oid is null or finish_oid is null then return false; end if;
  if (select count(*) from pg_attribute where attrelid = cache_oid and not attisdropped
    and attname = any(array['company_id','company_domain','company_name','status','evidence',
      'checked_at','next_check_at','lease_token','lease_until','reason'])) <> 10 then return false; end if;
  select rolbypassrls or rolsuper into bypass from pg_roles where rolname = current_user;
  -- The supported cache contract uses the service role, not user-specific RLS policies.
  if (select relrowsecurity from pg_class where oid = cache_oid)
    and not coalesce(bypass, false)
    and (select relowner <> (select oid from pg_roles where rolname = current_user)
      or relforcerowsecurity from pg_class where oid = cache_oid) then return false; end if;
  return has_table_privilege(current_user, cache_oid, 'SELECT')
    and has_table_privilege(current_user, cache_oid, 'INSERT')
    and has_table_privilege(current_user, cache_oid, 'UPDATE')
    and has_function_privilege(current_user, claim_oid, 'EXECUTE')
    and has_function_privilege(current_user, finish_oid, 'EXECUTE');
end;
$$;
revoke execute on function public.employee_research_ready() from public, anon, authenticated;
grant execute on function public.employee_research_ready() to service_role;
