# Reviewed discovery import and scoring — 2026-11-10 session

Completed on `stefan/company-import` after explicit user approval, at 2026-11-11 05:54 UTC (November 10, America/Chicago). The production rollback preview, atomic import, and scoped scoring run all succeeded.

The reviewed package covers 22 companies. Against the production snapshot of 257 companies, the plan creates 13 and attaches evidence to 9 existing records, for an expected total of 270 companies.

| Planned action | Companies |
| --- | --- |
| Create (13) | Itron, F5, ESAB, Broadridge, Deckers, Carrier, Veralto, Jabil, Fortrea, Fox, Humana, Labcorp, Ryder |
| Attach to existing (9) | Motorola Solutions, Autodesk, Agilent, Mizuho Americas, Unilever, Cisco Systems, Enbridge, ING, Equinor |

The package contains 88 signals, 22 Workday sites, 88 raw captures and 88 extraction records. Scores and contacts are excluded. Original evidence dates are preserved. Existing company facts and source/site settings are preserved.

Preparation found two cases requiring explicit handling:

- Three Cisco signals already rejected in production describe ordinary working-day prose, not Workday software. Those signals and their otherwise unreferenced captures/extractions are excluded from the package. The rejected target review is preserved.
- Humana already has an unassigned known-customer signal and career site in a pending review. The plan explicitly enumerates that review, signal and site. The future import resolves this item atomically using the existing review-resolution function. A changed/rejected review, different owner or additional queued evidence aborts the transaction.

Veralto's review identifies the evidence as Esko/Veralto group evidence; it makes no claim of a separate parent-headquarters implementation. Accenture's incorrect Avanade admission and held candidates remain excluded.

The transfer format now hashes exact raw response bytes and retains the collector's original fingerprint in metadata. Collector fingerprints can ignore volatile response fields, so using them alone would collide with some already-stored response variants.

Validation passed: 629 unit tests, 3 local database integration tests, TypeScript and lint. The complete production-target SQL was rehearsed twice in an isolated local schema seeded with the production identity/evidence snapshot. The rehearsal verified creation, attachment, retry without duplicates, Humana resolution, preserved Cisco rejection, and no scoring/contact writes. It rolled back completely, including the isolated schema, with unchanged local app database row counts.

The ready artifacts are in ignored `var/company-transfer-2026-11-10/`, including a README, reviewed package, audit/exclusions, pending-review resolution, production preflight mapping, preview/apply SQL, checksums, rehearsal report and 22 target IDs for later scoped rescoring. A portable copy is `var/company-transfer-2026-11-10-ready.tar.gz`.

## Production execution

The refreshed preflight confirmed 13 new companies and 9 existing matches. The SQL Editor rejected the full payload size before execution, so the batch used a temporary, fixed import function with invoker security and execution restricted to the existing service role. Its default preview rolled back the entire import in a subtransaction; the apply call committed atomically. The function was removed successfully afterward. No permanent schema/security change remains.

Verified production deltas: companies 257 → 270, signals 856 → 928 (+72), Workday sites 306 → 318 (+12), raw captures 1036 → 1114 (+78), extractions 1057 → 1135 (+78). Existing matching evidence was reused. All 88 selected signals and 22 sites were verified against the target ID mapping. Humana's pending review resolved; the rejected Cisco records stayed rejected and unassigned. Company facts, contacts, snapshots, insights and pipeline settings were preserved.

The current scoring engine then processed exactly the 22 mapped target IDs: 13 first assessments, 6 reassessments, and 3 unchanged. It found SEC financials for 20 companies, with no exact SEC-name match for 2. There were no scoring errors. Scores increased from 737 to 756 (+19); all historical assessments were preserved and no score was written outside the cohort. The stored `pipeline_only` scope was preserved; the explicitly requested 22-company scope was applied only within this scoring process.

All 22 currently have no contacts and zero Authority/Reachability points, and show Disqualified under the current rubric. The engine marked 14 as ready for contact research; no contact-research or discovery run was started.

Import audit run: `e9c52638-7ee8-4272-ac19-00b01d94d3fd`. Scoring audit run: `852bb794-f133-4573-8009-ddc55a90fc4c`.

Detailed results, per-company scores and machine-readable verification are in `var/company-transfer-2026-11-10/execution/RESULTS.md` and `final-verification.json`. The original ready archive remains a historical pre-import package, not a pending action.

## Contact enrichment follow-up — 2026-11-11

After the user requested enrichment and rescoring, the current eligibility check selected 21 of the 22 imported/matched companies. Unilever was excluded because its stored Workday observation from October 26 was outside the 14-day freshness window and its latest score was below paid readiness. The run used a process-local cohort/scope override; persistent settings were preserved.

Free enrichment researched all 21 eligible companies, added 57 provisional contacts across 20, and found no usable contacts for Itron. It performed 24 people searches (including 3 broader fallbacks) and 156 public evidence searches. None independently confirmed a current role, so all 57 contacts retain unconfirmed/provisional status and no verified-role credit was awarded. Provider provenance and LinkedIn URLs are stored with the contacts.

The configured Treg budget remained $0, actual spend was $0, and no paid email lookup ran. Fifteen companies were marked budget-skipped for paid follow-up; five with contacts remain below paid readiness. No email was guessed.

The current engine rescored all 21 eligible companies: 20 new assessments, with Itron unchanged. The 20 companies with new contacts each gained 5 provisional Authority points; all remain Disqualified, with Reachability still zero. Historical scores, unrelated existing contacts and persistent pipeline settings were preserved. Verified zero contact/score writes outside the cohort. Both stages completed without errors.

Enrichment run: `7e899651-b925-46aa-93e3-b9a4bb448fee`. Rescoring run: `68fcda96-01ad-4d17-8c14-290bacc00fa3`. Detailed results and verification are in `var/company-transfer-2026-11-10/enrichment/RESULTS.md` and `verification.json`.
