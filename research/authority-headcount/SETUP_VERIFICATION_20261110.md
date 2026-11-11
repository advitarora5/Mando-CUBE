# Employee-count setup verification — November 10, 2026

Historical verification of PR #50's opt-in defaults. The follow-up changes normal
runs to default-on with an explicit opt-out; current setup is in [TEAMMATE_SETUP.md](TEAMMATE_SETUP.md).

The [teammate setup guide](TEAMMATE_SETUP.md) was checked against context creation,
score-stage precedence, SEC and saved Workday collectors, PDF worker, cache store,
migration and Actions environment wiring. `.env.example` now lists the headcount
variables without enabling them.

Verified defaults: reviewed JSON is opt-in by file; SEC reuse needs no web flag
but needs the existing list/contact prerequisites. Both saved Workday reuse and
website research require literal `PIPELINE_EMPLOYEE_WEB_RESEARCH=1`. Only website
research needs the new cache migration/RPCs. The five-company cap applies to new
website attempts per context, not all existing source reads. Normal score runs can
write local scores; read-only preview uses the separate audit/preview tools.

Runtime setup failures now identify the cache table/RPCs, migration and role
permissions, or the missing PDF dependency installation. Cache diagnostics appear
once per context and contain no raw exception/credential. They never auto-migrate.
The PostgreSQL test now respects Docker's selected context instead of forcing a
Linux socket path on macOS.

## Disposable verification

Created a dedicated container `mando-headcount-test-setup` from the cached
`public.ecr.aws/supabase/postgres:17.11.0.002` image, with networking disabled and
temporary storage. Used no shared connection string, environment or credentials.
The test created a unique database with normal fixture roles and a minimal parent
companies table, proved that cache table and both RPCs were absent, and applied
only `202611080001_employee_research.sql` in that database.

The test passed checks for concurrent claims, stale/expired completion tokens,
30-day/7-day/1-day retry dates, identity-change evidence invalidation, service-role
access and anon/authenticated denial. It dropped its database; the dedicated
container was removed afterward. Existing local Supabase containers were not
migrated, reset, stopped or modified. This focused test proves the migration's
own prerequisite/permission behavior, not the entire repository migration history.

Validation on Node 24.21.0:

- **663 offline tests pass**, including real PDF worker extraction, deliberately
  missing PDF dependencies in a temporary directory, configuration defaults and
  missing table/claim/finish diagnostics.
- Dedicated PostgreSQL integration test: **1 pass, no skip**.
- TypeScript, full ESLint, production build and diff whitespace checks pass.
- CLI help confirms `supabase migration up --local` on installed CLI 2.119.0.
- Prior PR CI also passed full disposable-Supabase/PostgREST integration; the local
  verification above does not replace that full-schema REST test.

Local private configuration was read by presence/value only: loopback pipeline
host, paid budget zero, web research disabled, CLI fallback disabled. No secret
was printed. No normal pipeline run, provider request, credit spend, shared
migration, shared score write, runtime-variable change or production activation
was performed. Shared-environment and live search-provider validation remain open.
