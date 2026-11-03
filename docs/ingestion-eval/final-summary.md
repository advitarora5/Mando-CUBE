# Ingestion pipeline: final summary (2026-10-13)

Three rounds, per the trimmed plan: round 1 was the main build and measurement; round 2 a quick bug hunt with one live
verification run and one v2 eval; round 3 code review only. **The stop criteria were not checked for two rounds in a row**:
by agreement the loop stopped after round 3 to save time.

## Metrics over rounds

| Metric | Target | Round 1 | Round 2 | Round 3 |
|---|---|---|---|---|
| Tests green (incl. idempotency, failure injection, time travel) | all | 196 + 4 | 207 + 6 (1 unexplained flake in 6 runs) | 207 + 6 |
| Quote verbatim rate (kept) | 100% | 100% | 100% | (no eval) |
| Schema validity | ≥ 98% | 100% | 100% | (no eval) |
| Ollama consistency: company / types / quotes | ≥ 90% | 100% / 99.5% / 98.9% (v1, 5 runs) | not re-measured (1 run) | - |
| New companies with website + ≥1 sourced signal | ≥ 80% | 100% (15/15) | 100% | - |
| Duplicates across consecutive runs | 0 | 0 (1 local seeding artifact) | 0 | - |
| Scores spread, not identical | spread | weak (4 values, 12 of 15 at 5) | 11 values, 5 to 48 | - |
| Pipeline signal precision / recall | (not set) | 75% / 79% (v1) | 97% / 79% (v2) | - |
| Holdout precision / recall | (not set) | 87.5% / 50% | 100% / 50% | - |
| Cost per new company | low | $0.00 | $0.00 | - |

## What works end to end

SEC company names → Workday career-site resolver (robots.txt) → known-customer signal with a verbatim quote → free website
lookup → matching (exact website merges, similar names and weak guesses go to review) → new company with `origin = pipeline`
→ job postings mentioning Workday → structured hiring signals + model reading (fixed schema, grounded) → scores on the shared
rubric with a link and reason per point, Needs evidence where there is none → ready-for-contacts → free people search →
budget-gated verified email. Run log, alerts, health view, review CLI, CSV import, dispatch-only workflows.
Real result: 15 new large Workday customers (Amgen, AstraZeneca, Chevron, Intel, Mastercard, Novartis, Shell, Visa ...)
none of which were in the team's 112 researched companies, with 109 sourced signals, at $0.

## Stubbed or untested

- Paid email lookup ran only in tests (fakes): the live run correctly skipped it on budget ($0.066 treg balance).
- Phone lookup is not implemented (cost); LinkedIn is never paid for.
- PredictLeads tech lookup (`treg-workday-users`) is built but disabled and never called live ($0.04/record).
- r/workday via treg was called once (golden set), never in a scheduled plan. It is disabled by default.
- Greenhouse/Lever and partner client lists: not built (optional).
- Workflows were not run on GitHub (dispatch-only; hosted runners have no Ollama, so they default to structured signals only).
- Gemini/OpenAI providers are implemented but never called (no approval for paid models).
- Production Supabase: untouched. The migration is applied only to the local stack.

## Lead sources compared (prices from treg `catalog_get`, 2026-10-13)

| Source | Price | Yield observed | Verdict |
|---|---|---|---|
| SEC names → Workday tenant resolver | free (≈7 robots.txt requests per name at 1 req/s) | 18 sites from ~75 names (24%); 15 new companies, all large | **Primary lead source** |
| Workday career-site jobs (JSON) | free | 106 postings from 19 sites in one daily run | **Primary signal source** |
| treg `predictleads.technologies.users` (companies using Workday) | $0.04 per record | not run (balance) | Best paid lead source to test next; reviews note billing per `limit` slot |
| treg company search (Aadi's idea): `apollo.companies.search` $0.026, `leadmagic` $0.025, `aiark` $0.0005 (size fixed at 1) | per call | not run | Useful for firmographics; does not prove Workday use by itself |
| Jobs by technology: LinkedIn job providers $0.00045–$0.001 | per call | not used | **ToS risk** (LinkedIn data); not recommended |
| treg Reddit (`tikhub` app feed) | $0.001 per call | 6 posts, 300-character previews | Low yield; insight feed only |
| Free helpers: `hunter.x.domain-finder`, `quickenrich.people.search`, `apollo.people.search` | free | a website for 18/18 names, at least 2 wrong (Cisco, ASML; both held in review); 3 contacts for Amgen | Use first; never trust an unconfirmed website |
| `treg.people.email.find` with verify | routed, ~$0.005–$0.15; capped per call by header | not run live | Budget-gated |

## Ollama quality (qwen2.5:7b, local, ~13–17 s per item on an RTX 4050)

See round 1 and 2 tables. Model choice: qwen2.5:7b (llama3.2 3B and llama3.1 8B comparisons were cut to save time).
The 20 labels to hand-verify are in [labels-to-verify.md](labels-to-verify.md).

## Not met / risks

- Holdout signal recall is 50% (release planning inside long postings, webinars as events). Precision is high, recall is not.
- Consistency of v2 was not re-measured with 5 runs (v1 was ≥ 98.9%).
- Name-to-tenant guessing misses abbreviations and differently named tenants (≈1 in 4 names resolve).
- Budget in CI is per run (ledger not persisted).
- One unexplained integration-test flake.
- ToS: Reddit through a provider is a grey area (Reddit's Data API terms); LinkedIn-sourced job data was avoided.
  SEC requires a contact email in the User-Agent: a team address is needed (`PIPELINE_CONTACT`).

## Scoring change after the rounds

At Advit's request the pipeline now scores with the Mando team rubric (Qualified 70+), replacing `pipeline-v1`; the round
score numbers above were produced by `pipeline-v1`. Rescored locally, the 15 companies total 13-24 (eight at 16): Release is 8 for
every confirmed customer while 2027R1 is unconfirmed, people-search contacts count as unconfirmed, and operating income is not
collected. No company reaches the ready-for-contacts threshold of 25 under this rubric (highest 22).

## Three next steps

1. Decide the SEC contact address and treg budget, apply the migration to an approved test project, then enable the weekly
   and daily schedules (runbook section 7).
2. Hand-verify the 20 labels, then raise holdout recall: a second, narrow model pass for release-planning and event wording
   in long postings, and re-extract stored signals when grounding changes.
3. Test PredictLeads (10 records, $0.40) against the free resolver for new-company yield, and add a careers-page link scan
   to resolve tenants whose name differs from the company name.
