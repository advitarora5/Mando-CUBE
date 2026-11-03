# First live local pipeline test

Run on October 24, 2026 (America/Chicago; logs use October 25 UTC), after commit `38011af1`.
Production was neither read nor written during these runs. No schedules were enabled.

## Scope

- Local Supabase only: `http://127.0.0.1:54321`.
- Existing 154-company development copy; zero paid budget and no LLM.
- Saved repository SEC list (`sec.json`, 10,445 entries), followed by live Workday HTTP and free Treg domain lookups. This did **not** test refreshing the SEC file from the SEC website.
- Full pipeline plan with a five-site limit, then the daily plan for the same five sites.
- Previous unit/integration tests left 84 pending synthetic reviews, 84 unassigned synthetic signals, and one pending diagnostic capture. A private local test wrapper excluded those saved IDs and non-SEC diagnostic resolver retries. These records were preserved, not deleted; tracked pipeline source was unchanged.
- The repeat used the daily plan because repeating discovery would advance to new SEC names rather than retest the same batch.

## Results

| Check | First run | Repeat |
| --- | --- | --- |
| Runtime | 153.2 seconds | 33.6 seconds |
| Overall status | Failed: initial matching stage partial | Succeeded; existing reviews retained |
| Workday sites discovered | 5 from 17 completed company attempts | Discovery not repeated |
| Job postings collected | 24 new captures | 24 unchanged captures |
| Signals | 5 career-site + 21 hiring signals | 21 existing hiring signals refreshed; no new signals |
| Company count | 154; no additions | 154; no additions |
| Pending live reviews | 5 | Same 5 |
| Paid Treg / LLM spend | $0 / $0 | $0 / $0 |

Sites: NVIDIA (`nvidia.wd5`, `NVIDIAExternalCareerSite`), Broadcom (`broadcom.wd1`, `External_Career`),
Micron (`micron.wd1`, `External`), Visa (`visa.wd5`, `Visa`), and ASML (`asml.wd3`, `ASMLBERLIN`).
Micron was found through a weaker first-word guess and retained its lower 0.6 confidence.

All five candidate names exactly match existing company names after normalization. Without confirmed
websites, matching correctly placed them in `similar_name` review rather than creating duplicate companies
or automatically attaching their evidence to existing companies. These remain human decisions.

All 26 stored signal quotes were checked against their saved source captures using the extractor's quote
rules (one-word minimum for structured sitemap lines; three-word minimum for job-description quotes).
No duplicate captures, signals, reviews, or companies were added on the repeat. All original rows and
exported fields in the seven copied dashboard tables remained unchanged: 154 companies, 234 contacts,
623 scores, 139 company insights, 271 weekly snapshots, one outreach settings record, and eight drafts.
Live captures, signals, sites, review items and run logs remain in the local database for inspection.

## Findings before scheduling

1. **Website verification stops on ordinary robots.txt redirects.** NVIDIA, Broadcom, Micron and Visa's
   primary candidate domains returned HTTP 301 for `/robots.txt`. The verifier currently treats these as
   unavailable. Add bounded, validated redirects when reading robots.txt, retaining destination checks and
   access restrictions. Some alternative candidates also had network failures. The run correctly reported
   these website failures instead of returning a false success.
2. **Treg candidate accuracy needs a fallback query.** ASML's full legal-name query returned unrelated
   suggestions and no confirmable ASML website. Evaluate a normalized brand-name retry with the same zero-cost
   restrictions and independent confirmation. Do not accept a candidate solely because its label resembles the company.
3. **Automatic admission has not been demonstrated live.** Every company in this batch already exists.
   After addressing website verification, select a small SEC batch of companies absent from the dashboard
   to measure confirmation coverage and actual admission. Existing-company review handling needs inspection too.
4. **The repeat's success does not resolve the first failure.** It only collected existing job postings
   and retained the five human-only reviews; website verification was not retried.
