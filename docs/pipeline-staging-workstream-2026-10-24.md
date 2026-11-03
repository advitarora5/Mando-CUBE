# Pipeline assessment and staging workstream

**Updated decision:** use local Supabase for testing, then production. A second hosted project is blocked by the organization's free-project quota. See [the active local testing workflow](local-pipeline-testing.md). The shared staging proposal below is retained as the original assessment, not the current deployment plan.

Assessed October 24, 2026. Goal: run SEC → Workday ingestion on a schedule against an isolated shared database, validate it, then promote the same code to production.

## Verified state

- Refreshed `origin` before comparing. `main` / `origin/main`: `33836c26`; `aadi-scraping-engine` / its remote: `f6e2be0d`.
- Both branches have identical tracked files. Main contains the scraping branch through merge PR #27; its merge commit is the only commit difference. There is no outstanding scraping-branch implementation to merge.
- `npm test`: 245 passed, zero failed or skipped. These are offline tests, including fixture-based collector and pipeline coverage.
- `npm run typecheck` fails in this checkout because `lucide-react` cannot be resolved. It is declared in `package.json`; restore the locked dependencies and rerun before accepting a release.
- Docker is installed, but its daemon socket is absent. Local database integration tests could not be verified here. No `.env.pipeline.local` or committed `supabase/seed.sql` is present.
- GitHub Actions execution history, configured secrets/environments, hosted database contents/migration state, and the deployed application SHA were not verified. Workflow definitions establish available behavior, not successful live operation.
- This assessment did not run live ingestion, change production data, or enable schedules.

## What the first source actually does

The SEC supplies public-company names, not Workday postings or their robots files.

```text
SEC company_tickers.json
  → normalize company names and guess Workday tenant/pod
  → GET https://{tenant}.{pod}.myworkdayjobs.com/robots.txt
  → read Sitemap entries; choose one primary external career site
  → store discovered workday_sites and known_customer evidence
  → POST /wday/cxs/{tenant}/{site}/jobs, searchText="Workday"
  → GET each selected posting's detail JSON
  → raw_captures → extraction → signals → company matching / review
  → scores for pipeline-created companies → optional contact enrichment
```

Implementation: `src/pipeline/collectors/sources.ts`, `collectors/workday.ts`, `extract.ts`, `stages.ts`, and `runner.ts`.

### Already implemented

| Area | Current behavior |
| --- | --- |
| Discovery | Weekly plan captures SEC names, probes guessed Workday hosts, extracts sites, matches companies, and scores. |
| Posting collection | Daily plan rotates enabled sites by oldest check; searches for Workday; captures up to eight job details per site by default. `--limit 20` means up to 20 sites for this collector. |
| Request controls | Robots checks, request caps, pacing, timeouts, retries, and source blocking are implemented. |
| Storage | Raw captures retain source content; fingerprints avoid duplicate captures; unchanged content refreshes associated signals. |
| Evidence | Structured extraction provides known-customer and hiring evidence; model extraction adds products, project type, and other contextual signals with grounding checks. |
| Matching | Confirmed domain matches attach to existing companies; similar names and missing websites go to review. New-company creation requires a confirmed website and trusted evidence. |
| Scoring protection | Default `scoring_scope=pipeline_only` preserves existing researched companies' scores, although ingestion can still write signals and operational records. This is not database isolation. |
| Operations | Run records, health views, dead letters, review commands, stale-run cleanup, and logged source alerts exist. |
| Scheduling | Daily, weekly, and rescore workflows exist but their cron blocks are commented out. Import is manual. Jobs are restricted to the repository default branch. |

The separate `weekly-snapshot.yml` has an enabled cron in source and uses the application's `SUPABASE_*` credentials. It saves score snapshots; it does not collect SEC/Workday data. Its target does not change when pipeline credentials change.

### Limits and gaps to carry into the workstream

