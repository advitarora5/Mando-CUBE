# Ingestion milestone 1: collection inputs

The input boundary is independent of the browser or model provider. No scheduler,
browser integration, Ollama calls, database writes or scoring are added here.
Requires Node 24 (the repository scripts import TypeScript directly) and npm ci.
Commands below run from the repository root.

## Files

- config/ingestion/sources.json: editable source priorities and bounded collection settings.
  All three source families are enabled. Job/partner URLs are starting points to verify,
  not tested adapters. Priority defines rollout order, not a schedule.
- src/data/ingestion/contracts.ts: strict Zod schemas for source configuration,
  collection briefs and source batches. These are collection contracts, not changes
  to the shared company/database contract.
- docs/ingestion/browser-agent.md: explicitly loaded agent procedure.
- fixtures/ingestion/mixed-sources.json: fictional discussions, jobs, articles,
  case studies and client lists. No fixture may be imported as real data.
- var/ingestion/runs/: ignored local output. Back up useful runs outside Git;
  this folder is not durable cloud storage.

## Prepare a local pilot

    node scripts/ingestion/prepare-run.mjs job-boards

Run the jobs pilot first, then prepare a fresh brief immediately before the partner
pilot with `node scripts/ingestion/prepare-run.mjs partner-websites`. Reddit remains
available with `node scripts/ingestion/prepare-run.mjs reddit-workday`. Use one
brief per source family so yield can be compared. Do not generate both briefs
in advance: the second budget would expire while the first runs.

This creates a unique run directory and brief.json. It does not start an agent.
Prepare it when ready to collect, because started_at starts the time budget.
Each source pilot currently allows 15 minutes and up to 10,000 page visits, so
time should be the practical limit. Continue exploring useful material throughout
the window; blocked access or exhausted relevant results can still end it early.
These are agent instructions, not a programmatic execution timeout. Existing
briefs retain their original limits; generate a new brief for the new settings.
In a separate chat using this repository/branch, provide this prompt with the
printed absolute paths substituted:

> Read docs/ingestion/browser-agent.md, the ingestion contracts and the synthetic
> fixture. Collect relevant Workday usage, projects and potential buying signals.
> Record company attribution when explicitly present, otherwise mark it unknown.
> Do not perform extra identity searches or discard relevant anonymous material.
> Execute the collection brief at <absolute brief.json path> using the
> browser tools available in this chat. Save the source batch to <absolute
> captures.json path>, run the validator, and report results. Do not modify
> application code or write to Supabase. If browser access is unavailable, report
> that limitation rather than substituting uncited or invented content.
> Use the available time budget to explore additional relevant queries and
> result pages; do not stop after a small number of captures. Check elapsed time
> and save progress periodically. Explain any early stop. Summarize distinct named
> company candidates with supporting capture IDs, unresolved identities, and which
> candidates have current buying signals. Separate customers from vendors/partners.
>
> If a CAPTCHA appears, pause and tell me which browser tab and URL need
> attention. Do not solve or bypass it. Wait for me to complete it manually
> and explicitly tell you to continue. Waiting counts toward the time budget;
> if it expires, save collected material, record the interruption, mark the run
> limit_reached, and report that a fresh run is needed. If access still fails
> after I tell you to continue, record the failure and stop that source.

Another chat is organizational, not required. Verify it uses the intended checkout.
The durable instructions live in the repository, not this planning conversation.
Website access can still require permission or sign-in; unattended access is not
established by these files.

## Validate examples and captures

    node scripts/ingestion/validate-capture.mjs fixtures/ingestion/mixed-sources.json
    node scripts/ingestion/validate-capture.mjs <actual-captures.json>
    node --test tests/ingestion-capture.test.mjs

The validator is offline and does not rewrite inputs. Invalid structure exits 1;
valid captures exit 0 with warnings for empty batches, failures, unknown publication
dates or elapsed time over budget. A valid empty/blocked run is not extraction success.
The schemas check URL syntax, dates, IDs, comment ancestry, duplicates and timestamps.
They cannot prove source authenticity, actual pages visited, completeness or that
captured text was copied accurately. Review those before model extraction.

## Next boundaries

Browser -> captures.json -> validation -> Ollama candidate extraction -> evidence
review/company matching -> accepted candidates -> Supabase/scoring.
Company identity need not be present in every capture. Event dates, company claims,
modules and buying signals belong in the next extraction contract, backed by segments.

Cloud execution will use these same briefs/batches, with durable object storage or
a queue replacing the ignored local folder. A cloud browser alone does not make
local Ollama available while a laptop is offline. Worker hosting, browser access,
model hosting, credentials and scheduling remain separate deployment decisions.
