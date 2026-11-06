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
npx supabase db push --local          # apply new pipeline migrations to an existing local database
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
| `TREG_TOKEN` | Existing treg credential. When empty, the signed-in `treg` CLI is used unless disabled. |
| `TREG_ORG` / `TREG_DISABLE_CLI` | Organization slug (our local setup uses `cube`); set `TREG_DISABLE_CLI=1` to prevent implicit CLI fallback. |
| `TREG_BUDGET_USD` | Session cap for paid treg calls (default 0.50). `--max-spend` lowers it per run, never raises it. |
| `PIPELINE_CONTACT` | Contact address sent only to `sec.gov`, which answers 403 without one. Every other site gets `mando-cube-ingestion/1.0`; a URL in the agent gets 403 from SEC and several corporate firewalls. |
| `PIPELINE_SEC_FILE` | Optional local copy of `company_tickers.json`, used when `PIPELINE_CONTACT` is empty or the live SEC request fails. |

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

Discovery selects unattempted company names in SEC list order. Attempt history is checked in
pages of up to 200 names until the requested batch is filled or the list is exhausted, so later
runs advance beyond previously probed names even deep into the list.

The resolver interleaves new names with due rechecks. Successful discoveries become eligible
after **7 days**, completed misses after **30 days**. Known-site refresh takes priority over
miss retries; within each group the oldest attempt goes first. These are eligibility intervals:
actual execution depends on the schedule and request/item limits. At scale, allocate enough
capacity to revisit known sites before their 14-day evidence lifetime ends. Rechecks count toward
the resolver's existing limit, so not every returned site will be newly discovered.

Known hosts are checked directly before tenant guesses. Unchanged robots captures refresh the
existing signals' `last_seen_at` without duplicating them. Failed or vanished sites do not renew
evidence. Network/server failures and searches cut short by the request cap do not become
completed misses or reset an existing retry clock; they remain eligible on the next run. The
existing HTTP retry/backoff and source-stop rules still apply. Dry runs do not save attempt times.
This uses the existing `found` / `tried_at` columns; no database migration is required.

## Website confirmation and review recovery

### Local AI admission experiment

`npm run pipeline:admission:local -- --input candidates.json --output var/new-admission-run`
is a separate manual experiment. It refuses remote database/model endpoints and remote
overrides. It uses local Supabase and local Ollama `qwen2.5:7b`; it never runs scoring,
contact research or paid APIs. Normal pipeline commands and scheduled admission retain
their existing rules. No migration or source-setting change is needed.

Input is an array such as `[{"name":"Example Inc","corporate_urls":["https://example.com/"]}]`
(corporate URLs optional), or a saved SEC-object subset with `title` fields. Maximum 25
names. Discovery names must exist in the saved SEC snapshot. The experiment scopes
discovery/collection to that list, enables corporate-careers discovery only for this run,
and retains captures and signals. `--admission-only` instead evaluates already collected
candidates. Extraction is structured; Qwen is used for identity only.
For a frozen comparison, combine `--admission-only --packets packets.json` to use the
exact previously collected identity evidence without refreshing the paired pages/jobs.
Packets must match the selected name and each exact site, and remain within the normal
fourteen-day evidence window. This does not restore the database baseline for you.
`--reuse-results previous-results.json` can reuse valid answers with `--packets`; the
normal signature, model digest and freshness checks still apply. Model calls and reused
answers are counted separately in `identity-call-counts.json`.

