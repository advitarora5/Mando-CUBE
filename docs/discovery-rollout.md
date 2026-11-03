# Discovery rollout preparation

Prepared for task 1. This document does not enable execution, install secrets,
apply migrations, change another worker, or add a schedule.

## Where it runs and how companies reach the dashboard

The prepared worker runs in GitHub Actions using `discovery-execute.yml`.
Vercel continues serving the dashboard. The worker must write to the same Supabase
project that Vercel uses through `SUPABASE_URL`; dashboard repositories read that
database. Confirm the project identity privately, without copying credentials into
a PR, artifact or chat. A successful local test changes only the local dashboard data,
not the deployed Vercel dashboard. No new dashboard button or page is needed.

## Configuration to review, not enable yet

| Location | Name | Intended value or check |
| --- | --- | --- |
| GitHub variable | `DISCOVERY_EXECUTION_ENABLED` | Leave unset or `false` until explicit approval |
| GitHub variable | `DISCOVERY_SINGLE_WRITER_CONFIRMED` | Leave unset or `false` until writers are coordinated |
| GitHub variable | `DISCOVERY_APPROVED_PROJECT_REF` | Exact approved 20-character Supabase project reference |
| GitHub variable | `PIPELINE_ALLOW_REMOTE` | Exactly the same approved project reference |
| GitHub secret | `PIPELINE_SUPABASE_URL` | Exact `https://<approved-ref>.supabase.co`, matching Vercel's project |
| GitHub secret | `PIPELINE_SUPABASE_KEY` | Authorized server-side database key, entered privately by the owner |

The approved entry point checks flags and the exact target before starting its worker.
It fixes discovery to two items/sites per source, at most three admissions per pass,
20 requests per source and a five-minute worker deadline. It creates no Treg or model
client. Do not add paid credentials to this workflow to make held candidates pass.
No secret value is needed to review this configuration plan.

## Database and source readiness

The repository contains migrations through `202611020001_review_rejection_safety.sql`.
Before deployment, an authorized operator must compare the target's actual migration
history with the reviewed repository. In particular, score reasons use version
`202610270001` and company merge uses `202610270002`. Local test migration history
must not be copied into production. Record any missing migrations for separate review;
do not run `db push`, reset, or repair as part of scheduling setup.

The `sources` table must contain enabled entries for `sec-company-list`,
`workday-site-resolver`, `workday-tenant-crawl`, `workday-tenant-wayback` and
`workday-career-sites`. The worker rejects missing/disabled sources before collection.
Candidate caching uses the existing `raw_captures` table and requires no new migration.
Live archive health must be demonstrated; green fixture tests do not establish it.

## Coordinate existing writers

Discovery, daily ingestion, imports, weekly ingestion and rescoring use the shared
`mando-cube-ingestion` GitHub concurrency group. Check the reviewed workflow files
and active runs before asserting single-writer readiness.

`contact-research.yml` uses a separate `mando-cube-contact-research` group. Its hourly
trigger is already present in teammate code and its job is gated by
`CONTACT_RESEARCH_ENABLED`. It can make paid calls when enabled. The weekly snapshot
worker also has a separate concurrency group. Neither worker was changed by task 1.
Coordinate these and any local/manual writers before the first discovery batch;
do not claim that the discovery filesystem lock covers them. Confirm flags and
running jobs with their owners, and seek approval before changing their operation.

## First production batch, after explicit approval

1. Integrate reviewed tasks 2/3 and confirm their unattended execution contract.
   The current discovery worker does not invoke the experimental local AI path.
2. Require green offline and disposable-database CI for the final combined commit.
3. Run two bounded live local batches. Confirm new admissions have assessments,
   rejected reviews stay rejected, uncertain companies remain held, duplicate
   candidates are investigated, and archive candidates advance between runs.
4. Review the actual target, migration history, configuration and writer coordination.
   Request approval for the named target and one bounded production batch.
5. After approved deployment/configuration, manually dispatch **Discovery execution
   (approval gated)** on the default branch. Do not dispatch **Ingestion daily** as
   a substitute; it uses a different execution plan and provider configuration.
6. Inspect the Summary tab and safe JSON artifact. Compare the run's admissions and
   assessments with the same Supabase-backed Vercel dashboard. Review source evidence
   for the small new batch. A successful status with zero new companies is not growth.
7. Only after measured repeat runs, propose a cadence and request separate schedule
   activation approval. No recurring trigger has been added to this worker.

## Stopping and recovery

Disable future discovery execution by setting `DISCOVERY_EXECUTION_ENABLED=false`;
this prevents later jobs and does not cancel an already running worker. If an active
run must stop, cancel that run explicitly and inspect its stage checkpoints and
database changes. Completed/in-flight writes may remain; cancellation is not rollback.
Do not delete companies automatically or rerun migration scripts as recovery.
Review partial admissions and missing assessments before another batch.

## Error-log compatibility

Nevin's `nevin/company-error-log` commit `dfca2dd` and
`nevin/review-queue-error-audit` commit `de1b918` are ancestors of this feature branch.
The shared data-error log is the existing GitHub issue form/list described in
[company-data-error-log.md](company-data-error-log.md), not a new database table.
Task 1 retains operational diagnostics in `pipeline_runs` and safe run summaries;
it does not replace Nevin's issue process or automatically open/assign issues.

An archive outage is a source-health finding, not proof of a wrong company record.
For a verified record error, search the existing log first and record the source ID,
capture/company reference, run link, evidence and correction using that existing form.
Never copy raw provider bodies, credentials or private contact details into it.
The archive candidate cache remains metadata only and is not admission evidence.
