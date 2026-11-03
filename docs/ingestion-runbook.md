# Ingestion pipeline runbook

Finds companies that use Workday, captures public buying signals with a source link, date and exact quote,
scores them with the shared rubric and writes everything to Supabase. No human clicks during a run.

```
SEC names ──> Workday resolver ──┐
Workday career sites (jobs) ─────┼─> raw_captures ─> extract ─> signals ─> match ─> companies / review_queue ─> score ─> enrich (budget-gated) ─> score
treg r/workday (insight feed) ───┘   (append-only)  (structured + model)            (origin=pipeline)
```

## 1. Setup

```bash
npm ci
npx supabase start                    # local, isolated database (Docker). First start pulls images.
cp .env.example .env.pipeline.local   # then fill the PIPELINE_* values below (file is gitignored)
ollama pull qwen2.5:7b                # default local model
npm test && npm run test:integration
```

`.env.pipeline.local` for a local run:

| Variable | Meaning |
|---|---|
| `PIPELINE_SUPABASE_URL` / `PIPELINE_SUPABASE_KEY` | Target database. Local: `http://127.0.0.1:54321` and the `SECRET_KEY` from `npx supabase status`. **Deliberately not `SUPABASE_URL`**: that points at production in `.env.local`. |
| `PIPELINE_ALLOW_REMOTE` | Only for an approved non-local *test* project: its project ref. Any other remote URL is refused. |
| `PIPELINE_LLM` | `ollama` (default) \| `openai` \| `gemini` \| `none`. |
| `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX` | Local model (default `qwen2.5:7b`, context 6144). |
| `PIPELINE_ALLOW_PAID_LLM`, `PIPELINE_LLM_BUDGET_USD`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | Paid models. Off unless `PIPELINE_ALLOW_PAID_LLM=1` **and** a budget > 0. Ask before enabling. |
| `TREG_TOKEN` | treg per-org agent token (CI). Locally, when empty, the signed-in `treg` CLI is used. |
| `TREG_BUDGET_USD` | Session cap for paid treg calls (default 0.50). `--max-spend` lowers it per run, never raises it. |
| `PIPELINE_CONTACT` | Contact address in every collector User-Agent. SEC answers 403 without one. |
| `PIPELINE_SEC_FILE` | Optional local copy of `company_tickers.json`, used only when `PIPELINE_CONTACT` is empty. |

Secrets live only in environment variables, `.env.pipeline.local` and GitHub secrets. Nothing prints them.

## 2. Run it

```bash
npm run pipeline -- run --plan weekly --limit 20            # discovery: SEC -> resolver -> extract -> match -> score
npm run pipeline -- run --plan daily --limit 20             # jobs -> extract (model) -> match -> score -> enrich
npm run pipeline -- run --plan all --limit 20 --max-spend 0.05
npm run pipeline -- run --plan collect --source workday-career-sites --limit 5
npm run pipeline -- run --plan extract | match | score | rescore | enrich
npm run pipeline -- run --plan weekly --dry-run             # in-memory: reads nothing from and writes nothing to the database
npm run pipeline -- import path/to/rows.csv                 # Import button rows
npm run pipeline -- health
npm run pipeline -- review list | approve <id> --domain x.com | merge <id> <company_id> | reject <id>
```

### Review decisions

Verify the corporate domain, exact Workday site and attached evidence before approving or merging. A tenant-name guess is not identity proof. Approve creates a pipeline-origin company; merge attaches evidence to an existing company without creating a duplicate. Neither operation performs contact research or scoring by itself. Mixed valid/invalid evidence must be corrected or quarantined before resolving: the CLI attaches all waiting evidence for the review, not a reviewer-selected subset.

After migration `202611020001_review_rejection_safety.sql`, reject atomically closes the review and disables its unassigned Workday sites. Signals remain stored under the rejected review and are excluded from unassigned matching. Already assigned company sites are protected. Rediscovering an existing site does not re-enable it; reassessing a rejected site requires an explicit verified correction. Rejection concerns that association/evidence, not a permanent blacklist of the named company. Decisions cannot be repeated or reopened through these commands.

Apply repository migrations through the normal release process before relying on this rejection behavior. The migration does not retroactively change historical decisions; the November 1 audit's two wrong-site associations were already disabled manually.

`--limit` is items per source (for the resolver: Workday sites to find; it tries up to six names per site).
`--no-llm` and `--no-treg` switch those off for one run.

## 3. Stages and rules