AI-confirmed corporate identity replaces direct-link proof in this path; original signal
confidence is preserved. For a `first_word` site, whose tenant was guessed from one word of
the name, the candidate's own name must also be written on the corporate side of the evidence;
the Workday side does not count, because it says nothing about whether a same-word website is theirs.
Guessed websites are never treated as proof either: a same-name `.org` is skipped once that name's
`.com` answers, and a name with a legal form (Inc, Corp, PLC) is never checked against a guessed
`.org` or `.edu`, because the model has accepted a namesake charity on one shared word. A site
observed in the evidence, or a name with no legal form (a health system), is still checked.
A careers host (`jobs.`, `careers.`, `search-careers.`) also brings its parent domain as a hypothesis, because a company
is better stored under its main site. If the parent failed only the full-name check and the careers host passed with the
name, the parent is stored: `careers.manulife.com` passing makes `manulife.com` the company's domain. Up to three corporate URLs
and three exact sites are evaluated per candidate, within `--max-checks` (default 50,
maximum 100) and the matching time/request caps. Every observed enabled sibling site
must pass for one unambiguous corporate domain; disabled siblings or more than three
sites require manual review because existing admission RPCs link sites by company name.
Duplicate/merge review, prior human resolutions and the new-company cap still apply.
Negative/uncertain verdicts, absent evidence and failures remain held. Exhausted checks hold
a candidate unless one corporate domain has already passed against every site.
AI confirmation is never written to the normal direct-link cache.

The new output directory records selected names, a baseline, stage reports, frozen
identity packets, full verdicts/explanations, candidate outcomes and retained signals.
Missing-site discoveries and missing model input are counted separately. Legacy review
reason `no_website` also covers AI identity holds; use `identity-outcomes.json` for the
specific explanation. These outputs do not measure accuracy until independent reference
labels are supplied. Snapshot the local database before the controlled old/new comparison;
reuse the same frozen packets for policy comparison, and label a fresh evaluation batch
before revealing model verdicts. Evidence still expires after fourteen days.

### Discovery recovery (local experiment)

The resolver accepts exact tenant/pod sitemap URLs on both `myworkdayjobs.com`
and `wdN.myworkdaysite.com/recruiting/tenant/site/`. Full-name guessing tries
seven configured common pods by default, including observed `wd503`; first-word
guessing still tries three. Existing request caps apply. Complete trailing SEC
tags such as `/CAN/` are removed before generating names, without leaving a fragment.

Primary-site selection uses the tenant brand before the shortest career-like name. For
example, `shell` prefers `ShellCareers` over `NOVCareers`. The job collector can recover
observed alternatives from a saved robots capture, including databases that only stored
an older primary choice. It tries at most three sites per tenant. A successful unfiltered
empty job response allows trying the next site; zero keyword hits on an otherwise live
site do not. Access errors and challenges stop that tenant rather than triggering fallback.

The resolver has an **opt-in** `sources.config.corporate_discovery: true` path after
name-derived tenant guesses miss. It starts with `corporate_websites[normalized_name]`
(a URL or URL array), existing company/review domains, then a compact full-name `.com`
hypothesis. These URLs are candidates, not ownership evidence. Without a configured
lookup service, this remains a limited domain-discovery strategy.

Each homepage must independently identify the complete normalized company name. The
resolver follows same-company careers links and can check conventional `careers.` / `jobs.`
subdomains and `/careers`; every resulting page must also independently identify the
company. Only HTTPS links to an exact `tenant.wdN.myworkdayjobs.com` host and site are
extracted. Comments, script-only anchors, malformed paths and off-domain careers redirects
cannot supply a site. Corporate HTTP uses the existing DNS, robots, redirect, body and
timeout guards. It has a maximum of twelve requests per company, included in the resolver's
overall request cap; at most two candidate roots and three careers URLs per root are tried.
Access/transport failures are retryable, not completed discovery misses.

Successful HTML is retained unchanged as a `corporate_careers` raw capture. Extraction
rechecks its page identity and exact anchor, creates a `careers_link` site and a **0.6**
discovery signal, and retains the verbatim source anchor. This does not confirm the
corporate website or connect the shadow identity checker to admission. Fresh evidence
and the existing website confirmation are still required.

Do not enable this experiment on scheduled or shared runs without reviewing a local
comparison first. The saved twenty-name batch is useful for a before/after discovery
comparison, not a fresh identity holdout.

