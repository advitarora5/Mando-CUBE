# Company input automation

Group 2 scope: discover Workday HCM go-live dates and current Workday-related
jobs, preserving source evidence. Extends the preview collectors on
`krish/input-automation`, integrated against current main. No schema changes,
category-score generation, contacts collection, persona generation, or weekly
score/rank history. Existing tables, source strings, and research evidence
conventions remain in use.

The existing standalone preview commands still work:

```sh
node scripts/collect-signal-dates.mjs --companies companies.json --out dates.json
node scripts/collect-job-postings.mjs --boards boards.json --out jobs.json
```

Company records use the existing UUID `id`. Board records require `company_id`,
`company`, `board`, and `board_token` (plus observed Workday site fields when
applicable). The job preview now returns `{ jobs, checks }`, including successful
empty-board checks and explicit failures, rather than mixing failures into job
rows. Use the combined refresh command below for employer/board discovery and
reconciliation. Both standalone commands remain preview-only.

## Run locally

Use Node LTS (24). From the repository root:

```sh
npm ci
npm run inputs:refresh -- --companies src/data/research/workday-companies.json --out src/data/input-automation/latest.json
```

To discover additional sources, set `BRAVE_SEARCH_API_KEY` in ignored
`.env.local` and run the same command with Node's environment-file flag:

```sh
node --env-file=.env.local scripts/refresh-company-inputs.mjs --database --out src/data/input-automation/latest.json
```

`--database` reads the existing companies (paginated), including IDs and edit
versions. It requires the existing server-only Supabase environment variables.
Without a search key, only supplied sources and discoverable employer links
are checked. Search snippets never become stored facts. No LinkedIn sources
are fetched, including redirect destinations.

Use `--company-id UUID` for a pilot. Optional `--config FILE` accepts an object
keyed by existing company UUIDs; see `src/data/input-automation/config.example.json`.
Replace the fictional example entirely. `signal_urls` add primary sources;
`employer_domain` supplies a reviewed website when the company field is null.
The collector can also derive a domain from an outbound link in the existing
official Workday customer story, but only when the domain's company label
exactly matches the company name and there is one unambiguous domain. This
mapping and its evidence stay in the report; no company domain field is changed.
`trusted_hosts` explicitly approves partner domains after human verification.
`career_urls` and `boards` assert a reviewed employer-to-board mapping. Do not
guess a token from the company name. Config files must contain no credentials.
Keep public employer mappings in `src/data/input-automation/config.json` if
the team wants the workflow to use them.

## Date acceptance and review

An automatic candidate requires a trusted source (Workday, a verified company
domain, or a reviewed partner host) and a short sentence with the exact named
company followed by a completed event, Workday HCM product, and explicit `on`
date. For example: `Acme went live with Workday HCM on March 4, 2024.`
Accepts ISO dates and spelled-out English calendar dates. Ambiguous numeric
dates, approximate dates, future/invalid dates, selection/publication dates,
finance-only, uncertain/partial/regional deployments, and dates not attached
to that named event stay unverified. These intentionally narrow English rules
will miss legitimate announcements with other wording/languages.

All candidate excerpts are retained. Conflicting candidate dates block an
update. A different existing date is always preserved for human review; the
dashboard's existing editor can make a reviewed correction. No matching
evidence leaves the existing value untouched. Public pages can themselves
contain incorrect facts; deterministic extraction does not prove truth.

## Jobs and activity

Career links on employer-owned pages establish Greenhouse/Lever/Workday board mappings.
Greenhouse's public Job Board API and Lever's global/EU Postings API return
published roles; Lever pagination is exhausted before a refresh is complete.
Descriptions and duties supply Workday relevance evidence even when the title
only says HRIS Analyst. Consulting and incidental mentions are marked for
review; none prove the company uses Workday HCM or has buying intent.

Employer-page JobPosting JSON-LD is a fallback. It requires the exact employer
name and an actual same-host posting URL; activity remains unknown without a
valid future deadline.

For employer-linked `*.wdN.myworkdayjobs.com` sites, the adapter verifies tenant
and career-site identifiers in the actual public page, then uses that page's
anonymous CXS search/detail feed. This is an observed public frontend interface,
not a documented supported Workday tenant API. It may change; malformed,
redirected, mismatched or incomplete results fail closed. The collector searches
for Workday, exhausts pagination, and fetches the actual job descriptions and
canonical posting URLs. Activity requires `posted` and `canApply` to be true.
A keyword-filtered inventory cannot prove expiration when a job disappears;
those earlier jobs become unknown. No posting/start date becomes a go-live date.
A Workday-hosted careers page itself does not establish HCM customer status.

Records retain company UUID, employer, actual URL, posting ID/requisition,
location, relevant excerpt, checked time, mapping evidence, and status.
Failed, malformed, or incomplete API refreshes mark previous observations
unknown and retain their evidence. Only absence from a complete unfiltered
Greenhouse/Lever board establishes expiration. Reuse the same output file to reconcile jobs
between runs. Refreshing one company preserves records for other companies.

## Database apply and scoring handoff

First run a dry run. Manually check every proposed date update and a sample of
job matches against the original pages. Record precision (correct accepted
results / reviewed accepted results) and coverage (companies with verified
dates or supported job sources / companies checked). There is no claimed
accuracy percentage before this validation. No LLM generates these facts.

Once the team has reviewed the extraction rules and pilot results:

```sh
node --env-file=.env.local scripts/refresh-company-inputs.mjs --database --company-id UUID --out src/data/input-automation/latest.json --apply
```

