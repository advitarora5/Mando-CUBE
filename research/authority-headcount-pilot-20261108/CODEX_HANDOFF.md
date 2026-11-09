# Continue employee headcount automation for Mando-CUBE

## Objective and authorization

Avan wants employee-count evidence collected automatically during the company pipeline,
with correct entity scope, source and date, to support the existing +3 Authority bonus
for confirmed relevant contacts at employers with 3,000+ employees. Automate research
for all eligible pipeline companies and report unresolved cases. Do not promise 100%
source coverage. Continue development, tests and a public-source pilot on Avan's branch.
Coordinate with Stefan's contact work and Aadi's financial-capacity work. Keep shared
Supabase data and other branches intact. Production rollout and merging need review.

## Repository and transfer

Repository https://github.com/advitarora5/Mando-CUBE
PR https://github.com/advitarora5/Mando-CUBE/pull/50
PR base refined-scoring, head Avan/authority-headcount-evidence.
Avan's Mac checkout is /Users/avanteuer/Documents/Codex/2026-11-01/here-x20/work/Mando-CUBE.
His existing branch contains PR #50's original single commit 2de46fca10872f3ecbab5d8a67216794b131351e.
Our corresponding local original commit b9b4069 has the same content. Additional
committed pilot/SEC work and uncommitted web fallback changes have NOT been published.
The supplied codex-employee-headcount.patch is a complete binary-capable git diff
from that original content, including this handoff and all later work. Inspect
local status and run git apply --check before applying it. If already applied, do
not apply twice. Never reset or overwrite unrelated local edits.

## Completed and in-progress implementation

1. Original PR reads reviewed JSON via PIPELINE_EMPLOYEE_EVIDENCE_FILE, checks
normalized domain and 548-day age, scores and preserves provenance. PR's GitHub
unit and disposable-Supabase integration checks passed. Vercel preview built.
2. Local SEC extension parses dei.EntityNumberOfEmployees from the existing
Budget companyfacts response, matching CIK and normalized entity name, with no
extra SEC request. Reviewed evidence takes precedence. It handles amendments,
contradictions, expiry and temporary SEC failures retaining valid saved evidence.
3. Local read-only preview script compares Authority against saved assessments,
holding incompatible manual scoring policies and inconsistent saved scores.
4. Work-in-progress web fallback uses verified company domains, the existing
WebsiteHttp DNS/robots/redirect limits, optional zero-cost tinyfish.web.search
through existing treg, and bounded HTML/PDF reads. Snippets discover URLs only.
PDF text extraction runs pdf-parse 2.4.5 in a bounded worker. Node 24 is used.
5. Web claims preserve count, quote, source, numeric precision and date basis.
Explicit effective dates, publication dates and observations on current corporate
pages are distinguished. Observations are labeled 'observed on' and expire in
30 days; explicit dated facts expire in 548 days. This observation-date policy
was an implementation choice and needs reviewer agreement.
6. Web results use a new company_employee_research table, retry dates, UUID leases
and ownership tokens. Found claims refresh in 30 days, unresolved cases retry in
7 days and source failures in 1 day. Default research cap is 5 new companies per
context. Current cached evidence can be reused. Entity changes invalidate it.
7. Web fallback is off unless PIPELINE_EMPLOYEE_WEB_RESEARCH=1. Workflow env wiring
has been added locally to daily, weekly, rescore and discovery execution jobs.
The migration supabase/migrations/202611080001_employee_research.sql is prepared
but has NOT been applied to shared data. Missing storage disables web research
for that context and leaves ordinary scoring available. Do not silently enable
production while integrating this patch.

## Validation and source results

SEC extension: all 624 unit tests, types and lint passed before web additions.
Public SEC check: 2/7 had usable facts (Constellium 11,500, Green Brick 620).
Web additions: last full suite 633 passed before latest small edits. Latest focused
web suite 11/11 passed, including a generated real PDF and stale/concurrent cases.
Typecheck, lint and production build passed during development. Repeat them on
final state. New local Supabase integration test is present but has not run
against Supabase here. Its SQL migration/RPC logic WAS executed successfully in
isolated embedded PostgreSQL (PGlite): claims, retry scheduling, stale token
rejection, evidence retention, identity changes and anon denial.

Direct crawl of 12 public/private/US/international examples returned 0 accepted
claims. Do not call that universal coverage. A second run used recorded URLs
retrieved via web search, replaying URL discovery through the transport interface
while fetching actual documents. It is NOT a live treg-provider validation. At
handoff, Ferring's published 7,500+ count was accepted and many cases remained
unresolved. Partial/full results are included when available. The benchmark uses
EMPLOYEE_BENCHMARK_DOH=1 here because system DNS fails with EAI_AGAIN. This uses
real Cloudflare HTTPS DNS answers, preserving private-IP checks. Production's
normal system DNS behavior was not changed.

## Immediate next work

- Inspect the WIP extractor/crawler and finish review. Explicitly test and reject
future planned headcounts and negated claims. Check pronoun ownership in acquisition,
customer, subsidiary and network-of-independent-firms contexts. Avoid broadening
patterns just to increase accepted counts.
- Diagnose unresolved official sources (identity, date, tables, terminology and
source discovery). Norconsult's announcement has multiple dates near its heading;
current publication-date fallback may need careful improvement. Employee tables
and structured numberOfEmployees data are not yet implemented. Add them only with
clear entity/date/unit grounding. Cached source diagnostics are optional in result.
- Complete the 12-company benchmark after final parser changes and audit accepted
quotes against originals. Keep direct crawl, replayed discovery and live-provider
results labeled accurately. Benchmark source URLs are public; no database involved.
- Run npm ci, npm test, npm run typecheck, npm run lint and npm run build. Run
npm run test:integration only with isolated local Supabase; never point tests at
shared production. Review SQL security and migration behavior.
- Read current companies/contacts/scores through existing private local environment
without printing keys. The read-only preview script allows GET only. Real dashboard
qualification gains remain unmeasured; historical October scores are not current
pipeline assessments and cannot simply receive three points.
- Publish tested changes to Avan's existing PR branch using local authenticated
git. GitHub connector writes here returned 403 for both Git Trees and Contents API.
No merge, shared database mutation, paid research or teammate message occurred.

## Useful commands

npm test
npm run typecheck
npm run lint
npm run build
node --env-file=.env.local scripts/preview-employee-evidence.mjs --evidence research/authority-headcount-pilot-20261108/employee-evidence.json
EMPLOYEE_BENCHMARK_DOH=1 node scripts/benchmark-employee-web.mjs research/authority-headcount-pilot-20261108/web-benchmark-companies.json
EMPLOYEE_BENCHMARK_DOH=1 node scripts/benchmark-employee-web.mjs research/authority-headcount-pilot-20261108/web-benchmark-companies.json research/authority-headcount-pilot-20261108/search-discovery-urls.json

## Access limitation

Supabase and Vercel require sign-in in this environment. Google authentication was
blocked by automatic browser approval review, and no explicit subsequent Google
approval was supplied. Do not attempt to bypass that block. A local Codex session
may use the user's existing authorized environment without exposing credentials.