| Stage | What it does | Rules |
|---|---|---|
| Collect | `src/pipeline/collectors/*`, all `Collector.collect(source, limits, ctx) -> RawItem[]` | Plain HTTP/JSON, robots.txt checked, ≥1 s between requests to the same site, backoff on 429/503 (max 2 retries, Retry-After capped at 30 s). 401/403, CAPTCHA and "unavailable" pages (including 200 responses that are not the expected JSON) stop the source and are logged. |
| Raw store | `raw_captures` | Body exactly as received + SHA-256 fingerprint (volatile fields such as "Posted 3 Days Ago" excluded). Unchanged items are skipped and only refresh their signals' `last_seen_at`. Immutable (trigger). `pending_captures` is the work queue. |
| Extract | `src/pipeline/extract.ts` | Structured fields read directly (titles, dates, URLs, Workday tenant). The model reads only messy text into the fixed schema (`src/domain/ingestion/extraction-schema.ts`), temperature 0, JSON-schema constrained, retry once, then dead-letter. Quotes must be verbatim (else the signal is dropped); company, products, timing words, dates and project type must be supported by the text (else cleared and counted as hallucinations). Model down = captures stay queued. |
| Signals | `signals` | go_live, hiring, release_planning, known_customer, budget_clue, event; link, date, quote, confidence. Every type expires 14 days after last seen, except go-live (date bands). |
| Match | `src/domain/ingestion/matching.ts` | Exact website match merges. Similar name -> review (`similar_name`, with suggestion). New company + confirmed website + trusted signal (≥0.9) -> created with `origin = pipeline` (atomic SQL function). Else review (`no_website`, `untrusted_signal`, `over_run_cap`). Workday itself is excluded. Size never blocks ("size unknown" when missing). |
| Score | `src/domain/ingestion/pipeline-score.ts` on the shared `buildAssessment` / `evaluateTier` | Only companies in scope (`scoring_scope = pipeline_only` -> pipeline companies only; matched existing companies only receive signals). No evidence = "Assessment status: unknown. Needs evidence: ..." (shown as Not Enough Evidence, never a silent 0). A row is appended when numbers, tier or sources change, and at least every 14 days. |
| Enrich | `src/pipeline/enrich.ts` | Only companies with Budget + Release + Timing ≥ `ready_for_contacts_threshold` (25). Free people search first; then one verified work-email lookup per contact within the treg cap. Never pays for LinkedIn; "valid" only = verified; risky stored unverified; invalid not stored; never guesses; same contact + step never paid twice. No budget -> `enrichment_requests.status = skipped_budget`, Authority/Reachability stay "Needs evidence", the run continues. |

Scoring = the **Mando team scoring rubric** (provisional revision of 2026-10-13), rubric version `mando-team-70:pipeline-v2`.
Weights 25/25/20/15/15; **Qualified 70+, Maybe 55+** for rows of this version (`tierThresholdsFor` in
`src/domain/scoring/rubric.ts`; rows of older versions keep 80/55). Code: `src/domain/ingestion/pipeline-score.ts`, tests:
`tests/ingestion/team-rubric.test.mjs`. How each rule maps onto what the pipeline collects:

| Category | Team rubric | What the pipeline can evidence automatically |
|---|---|---|
| Authority /25 | Role base 22/20/18/15/10/5/0; +3 employer 3,000+; +2 personal Workday responsibility; bonuses only for confirmed current contacts; best contact | Base from the title (`authorityBand`). Contacts found by the people search count as **current role unconfirmed** (5, no bonuses) until a person confirms them (`linkedin_status` confirmed/provided). +2 when the title names Workday. +3 only with a sourced employee count (company rows have none yet, so not awarded). |
| Reachability /25 | Email+phone 20, either 15, confirmed LinkedIn only 10, general inbox 5; +3 LinkedIn alongside, +3 dated initiative, +2 leading active Workday work, +5 willing introduction | Published (sourced) or provider-verified ("valid") work email; published direct phone (a live line alone does not count); LinkedIn only when confirmed. +5 only when `mutual_connection` records willingness; +2 is not collected. |
| Budget /20 | Operating-income capacity 10 (+1 +1) + one investment band 8/6/3; funded expansion 20; freeze 0 | Capacity is **not collected** (0, shown in the reason). Investment: dated budget clue within 24 months 8, undated/older 3, active Workday implementation 6. Labelled as a proxy. |
| Timing /15 | Strongest single trigger 15/12/10/8/5 | Go-live within the next 6 months 15, previous 6 months 12, 6-12 months 10; employer Workday hiring within 12 months 8; known customer, skill-only posting or undated go-live 5. |
| Release /15 | Confirmed deployment; 42-84 days before a confirmed release 12 (+3 documented preparation = 15), 85-126 days 10, otherwise 8 | Deployment = known customer, release planning or a past go-live. Bands use `releases.ts` confirmed dates; an estimated next release (2027R1 today) gives 8. |