5. **Live SEC refresh and scheduling remain untested.** Configure an identified SEC contact before testing
   a fresh SEC download. Keep schedules disabled until manual collection, confirmation, admission and repeat
   behavior have been validated on the local database.

Private raw logs, reports, baseline and audit files are under ignored `var/live-pipeline-*`. No credentials
or production copy artifacts are included in this report. No implementation changes were made during this test.

## Follow-up fixes and live recheck

Implemented after the original test:

- Follow up to three validated robots.txt redirects, enforce returned rules for their original origin, and reject loops/unsafe targets/challenges.
- Retry a legal-name lookup once with its complete normalized identity when no usable exact-name candidate is returned. ASML now returns `asml.com`; unrelated suggestions are still rejected. Both queries remain in the evidence.
- Raise the HTML limit to a bounded 2 MiB (NVIDIA's homepage was about 757 KiB); keep robots capped at 512 KiB.
- Prioritize main careers pages and their linked job-search pages, permit explicitly linked company subdomains, skip saved-job/account pages and unrelated job-news links, and follow at most three careers pages.
- Do not mistake a normal reCAPTCHA form script for an access challenge. Genuine challenge markup still stops verification.
- Advance the verifier version so old cached results can be re-evaluated. Existing human-only similar-name reviews are not overridden.

All 297 offline tests, typecheck, lint and the targeted local database admission/rollback test passed.
The five live website checks were repeated using the local evidence table and a zero paid budget;
company rows and review decisions were not modified. No additional migration was required.

The original robots-redirect errors are gone, and ASML's correct corporate domain is now among the candidates.
However, **these five companies are still unconfirmed by the current evidence rule**: readable company pages
lead to careers portals without the exact observed Workday tenant/site link in accessible HTML; Broadcom
returns challenge markup; several alternative provider domains are inaccessible. This recheck does not
prove automatic admission or justify enabling schedules. Missing corroboration and blocked sites stay in review.
Private recheck evidence is in ignored `var/website-fixes-live-results.json` and `var/website-fixes-live.log`.

## Employer-backed confirmation follow-up

The saved NVIDIA postings contain an explicit link to `https://www.nvidia.com/en-us/benefits/`;
Micron postings link to `https://www.micron.com/careers/benefits` and `https://www.micron.com/careers`.
The verifier now accepts these links from the exact observed Workday job source as corroboration,
combined with exact company identity on the candidate homepage. It no longer requires the corporate
website to link back to Workday when this independent source evidence is available.

A targeted live check now confirms **nvidia.com and micron.com**, using 11 website requests and $0 paid
spend. The selected evidence retains the original Workday posting URL, capture ID, employer link,
field and corporate-page identity. The empty website fields on these two local `similar_name` reviews
were filled. Both reviews remain pending; no companies were merged, created or rescored in this live check.

The implementation keeps multiple verified domains ambiguous; does not overwrite human website choices
or rejected decisions; excludes shared document/social/ATS sites; and rejects wrong tenant/site, expired,
commented or script-only evidence. Newly collected employer links invalidate old unresolved caches, so an
eligible `no_website` review can recover without waiting seven days. Unchanged job captures remain usable
when their associated signals were seen recently. Source-backed candidates are checked before unrelated
provider suggestions, avoiding speculative requests to bad alternatives when corporate ownership is established.

Validation: 307 offline tests passed (about 1.5 seconds), typecheck and lint passed, and a local database test
confirmed source-backed admission, persistence, rollback and human-review protection. A fixture-backed flow
also demonstrated new-company admission, scoring and an idempotent repeat. This is not a claim that a new
real company has yet been admitted live: the two confirmed samples already exist on the dashboard.

Migration `202610250002_employer_website_confirmation.sql` was applied **locally only**. It adds lookup
indexes and updates automatic-admission audit wording to cover both evidence directions; existing company
rows and review decisions are not rewritten. Broadcom, Visa and ASML remain in review where corroboration
is missing or access is blocked. Scheduling remains disabled. Private targeted results are under ignored
`var/employer-website-live-results.json` and `var/website-fixes-live.log`.
