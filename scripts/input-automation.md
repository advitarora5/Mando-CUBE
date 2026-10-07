# Company input automation

Group 2 scope: discover Workday HCM go-live dates and current Workday-related
jobs, preserving source evidence. Extends the preview collectors on
`krish/input-automation`, integrated against current main. No schema changes,
category-score generation, contacts collection, persona generation, or weekly
score/rank history. Existing tables, source strings, and research evidence
conventions remain in use.

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
`scoring_inputs` exposes the date, `release_evidence` as `URL | reason`, and
active `job_evidence_candidates` in the same evidence format. The scoring owner
must confirm internal-role relevance and map job evidence to the approved
category. Do not insert assessments with copied category scores just to attach
new evidence. Numeric recalculation still belongs to the scoring engine; the
dashboard's existing days-since-signal display updates from the date field.

## Scheduled runs and checks

`.github/workflows/company-inputs.yml` runs daily and on manual dispatch after
merge to main. It defaults to dry run and uploads a 30-day evidence artifact.
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
