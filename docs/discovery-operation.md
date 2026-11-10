# Discovery execution controls

See [rollout preparation](discovery-rollout.md) for the reviewed configuration,
dashboard connection, writer coordination, error-log compatibility and staged activation plan.

The feature branch now has a supervised local entry point and a manual-only,
approval-gated GitHub execution workflow. No schedule or execution flags have been enabled.

## Local command

With credentials for the isolated local database configured privately:

```sh
node --env-file=.env.pipeline.local scripts/discovery-execute-local.mjs
```

The local entry point collects and extracts evidence, then uses AI to admit up to three
queued candidates. It requests two items/sites per source and limits each source to
20 requests. The approved batch requests five per source with 60 requests each.
Providers may return fewer results.
Each collection stage also has a cooperative time budget, 75 seconds or 120 for the two
archives (`scripts/discovery-source-budget.mjs`): requests are cancelled, retry waits wake,
and buffered items are retained before the next source runs.

Tenant discovery works through what the archives list, public companies first. A tenant
whose name is exactly one SEC company's full name takes that title, which also lets its
filings reach Budget, but it remains a name guess that the corporate site must confirm.
The Wayback query collapses on the start of the index key, because a plain wildcard returns
every captured URL and stops within the first few dozen tenants, all starting with "a".
Measured on 2026-11-05, the six smaller pods answered in 6-47 seconds with 90-294 tenants
each. `wd3`, `wd1` and `wd5` hit the index's 60-second limit, so they go last and Common Crawl
covers them.

Unattended archive requests use a 30-second request timeout (65 for Wayback) with no in-run HTTP
or gateway retries. An index failure stops enumeration against that service for
the current batch; the next invocation can try again. This keeps an archive outage
from consuming the source deadline in nested retries. Interactive collector defaults
are unchanged. Safe summaries include request counts and measured candidate-cache
hits. Matching reports `pending_reason_*` counts for existing reviews without
changing admission or human-review rules. Wayback captures retain Wayback provenance.
This prevents a stalled index source from consuming the entire worker window. Processing
stages still share the remaining overall deadline.
Collection uses no Treg or model client. SEC names can come from committed sec.json.
Local discovery and admission leave scoring to the existing score/rescore plans.

## Overlap and interruption

### Local AI admission

The normal local command uses the existing AI identity-admission policy. Both the database and model
must use explicit loopback endpoints; the model is pinned to `qwen2.5:7b`.
The local entry point refuses production. A separate, disabled-by-default
[approved AI path](discovery-approved-ai.md) is prepared for an operator-reviewed pilot.
Use `--collect-only` on the local launcher to collect and extract evidence without Ollama.
Use `--ai-admission-only` to match saved candidates. The combined command checks Ollama
after collection. If Ollama is unavailable, the summary shows admission as deferred and
the collected evidence is available for the next run.

Local admission selects at most three candidates and runs up to nine model checks across
their possible corporate domains and sites. The existing evidence rules, human reviews,
rejections, and disabled-site protections apply.

The supervisor allows 15 minutes for a run with admission and five minutes for a
collection-only run. Local AI allows up to four minutes per model request. The dedicated
admission CLI retains its two-minute default. Slow model calls may exhaust the run window.

Identity evidence/results are stored under the run's `identity/` directory for local
inspection. They are not part of the GitHub summary artifact pattern. Only safe job
counts and statuses go into `summary.json`. Use a two-case fictional live-model smoke
test only as a connectivity/behavior check, not an estimate of real-company accuracy.

An exclusive var/discovery/execution.lock prevents concurrent supervised processes on
the same machine. An existing lock is never automatically stolen. If the supervisor
itself is killed, verify that its worker is no longer running before manually removing
the stale lock. Do not remove another process's active lock.

Each worker has its own var/discovery/runs/<id>/summary.json and checkpoints completed
stages. latest.json points to the last completed supervised result. A timeout or
interruption is a failed/incomplete result; an in-flight database write may have committed.
The process exits before releasing its lock. Existing deduplication and review decisions
remain responsible for safe repeated execution. Never interpret a timeout as a rollback.

## Reading the coverage counts

`summary.json`, `batch-summary.json` and the health report carry a `rollup` of unique candidates,
admissions, held cases, contact coverage, categories scoring zero and financial evidence status.
Candidate names are stored as short hashes, and only counts reach the health report.

A new company with a Workday customer signal and nothing else scores 13: Release 8 plus Timing 5.
Read `zero_points` and `financials` before treating that as a judgment about the company.
`no_contact`, `no_sec_list` and `fetch_failed` mean the filing lookup could not run. In those cases a
saved assessment is kept rather than lowered (`financials_deferred`). The first failed SEC call stops
further SEC calls for that run. `no_filing_facts` and `no_operating_income` are answers about the
filing: IFRS filers and many banks and insurers earn no capacity points, and nothing is estimated.
Filing evidence can move a company past `ready_for_contacts_threshold`; paid email lookup still needs
its separate budget.

## GitHub workflow prepared for later approval

.github/workflows/discovery-execute.yml has workflow_dispatch only. Its execution job
requires the default branch, DISCOVERY_EXECUTION_ENABLED=true and
DISCOVERY_SINGLE_WRITER_CONFIRMED=true. The CLI also requires an exact HTTPS Supabase
project URL, a 20-character DISCOVERY_APPROVED_PROJECT_REF, and matching PIPELINE_ALLOW_REMOTE.
Database credentials must be configured as GitHub secrets, never committed or pasted into chat.

The workflow shares mando-cube-ingestion concurrency with the existing ingestion workflows.
Its ten-minute job deadline includes installation and a five-minute worker deadline.
It retains only safe JSON summaries for seven days, even on failure. Raw provider output
is not uploaded. Partial failures return a failing workflow status while retaining success counts.

The workflow's Summary tab shows each source's status, items, request count and
candidate-cache reuse, plus admission, new-review and assessment-write counts.
Missing stages and early stops are shown explicitly; counts come from completed
stage reports and are not a transaction audit. A zero-count scoring stage is not
proof that new admissions were scored. No raw errors, company/contact records or
provider URLs are copied into the Markdown summary. For an existing local run,
`node scripts/discovery-health.mjs` reads only `var/discovery/latest.json`.

The filesystem lock does not coordinate different machines. Before enablement, confirm
that all other writers either participate in the same GitHub concurrency group or are
stopped. The single-writer flag records an operator confirmation; it is not a database lock.
Use a distributed lease in a later reviewed migration if multiple independent runners are needed.

## Rollout requirements still outstanding

Review the combined branch's admission and scoring changes with teammates. Main's
merged contact-worker PR resolves the duplicate version in the repository: score-change
reasons use 202610270001 and company merge uses 202610270002. Confirm the actual target
database's migration history separately before deployment.
Approve database migration/deployment changes separately. Decide how task 2/3 identity
verification should run unattended; the experimental local model path is not invoked here.
Re-run bounded live discovery to verify scoring after a partial match and supervised
execution against the local database. Choose cadence from observed throughput and error
rates, then obtain explicit activation approval before adding a recurring trigger.

One 144-second live local run admitted one company and held two; Common Crawl returned
504 and one Workday endpoint returned 500. The admitted company's missing score was
recovered successfully. This is not a sustained growth-rate estimate. All nine database
integration tests passed before adding the supervisor; no production data was accessed.

## Archive candidate windows

See discovery-archive-cache.md for candidate caching and bounded enumeration added
after the first supervised runs. Caching requires no new database schema and does not
replace live checks or create company evidence.
