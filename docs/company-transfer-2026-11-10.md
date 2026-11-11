# Reviewed discovery import prepared — 2026-11-10

Prepared on `stefan/company-import`. Production was queried with SELECT only. No production import, rollback preview, scoring, queue resolution or settings update was executed.

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

The remaining production steps require the user's go-ahead: refresh the read-only mapping, execute the production rollback preview, review its result, and execute the atomic apply file. The existing target-snapshot and evidence-ownership guards stay enabled. Importing does not start scoring; the 22-ID rescore cohort is prepared for a separate run afterward.
