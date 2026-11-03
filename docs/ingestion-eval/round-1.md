# Round 1: main build-out (2026-10-13)

Local Supabase (isolated), treg cap $0.02 for the run, Ollama `qwen2.5:7b`. Round window started 06:02 UTC.

## Tests

All green at the round-1 commit (`359b37d`): 196 tests (`npm test`) + 4 integration tests on the local database.
Bugs found this round each got a regression test before the fix (8 tests marked "regression").

## End-to-end run (real data)

Weekly discovery (SEC names -> Workday tenant resolver), then the daily plan (job postings -> model -> match -> score -> enrich).

| Metric | Value |
|---|---|
| New companies (by source) | 15, all from `workday-site-resolver` (SEC names) |
| Companies created | Amgen, Analog Devices, AstraZeneca, Broadcom, Chevron, CrowdStrike, GE Vernova, Intel, KLA, Mastercard, Micron Technology*, Novartis, Qualcomm, Shell, Visa |
| Overlap with the team's 112 researched companies | 0 (all genuinely new) |
| treg spend / cost per new company | $0.00 / $0.00 (free sources; the domain finder is free) |
| % new companies with website + ≥1 sourced signal | 100% (15/15) |
| Auto-added vs review | 15 created / 6 to review = 71% auto-added (3 untrusted first-word tenant guesses, 3 no website) |
| Duplicates | 0 by domain; 1 by name (NVIDIA, a local seeding-order artifact, merged; not a pipeline bug) |
| Signals on new companies | 25 (known_customer 15, hiring 10) |
| Score distribution | 5 (x12), 10, 11, 15. Not identical, but **clumped**: only 3 companies got job postings |
| Tiers | all stored `Disqualified`, shown as Not Enough Evidence (no contacts: Authority/Reachability need evidence) |
| Ready for contacts (B+R+T >= 25) | 0, so no contact lookups ran (contacts pending) |
| Resolver yield | 18 sites from ~75 names (24%), ~7 robots.txt probes per name, 0 blocks |
| Run time | discovery ~14 min (network, 1 req/s), daily ~8 min |
| Errors by type | `match:partial` x2 and `error_match` x2 came from the failure-injection integration test that ran in the same window; none from the live run |

\* Micron was created by a bug (below) while its review item was pending.

## Extraction (golden set, 37 real items, 10 held out)

| | v1 prompt (5 runs) | v2 prompt, v1 grounding (3 runs) |
|---|---|---|
| Schema valid (first try / after retry) | 100% / 100% | 100% / 100% |
| Kept quotes verbatim | 100% | 100% |
| Raw model quotes verbatim (before dropping) | 87.7% | 83.5% |
| Hallucination rate | 7.3% | 7.0% |
| Company accuracy | 83.8% | 89.2% |
| Pipeline signal recall / precision | 78.9% / 75.0% | 78.9% / 84.1% |
| Holdout: company / recall / precision | 80% / 50% / 87.5% | 90% / 50% / 81.8% |
| Consistency company / types / quotes | 100% / 99.5% / 98.9% | 100% / 98.2% / 96.4% |
| Time per call | 17.1 s | 13.2 s |

The v2 column used v1 grounding because of an eval bug (fixed in round 2); see round 2 for v2 with its own grounding.

## Top problems and fixes

1. **The model labels verbatim quotes with unsupported types** (job duty "implement, test ... Workday modules" as go_live; an
   APAC HR sentence as known_customer; skill lines as budget_clue). Fix: extraction v2. The prompt says what each type is not,
   and v2 grounding drops a signal whose quote lacks words for its type, drops quotes over 60 words, and drops company values that
   are descriptions ("a globally recognized ... organization"). Postings that only list Workday as a skill are weaker hiring signals.
2. **Only 3 of 15 companies got job postings**: `--limit` capped postings, not companies. Fix: the limit counts sites, sites
   rotate by last check, and one main career site per tenant (agency, University, ContractorConversion and Fasttrack sites were chosen).
3. **A company was created behind a pending review item** (Micron): job signals from a review-linked site were matched again.
   Fix: job signals inherit their site's company or review item; matching never re-decides a name waiting in review.

Also fixed: the resolver read a stale SEC list (an unchanged list reuses an older row); Workday itself would have become a lead;
the Reddit app-feed shape was not parsed; integration tests left real sites disabled; all-capital names ("Asml Holding Nv").

## Not met / open

- Scores were clumped (fix verified in round 2). No company reached ready-for-contacts. With the next Workday release 5 months
  away, Release can give at most 5, so readiness needs a budget clue.
- Holdout signal recall is 50%: the model misses release-planning and event signals in long postings and webinars.
