# Round 3: code review only (2026-10-13)

Per the trimmed plan, round 3 is a fresh read of the code for edge cases, with tests. No new live run or eval: the
round-2 numbers stand. 205 tests pass (`npm test`) + 5 integration tests on the local database.

## Found and fixed (each with a regression test)

1. **A go-live without a day said "no go-live signal".** A signal such as "Workday Student is scheduled to go live in
   October 2026" is real evidence that the date bands cannot score (no day, and a day is never invented). Timing now shows
   "Needs evidence: go-live mentioned without a day-precise date ..." with its source link, instead of claiming nothing was found.
2. **Hexadecimal HTML entities** (`&#x27;`) were left in job text and therefore in stored quotes and evidence.

## Checked and documented (no code change)

- **Budget in CI is per run.** The spend ledger is a gitignored local file; GitHub runners start empty, so `TREG_BUDGET_USD`
  caps each workflow run, not each day. Workflows default to 0. Paid email lookups are still never repeated (`paid_calls`).
  Documented in the runbook.
- **Secrets:** only `.env.example` is tracked; `.env.pipeline.local`, `var/` (ledger, SEC copy, eval output) are gitignored.
  treg CLI calls use `execFile` (no shell), so a company name cannot inject arguments.
- **Remote database guard:** `http://localhost@evil.com` and `http://127.0.0.1.evil.com` parse to non-loopback hosts and are refused.
- **Prompt injection** in a posting ("ignore your instructions...") can at most produce a wrong label: quotes must be verbatim,
  types need supporting words, and company names must appear in the text and look like names.

## Known limits left open (not fixed, in the final report)

- Sites that keep failing (renamed career site) are re-checked every run; there is no auto-disable after N failures.
- Go-live dates with month precision get no Timing points (by design: no invented day).
- Name-to-tenant guessing misses abbreviations (WM, MMC) and companies whose tenant differs from their name.
