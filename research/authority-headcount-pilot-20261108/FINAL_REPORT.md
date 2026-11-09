# Automatic employee-count continuation — November 8, 2026 (Chicago)

This report supersedes the implementation status in CODEX_HANDOFF.md. The handoff
and earlier benchmark files are retained as historical inputs, not current coverage claims.
The Mac checkout was unavailable in this cloud session and was not modified. The
clean PR head was cloned, the supplied patch was absent, and `git apply --check`
succeeded before applying it. Both PR head and base remained unchanged remotely.

## Behavior

Reviewed domain-matched evidence takes precedence, followed by exact-name/CIK SEC
facts reused from the existing Budget companyfacts response (no additional SEC
request), retained current SEC evidence during temporary failures, then optional
web research. Budget calculation and contact discovery rules are unchanged.

Web research reads verified corporate sites and linked reports, including bounded
PDF text extraction in a worker. Exact-employer Organization/Corporation JSON-LD
supports numeric employee counts and QuantitativeValue values with employee units.
Search snippets discover URLs only. Source access still obeys DNS/private-address,
robots, redirect, response size, request and time limits. Crawl depth competes within
a six-document / eighteen-HTTP-request / 45-second budget; robots and redirects count.
Supplier/customer links are deprioritized/excluded and shallow corporate pages win
before deeper unrelated pages. Official sites can still be unavailable or incomplete.

Claims retain source, quote or structured-data excerpt, numeric precision, date
basis, publication date when present, and observation date. Explicit effective dates
remain distinct from article publication dates; current corporate pages with no
reporting date use a clearly labeled observation, never an invented year-end date.
Effective/publication evidence expires after 548 days; observations after 30 days.
Copyright, modification dates and bare reporting years do not establish effective dates.

Negated, planned/future, acquired-company, customer/dealer, subsidiary, independent
network, local/business-unit, FTE-only, upper-bound, range, ambiguous-unit, conflicting
and ungrounded-date claims are held. Explicit group totals are held for company names
that do not identify a group. This conservative rule can miss valid consolidated
corporate totals. Approximate counts are preserved for diagnosis but do not establish
the 3,000 minimum: web approximations at/above the threshold require review, and the
scorer also excludes approximate reviewed evidence from the size bonus. Exact counts
and supported lower bounds can add the existing +3 only with a relevant confirmed
contact. Assessments label lower bounds and distinguish “as of”, “reported on”, and
“observed on”. Existing reviewed files without metadata remain backward compatible.

The employee research table stores evidence and unresolved reasons, with a 30-day
refresh, 7-day unresolved retry, and 1-day source-failure retry. UUID ownership tokens
and two-minute leases prevent duplicate research; expired/replaced tokens cannot
finish. Entity/domain changes invalidate evidence. Temporary unavailability retains
only still-fresh matching evidence. Missing migration/permissions disable this fallback
for the context while ordinary scoring continues. A default five-company research
cap per context allows subsequent runs to progress past cached cases. Pipeline counters
report evidence origin and unresolved status. Per-document diagnostics are in benchmark
results; the production cache stores the summary reason rather than every document.

## Measured public-source coverage

The expanded roster has 20 companies: public/private, US/international, large and
smaller employers, a university and an independent-firm network. It is a diagnostic
sample, not a representative estimate for the pipeline. No database was accessed.

| Method | Accepted counts | Threshold-supported counts | Unresolved |
| --- | ---: | ---: | ---: |
| Direct official-site crawl | 4/20 (20%) | 2/20 | 16/20 |
| Replayed curated/discovered URLs + live official document reads | 5/20 (25%) | 3/20 | 15/20 |
| Actual live `tinyfish.web.search` through treg | Not run | Not measured | No credentials configured |

The replay uses original recorded search URLs plus expanded URLs curated during this
session. Some additional destinations are corporate navigation candidates, not search
results. Live ChatGPT web search helped investigate GEA, Medtronic, Workday, Atlassian,
Bosch, GitLab, Automattic and Zapier; this is not the pipeline's treg-provider test.
The benchmark transport replays URL discovery and cannot establish provider response
shape, cost enforcement, reliability or end-to-end live-search coverage. Both runs
used actual Cloudflare HTTPS A records because system DNS was unsuitable here;
production DNS behavior is unchanged. The final parser was also used to re-fetch and
re-audit every accepted claim after the runs.

| Employer | Count | Date basis | Source audit |
| --- | ---: | --- | --- |
| GEA Group | More than 18,000 | Observed November 8 | Own global group statement, not an FTE figure |
| Ferring Pharmaceuticals | More than 7,500 | Published February 16, 2026 | Own worldwide workforce; publication is not an effective date |
| Atlassian | 12,000 | Observed November 8 | Named corporate homepage JSON-LD |
| GitLab Inc | 2,500 | Observed November 8 | Named corporate homepage JSON-LD; below threshold |
| Automattic | 1,347 | Observed November 8 | Named corporate homepage JSON-LD; below threshold |

