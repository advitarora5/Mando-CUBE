# Discovery execution controls

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
This prevents a stalled index source from consuming the entire worker window. Processing
stages still share the remaining overall deadline.
No Treg or model client is created. SEC names can come from committed sec.json.
No migration is executed. Discovery scoring is limited to companies touched by this run;
the existing daily/rescore plans remain responsible for periodic full rescoring.

## Overlap and interruption

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

The filesystem lock does not coordinate different machines. Before enablement, confirm
that all other writers either participate in the same GitHub concurrency group or are
stopped. The single-writer flag records an operator confirmation; it is not a database lock.
Use a distributed lease in a later reviewed migration if multiple independent runners are needed.

## Rollout requirements still outstanding

Review the combined branch's admission and scoring changes with teammates. Verify the
target schema and migration history, particularly duplicate version 202610270001 in the
repository (the disposable test copy renumbered one file without changing its SQL).
Approve database migration/deployment changes separately. Decide how task 2/3 identity
verification should run unattended; the experimental local model path is not invoked here.
Re-run bounded live discovery to verify scoring after a partial match and supervised
execution against the local database. Choose cadence from observed throughput and error
rates, then obtain explicit activation approval before adding a recurring trigger.

One 144-second live local run admitted one company and held two; Common Crawl returned
504 and one Workday endpoint returned 500. The admitted company's missing score was
recovered successfully. This is not a sustained growth-rate estimate. All nine database
integration tests passed before adding the supervisor; no production data was accessed.
