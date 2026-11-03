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

The initial operating configuration requests two items/sites per source, limits each
source to at most 20 requests, and admits at most three new companies per matching pass.
The supervisor stops its worker after five minutes. Providers may return fewer results.
Each collection stage also has a 25-second cooperative time budget: requests are
cancelled, retry waits wake, and buffered items are retained before the next source runs.

Unattended archive requests use a 12-second request timeout with no in-run HTTP
or gateway retries. An index failure stops enumeration against that service for
the current batch; the next invocation can try again. This keeps an archive outage
from consuming the source deadline in nested retries. Interactive collector defaults
are unchanged. Safe summaries include request counts and measured candidate-cache
hits. Matching reports `pending_reason_*` counts for existing reviews without
changing admission or human-review rules. Wayback captures retain Wayback provenance.
This prevents a stalled index source from consuming the entire worker window. Processing
stages still share the remaining overall deadline.
No Treg or model client is created. SEC names can come from committed sec.json.
No migration is executed. Discovery scoring is limited to companies touched by this run;
the existing daily/rescore plans remain responsible for periodic full rescoring.

## Overlap and interruption

### Optional local Ollama pilot

`node --env-file=.env.pipeline.local scripts/discovery-execute-local.mjs --local-ai`
opts into the existing local identity-admission policy. Both the database and model
must use explicit loopback endpoints; the model is pinned to `qwen2.5:7b`. No production
or GitHub-hosted AI mode is provided. The model is checked before collection writes.
The normal execution command remains model-free.

This pilot selects at most one candidate, excludes human-only/rejected decisions
and disabled sibling sites, and allows at most three model checks across the selected
candidate's possible corporate domains/sites. Missing evidence, errors, contradictory
sites and exhausted checks remain held. It does not relax the checker or change
stored signal confidence. All enabled sibling sites must be verified by the existing
policy before admission. A human-only similar-name review is not automatically resolved.

The local AI supervisor has a ten-minute overall deadline and an admission cap of
one; individual collection budgets remain 25 seconds. This longer deadline is local
only. Slow model calls may exhaust the window. Scoring follows matching and stays
limited to touched companies. Inspect actual admission/assessment counts; a completed
run or an empty scoring stage does not establish growth.

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
