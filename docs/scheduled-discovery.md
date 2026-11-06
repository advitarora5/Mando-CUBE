# Scheduled discovery skeleton

Initial skeleton notes. Current execution controls are in discovery-operation.md and
archive candidate caching is documented in discovery-archive-cache.md. Contact-worker
PR 37 has since merged into main; its execution remains separately gated.

Task 1 coordinates existing discovery and ingestion. The local feature branch now integrates
refined-pipeline with main, but does not activate schedules, apply migrations or enable contact research.
The dashboard remains on Vercel. GitHub Actions is the proposed background runner.

## Try the skeleton

Use Node 24 from the repository root:

```sh
node scripts/discovery.mjs --limit 10
node --test tests/discovery-plan.test.mjs
```

Preparation needs no dependencies, credentials, database or network access. It writes
var/discovery/summary.json with status prepared. This is a plan, not collected companies.
The manual Prepare discovery plan workflow does the same and saves the plan artifact.
It has no schedule and does not receive database or provider secrets.

## Local execution after integration

```sh
node --env-file=.env.pipeline.local scripts/discovery.mjs --execute-local --limit 2
```

This writes to a separately prepared local Supabase database and fetches public websites.
It does not create that database or run migrations. A remote database target is rejected.
All five source configurations must exist and be enabled before collection begins:
SEC list, Workday resolver, Common Crawl, Wayback, and Workday job collection.
The feature branch includes the Common Crawl and Wayback implementation. A database
must still have the appropriate schema and source configuration from the existing migrations.
Do not add empty source entries merely to pass preflight.

The sequence collects discovery sources, extracts their discovered sites, collects jobs,
then extracts postings, matches/admit-or-holds, and scores. The first extraction is necessary
so newly discovered sites can be collected during the same invocation.
Existing matching and storage own deduplication; no second admission implementation is added.
One collector failure does not suppress other collectors. The final status remains
needs_attention even if processing saved partial results. Partial processing continues so
successfully admitted companies still get scored. Failed or blocked processing stops
subsequent dependent stages. Treg and model clients are disabled and there is no
enrichment step. This mode therefore does not use the experimental AI identity checker.

The saved summary includes stage counts, statuses and durations. Existing pipeline logs
provide stage diagnostics. Do not publish raw logs or provider responses without review.
The summary file describes only the latest invocation; archive it externally for history.

## Integration and PR plan

1. Review this skeleton separately on anushka/scheduled-discovery, based on main.
2. Reconcile refined-pipeline with main in a separate reviewed change. Preserve main's
   alias matching, review rejection safety and ordinary-working-day evidence fixes.
3. Validate required schema and source configurations in an approved disposable database.
   No migration has been applied by this skeleton.
4. Run offline checks and database tests; run small consecutive discovery batches and
   verify new-candidate progression, duplicate prevention and rejected-site preservation.
5. Agree with tasks 2/3 owners on production identity validation and model hosting.
   Keep contact worker PR 37 separate and disabled until spending is approved.
6. Add the production execution workflow only after measuring runtime and yield.
   Reuse mando-cube-ingestion concurrency with existing daily/weekly workflows,
   set an execution timeout, validate source availability and publish safe failure summaries.
   That concurrency group protects participating GitHub workflows only; it does not lock
   local/manual clients. A database lease or single-writer operating rule is still needed.
7. Obtain explicit approval for the database target, migrations and schedule activation.

## Limits before scaling

This is not a production scheduler. Local execution has per-source item/request limits
from the existing collectors, but no new global deadline, distributed lock or admission cap.
The preparation workflow's five-minute timeout only bounds preparation. Source limits
are not a cap on total downstream pending work or newly admitted companies.

Do not enable recurring execution until those production bounds and durable failure
reporting are implemented. Measure candidates, unique admissions, holds, duplicates,
errors and runtime per source. Increase throughput using measured admission yield;
more frequent discovery alone does not guarantee thousands of correct companies.