All five accepted sources were fetched afresh and manually checked for identity,
scope, units and dates. The final extractor reproduced each count/precision/date basis.
`accepted-source-audit.json` retains source URLs, response status and content hashes.
JSON-LD counts are self-published observations, not independently verified HR totals;
no reporting date or precision beyond what the publisher asserts is inferred.

The earlier SEC check found 2/7 usable facts (Constellium 11,500, Green Brick 620).
It was not rerun here and must not be added to the 20-company web numerator. Historical
manual pilot inputs and earlier 12-company files likewise are not automatic coverage.

## Unresolved-case diagnosis

Full per-URL outcomes are in web-direct-final.json and web-replay-final.json.

| Employer | Remaining gap / disposition |
| --- | --- |
| Medtronic | Corporate variants, robots restrictions, timeout and no qualifying dated claim within budget; a manually reviewed filing is not automatic coverage |
| Norconsult | Approximate 7,200 and ambiguous nearby article dates; no guaranteed lower bound accepted |
| Workday | Current count is presented in cards/graphics and reports; bounded pages did not establish a qualifying workforce sentence/structured field |
| Caterpillar | Dealer count explicitly rejected; corporate scope and robots access unresolved |
| Shell | Employer metadata identity not established; no inferred parent/group total |
| Datadog | Report/static-file discovery and page text did not yield an accepted dated own-workforce statement |
| Canva | Limited readable pages and robots restrictions; no qualifying claim |
| Deloitte | Intermittent HTTP 503 plus independent-firm network/approximate workforce scope, requiring review |
| Washington State University | Facts/report PDFs not successfully established within navigation/access limits; linked-host robots returned 403 |
| HubSpot | No qualifying dated own-workforce claim within document budget |
| SAP | Robots disallow access; no bypass attempted |
| Siemens | No qualifying statement; one document response was not readable HTML/PDF |
| Bosch Group | Exact employer metadata identity absent; approximate associates and R&D-only figures are not accepted employee totals |
| IKEA | Group/entity scope and no qualifying dated statement within budget |
| Zapier | No qualifying statement in bounded pages; unresolved, not assumed small |

PDF extraction is tested with an actual generated PDF, but no accepted claim in this
web sample came from a PDF. Employee tables, chart/image OCR, year-only report dates,
non-English workforce terminology, ambiguous entity aliases and discovery beyond the
bounded crawl remain coverage gaps. The conservative ownership rules reduce false
positives but cannot promise complete natural-language interpretation.

## Validation

- Node 24.22.1, clean `npm ci` using a workspace-local cache.
- `npm test`: 639 passed, zero failed.
- `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- `EMPLOYEE_TEST_POSTGRES_CONTAINER=mando-headcount-test npm run test:integration`:
  2 passed, 11 skipped, zero failed. The PostgreSQL migration test passed against an
  isolated PostgreSQL 17 Docker container with a disposable database. It executed the
  actual migration and tested simultaneous claims from separate processes, lease
  expiration, stale tokens, retry intervals, retained evidence, identity changes,
  service-role completion, invalid statuses and denied anon/authenticated access.
- Supabase/PostgREST-specific integration cases were skipped. The installed Supabase
  CLI could not create its config under the read-only home directory. PostgreSQL
  validates actual SQL/locking/permissions, but does not establish REST adapter behavior.
- `git diff --check`: passed. Shared-file diffs are limited to headcount wiring,
  shared HTTP document access, optional store methods and workflow environment entries.
  No teammate branches or messages were changed.

Current Supabase/company/contact/score credentials were not configured in this
cloud environment. No actual current score preview was possible. The GET-only preview
script is prepared and tested; current qualification gain remains unmeasured. Historical
scores must not be increased by three and presented as new qualifications.

## Publish and activation

PR #50 remains draft against refined-scoring. Cloud Git push and GitHub Git Trees
writes both returned HTTP 403; the connected integration could read but not publish
these commits. This does not establish whether the user's Mac login can push. No
merge, shared migration, production activation, paid service or teammate message occurred.

After publishing the validated commit to Avan/authority-headcount-evidence:

1. Review shared-file integration with the current Budget/contact branches and rerun CI.
2. Approve the 30-day observation policy, structured-data policy and conservative
   approximation/group handling. Run the real zero-cost treg endpoint in an authorized
   environment if search-assisted rollout is desired. Direct crawling needs no search key.
3. Run Supabase REST integration against an isolated local Supabase instance.
4. With existing private environment configuration, run the GET-only current-score
   preview and review employer/contact scope. Do not export secrets or contact data.
5. Obtain explicit approval before applying 202611080001_employee_research.sql to
   shared Supabase, merging, or enabling production. Apply migration before enabling
   PIPELINE_EMPLOYEE_WEB_RESEARCH=1; optionally set PIPELINE_EMPLOYEE_WEB_MAX_COMPANIES
   (default 5, maximum 20) in repository workflow variables.
6. Start a small approved rollout, inspect origin/unresolved counters and retry rows,
   and audit live accepted sources before expanding. Disable the feature variable to
   stop new web research; this does not roll back previously saved assessments.