Apply the website migrations through `202610250002_employer_website_confirmation.sql` to the local database before running this version.
The migration adds `website_resolutions` with service-role-only access and an atomic review-admission
RPC. Production rollout is a separate step: the Supabase integration may deploy migrations merged to main.

Website resolution first checks distinct domains explicitly linked from saved Workday postings,
even if no lookup provider suggests them. A domain must independently identify the company;
posting links alone are insufficient. At most five source domains are checked per candidate;
additional source domains leave the result unresolved for review. A unique complete confirmation
does not require Hunter or TinyFish to be configured or called.

If no source domain confirms, Treg's free `hunter.x.domain-finder` supplies up to three candidates per query. If a legal-name query returns no usable exact-name candidates, one retry uses the complete normalized name (for example, `ASML HOLDING NV` → `asml`). Both query results are saved; unrelated names remain unconfirmed. Both maximum route cost and waterfall
are set to zero, and successful HTTP/CLI responses must explicitly report a zero charge. There is no paid
website-lookup fallback. If none of those candidates passes confirmation, one `tinyfish.web.search`
request searches the full company name plus “official corporate website careers.” This is a different
provider accessed through the existing Treg transport. It also requires an explicit zero charge and
disables paid fallback. At most ten search rows are inspected and three safe distinct hostnames
checked; explicit parent hostnames are preferred over their subdomains only when both occur in the
results. Search queries, selected URLs and titles are retained as candidate provenance. Titles and
snippets are not confirmation evidence. This path does not use the contact-enrichment budget or an LLM.

A website is confirmed only when:

1. For Hunter candidates, the provider name exactly matches the normalized candidate name (legal suffixes are ignored). Posting links and search results supply candidates independently of Hunter and must pass the following checks.
2. Its homepage identifies that same company in its title, site-name metadata, structured `Organization` or `Corporation` data, or an explicit copyright element naming the complete legal owner. Arbitrary body mentions and first-word brand guesses are insufficient.
3. Either its homepage/careers pages link to the observed enabled Workday **tenant and site**, or a stored job from that exact tenant/site explicitly links to the candidate website through `hiringOrganization.url` or an anchor in `jobPostingInfo.jobDescription`. The candidate homepage must still identify the company independently.
4. Corroboration resolves to one canonical hostname. Source domains are checked before provider lookups. Multiple corroborated websites stay unresolved. A competing candidate that independently identifies the company but cannot finish its ownership checks also prevents confirmation. Failures before company identity is established remain in the saved evidence but do not veto another candidate's complete proof. With no complete proof, access failures remain errors with retries. Weak signals remain pending even when the website is confirmed; this does not upgrade discovery confidence or change the admission threshold.

HTTPS page and robots.txt redirects are limited to three hops and checked individually. Rules obtained through a robots redirect apply to the original origin; page redirects check the destination rules too. Loops, unsafe targets and genuine challenges remain failures. Fetches have
time/size/request limits and reject IP/private-network targets. HTML is capped at 2 MiB, robots at 512 KiB. Up to three careers pages are followed, prioritizing the landing page and its job-search links over saved jobs or unrelated news. A normal reCAPTCHA form script is not treated as an access challenge. No browser rendering or access-control bypass
is attempted. A homepage's HTTP 200, matching name alone or arbitrary body mention is insufficient.
Aliases that redirect to the same verified hostname collapse together. A parent/subdomain relationship to an
existing company goes to human review rather than creating another company or guessing a root domain.

Employer-link evidence comes only from HTTP-200 job captures on an enabled, exact Workday host and CXS tenant/site path, with matching collector metadata. At most 20 recent captures per company are inspected. Evidence must have been fetched or seen through its signals within 14 days. Shared document/social/ATS domains, comments, script-only links and unsafe URLs cannot confirm ownership. A benefits link on a third-party domain does not pass unless that website independently identifies the candidate company; known shared hosting platforms are excluded entirely. A link on the company's own domain (such as NVIDIA benefits on `nvidia.com`) can corroborate that domain. Workday discovery confidence is not upgraded by website confirmation.

