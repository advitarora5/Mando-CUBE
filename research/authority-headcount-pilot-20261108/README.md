# Authority headcount pilot, November 8, 2026

See [FINAL_REPORT.md](FINAL_REPORT.md) for the validated continuation and measured automatic coverage. The following manual review is historical. Norconsult is now explicitly approximate (no automatic size bonus), and Ferring/Norconsult dates are publication dates, not effective dates.

PR #50 targets `refined-scoring`. Its Vercel deployment and GitHub ingestion job
42540856548 completed successfully, including integration tests on disposable Supabase.

## Source review

The repository's October 14 tier reconciliation preview supplied candidate names.
Its totals are historical and use earlier assessment policies. They do not establish
current scores, current contact verification, or compatibility with pipeline scoring.

| Candidate | Historical total | Reviewed workforce evidence | Evidence date (see basis below) | Pilot disposition |
| --- | --- | --- | --- | --- |
| GEA Group | 69 | 18,970 employees, distinct from 18,628 FTEs | 2025-12-31 | Evidence prepared for group record, pending current record/contact read |
| Medtronic | 69 | Over 95,000 full-time employees; 95,000 stored as conservative lower bound | FY ended 2026-04-24 | Evidence prepared for group record, pending current record/contact read |
| Norconsult | 67 | Approximately 7,200 employees, in dated annual-report announcement | 2026-04-10 | Evidence prepared for group record, pending current record/contact read |
| Ferring Pharmaceuticals | 69 | More than 7,500 people; 7,500 stored as conservative lower bound | 2026-02-16 | Evidence prepared for group record, pending current record/contact read |
| Yokogawa Electric | 65 | Group has 18,313; parent corporation has 2,240 | 2026-03-31 | Held; confirm prospect and buyer entity scope before assigning a group count |

Sources were opened and checked on November 8, 2026.

- GEA Sustainability Report 2025, printed page 156 (PDF page 94), gives employee headcount and December 31 basis. https://cdn.gea.com/-/media/investors/annual-report/2025/sustainability-report-2025-en.pdf?rev=1c8a81f4cd0842879914c11d7c3a83c6
- Medtronic FY2026 10-K, Human Capital, printed page 8. Fiscal year ended April 24, 2026. The count is company-wide, including the reported business scope of that filing. https://app.quotemedia.com/data/downloadFiling?cdn=90112680366a16357877b3f99d658939&companyName=Medtronic+plc.&dateFiled=2026-06-18&formType=10-K&ref=320141818&symbol=MDT&type=HTML&webmasterId=101533
- Norconsult annual-report announcement dated April 10, 2026, About Norconsult. Its approximate count is dated to the announcement, not presumed to be an exact year-end headcount. https://investor.norconsult.com/stock-exchange-and-press-releases/norconsult-annual-report-2025/
- Ferring leadership announcement dated February 16, 2026, About Ferring Pharmaceuticals. https://www.ferring.com/ferring-announces-changes-to-board-of-directors-and-executive-committee/
- Yokogawa sustainability table distinguishes group and parent headcount. The slavery statement explicitly dates the group's count to March 31, 2026. https://www.yokogawa.com/about/sustainability/sustainabilityinfo/sustainability-data/ and https://www.yokogawa.com/be-fr/about/sustainability/sustainabilityinfo/modern-slavery-act/

`employee-evidence.json` contains the four prepared inputs. The source review supports
workforce size. Before applying, match each prospect and buyer to the same entity scope.
It does not verify any contact's current employer or buying authority.

## Read-only comparison

From the project directory, using its existing private database environment:

```sh
node --env-file=.env.local scripts/preview-employee-evidence.mjs --evidence research/authority-headcount-pilot-20261108/employee-evidence.json
```

The command performs SELECT requests only and rejects HTTP methods other than GET.
It imports no pipeline runner, writes no run logs or assessments, and uses no paid
provider. Output contains score comparisons and evidence, not raw contacts or secrets.
A private JSON export with `companies`, `contacts`, and `scores` arrays can instead
be supplied with `--input SNAPSHOT.json`. Keep exports out of Git.

The comparison changes only Authority and holds the other four saved categories
constant. It accepts pipeline rubric versions beginning `mando-team-70:pipeline-`.
Other policies, malformed assessment dates and saved Authority values that cannot
be reproduced from current contacts are held. Held rows are not promotions. Review
expired role evidence, full rescoring and pending Release changes separately before
any shared-data update. Authority caps and the tier evidence gate still apply.

## Current result and access dependency

Four source-backed inputs prepared; one entity-scope case held. Current company,
contact and assessment data were inaccessible in this session: the preview redirects
to Vercel login, Supabase requires sign-in, and the checkout has no private database
environment. No current score preview has been claimed. Current qualified-company
gain is unmeasured. The historical totals above must not be increased by three and
reported as new Qualified companies.


## Automatic-source check

The automatic SEC extension reuses the existing companyfacts fetch. A public
seven-company check returned dated counts for Constellium (11,500 as of September
30, 2026) and Green Brick Partners (620 as of December 31, 2025). Bank of America,
Caterpillar, Shell, Medtronic and Workday returned no usable matched employee fact.
This is a source-coverage check. No dashboard records, current contacts or saved
tiers were read or updated. Detailed public results are in `sec-live-validation.json`.
