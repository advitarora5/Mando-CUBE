# Ingestion pipeline progress

Branch `advit-ingestion-pipeline` (fast-forwarded to `origin/main` 933198e on 2026-10-13). Updated after every round.
If you are picking this up cold: read this file, then `docs/ingestion-runbook.md`, then the latest `docs/ingestion-eval/round-N.md`.

## Audit (2026-10-13)

| Plan phase | Before this branch | Now |
|---|---|---|
| 1 Foundation | Partial: `202610120001_ingestion_foundation.sql` tables + `settings.ts`; nothing used them | Done: `202610130001_ingestion_pipeline.sql` (additive) + typed modules for every stage |
| 2 Workday collector | Missing | Done: resolver (SEC names -> tenant robots.txt) + jobs collector (verified JSON endpoints) |
| 3 Extraction | Missing on main (Aadi's branch has a claim schema and test set, unmerged) | Done: structured readers + fixed-schema model reading behind `LLMProvider`, verbatim-quote grounding, retry once, dead-letter |
| 4 Matching / review queue | Table only | Done: normalize, exact-website merge, similar-name review, auto-add rule, approve/merge/reject (SQL functions + CLI) |
| 5 Scoring automation | Shared rubric + evaluator only | Done: pipeline-v1 policy on top of `buildAssessment`/`evaluateTier`; Needs evidence; 14-day expiry; 14-day rescore; ready-for-contacts |
| 6 Scheduler / monitoring | Weekly snapshot only | Done: dispatch-only workflows (schedules commented out), run log, alerts view, health view/CLI |

No "Ingestion Pipeline Architecture" or "Implementation Plan" document exists in the repo; the brief's phase list was used.

## What is done

- Schema: `supabase/migrations/202610130001_ingestion_pipeline.sql` (local Supabase only; NOT applied to production).
- Code: `src/domain/ingestion/*` (pure), `src/pipeline/*` (I/O), CLI `scripts/pipeline.mjs`.
- Tests: `npm test` (unit, collector contracts, pipeline incl. idempotency / failure injection / time travel / boundary / spend),
  `npm run test:integration` (local Supabase). CI: `.github/workflows/ingestion-tests.yml`.
- Workflows: `ingestion-{daily,weekly,rescore,import}.yml`, `workflow_dispatch` only.

## Open decisions for Advit

1. SEC requires a contact email in the User-Agent (403 without). Set `PIPELINE_CONTACT` to a team address, or keep supplying a local copy via `PIPELINE_SEC_FILE`.
2. treg balance is $0.067 (below the $0.50 cap), so paid contact lookups barely run. Top-up or keep "Needs evidence".
3. Hosted runners have no Ollama: scheduled runs use structured signals only (`PIPELINE_LLM=none`) until a model host is chosen.
4. Aadi's branch adds a second `signals` table under the same migration timestamp; it will conflict with main's on merge.

## Rounds (plan trimmed on 2026-10-13: round 1 = build; rounds 2-3 = quick bug hunts)

| Round | What | Result |
|---|---|---|
| 1 | Build + first live run + v1 eval | 15 new companies at $0; 5 bugs fixed (site coverage, review bypass, type mislabels, stale SEC list, vendor as lead) |
| 2 | Fresh-eyes review + live verification + v2 eval | 11 bugs fixed (incl. 1,000-row API limit, date semantics, tests touching real data); 11 distinct scores; v2 precision 97% |
| 3 | Code review only | 2 fixes (undated go-live evidence, hex entities); CI budget is per run (documented) |

Status: all tests green (207 + 6 integration). Default extraction: `extract-v2` on `qwen2.5:7b`.
Next step: the open decisions above, then `docs/ingestion-eval/final-summary.md` "Three next steps".
Local state: Supabase local stack has the 15 round-1 companies, the team's 112 researched companies (seeded copy) and
integration-test fixtures (".example" domains). `npx supabase db reset` wipes it.