1. **Failure propagation:** the runner catches stage failures and continues, but `scripts/pipeline.mjs` prints the report without setting a failing exit code for failed/blocked stages. Actions can appear successful while ingestion failed. Define required-stage success and emit an exit status plus a useful workflow summary; retain per-stage logs.
2. **Discovery progress:** `resolverNames` loads attempts only for `candidates.slice(0, max * 5)`, then filters the entire SEC list. Once discovery passes that window, already-tried later names can be selected repeatedly. Page through all candidate/attempt records or maintain a durable cursor; test progress across the window.
3. **Retry and refresh:** attempts have timestamps but current selection treats attempts as permanent. Add bounded retries for transient misses and periodic revalidation of successful sites. Robots-derived `known_customer` signals expire after 14 days, yet successful resolver names are normally skipped thereafter; define how that evidence stays fresh.
4. **Coverage:** tenant guessing misses abbreviations and unconventional tenant names. One primary career site and eight postings per site are deliberate sampling, not exhaustive company/job coverage. The existing runbook's roughly 25% discovery estimate came from a small historical probe, not a current coverage guarantee.
5. **Company admission:** a working collector need not produce new dashboard companies. With treg disabled, domain lookup returns no website, so new names generally wait in review and existing names can also require review. For the first milestone, assign a reviewer and merge/approve evidence-backed candidates; use a trusted domain mapping or separately validate automated lookup later.
6. **Model choice:** hosted workflows default to `PIPELINE_LLM=none`; GitHub-hosted runners do not have local Ollama. Structured-only extraction is a viable first milestone. With no model configured, captures are marked processed, so switching on a model later requires an explicit reprocessing path for old unchanged captures. Configured-but-unavailable models keep relevant captures queued instead.
7. **Capacity and freshness:** at 20 sites/day, site revisit time is approximately `ceil(enabled_sites / 20)` days before errors or request limits. Keep this comfortably under the 14-day signal lifetime. Set limits from measured throughput and queue age.
8. **Automation boundaries:** `pipeline:full` contains extra model-assisted website approval; the scheduled workflows invoke `pipeline.mjs`, not that helper. Do not assume the helper's approval behavior is scheduled or adopt it without validating its website checks.

## Database approach

Use three distinct environments:

| Environment | Purpose | Access and data |
| --- | --- | --- |
| Local Supabase | Individual development and integration tests | Docker; migrations plus repeatable seed; localhost credentials. |
| Shared staging | This week's scheduled pipeline and team review | Persistent Supabase branch or separate staging project; independent URL and server key; a preview dashboard points here too. |
| Production | Deployed application and approved ingestion | Production-only credentials; enable writes after code/schema deployment and staging acceptance. |

Supabase supports isolated branches with independent instances and API credentials. Ephemeral PR branches are suitable for individual feature validation; use a persistent branch for a scheduler that must survive merges and PR closure. A Git branch alone does not create a database or redirect application credentials.

New branches are data-less by default. GitHub-connected branches build schema from repository migrations. Supply a repeatable seed, or deliberately copy the required production records and related tables. Supabase's dashboard Include data option currently requires the Point-in-Time Recovery add-on; a controlled export/restore into staging is another option. Check migration parity before calling an environment a production copy. A migration/seed replica is sufficient to begin testing; a full production snapshot is not required.

Branch creation and scheduled jobs are separate concerns: GitHub cron runs on the default branch. The existing jobs additionally reject non-default refs. The simplest first deployment is reviewed main code → shared staging credentials. If a feature branch must run on a timer, add an explicit checkout/ref and environment policy in a default-branch scheduler; do not merely uncomment cron on the feature branch.

Use GitHub Environments such as `pipeline-staging` and `pipeline-production`, with separate scoped credentials and concurrency groups per target. Current workflows use repository secrets and do not declare an environment. Configure both the scheduler and dashboard preview to the staging database; Vercel preview credentials and GitHub Actions credentials are configured separately.

The existing remote guard accepts the project ref named by `PIPELINE_ALLOW_REMOTE`. It does not independently know which ref is production. Set the staging ref deliberately, keep production credentials out of staging jobs, and add an explicit production-ref rejection for nonproduction execution.

## Local setup path

After starting Docker:

```bash
npm ci
npx supabase start
npx supabase status
```

