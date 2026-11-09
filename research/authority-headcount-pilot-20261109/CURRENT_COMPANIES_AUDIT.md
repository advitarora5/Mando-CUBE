# Current-company headcount audit — November 9, 2026

The GET-only audit checked all **207 current companies** in project
`fkhychihxpregusklggo`. It read 238 contacts, 675 saved assessments, 168 Workday site
records and metadata for 770 captures. No pipeline runner, mutation store, RPC,
shared migration or production configuration was invoked. No manual evidence or
investigator-discovered URLs were injected into automatic collection. No live
search provider was invoked; discovery here is the bounded direct-site path.

## Automatic coverage

| Source | Accepted companies | Notes |
| --- | ---: | --- |
| Existing SEC companyfacts responses | 0 | No companyfacts payloads exist in saved captures; two SEC company-list captures are not employee evidence. No new SEC financial lookup was performed. No retained SEC headcount was found in current Authority evidence. |
| Saved company-bound Workday descriptions | 2 | Adobe and Danaher. 82 companies have enabled exact-name, company-bound sites; the implemented collector checked up to 20 recent captures per bound company. |
| Bounded official-site fallback | 6 | Actual public GETs, DNS/robots/redirect/size limits, six-page/18-request/45-second per-company limits. |
| **Combined accepted evidence** | **8/207** | Seven establish 3,000+; Bloom Energy's 2,000+ lower bound does not establish that threshold. |
| **Unresolved** | **199/207** | 162 have readable sources but no accepted current employer-wide count; 37 have unavailable sources. |

The final-result crawler request counter totals 1,617 public requests, excluding
superseded reads for the three corrected cases. The complete initial sweep used
six workers, then resumed unfinished companies with sixteen workers. Original
company limits were preserved. The three affected companies were re-fetched with
the corrected extractor; all Authority comparisons were then recomputed using
current GET-only records. Capture bodies and contact details remain outside Git.

