# Weekly snapshot commands

Preview (reads Supabase; no writes):

```sh
node --env-file=.env.local scripts/save-weekly-snapshot.mjs
```

The original `scripts/preview-weekly-snapshot.mjs` remains preview-only and rejects flags.

Save, only when database writes are authorized and the approved tied-rank migration has been applied:

```sh
node --env-file=.env.local scripts/save-weekly-snapshot.mjs --apply
```

The week starts Monday in America/Chicago. The script uses the latest nonfuture assessment for each company and the existing evidence gates and competition ranking (1, 1, 3). Manual insight overrides take precedence. Companies without assessments are omitted.

If any snapshots already exist for the week, saving skips the entire week, including missing companies. It never updates or backfills history. New snapshots are sent as one bulk INSERT, never chunked or upserted: PostgreSQL rejects the entire statement if any row fails. A network failure can leave the client unsure whether the statement committed; preview before retrying.

The approved migration removes only `weekly_snapshots_week_start_rank_key`; uniqueness on `(week_start, company_id)` remains. No additional database structure changes are included. Run only one saver at a time: guaranteed serialization of concurrent runs would require a separate database transaction function/lock design, particularly if their company sets differ. Reading source tables is also not a transactionally frozen view across tables.

Local synthetic verification: `npm test`. Tests use an in-memory database double; they verify a single batch call and modeled rejection, not a live PostgreSQL transaction. No scheduling, dashboard history UI, or evidence mapping is added.
