-- Merges a duplicate company into the company being kept, in one transaction.
-- Run through scripts/merge-companies.mjs (npm run companies:merge): a preview does every step, then rolls back.
--
-- The kept company keeps its name and its own values; only its empty fields are filled from the duplicate.
-- Everything that points at the duplicate moves to the kept company: contacts, scores, snapshots, drafts,
-- signals, Workday sites, review items, and any table added later with a foreign key to companies.
-- One-per-company rows (insights, pipeline origin, enrichment status) keep the kept company's row with its
-- gaps filled, or move the duplicate's row when the kept company has none.
-- Weekly snapshots for the same week on both companies stop the merge: history is never dropped silently.
create function public.merge_companies(p_keep uuid, p_drop uuid, p_apply boolean default false)
returns jsonb language plpgsql as $$
declare
  keep_row public.companies;
  drop_row public.companies;
  moved jsonb := '{}';
  ref record;
  cols text;
  clash text;
  n bigint;
  kept bigint;
  snapshots jsonb;
  stages text[] := array['queued', 'contacted', 'replied', 'demo_booked'];
begin
  if p_keep is null or p_drop is null or p_keep = p_drop then
    raise exception 'Choose two different companies to merge.';
  end if;
  -- Lock in id order so two merges at once cannot deadlock.
  perform 1 from public.companies where id in (p_keep, p_drop) order by id for update;
  select * into keep_row from public.companies where id = p_keep;
  if not found then raise exception 'Company to keep (%) does not exist.', p_keep; end if;
  select * into drop_row from public.companies where id = p_drop;
  if not found then raise exception 'Company to merge (%) does not exist.', p_drop; end if;

  select string_agg(a.week_start::text, ', ' order by a.week_start) into clash
    from public.weekly_snapshots a join public.weekly_snapshots b on b.week_start = a.week_start
    where a.company_id = p_keep and b.company_id = p_drop;
  if clash is not null then
    raise exception 'Both companies have a weekly snapshot for %. Decide which snapshot to keep for each week first.', clash;
  end if;

  -- Company fields: fill the kept company's empty fields. The duplicate's website is cleared first because
  -- websites are unique. Lead status keeps whichever company got further in outreach.
  update public.companies set domain = null where id = p_drop;
  select string_agg(format('%1$I = coalesce(c.%1$I, ($1).%1$I)', column_name), ', ') into cols
    from information_schema.columns
    where table_schema = 'public' and table_name = 'companies' and is_nullable = 'YES' and is_generated = 'NEVER';
  if cols is not null then
    execute format('update public.companies c set %s where c.id = $2', cols) using drop_row, p_keep;
  end if;
  update public.companies set lead_status = drop_row.lead_status
    where id = p_keep and array_position(stages, drop_row.lead_status) > array_position(stages, keep_row.lead_status);

  -- Scores and weekly snapshots move together: a snapshot points at (score id, company id), so the duplicate's
  -- snapshots are set aside, its scores move, and the snapshots come back under the kept company unchanged.
  select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('company_id', p_keep)), '[]') into snapshots
    from public.weekly_snapshots s where s.company_id = p_drop;
  delete from public.weekly_snapshots where company_id = p_drop;
  update public.scores set company_id = p_keep where company_id = p_drop;
  get diagnostics n = row_count;
  moved := moved || jsonb_build_object('scores', n);
  insert into public.weekly_snapshots select * from jsonb_populate_recordset(null::public.weekly_snapshots, snapshots);
  moved := moved || jsonb_build_object('weekly_snapshots', jsonb_array_length(snapshots));

  -- Every other reference to companies, found from the schema so tables added later are covered too.
  for ref in
    select c.conrelid::regclass as tbl, a.attname as col,
      exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indisunique and i.indnkeyatts = 1 and i.indkey[0] = a.attnum) as one_per_company
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.companies'::regclass and cardinality(c.conkey) = 1
      and c.conrelid not in ('public.scores'::regclass, 'public.weekly_snapshots'::regclass)
    order by c.conrelid::regclass::text, a.attname
  loop
    execute format('select count(*) from %s where %I = $1', ref.tbl, ref.col) into n using p_drop;
    if n = 0 then continue; end if;
    if ref.one_per_company then
      execute format('select count(*) from %s where %I = $1', ref.tbl, ref.col) into kept using p_keep;
      if kept = 0 then
        execute format('update %s set %I = $1 where %I = $2', ref.tbl, ref.col, ref.col) using p_keep, p_drop;
      else
        select string_agg(format('%1$I = coalesce(k.%1$I, d.%1$I)', attname), ', ') into cols
          from pg_attribute
          where attrelid = ref.tbl and attnum > 0 and not attisdropped and not attnotnull and attgenerated = '' and attname <> ref.col;
        if cols is not null then
          execute format('update %1$s k set %2$s from %1$s d where k.%3$I = $1 and d.%3$I = $2', ref.tbl, cols, ref.col) using p_keep, p_drop;
        end if;
        execute format('delete from %s where %I = $1', ref.tbl, ref.col) using p_drop;
      end if;
    else
      execute format('update %s set %I = $1 where %I = $2', ref.tbl, ref.col, ref.col) using p_keep, p_drop;
    end if;
    moved := moved || jsonb_build_object(ref.tbl::text || '.' || ref.col, n);
  end loop;

  -- Nothing may still point at the duplicate, or deleting it would cascade or fail.
  for ref in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.companies'::regclass and cardinality(c.conkey) = 1
  loop
    execute format('select count(*) from %s where %I = $1', ref.tbl, ref.col) into n using p_drop;
    if n > 0 then raise exception '% rows in %.% still point at the duplicate; merge stopped.', n, ref.tbl, ref.col; end if;
  end loop;
  delete from public.companies where id = p_drop;

  if not p_apply then
    -- A preview undoes everything by failing on purpose; the report travels in the message.
    raise exception 'MERGE PREVIEW %', jsonb_build_object('kept', keep_row.name, 'merged', drop_row.name, 'moved', moved);
  end if;
  return jsonb_build_object('kept', keep_row.name, 'merged', drop_row.name, 'moved', moved);
end;
$$;

revoke execute on function public.merge_companies(uuid, uuid, boolean) from public, anon, authenticated;
