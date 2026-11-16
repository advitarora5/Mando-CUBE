# SEC sections: discovery and evidence processing

The pipeline has 10 fixed SEC sections. Previews remain offline and read-only. Section execution performs discovery, extraction, posting collection, matching, and automatic review recovery for the selected section, with database-backed discovery checkpoints. Company admission handles concurrent exact website matches, and admitted companies enter a shared scoring queue.

```bash
npm run pipeline -- sections
npm run pipeline -- section 3 --preview

# Execute against the database configured in your ignored local environment file:
npm run pipeline -- section 3 --limit 25 --no-llm --max-spend 0
```

Choose a number from **1 through 10**. Agree on one person per section; with nine people the tenth section can be assigned later. A section number is required for every command; there is no default or saved personal setting. The section preview prints every assigned issuer, its CIK, and its position in the deduplicated list. The overview prints all section boundaries and counts. Positions are one-based and inclusive.

## Local development setup

Apply repository migrations to the running local Supabase instance before executing:

```bash
npx supabase migration up --local
```

Configure the existing pipeline database environment variables in an ignored environment file as described in the [runbook](ingestion-runbook.md). Execution requires the new section migration; missing tables or a mismatched stored manifest stop the run before any provider requests. Remote writes retain the existing explicit project allowance. No production migration or production run is performed by local setup.

`--limit` defaults to 25 and accepts integers from 1 through 100. It caps discovery issuers attempted, not companies admitted; discovery has its own source request cap and may stop earlier. Posting collection uses the same limit for owned tenants, including previously discovered tenants. It does not cap extraction or matching to only newly discovered issuers: those stages also recover existing work within this section.

Use `--no-llm` to disable model extraction, `--no-treg` to disable treg transport, and `--max-spend 0` to lower the paid treg budget to zero. Without `--no-llm`, the existing model configuration applies. These runs collect live evidence; they are not dry runs. Use `--preview` for an offline list instead. Preview cannot be combined with execution options. Unknown or repeated options are rejected.

## Fixed assignments

Assignment `sec-sections-v1` pins the repository's existing `sec.json` by SHA-256 in `src/data/sec-sections-v1.json`. It was frozen on November 15, 2026; this is the assignment freeze date, not a claim about when the SEC originally published or fetched the saved data.

The snapshot contains 10,445 ticker rows and 8,028 unique issuers. Deduplication uses CIK, retaining the first occurrence and its company name in snapshot order. Sections 1–8 have 803 issuers each; sections 9–10 have 802 each. An issuer is assigned exactly once, even if it has multiple tickers. Companies with different CIKs retain separate assignments even when names match; company identity matching happens later.

Assignments are calculated before any pipeline eligibility, existing-company, or completed-work filtering. Every teammate using the same assignment version and checksum gets the same sections. `PIPELINE_SEC_FILE`, the database's latest SEC capture, global resolver history, and live SEC updates do not override this assignment snapshot. Changing `sec.json` causes previews to fail checksum validation. Coordinate a new assignment version before changing the pinned snapshot or partition algorithm; never quietly repartition active work. Execution registers the manifest checksum centrally and verifies immutable issuer assignments.

## Resume and section scope

Discovery progress is stored by assignment version and CIK, so another device can resume the same section. A complete search records `found` or `miss` only after the returned captures and their issuer memberships have been saved. Completed discovery is skipped on subsequent runs of this manifest. Temporary failures and incomplete searches record `retry`, eligible after 15 minutes; fresh issuers are attempted before due retries. An interruption before checkpointing leaves the issuer eligible. Old global discovery attempts do not count as completion for this assignment.

Downstream work resumes independently: pending captures remain queued across runs, and pending reviews are revisited using the existing website-evidence retry rules. A model response alone does not complete a capture; signals and the structured completion must also be saved. Section extraction errors leave evidence queued for retry.

Every collected capture has a separate issuer membership. Extraction filters memberships before applying its limit; sites and signals are filtered by both membership and issuer name. Matching and automatic review recovery read only this section's eligible signals. Existing companies are still read globally for correct duplicate matching. Admission attaches only eligible section signals and sites; it does not sweep up unrelated same-name sites or all signals in a shared review.

Unchanged pages may have memberships for multiple issuers without changing the original capture. Existing same-company sites and signals retain their original provenance and gain the appropriate membership. If a shared record has a different company context, processing reports a manual-review error and does not relabel it. Issuers with a normalized name shared by multiple CIKs in the manifest are held out of automatic discovery and counted as `held_ambiguous` in the run summary.

The JSON summary reports the assignment, section, counts of pending/found/miss/retry issuers, held ambiguous names, and stage results. These are discovery outcomes: `found` does not mean admitted or scored. Offline previews deliberately do not query database progress.

## Database target and current limits

Previews show the hostname configured by `PIPELINE_SUPABASE_URL`, labeled local or remote. A remote hostname alone does not identify whether a project is production or staging; verify the intended project through the team's deployment configuration. Missing database configuration is allowed for previews. No credentials, URL user information, paths, or query parameters are displayed.

