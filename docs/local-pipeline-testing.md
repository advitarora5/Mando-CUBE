# Local pipeline testing, then production

Decision, October 24, 2026: use local Supabase rather than another hosted project. Shared staging creation was blocked by the organization's free-project quota.

## Current setup

- Docker Desktop runs the local Supabase database, Auth, REST API, and API gateway.
- API: `http://127.0.0.1:54321`; Postgres: `127.0.0.1:54322`.
- The repository migrations were applied successfully to the local database.
- The ignored `.env.pipeline.local` holds local credentials, an independent session secret, no remote-write allowance, no LLM, and zero paid treg budget. The committed SEC JSON file is available for initial offline discovery input.
- `npm run dev:local` redirects only that dashboard process to local Supabase. Production `.env.local` was not edited.
- Production dashboard data was copied using GET requests and imported in one transaction into the empty local database: 154 companies, 234 contacts, 623 scores, 139 company insights, 271 weekly snapshots, one outreach settings record, and eight drafts.
- The copy preserves IDs and score/snapshot relationships. It was fetched sequentially across tables, not from a single database snapshot. It is a development copy, not a transaction-consistent production backup.
- All exported fields were compared with the restored rows after tests. Local migrations also add company lead-status/date columns absent from the production export; those retain their local schema defaults. Check production schema parity before deployment.
- Copy artifacts are private local files under ignored `var/`. Do not commit them. Production Auth users, credentials, webhooks, and operational ingestion queues were not copied.

## Starting and stopping

Start Docker Desktop, then from the repository:

```bash
npx supabase start -x studio,realtime,storage-api,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor
npm run dev:local
```

Open `http://127.0.0.1:3000` and use the existing dashboard password configured locally. This is the application dashboard; Supabase Studio is not enabled in this minimal setup.

Stop the dashboard with Ctrl+C. `npx supabase stop` stops local services while retaining their data for restart. Avoid `--no-backup` unless deliberately discarding local test data. Do not use a remote reset for this workflow.

## Validation sequence

1. Run `npm test`, `npm run typecheck`, and `npm run test:integration`. Integration tests generate fictional records in the local database; clean or rebuild the development copy before evaluating live collection counts.
   On this setup the integration assertions finish but open handles keep the process alive. Verification completed with `node --env-file=.env.pipeline.local --test --test-force-exit tests/integration/*.test.mjs`: six passed, none skipped. The unit suite passed 245 tests, and typecheck passed after restoring locked dependencies. Test company fixtures were removed from the local dashboard; diagnostic ingestion records remain.
2. Step 1 implementation is complete locally: required-stage exit status, resolver progress, evidence refresh, website confirmation and pending-review recovery. The website migration was applied only locally. Current validation: 287 offline tests, typecheck and lint passed; full-flow and website-admission database checks passed. Test fixtures were cleaned from the dashboard, and all seven copied dashboard tables were verified unchanged. See the website-confirmation section of `docs/ingestion-runbook.md` for the conservative admission rule and retry intervals.
3. Next: run a small live local discovery batch, followed by local posting collection. Treg is enabled for the free domain endpoint; paid budget remains zero:

```bash
npm run pipeline -- run --plan weekly --limit 5 --no-llm --max-spend 0
npm run pipeline -- run --plan daily --limit 5 --no-llm --max-spend 0
npm run pipeline -- health
```

4. Inspect the local dashboard. Existing-company matching, required fields, evidence links, review handling, and repeated-batch duplicate prevention must all be verified. These commands fetch live Workday URLs even when using the committed SEC list.
5. Exercise the schedule locally for a limited soak period after manual validation. The machine and Docker must remain running; sleeping/offline machines cannot provide dependable scheduling.
6. Promote reviewed code and migrations, validate a small production run, then enable production GitHub Actions schedules.

## Production transition

For a bounded local discovery/admission/scoring measurement, use the reusable runner:

```bash
npm run pipeline:benchmark -- --minutes 20 --limit 3 --max-new 25
```

It requires local Supabase and zero paid budget, disables contact enrichment/LLM, excludes existing
companies and old diagnostic queues, and uses the saved SEC snapshot plus live Workday/website calls.
Each discovery batch is capped at 60 probes. New postings are extracted before matching, then only
companies added during the benchmark are scored. The duration is a soft discovery window: the
current bounded batch finishes before final verification, so actual runtime can exceed the target.
Database run logs and private `var/benchmarks/<timestamp>/summary.json` retain results; no per-run
document is required. The summary includes actual elapsed time, admissions/hour, reviews, stage
errors, spending, quote checks, and preservation checks against the existing dashboard rows.

GitHub-hosted runners cannot reach the database on this laptop's `127.0.0.1`. The eventual production scheduler targets hosted production Supabase directly. CI's existing throwaway local database is for tests and does not retain discovered companies across runs.

The Supabase GitHub integration currently displays deployment to production enabled for `main`. Review migration deployment behavior before merging database changes; production migration deployment and ingestion credentials are separate controls.

Keep a production backup and verify the deployed application SHA, required database schema, target project ref, pipeline credentials, and alerting before enabling writes. The existing remote guard is an explicit project-ref allowance, not an independent detector of production.

Promote code and schema rather than restoring the entire local database into production. Local fixtures and test scores must stay local. Either recollect approved source data in production or import vetted records through a controlled matching path.