`website_resolutions` retains queries, candidate domains/names, employer URLs with capture IDs/field names, identity text, proof-page and Workday URLs,
reasons, timestamps and the input signature. Confirmations are reusable for 30 days; unresolved results
retry after 7 days; transport/check errors retry after 1 day. New eligible employer-link evidence or a changed set of observed Workday sites
invalidates the cache immediately; verifier version changes also invalidate older results. These intervals differ from the Workday discovery retry intervals above.
At most 50 due candidates are evaluated per matching stage; website HTTP has a 300-request cap and the
stage stops starting candidates after five minutes. Deferred work stays queued. Each request has a ten-second
timeout; Treg lookup has a fifteen-second timeout. In-flight work may finish after the stage time threshold.

Matching revisits pending `no_website`, `untrusted_signal` and `over_run_cap` reviews even without new
unassigned signals. Fresh evidence, a confirmed website, an HTTPS evidence URL and room under the cap
allow creation; a guessed `first_word` tenant also needs the company's name on that website. Existing confirmed domain matches attach to the existing company. Recovered admission locks
the pending review and creates/resolves/attaches in a single transaction; failure leaves it pending for retry.
New signals/sites join that review before admission. Rejected decisions remain rejected; `similar_name`
reviews remain human decisions. Confirmation may fill their empty website field, but cannot resolve them or overwrite an existing website choice. Cap-limited reviews can recover on the next run using cached confirmation.
Expired signals cannot unlock company creation until fresh evidence arrives.

Website/provider errors appear in matching stage errors and therefore the CLI failure signal. Provider
401/402/403/429 and nonzero/unknown charge responses stop further lookups for that stage. Other candidates
can continue after an individual website failure. Ordinary unresolved/ambiguous results remain review work.

This deliberately favors precision. Short brand aliases, JavaScript-only pages,
third-party careers portals outside the company domain, inaccessible pages and companies without either form of observable Workday corroboration may
require manual review. A small live local batch must measure coverage before production or scheduling.
Other input sources can reuse the lookup; automatic confirmation currently requires an observed Workday site.

Inspect the evidence with:

```sql
select company_name, status, domain, reason, next_check_at, evidence
from website_resolutions order by checked_at desc;
```

## 3. Stages and rules

| Stage | What it does | Rules |
|---|---|---|
| Collect | `src/pipeline/collectors/*`, all `Collector.collect(source, limits, ctx) -> RawItem[]` | Plain HTTP/JSON, robots.txt checked, ≥1 s between requests to the same site, backoff on 429/503 (max 2 retries, Retry-After capped at 30 s). 401/403, CAPTCHA and "unavailable" pages (including 200 responses that are not the expected JSON) stop the source and are logged. |
| Raw store | `raw_captures` | Body exactly as received + SHA-256 fingerprint (volatile fields such as "Posted 3 Days Ago" excluded). Unchanged items are skipped and only refresh their signals' `last_seen_at`. Immutable (trigger). `pending_captures` is the work queue. |
| Extract | `src/pipeline/extract.ts` | Structured fields read directly (titles, dates, URLs, Workday tenant). The model reads only messy text into the fixed schema (`src/domain/ingestion/extraction-schema.ts`), temperature 0, JSON-schema constrained, retry once, then dead-letter. Quotes must be verbatim (else the signal is dropped); company, products, timing words, dates and project type must be supported by the text (else cleared and counted as hallucinations). Model down = captures stay queued. |
| Signals | `signals` | go_live, hiring, release_planning, known_customer, budget_clue, event; link, date, quote, confidence. Every type expires 14 days after last seen, except go-live (date bands). |
| Match | `src/domain/ingestion/matching.ts` | Confirmed exact website match merges. An unconfirmed website suggestion cannot assign signals to an existing company. Similar name -> review (`similar_name`, with suggestion). New company + confirmed website + verified Workday connection (yes/no; stored signal confidence does not decide it) -> created with `origin = pipeline` (atomic SQL function). Else review (`no_website`, `untrusted_signal` for an unverified connection, `over_run_cap`). Workday itself is excluded. Size never blocks ("size unknown" when missing). |
| Score | `src/domain/ingestion/pipeline-score.ts` on the shared `buildAssessment` / `evaluateTier` | Only companies in scope (`scoring_scope = pipeline_only` -> pipeline companies only; matched existing companies only receive signals). No evidence = "Assessment status: unknown. Needs evidence: ..." (shown as Not Enough Evidence, never a silent 0). A row is appended when numbers, tier or sources change, and at least every 14 days. |
| Enrich | `src/pipeline/enrich.ts` | Only companies with Budget + Release + Timing ≥ `ready_for_contacts_threshold` (25). Free people search first; then one verified work-email lookup per contact within the treg cap. Never pays for LinkedIn; "valid" only = verified; risky stored unverified; invalid not stored; never guesses; same contact + step never paid twice. No budget -> `enrichment_requests.status = skipped_budget`, Authority/Reachability stay "Needs evidence", the run continues. |

