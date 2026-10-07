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

## GitHub Actions automation

`.github/workflows/weekly-snapshot.yml` runs the existing saver with `--apply` every Monday at **15:17 UTC**, which is **09:17 CST** or **10:17 CDT** in America/Chicago. Both are safely within Monday. The off-hour minute avoids the busiest start-of-hour scheduling window. GitHub schedules can be delayed or dropped; this is not an exact-time guarantee. The saver determines the current Chicago week when it starts, not from the nominal scheduled date.

The workflow also supports **workflow_dispatch** (Actions → Weekly snapshot → Run workflow). Both triggers use Node 24 (supports the saver's direct TypeScript imports), `npm ci` with the existing `package-lock.json`, read-only `contents` permission, and a 15-minute job timeout. Credentials are passed only to the save step; no `.env.local` file is used or printed.

### Repository setup

1. After review, commit/push and merge the workflow, documentation, saver, and lockfile onto the repository's **default branch**. Scheduling uses the default branch; pushing only to `avan-data-import` will not activate it. The manual trigger also requires the workflow to exist on the default branch. This workflow explicitly skips jobs dispatched against other branches.
2. In **Settings → Actions → General**, enable Actions and allow `actions/checkout@v4` and `actions/setup-node@v4` under the repository/organization action policy. No write token permissions are needed.
3. In **Settings → Secrets and variables → Actions → Secrets → New repository secret**, create `SUPABASE_URL` and `SUPABASE_SECRET_KEY` for the intended database. Enter their values directly in GitHub; never commit them or paste them into workflow logs. These are repository secrets, not environment secrets.
4. The tied-rank migration must already be applied. It was reported applied, with 26 snapshots saved for 2026-10-05 and a repeat run confirmed to skip that week. No migration step is included in this workflow.
5. Once database writes are authorized, open **Actions → Weekly snapshot → Run workflow**, select the **default branch**, and run it. This is a real save, not a preview. Confirm the log's Monday week date and either `Saved N snapshots` or the existing-week skip message. If run during the already-saved 2026-10-05 week, expect preservation of the 26 existing snapshots.
6. Review the next scheduled run and independently verify the week's snapshot count and shared ranks using authorized read-only access. Monitor failed or missing weekly runs through Actions.

Scheduled workflow behavior: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
Manual trigger requirements: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch
Concurrency behavior: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency

### Preservation, retries, and concurrency

The saver is unchanged: any existing row for the current week causes the entire week to be skipped. New weeks still use one plain bulk INSERT, with no upsert or ignored duplicates. A database rejection rejects the batch; a timeout or lost response can leave commit status unknown. Check the current week's saved state before retrying. A rerun in the same week preserves an already committed batch; a rerun after Monday rollover targets a new week, not the missed week.

A fixed concurrency group serializes this workflow's scheduled and manual runs across branches, and `cancel-in-progress: false` keeps a running saver from being interrupted by a newer trigger. GitHub retains at most one pending run in the group; a newer pending run can replace an older pending run. This does not lock local CLI runs, other workflows unless they share the same group, or another repository. Avoid running those savers simultaneously. Source-table reads still are not one consistent database transaction, and an unusually large batch must fit API limits.

Local checks: `npm test`, `npm run lint`, `npm run typecheck`, and `git diff --check`. Synthetic tests do not connect to Supabase. Local checks cannot verify repository secrets, Actions policy, GitHub scheduling, or a hosted runner's real save; those require the setup and authorized verification above.
