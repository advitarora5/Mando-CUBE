# Employee-count collection: teammate setup

Use the updated code revision, **Node 24** and `npm ci` in that checkout. The
lockfile supplies `pdf-parse`, PDF.js/native optional dependencies, Supabase client
and CLI, and Zod. Keep npm's default optional dependencies. Direct HTML/PDF research
needs no browser, Python, LLM, Hunter account or Treg installation.

## Defaults and opt-out

Normal pipeline contexts now enable both saved Workday descriptions and bounded
official-site/annual-report research. Missing, empty and whitespace-only settings
use that enabled default. The same parser is used by the public audit/benchmark
entry points. These settings are listed in `.env.example`:

```dotenv
PIPELINE_EMPLOYEE_WEB_RESEARCH=1
PIPELINE_EMPLOYEE_WEB_MAX_COMPANIES=5
TREG_BUDGET_USD=0
TREG_DISABLE_CLI=1
```

Set `PIPELINE_EMPLOYEE_WEB_RESEARCH=0` to opt out explicitly. `false`, `off`, `no`,
`disable` and `disabled` are also recognized, case-insensitively. An opt-out stops
new Workday/website lookup; previously accepted, still-valid evidence can still be
used by normal scoring. Reviewed JSON (`PIPELINE_EMPLOYEE_EVIDENCE_FILE`) and SEC
reuse are independent of this switch. SEC reuse still needs `PIPELINE_CONTACT`, a
saved `sec-company-list` capture and the exact unambiguous entity/CIK match.
Workday reuse still needs exact employer/site binding and recent saved captures.

Limits are unchanged: 5 new website attempts per context (clamped 1–20), 6 documents,
18 HTTP requests and a 45-second source deadline per company. PDF limits remain
12 MiB, 300 pages, 1.5M text characters and a 10-second/384-MB worker. No OCR.
Evidence, matching, cache leases/retries, 548/30-day freshness, the +3 rule, cap and
duplicate-award protection are unchanged. Approximate counts are still held.

## One-time database prerequisite

Through the team's approved database release process, apply the repository's
migration history including:

- `202611080001_employee_research.sql`: cache table and claim/finish RPCs;
- `202611100001_employee_research_readiness.sql`: a read-only startup RPC.

The second migration does not activate research or rewrite data. **No migration
is applied automatically.** Teammates must also run the updated code: an old
checkout/runtime keeps its old defaults. Applying a migration alone is insufficient.

`PIPELINE_SUPABASE_URL`/`PIPELINE_SUPABASE_KEY` must target the intended environment
with service-role access. The cache requires SELECT/INSERT/UPDATE, lease-RPC EXECUTE
and suitable RLS access; the stable SECURITY INVOKER readiness RPC checks those
actual database privileges without writing or claiming a lease. Its execute grant
is restricted to `service_role`. PostgREST must expose the RPC after schema reload.
Missing migration, permissions, API access or a 5-second readiness timeout produces
one clear warning and skips website research for that context. It does not stop
saved Workday reads or unrelated stages. Missing PDF packages explain `npm ci`.

Failed/timed-out sources or persistence retain only already accepted evidence for
the same company while it is fresh. Observation evidence expires after 30 days;
effective/publication evidence after 548. Current contact eligibility is rescored;
a new valid below-threshold count or a conflict cannot inherit an old size bonus.
No fallback uses an unsourced company-row count or Hunter-only estimate.

## Disposable verification

For a disposable local Supabase checkout with Docker running/unpaused:

```sh
npm ci
npx supabase start -x studio,realtime,storage-api,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor
npx supabase migration up --local
```

Use that instance's local API URL and secret/service-role key in an ignored local
env file; leave `PIPELINE_ALLOW_REMOTE` unset. Do not use `--linked`, a shared
`--db-url`, or `db push` for disposable testing. Normal pipeline commands use the
`PIPELINE_` variables; audit/preview tools also support `SUPABASE_URL` and
`SUPABASE_SECRET_KEY`. Never commit keys or paste credential-bearing status output.

```sh
npm test
npm run build
npm run typecheck
npm run lint
npm run test:integration
```

The integration command must use **only the disposable local environment**; it
writes/removes fixtures. Build precedes typecheck because it regenerates Next types.
The focused PostgreSQL test additionally checks missing schema, revoked table/RPC
permissions and read-only transactions in a dedicated `mando-headcount-test-*`
container. CI verifies the full throwaway Supabase/PostgREST migration history.

Normal scoring runs can write local run/cache records and append local scores.
`--dry-run` uses an empty in-memory store, not existing Supabase companies. For
read-only data work, use the guide's audit or preview tools. Status counters distinguish
explicitly disabled, readiness-skipped, cached/not-due, limit/lease/domain-skipped,
source attempts and failed attempts; startup warnings are not fatal pipeline errors.

All normal entry points share the context default. Actions `discovery-execute`,
`ingestion-daily`, `ingestion-weekly` and `ingestion-rescore` pass the repository
variable with an enabled fallback; explicit string `0`/`false` remains respected.
Other entry points inherit the parser without special overrides. Laptop env files
do not configure Actions/deployed runtimes. No schedules, shared variables, secrets
or production settings are changed by this PR. Paid Treg enrichment remains gated;
headcount uses public reads and, if configured, discovery search with a zero-cost
request guard. `--no-treg` guarantees no provider calls; this feature requires none.