There are no work claims or leases: two people choosing the same section can duplicate effort. Assign one person per section. The existing `run` command rejects section options instead of silently ignoring them. Existing unsectioned pipeline commands retain their original behavior and must not be used as a substitute for section execution.

Section runs intentionally do not score inline or research contacts. Run the scoring worker separately. These changes have been exercised locally; production deployment and the production pilot remain separate work.

## Concurrent admission and shared scoring

Admission checks the confirmed website and serializes the short matching-and-creation transaction; research remains parallel. Scheme, case, a leading `www`/`www1`, paths, ports, and a trailing dot do not create different identities. Parent/subdomains remain distinct and their relationship requires review. Simultaneous admissions for an exact confirmed host return the same company ID and preserve the existing company fields and origin. Each section attaches its own eligible evidence. A conflicting same-name website or multiple historical matches is held for review rather than merged automatically. Historical duplicate records are not rewritten.

Direct inserts, including imports, also have a database guard against adding another canonical host. A racing direct import receives a conflict and should be rerun so its existing matching logic can reuse the saved company; pipeline admission itself handles that reuse within its transaction. Assignments cannot move evidence that already belongs to a different company.

`company_scoring_jobs` has one row per company. New companies and changes to assigned signals, contacts, or company scoring inputs enqueue work in the same transaction as the data change. Several requests coalesce into one row. Queue versions distinguish evidence requested for scoring from evidence already processed; evidence arriving during scoring leaves another pass pending. Deployment does not enqueue every historical company automatically.

```bash
npm run pipeline -- scoring status
npm run pipeline -- scoring work --limit 25
npm run pipeline -- scoring work --watch --limit 25
```

One-shot work attempts up to the limit and exits; watch mode keeps polling every five seconds (customizable with `--poll-seconds 1` through `60`). The worker uses the existing evidence-backed scoring engine, including "Needs evidence" results. It handles explicitly queued existing companies regardless of the legacy `pipeline_only` scoring setting. It does not call model or treg providers or perform contact enrichment. SEC filing lookups can still make HTTP requests when a contact User-Agent is configured; their issuer index comes from the verified frozen SEC snapshot.

Only one designated worker is needed. Atomic queue claims also prevent accidental extra workers from scoring the same request simultaneously. Each company claim expires after five minutes; a killed worker's work becomes claimable then. Ctrl+C lets the current company finish before stopping. Failed scores retry with a delay beginning at 15 seconds, increasing to a few minutes. A stale worker cannot commit over a replacement worker. Score insertion and queue acknowledgement commit together. An unavailable financial lookup preserves a higher saved assessment and leaves a retry instead of silently lowering it.

Use `scoring work --company <company-id> --limit 1` to restrict work to a specific company, or `scoring enqueue <company-id>` to explicitly request another pass. Status reports `pending`, `running`, `retry`, and `done` counts. Keep legacy inline `run --plan score`, `daily`, or `all` runs separate from this section-plus-worker test; they are not the shared worker.

## Test from separate terminals on one computer

Use the same checkout and **the same local Supabase database** in all terminals. Run `npx supabase migration up --local` once. Confirm `npm run pipeline -- sections` reports a local database target, then note the baseline from `npm run pipeline -- scoring status`. Existing local test fixtures or earlier queued work may contribute to those baseline counts.

Terminal 1:

```bash
npm run pipeline -- section 1 --limit 3 --no-llm --max-spend 0
```

Terminal 2, at the same time:

```bash
npm run pipeline -- section 2 --limit 3 --no-llm --max-spend 0
```

Terminal 3:

```bash
npm run pipeline -- scoring work --watch --limit 10
```

Check each discovery summary identifies the correct section. New admissions should generate work for terminal 3; an all-miss or review-only batch may admit nothing. Check `npm run pipeline -- scoring status` after the discovery runs finish: ready work should drain, while any retries should be explained by the worker output. An empty watch worker waits quietly.

Rerun a section command to confirm completed discovery is skipped and the next issuers are selected. To check interruption recovery, stop a discovery process with Ctrl+C and rerun its command. Completed issuer checkpoints remain saved; pending captures and reviews stay eligible for downstream recovery. Posting collection and review checks can legitimately revisit previously discovered companies.

For a deterministic overlap and scoring-recovery test with fictional records and fake research providers:

```bash
node --env-file=.env.pipeline.local --test --test-force-exit \
  --test-name-pattern='separate processes|scoring queue|direct concurrent' \
  tests/integration/pipeline-db.test.mjs
```

That test launches two independent Node processes behind a start barrier, admits the same host from two sections, and verifies one company retains both sets of evidence. It also checks failed score transactions, newer evidence during scoring, and recovery from abandoned claims. The live terminal test exercises actual collection and device-independent shared progress; the deterministic test forces races that live sections may never happen to encounter.