Apply collects fresh evidence; it cannot apply an edited report. Evidence is
written before mutations. Only empty `companies.workday_signal_date` fields
are filled, with an `updated_at` comparison to prevent concurrent overwrites.
Each result has an apply status. Writes are per company, so a run may partially
succeed; inspect the report before retrying. Existing company confirmation
`source`, scores, insight overrides, contacts and snapshots are preserved.

The report is the current file-level research evidence artifact, following
the existing research dataset convention, not a new database model. Per-company
`scoring_inputs` exposes the date, `timing_evidence` as `URL | reason`, and
active `job_evidence_candidates` in the same evidence format. Relevant and
consulting-review roles are handed off; incidental mentions stay in the full
posting report but are excluded from scoring candidates. Go-live evidence
belongs to Timing Trigger, not Release Alignment. The existing `score:save`
command is preserved; its reviewed assessment CSV accepts `timing_source` and
`timing_reason`, with blank `timing_score` calculated from the saved company date.
This collector supplies evidence rather than generating category scores.

The scoring owner
must confirm internal-role relevance and map job evidence to the approved
category. Do not insert assessments with copied category scores just to attach
new evidence. Numeric recalculation still belongs to the scoring engine; the
dashboard's existing days-since-signal display updates from the date field.

## Scheduled runs and checks

`.github/workflows/company-inputs.yml` runs daily and on manual dispatch after
merge to main. It defaults to dry run and uploads a 30-day evidence artifact.
On pull requests, a separate job runs repository tests, lint, typecheck, and
build without secrets or collection/database access. PR validation does not
prove live source coverage. Production scheduling needs this workflow merged
into `main`; Vercel deployment alone does not execute the collectors.
Configure `BRAVE_SEARCH_API_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` as GitHub
Actions secrets, separately from Vercel. Set repository variable
`INPUT_AUTOMATION_APPLY=true` only after reviewing a pilot; manual dispatch can
also enable apply. Apply fails closed without database credentials.

The workflow restores the most recent unexpired evidence artifact from the
same branch before collection to reconcile prior job status. If no previous
artifact exists, it starts with current observations and makes no claim about
earlier expiration. This is input provenance, not weekly score/rank storage.
Artifacts must be downloaded and retained by the scoring owner for longer-term
provenance; they are not automatically loaded into dashboard score rows.

Evidence is checkpointed after each completed company. `complete: false` means
the run stopped before all requested companies were processed; unvisited
companies' previous postings are retained. The report lists requested IDs and
completed companies, and the CLI summarizes source failures and coverage gaps.
Source failures exit nonzero; a successful board with zero relevant jobs is
different from an unsupported source or failed refresh. Source failures never
clear dates or imply a posting expired.

Timeouts, bounded responses, validated public HTTPS destinations/redirects,
and bounded retries protect against unbounded collection. Hosts denying access
remain gaps. Source failures exit nonzero after preserving the report; an empty
successful board is different from a failure.

```sh
npm test
npm run lint
npm run typecheck
npm run build
```

Sources: [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html),
[Lever Postings API](https://github.com/lever/postings-api),
[Brave Search API](https://api-dashboard.search.brave.com/documentation),
[Workday newsroom](https://newsroom.workday.com/press-releases).

## Integration verification (October 7, 2026)

Integrated with `main` after PRs #3, #5, and #6. Local validation passed all
75 repository tests (22 input-automation tests), lint, typecheck, and the
production build. The diff from `main` is confined to input collectors, their
configuration/workflow/tests, and setup documentation; no schema or UI changes.

A preview against the real 3M research record preserved a report, proposed zero
dates, and exited nonzero for an unavailable source. This execution workspace
could not resolve `www.workday.com` (`EAI_AGAIN`), so live dates/job coverage and
the Workday careers adapter are not yet verified here. No database writes were
performed. The search key was absent during this preview.

Before enabling apply, run a live pilot from a network-enabled environment with
the reviewed source mappings and, if needed, the optional search key. Inspect
original source excerpts, employer mappings, posting activity, and coverage
gaps. Configure GitHub Actions secrets separately from Vercel, merge the PR
after review, then verify the scheduled/manual dry run and its evidence artifact.
Leave automatic apply disabled until that pilot is reviewed.

## First GitHub live run and follow-up

Manual dry run 37581082586 on October 7 read 136 database companies, preserved
its evidence artifact, and made no database writes. It found six active 3M
postings, of which two were relevant Workday roles; incidental mentions are
excluded from the scorer handoff. No exact go-live dates were proposed. Only
three companies had supported job sources, so discovery coverage remains limited.
The optional Brave search key was absent.

The run exited nonzero for 24 source failures: 18 involved the nine fictional
records from `seed-demo.mjs`, and six involved unavailable real sources. The
follow-up skips only those nine known seed UUIDs, adds bounded failure diagnostics,
and separates relevant-role counts from incidental mentions. Real source failures
still exit nonzero; skipping demos does not resolve the remaining discovery gaps.
No schema, dashboard, or weekly-history changes are needed.

For a smaller manual pilot, set the workflow's optional `company_id` to an
existing company UUID. For the verified 3M record use
`36890587-f5bf-59af-ad10-f62c4b822862`, and leave `apply` false. Blank runs all
companies. Retained evidence for companies outside a pilot is preserved but
excluded from that pilot's summary counts. Review the evidence artifact before
enabling writes. Improve coverage using reviewed employer/career mappings in
`config.json` and, optionally, the GitHub secret `BRAVE_SEARCH_API_KEY`.
