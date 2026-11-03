# PR: Ingestion pipeline: Workday discovery, grounded extraction, scoring and tests

## Summary

Builds the ingestion backend end to end on top of main's ingestion foundation. It runs without anyone clicking anything,
on a local isolated Supabase:

- **Discovery:** SEC company names → Workday career-site resolver (robots.txt). The Workday JSON endpoints were verified live
  (page size 20, 2,000 cap, 422 on a wrong site).
- **Collection:** Workday job postings mentioning Workday; r/workday and PredictLeads through treg, budget-gated and off by default.
  Plain HTTP only, robots.txt respected, 1 request per second per site, backoff, CAPTCHA/"unavailable" detection.
- **Raw store:** append-only, fingerprinted; unchanged items are skipped and keep their signals fresh.
- **Extraction:** structured fields first. The model (`LLMProvider`; Ollama by default) fills a fixed schema. Every quote
  is verbatim, and v2 grounding drops unsupported types, non-name companies and over-long quotes. Retry once, then dead-letter.
- **Matching:** exact website merge, similar name → review, trusted new company → `origin = pipeline` (atomic SQL function),
  Workday itself excluded. Review approve/merge/reject as SQL functions and a CLI.
- **Scoring:** the Mando team scoring rubric (2026-10-13 revision, Qualified 70+) as `mando-team-70:pipeline-v2`, on the shared `buildAssessment` / `evaluateTier`. Tier thresholds are now version-aware (`tierThresholdsFor`): rows of this version use 70/55, older rows keep 80/55. Needs evidence instead of silent zeros,
  14-day expiry, 14-day rescore, ready-for-contacts. Existing companies only receive signals while the scope is `pipeline_only`.
- **Enrichment:** free people search, then a verified email within the treg cap. Never pays for LinkedIn, never repeats a
  paid call, never guesses an address.
- **Ops:** run log, source alerts, health view, read-only server queries, CSV import (Import button backend), and
  dispatch-only GitHub workflows (schedules commented out).

Migration `202610130001_ingestion_pipeline.sql` is additive (two CHECK constraints widened). **Not applied to production.**

## Results (local, real data)

15 new Workday customers (none already in the team's research) at $0 treg spend. All have a website and sourced signals:
109 signals, 11 distinct score totals. Extraction v2 on a 37-item real golden set: 100% schema-valid, 100% verbatim kept
quotes, 97% signal precision, 79% recall (50% on the held-out items). Details in `docs/ingestion-eval/`.

## Review notes

- Env names: `PIPELINE_SUPABASE_URL`/`PIPELINE_SUPABASE_KEY`, deliberately not `SUPABASE_URL` (production in `.env.local`).
  Remote databases are refused unless `PIPELINE_ALLOW_REMOTE=<ref>`.
- Scoring follows the team rubric; rules the pipeline cannot evidence automatically (operating income, confirmed contacts, confirmed release dates) earn nothing and say so. See the mapping table in `docs/ingestion-runbook.md`.
- Aadi's branch adds a second `signals` table under the same migration timestamp; it will conflict with main's on merge.
- Every signal type now expires after 14 days except go-live (changed `settings.ts`, with its test).

## Test plan

- [x] `npm test` (204: unit, team rubric, collector contracts, pipeline incl. idempotency, failure injection, time travel, boundary, spend)
- [x] `npm run test:integration` on local Supabase (6)
- [x] `npm run lint`, `npm run typecheck`
- [x] Live weekly + daily runs on local Supabase (`docs/ingestion-eval/round-1.md`, `round-2.md`)
- [ ] Hand-verify `docs/ingestion-eval/labels-to-verify.md`
- [ ] Decide `PIPELINE_CONTACT` (SEC) and treg budget before enabling schedules

🤖 Generated with [Claude Code](https://claude.com/claude-code)