Scoring = the **Mando team scoring rubric** (provisional revision of 2026-10-13), rubric version `mando-team-70:pipeline-v3`.
Weights 25/25/20/15/15; **Qualified 70+, Maybe 55+** for rows of this version (`tierThresholdsFor` in
`src/domain/scoring/rubric.ts`; rows of older versions keep 80/55). Code: `src/domain/ingestion/pipeline-score.ts`, tests:
`tests/ingestion/team-rubric.test.mjs`. How each rule maps onto what the pipeline collects:

| Category | Team rubric | What the pipeline can evidence automatically |
|---|---|---|
| Authority /25 | Role base 22/20/18/15/10/5/0; +3 employer 3,000+; +2 personal Workday responsibility; bonuses only for confirmed current contacts; best contact | Base from the title (`authorityBand`). Contacts found by the people search count as **current role unconfirmed** (5, no bonuses) until a person confirms them (`linkedin_status` confirmed/provided). +2 when the title names Workday. +3 only with a sourced employee count (company rows have none yet, so not awarded). |
| Reachability /25 | Email+phone 20, either 15, confirmed LinkedIn only 10, general inbox 5; +3 LinkedIn alongside, +3 dated initiative, +2 leading active Workday work, +5 willing introduction | Published (sourced) or provider-verified ("valid") work email; published direct phone (a live line alone does not count); LinkedIn only when confirmed. +5 only when `mutual_connection` records willingness; +2 is not collected. |
| Budget /20 | Operating-income capacity 10 (+1 +1) + one investment band 8/6/3; funded expansion 20; freeze 0 | Capacity comes from SEC company facts, from the newest 10-K, 20-F or 40-F under US GAAP or IFRS, in the filer's reporting currency. Nothing is converted, because the rubric asks only whether the figure is positive and grew, and years are compared within one currency. A filer with no usable operating figure (banks usually report none, a figure identical to revenue is total income, and a tag can stop being filed) uses pre-tax income on the same bands, labeled "pre-tax income" in the reason; a real operating loss is never replaced. Not collected (0, shown in the reason) with no filing or a stale one. Investment: dated budget clue within 24 months 8, undated/older 3, active Workday implementation 6. Labelled as a proxy. |
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

For `pipeline run`, the CLI exits **0** when every executed stage succeeds and **1** if any stage is
`partial`, `failed`, or `blocked`. Later stages still run, and the JSON report includes an overall
`status` (`succeeded` or `failed`) plus each stage's `blocked` reason and `errors`. Standard error
also lists unsuccessful stages, so GitHub Actions marks the command as failed. Every executed
stage participates in this result; disabled sources do not run. Clean empty results, candidates
awaiting review, and ordinary contact-budget skips remain successful. Logged source alerts alone
do not change the exit code. This does not enable any schedules.

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
