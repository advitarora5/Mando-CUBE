-- Allow companies with equal scores to share a weekly rank.
-- One snapshot per company per week is still enforced.
begin;

alter table public.weekly_snapshots
  drop constraint weekly_snapshots_week_start_rank_key;

commit;