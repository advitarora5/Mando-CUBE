-- Why each score row exists. Written by the pipeline when it saves a score; older rows stay null.
-- The dashboard reads these to explain rank changes, and falls back to comparing rows when they are null.
alter table public.scores
  add column run_id uuid references public.pipeline_runs(id) on delete set null,
  add column change_trigger text check (change_trigger in ('pipeline_run', 'new_contacts', 'csv_import', 'periodic_refresh')),
  add column previous_score_id uuid references public.scores(id) on delete set null,
  add column change_summary text;
