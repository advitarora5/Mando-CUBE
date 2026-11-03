create or replace function public.review_resolve(p_item uuid, p_company uuid, p_status text, p_note text)
returns void language plpgsql as $$
begin
  if p_status is null or p_status not in ('approved', 'merged', 'rejected') then
    raise exception 'invalid review decision %', p_status;
  end if;
  if (p_status = 'rejected') <> (p_company is null) then
    raise exception 'rejected reviews require no company; approved and merged reviews require a company';
  end if;
  update public.review_queue set status = p_status, resolved_company_id = p_company, decision_note = p_note, decided_at = now()
    where id = p_item and status = 'pending';
  if not found then raise exception 'review item % is not pending', p_item; end if;
  if p_status = 'rejected' then
    update public.workday_sites set enabled = false where review_item_id = p_item and company_id is null;
  else
    update public.signals set company_id = p_company where review_item_id = p_item and company_id is null;
    update public.workday_sites set company_id = p_company where review_item_id = p_item and company_id is null;
  end if;
end;
$$;

revoke execute on function public.review_resolve(uuid, uuid, text, text) from public, anon, authenticated;