Create ignored `.env.pipeline.local` with local `PIPELINE_SUPABASE_URL=http://127.0.0.1:54321`, the local server key, `PIPELINE_LLM=none`, `TREG_BUDGET_USD=0`, and a real `PIPELINE_CONTACT` address. Leave `PIPELINE_ALLOW_REMOTE` empty. If needed, a local SEC JSON copy can be supplied through `PIPELINE_SEC_FILE` when no contact is configured.

```bash
node --env-file-if-exists=.env.pipeline.local scripts/seed-local-existing.mjs
npm test
npm run test:integration
npm run pipeline -- run --plan weekly --limit 5 --no-llm --no-treg
npm run pipeline -- run --plan daily --limit 5 --no-llm --no-treg
npm run pipeline -- health
npm run dev:local
```

The existing seed imports committed researched company records as non-pipeline companies; it is not a full copy of production contacts, scores, or operational history. `dev:local` redirects the dashboard to the local pipeline database. Review/approve or merge candidates separately before expecting every discovery to appear as a scored company.

The config references `supabase/seed.sql`, but that file is absent: add a deterministic seed or document the existing script as the explicit seed step. Validate migrations from an empty local instance, not just against a previously initialized developer database. `--dry-run` uses an in-memory database; it is not a read-only rehearsal against production and may still make source requests.

## Proposed workstream for the coming week

| Step | Work | Acceptance evidence |
| --- | --- | --- |
| 1. Establish isolation | Start local stack; restore dependencies; replay all migrations; seed representative existing companies. Provision shared staging and matching dashboard preview. | Passing typecheck/unit/integration checks; recorded staging project ref; dashboard and ingestion point to staging. |
| 2. Make runs trustworthy | Fix required-stage exit status, discovery progress, and retry/refresh behavior. Add targeted regression tests. Define review ownership and structured-only extraction scope. | Simulated blocked source makes Actions fail; successive discovery batches progress; repeat runs add no duplicates; stale evidence behavior is explicit. |
| 3. Prove live path manually | Run small weekly discovery then daily collection on staging. Review/merge a small sample and score it. Repeat the same batch. | SEC capture → robots capture/site → job detail → quoted signal → company/review → score is traceable; no unexplained duplicates; timestamps and source URLs verified. |
| 4. Schedule staging | Bind workflows to the staging environment; supply contact and staging keys; enable weekly discovery and daily collection. Keep paid sources/enrichment off initially. Capture reports and notify on failure/staleness. | At least two successive unattended daily runs, plus a successful discovery run; health/queue/freshness checks pass. |
| 5. Prepare promotion | Compare deployed code SHA with tested SHA; verify production migrations and backup; deploy compatible code; manual small production run; enable production schedule after acceptance. | Production target explicitly confirmed; monitoring works; rollback disables writes; staging and production remain separate. |

Proposed initial cadence: weekly discovery Mondays, daily postings every morning, daily scoring via the daily plan. Bootstrap discovery manually before the first daily run, and chain an initial daily collection after discovery if newly discovered sites must be collected immediately. The repository's commented weekly cron occurs after its daily cron on Mondays; clock spacing also does not guarantee dependency order.

Keep first-run limits at five sites; increase after measuring completeness, request failures, run duration, review backlog, and enabled-site revisit time. Standalone 1st/15th rescore is optional because daily ingestion already scores.

Production promotion moves reviewed code and migrations. Do not overwrite production with the staging database. Decide explicitly whether vetted staging results are imported through the normal matching path or recollected in production. To roll back ingestion, disable schedules; preserve captures/run records for diagnosis and reverse only identified bad writes.

## References

- Repository: `docs/ingestion-runbook.md`; `.github/workflows/ingestion-{daily,weekly,rescore,import,tests}.yml`; `supabase/migrations/`; `src/pipeline/`.
- Supabase branching: https://supabase.com/docs/guides/deployment/branching
- Supabase dashboard/data copying: https://supabase.com/docs/guides/deployment/branching/dashboard
- Supabase local development: https://supabase.com/docs/guides/local-development/cli-workflows
- GitHub schedule behavior: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
