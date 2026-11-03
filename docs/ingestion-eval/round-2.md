# Round 2: fresh-eyes bug hunt + verification run (2026-10-13)

Quick round per the trimmed plan: re-read the code for edge cases, verify the round-1 fixes on real data with one daily
run, and score extraction v2 once (1 run; v1 already showed ~99% consistency at temperature 0).

## Tests

207 tests (`npm test`) + 6 integration tests on the local database, all green at `d91c4d5`. One integration failure was seen
once in six runs (both database tests failed together) and could not be reproduced; see "Open".

## Live run (daily plan on the 15 round-1 companies; treg cap $0.02)

| Metric | Round 1 | Round 2 |
|---|---|---|
| Career sites collected | 3 | 19 (one main site per tenant; agency/campus sites skipped) |
| New postings captured / model readings / dead letters | 14 / 10 / 0 | 86 / 85 / 0 |
| Signals on the 15 companies | 25 | 109 (hiring 85, known_customer 17, release_planning 5, go_live 1, budget_clue 1) |
| % with website + ≥1 sourced signal | 100% | 100% |
| Distinct score totals | 4 (12 of 15 at 5) | **11** (5, 10, 11, 12, 15, 16, 21, 22, 23, 25, 48) |
| Ready for contacts (B+R+T ≥ 25) | 0 | 2 (Amgen, Mastercard) |
| Contacts found (free people search) | 0 | 3 (Amgen); paid email lookup skipped: $0.001 spent + $0.02 worst case > $0.02 cap |
| Duplicates (companies by name/domain, signals, raw items) | 0 | 0 |
| treg spend / cost per new company | $0 | $0 (session total $0.001: one Reddit call for the golden set) |

No new companies in round 2: discovery (weekly) was not rerun; this round verified collection, extraction and scoring.

## Extraction v2 (prompt v2 + v2 grounding, 1 run, `qwen2.5:7b`)

| | v1 | v2 |
|---|---|---|
| Schema valid | 100% | 100% (one "invalid" was an Ollama timeout while the live run used the GPU; rerun alone: valid) |
| Kept quotes verbatim | 100% | 100% |
| Pipeline signal precision | 75.0% | **97.3%** |
| Pipeline signal recall | 78.9% | 78.9% |
| Company accuracy | 83.8% | 89.2% |
| Holdout: precision / recall / company | 87.5% / 50% / 80% | **100%** / 50% / 90% |
| Fields removed by grounding | 7.3% | 18.7% (v2 also removes unsupported types and non-name companies, so this counts more of the model's guesses as caught, not more guesses) |

v2 is now the default (`PIPELINE_PROMPT_VERSION`, `extract-v2`).

## Bugs found and fixed (each with a regression test)

From the code review:
1. A Reddit go-live without its own date took the post's publication date as the go-live date (wrong Timing band).
2. A capture its reader could not read stayed in the queue and failed on every run; now dead-lettered once.
3. Unconfirmed website guesses (Cisco -> senderbase.org, ASML -> rova.nl) were saved on review items, so approving would create
   the company with a wrong website; only confirmed websites are stored now.
4. Weekly paid treg feeds would have run in every daily plan; each plan now collects only its own frequency.
5. A crashed run stayed "running" forever (health reported it); stale runs are closed as failed at the next start.
6. **Supabase returns at most 1,000 rows per request.** Matching and scoring read all companies in one request, so past 1,000
   companies they silently missed the rest (duplicates and unscored companies). Every list read now pages.
7. A quote could be a whole page; v2 drops quotes over 60 words.
8. The eval scored v2 with v1 grounding (missing version argument).

From the live data:
9. "Executive Director ..., Office of the CIO" scored C-level seniority from the org phrase.
10. A job duty "monitor and manage budget" passed as a budget clue (stored signals from before the fix are not re-graded;
    it still lifts Amgen's Budget to 17).
11. **Integration tests touched real data**: in the shared local database they scored and enriched real pipeline companies and
    wrote a fake email onto two real Amgen contacts (local only; repaired). Tests are now scoped to their fictional companies,
    with a regression check.

## Open

- Holdout signal recall stays at 50%: release-planning wording inside long postings and webinar events are missed.
- One unexplained integration flake (1 of 6 runs).
- Signals stored before a grounding fix keep their old grading (no re-extraction job).
