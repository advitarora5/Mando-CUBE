# Ingestion evaluation rounds

Each round: full test suite, a real end-to-end run on fresh data with strict caps (local Supabase, treg spend
capped), the extraction golden set, the top three problems fixed with regression tests, then a commit.

- End-to-end numbers: `node --env-file-if-exists=.env.pipeline.local scripts/round-metrics.mjs --since <round start>`.
- Extraction numbers: `npm run pipeline:eval -- --model <m> --prompt <extract-vN> --runs 5` on
  `tests/fixtures/ingestion/golden` (37 real items; 10 held out from prompt tuning; labels are model-written and
  need a human spot-check, see `final-summary.md`).

Metric definitions:

| Metric | Definition |
|---|---|
| schema validity | model replies that parse and match the fixed schema (first try; after the single retry) |
| raw quote verbatim rate | model quotes found verbatim in the source, before grounding. Kept quotes are 100% verbatim by construction: the rest are dropped |
| hallucination rate | filled fields (company, products, timing words, dates, project type) not supported by the text / all filled fields |
| signal recall / precision | required signal types found / required; predicted types that are required or allowed / predicted (run 1) |
| consistency | per item, share of the 5 runs that agree with the most common answer, averaged (company, signal-type set, quote set) |
| % auto-added | new companies created / (created + sent to review) |
| cost per new company | treg spend in the round window / new companies |

Rounds: [round-1](round-1.md) · [round-2](round-2.md) · [round-3](round-3.md) · [summary](final-summary.md) · [labels to verify](labels-to-verify.md)
