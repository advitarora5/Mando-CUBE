# Employee-count collection: teammate setup

Verified November 10, 2026. These instructions configure a disposable local
checkout; shared migration and activation remain separate release decisions.

## Dependencies

Use the feature's PR revision, **Node 24** (the CI runtime), and `npm ci` from the
repository root. This installs the lockfile versions of `pdf-parse`, PDF.js/native
optional dependencies, Supabase client, Zod and the Supabase CLI. Keep npm's default
optional dependencies enabled. No separate PDF utility, Python, browser, LLM,
Hunter account or Treg installation is required for direct public research.
Node 24 executes the pipeline's TypeScript modules directly.

The PDF reader uses a worker: 10 seconds, 384 MB, at most 300 pages and 1.5 million
text characters; document downloads are capped at 12 MiB. Scanned/image-only PDFs
are not OCR'd. Dependency installation does not itself enable research.

## Sources and defaults

Sources run only when the normal score stage runs for an in-scope company.
Precedence is top to bottom; nothing below enables a schedule.

| Source | Default | Required setup |
| --- | --- | --- |
| Reviewed domain-matched JSON | Available, but no file loaded unless configured | `PIPELINE_EMPLOYEE_EVIDENCE_FILE`, valid JSON and reviewed scope/date/source. No new cache migration. |
| SEC workforce facts reused from Budget's companyfacts response | Available without web flag | `PIPELINE_CONTACT`, existing saved `sec-company-list` capture, unambiguous exact entity/CIK match and SEC access. No new cache migration or Treg. |
| Still-current SEC evidence retained from latest assessment on lookup failure | Available without web flag | Existing valid SEC provenance; not an arbitrary company-row count. |
| Saved company-bound Workday descriptions | **Off** | Literal `PIPELINE_EMPLOYEE_WEB_RESEARCH=1`, enabled exact-company site binding, recent saved job captures (seen within 30 days). Uses existing pipeline tables, not the new website cache. |
| Official-site HTML/PDF/structured-data research, including workforce tables | **Off** | Same web flag, verified company domain, public-source access, PDF dependencies and cache migration/permissions below. |

`PIPELINE_SEC_FILE` helps collect the SEC list; setting it alone does not create
the saved capture or waive the contact requirement for companyfacts. SEC adds no
separate headcount request, but the existing financial lookup can make a public SEC
GET. Workday reuse reads saved captures; it does not buy a job lookup.

## Database prerequisite

Apply the repository's earlier migrations first. The optional website fallback
then requires `supabase/migrations/202611080001_employee_research.sql`, which creates:

- RLS-protected `public.company_employee_research`, referencing `public.companies`;
- `claim_employee_research(uuid,text,text)` for leases;
- `finish_employee_research(uuid,uuid,text,jsonb,text)` for result/retry completion.

The pipeline key must act as `service_role`. Anonymous/publishable and ordinary
`authenticated` keys cannot access this cache or run its RPCs. The migration also
needs the normal Supabase roles; it is not a complete standalone application schema.

For a **disposable local Supabase project**, with Docker Desktop running/unpaused:

```sh
npm ci
npx supabase start -x studio,realtime,storage-api,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor
npx supabase migration up --local
```

A fresh local start applies migration history; `migration up --local` applies
pending files to an existing disposable local instance. The installed CLI's help
confirms `--local`. Do not substitute `--linked`, a remote `--db-url` or `db push`
for this disposable verification. PostgREST must expose the new table/RPCs; a stale
schema cache needs a reload through the approved database release process.

Put the local API URL (normally `http://127.0.0.1:54321`) and that instance's secret/
service-role key into an **ignored local env file** as `PIPELINE_SUPABASE_URL` and
`PIPELINE_SUPABASE_KEY`. Obtain them from local CLI status; do not reuse a shared
key. Leave `PIPELINE_ALLOW_REMOTE` unset. Normal pipeline commands use these
`PIPELINE_` names; audit/preview tools also accept `SUPABASE_URL` and
`SUPABASE_SECRET_KEY`. Do not interchange them implicitly or commit the file.

## Explicit activation

The variables are now listed in `.env.example`. Configure the ignored local file
only after dependencies and the local database are ready:

```dotenv
PIPELINE_EMPLOYEE_WEB_RESEARCH=1
PIPELINE_EMPLOYEE_WEB_MAX_COMPANIES=5
TREG_BUDGET_USD=0
TREG_DISABLE_CLI=1
```

Only the literal `1` activates the web flag; `true`, `0` and unset do not. The new
website-attempt cap defaults to 5 and is clamped to 1–20 per context. The crawler
still has six-document, 18-request and 45-second per-company limits. Keep the paid
budget explicitly zero: its code default is $0.50 if unset.

`TREG_DISABLE_CLI=1` disables implicit CLI fallback, but a configured `TREG_TOKEN`
still takes precedence. Use `--no-treg` for guaranteed provider-free operation.
Optional Treg search discovers URLs with a zero-cost guard; it does not enable
Hunter headcount enrichment. Direct website/PDF research needs neither Treg nor LLM.

Example **disposable-only** execution after configuring the local env file:

```sh
node --env-file=/path/to/ignored-local.env scripts/pipeline.mjs run --plan score --no-treg --no-llm --max-spend 0
```

That pipeline run writes local run/cache records and can append local scores.
Existing scoring-scope/contact rules apply; do not change scope just to force a
result. `--dry-run` uses an empty in-memory store, so it does not preview existing
Supabase companies. Use the guide's GET-only audit or reviewed-evidence preview
for read-only existing-company work. No setup command enables a production schedule.

Actions workflows `discovery-execute`, `ingestion-daily`, `ingestion-weekly` and
`ingestion-rescore` already forward repository variables
`PIPELINE_EMPLOYEE_WEB_RESEARCH` and `PIPELINE_EMPLOYEE_WEB_MAX_COMPANIES`.
Unset variables leave research off. A laptop env file does not configure Actions or
a deployed runtime. Approved database migration, released code and runtime variables
are separate rollout steps. No shared variable, secret or runtime was changed here.

## Missing setup and verification

Website-cache failures now name the table, both RPCs, `service_role` permissions,
migration file and setup guide, and disable the website fallback once per context.
Raw database errors/credentials are not logged. No auto-migration occurs. Reviewed,
SEC and saved Workday evidence remain separate. This is a runtime diagnostic, not
a schema preflight: a missing finish RPC can be discovered after a public fetch.

Missing PDF packages now explicitly say to run `npm ci` with Node 24; malformed
PDFs retain their separate extraction failure. Reinstall dependencies in the
actual pipeline checkout, not a different worktree.

Offline checks: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`
(run build and typecheck sequentially because build regenerates `.next/types`).
For the existing REST integration suite, supply **only disposable local**
`PIPELINE_SUPABASE_URL`/`PIPELINE_SUPABASE_KEY`, then `npm run test:integration`.
These tests write and remove fixture records. CI runs them on throwaway Supabase.

The focused PostgreSQL test creates/drops a unique database in an explicitly named,
dedicated container; it uses Docker's current context on macOS and Linux:

```sh
EMPLOYEE_TEST_POSTGRES_CONTAINER=mando-headcount-test-setup node --test tests/integration/employee-research-postgres.test.mjs
```

It proves missing-table/RPC failures before migration, then lease concurrency,
retry windows, stale tokens, identity invalidation and permissions after migration.
Use a dedicated local PostgreSQL container named `mando-headcount-test` or
`mando-headcount-test-*`; do not point it at a shared database/container.
See [setup verification](SETUP_VERIFICATION_20261110.md) for this run's evidence.