| Company | Count | Precision/date basis | Automatic source |
| --- | ---: | --- | --- |
| Adobe | 30,000 | lower_bound; observed 2026-11-05 | [saved_company_bound_Workday](https://adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external_experienced/job/San-Jose/Senior-Program-Manager--Employee-Experience-M-A_R171802) |
| Bloom Energy Corp | 2,000 | lower_bound; publication 2026-10-22 | [bounded_direct_official_site](https://www.bloomenergy.com/news/bloom-energy-reports-record-third-quarter-2026-financial-results-and-raises-full-year-2026-guidance/) |
| Capita | 34,000 | exact; observed 2026-11-09 | [bounded_direct_official_site](https://www.capita.com/) |
| Danaher | 63,000 | lower_bound; observed 2026-11-04 | [saved_company_bound_Workday](https://danaher.wd1.myworkdayjobs.com/wday/cxs/danaher/DanaherJobs/job/POL---Remote/EMEA-Payroll-Specialist--Austria-_R1321106-1) |
| Elekta | 4,500 | lower_bound; observed 2026-11-09 | [bounded_direct_official_site](https://www.elekta.com/company/about-us/story/) |
| FTI Consulting, Inc | 8,100 | lower_bound; observed 2026-11-09 | [bounded_direct_official_site](https://www.fticonsulting.com/about) |
| Mondelēz International | 90,000 | exact; observed 2026-11-09 | [bounded_direct_official_site](https://www.mondelezinternational.com/about-us/) |
| Unum | 10,000 | lower_bound; publication 2025-12-31 | [bounded_direct_official_site](https://www.unumgroup.com/about) |

## Authority only — no qualification-tier calculations

“Without/with size” recalculates Authority from current contacts using the existing
scorer. “Saved before/after” applies only a supported incremental size award; it
preserves existing points and does not repair historical scores or rubrics.
Existing documented size awards and the 25-point cap prevent double awards.
A saved score equal to the with-size calculation establishes no additional gain;
it does not by itself prove the historic award's provenance.

| Company | Current-contact Authority without → with size | Saved Authority before → after | Additional | Disposition |
| --- | --- | --- | ---: | --- |
| Adobe | 0 → 0 | 0 → 0 | 0 | no supported size bonus |
| Bloom Energy Corp | 0 → 0 | 0 → 0 | 0 | no supported size bonus |
| Capita | 18 → 21 | 25 → 25 | 0 | already at authority cap |
| Danaher | 0 → 0 | 0 → 0 | 0 | no supported size bonus |
| Elekta | 0 → 0 | 5 → 5 | 0 | no supported size bonus |
| FTI Consulting, Inc | 0 → 0 | 0 → 0 | 0 | no supported size bonus |
| Mondelēz International | 22 → 25 | 25 → 25 | 0 | already at authority cap |
| Unum | 18 → 21 | 21 → 21 | 0 | saved already equals with size calculation |

**Capita, Mondelēz and Unum** satisfy the current-contact and sourced-size conditions.
None has a supported incremental award against the saved Authority scores. Adobe,
Danaher, Elekta and FTI have accepted 3,000+ counts but no currently scoring eligible
contact. Bloom's lower bound does not establish the threshold. Elekta's saved 5 is
preserved; this headcount audit does not change it to the current-contact calculation
of zero. No unrelated score or rubric was changed.

## Manual/investigator evidence — excluded from the automatic 8/207

The pre-existing reviewed file separately supports Medtronic (95,000 lower bound),
Ferring (7,500 lower bound) and GEA Group (18,970 exact). Their current-contact
without/with calculations are 18→21, 18→21 and 22→25 respectively. Their saved
Authority remains **25→25, 21→21 and 25→25**, so none establishes an incremental
award. Medtronic and GEA have an explicit size award in saved evidence. Ferring's
saved score already equals its with-size calculation. Norconsult's approximate
7,200 earns no bonus; saved Authority stays 21. These are independent Authority
comparisons, with no tier inference or historical rubric repair.

### GEA identity and domain

The saved record is **GEA Group**, domain `geagroup.com`.
[GEA's current imprint](https://www.gea.com/en/legal/imprint-and-website-terms-of-use/)
identifies `gea.com` as operated by GEA Group Aktiengesellschaft, Düsseldorf,
registration HRB 65691.
[WIPO case D2019-0365, factual background](https://www.wipo.int/amc/en/domains/decisions/text/2019/d2019-0365.html)
documents the same entity's ownership of `geagroup.com` (registered March 25, 2000).
This establishes the corporate identity relationship, rather than a subsidiary
borrowing its parent's workforce. The legacy domain timed out during this audit;
a current live redirect was not verified. The automatic crawler therefore remains
unresolved for this stored domain. No hard-coded alias or shared record update was
introduced. The reviewed group-wide count is used only in the separate manual
comparison above. A future canonical-domain update must preserve this identity
provenance; it was not performed here.

## Extraction fixes driven by the sweep

The initial extractor accepted eleven companies. Review found three unsafe claims,
which were fixed and rechecked:

- Cochlear: “helped over 700,000 people to hear” describes beneficiaries. “People”
  now requires an immediately preceding workforce/employment phrase. No count is
  accepted after the fix.
- Shell: a saved Workday description's “Shell in The United States” heading scopes
  its 11,000 to a local workforce. Flattening HTML must not discard that scope. No
  employer-wide count is accepted from that claim after the fix.
- Baker Hughes: `~56,000` is approximate. Symbolic `~`/`≈` precision now survives;
  approximate counts cannot establish a guaranteed 3,000 minimum. It is held for review.

Regression cases also preserve valid team/employee statements. None of these fixes
changes the existing +3 rule, contact policy, Authority cap or qualification logic.

## Reproduction and limitations

`scripts/audit-headcount-coverage.mjs --output PRIVATE_RESULT.json` uses existing
private Supabase environment plus `HEADCOUNT_AUDIT_PROJECT`. Every network request
is guarded as GET-only (including Request objects). Its store adapter exposes only
Workday reads; there is no mutation/RPC or research-cache lease operation. It accepts
no manual-evidence inputs or write flags. Keep its output outside Git.

Full local per-company results, source/date/precision and document-level unresolved
diagnostics are in `/private/tmp/mando-headcount-207-coverage.csv` and
`/private/tmp/mando-headcount-207-reviewed.json`. The CSV lists **all 199 unresolved
companies**; it and raw record snapshots are deliberately excluded from this commit.
The audit does not prove universal source availability: access failures, identity
mismatches, JS-only content, bounded discovery, PDF/table layouts and unresolved
precision/scope remain. Saved SEC employee-fact coverage is unmeasurable beyond the
absence of payloads; live SEC lookup and live search-provider discovery were not
silently counted as completed.

Validation: 652 unit tests, TypeScript, ESLint and production build passed locally.
Shared Supabase write/integration tests were not run. No shared data writes,
migrations, production activation, merge or teammate messages occurred.