Reasons are capped at 240 characters; every awarded point carries its link; unknowns say "Needs evidence" without a URL.

## 4. Read the run log and health

```sql
select job, source_id, trigger, status, counts, requests_made, llm_spend_usd, treg_spend_usd, error, started_at, finished_at
from pipeline_runs order by started_at desc limit 20;
select * from pipeline_health;   -- last run, new companies (7 days), review queue, dead letters, spend (7 days)
select * from source_alerts;     -- sources that failed or found nothing in each of their last 3 runs
select * from review_queue where status = 'pending' order by created_at desc;
```

`npm run pipeline -- health` prints the same. A run's `status`: `succeeded`, `partial` (some items failed), `blocked`
(source stopped: 403, CAPTCHA, rate limit or treg 402), `failed` (nothing worked). The runner also logs
`ALERT: source ... last 3 runs` lines. Spend: `var/spend-ledger.jsonl` (gitignored) and `paid_calls`.

## 5. Add a source

1. Add a row to `sources` (migration) with `type`, `frequency`, `max_requests_per_run`, `min_delay_ms`, `enabled`.
2. Implement `Collector` in `src/pipeline/collectors/` returning `RawItem`s exactly as received (put reading context in `meta.kind`).
   Use `PoliteHttp` for HTTP, or `paidTregCall` for treg (budget check + ledger + 402 handling).
3. Register it in `collectors` (`src/pipeline/collectors/sources.ts`) and add a reader for its `meta.kind` in `extractCapture`.
4. Record real responses into `tests/fixtures/ingestion/` (scrub secrets) and add contract tests: happy, empty,
   unavailable, CAPTCHA, 429, 403, malformed, timeout.
Stefan's raw-JSON input work plugs in here: a collector that returns his JSON as `RawItem`s needs no other changes.

## 6. Switch the model

`PIPELINE_LLM=ollama OLLAMA_MODEL=llama3.1:8b`, or a paid provider after approval:
`PIPELINE_LLM=openai PIPELINE_ALLOW_PAID_LLM=1 PIPELINE_LLM_BUDGET_USD=0.50 OPENAI_API_KEY=...`.
The prompt is versioned (`src/pipeline/prompts/extract-vN.md`, `PIPELINE_PROMPT_VERSION`). Compare on the golden set first:
`npm run pipeline:eval -- --model <model> --runs 5 --prompt extract-vN`. Another provider only needs a class implementing
`LLMProvider` (`src/pipeline/types.ts`).

## 7. Enable the schedule (after approval only)

The workflows in `.github/workflows/ingestion-{daily,weekly,rescore,import}.yml` ship with `workflow_dispatch` only.
To turn on a schedule: uncomment its `schedule:` block, set repository secrets `PIPELINE_SUPABASE_URL`,
`PIPELINE_SUPABASE_KEY`, `TREG_TOKEN` and variables `PIPELINE_ALLOW_REMOTE`, `PIPELINE_CONTACT`, `TREG_BUDGET_USD`
(default 0 = no paid calls), `PIPELINE_LLM` (hosted runners have no Ollama; default `none` = structured signals only).
Apply `supabase/migrations/202610190001_ingestion_pipeline.sql` to the target first (after a backup).
**Budget in CI is per run:** the spend ledger is a local file and GitHub runners start empty, so `TREG_BUDGET_USD` caps
each workflow run, not each day. With a daily schedule, the daily treg ceiling is `TREG_BUDGET_USD` × runs per day.
Paid email lookups are still never repeated (`paid_calls` in the database).
The Monday `weekly-snapshot.yml` is unchanged and still runs.

## 8. Verified Workday endpoint facts (2026-10-13)

- `POST https://{tenant}.{pod}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with `{appliedFacets:{}, limit, offset, searchText}`.
  `limit` max 20 (21 -> HTTP 400). `total` is capped at 2000; offsets ≥ 2000 return the same page again. Wrong site -> HTTP 422.
  `searchText` is fuzzy (Target's "Analyst Payroll FinOps" matched "Workday" without containing it).
- `GET .../wday/cxs/{tenant}/{site}{externalPath}` -> `jobPostingInfo` (HTML `jobDescription`, `startDate`, `externalUrl`, `jobReqId`).
- `https://{tenant}.{pod}.myworkdayjobs.com/robots.txt` lists every site as `Sitemap: .../{site}/siteMap.xml` and allows `/wday/`.
  Unknown tenant -> HTTP 422; some private tenants -> 401.
- Name-to-tenant guessing finds about 1 in 4 public-company names (3 of 12 in a probe); abbreviations (WM, MMC) are missed.
