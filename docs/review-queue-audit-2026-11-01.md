# Company review and shared error-log update — November 1, 2026

## Saved in Supabase

Reviewed all nine pending records in project `fkhychihxpregusklggo`: **6 approved, 1 merged, 2 incorrect company/site pairs rejected; 0 pending remain.** The company count increased from **154 to 160**. Rejected associations are not a finding that the named company is an unsuitable prospect or does not use Workday.

| Original candidate | Decision | Verification and correction |
| --- | --- | --- |
| Abbott Laboratories | Approved | Changed candidate website from `rals.com` to `abbott.com`. [Official Abbott careers](https://www.jobs.abbott/us/en) links to `abbott.wd5.myworkdayjobs.com/abbottcareers`; captured HCM/payroll architecture roles corroborate use. |
| Accenture plc | Approved | Replaced `AvanadeCareers` with `AccentureCareers`, a separate site present in the same original robots capture. [Live Accenture careers site](https://accenture.wd103.myworkdayjobs.com/AccentureCareers) identifies Accenture and links back to `accenture.com`. Recruiting evidence does not establish an internal go-live date. |
| Cisco Systems | Approved | Changed candidate website from `senderbase.org` to `cisco.com`. [Live Cisco employer posting](https://cisco.wd5.myworkdayjobs.com/Cisco_Careers/job/Armenia/People-Operations-Coordinator_2021792) identifies Cisco, lists Workday among HRIS tools and links to Cisco's corporate privacy policy. |
| Gilead Sciences | Approved | [Official corporate careers page](https://www.gilead.com/careers) links to `gilead.wd1.myworkdayjobs.com/gileadcareers`; captured Workday architecture roles corroborate use. |
| Marvell Technology | Approved | [Official corporate careers page](https://www.marvell.com/company/careers.html) links to `marvell.wd1.myworkdayjobs.com/MarvellCareers`. The captured HR role lists Workday as tool experience; no implementation date inferred. |
| Mizuho Financial Group Inc | Approved as **Mizuho Americas** | [Official Americas careers page](https://www.mizuhogroup.com/americas/careers) links to the exact `mizuhoamericas` Workday site. [Americas learning programs](https://www.mizuhogroup.com/americas/careers/learning-programs) confirms Workday Learning. Narrowed the name to the supported regional organization; no group-wide deployment inferred. Corporate domain `mizuhogroup.com`. |
| Nvidia Corp | Merged | Attached signals and site to existing NVIDIA UUID `b407f588-c9d3-5166-995c-f3de60ee5c27`; no second company created. Existing `nvidia.com` record and [official careers](https://www.nvidia.com/en-us/about-nvidia/careers/) establish identity. |
| Western Digital | Rejected association | [Western Colorado University's official careers page](https://western.edu/about/directory/human-resources/careers-at-western/) links to `western.wd1.myworkdayjobs.com/WESTERN`. That site does not belong to Western Digital. Disabled the incorrect site association. |
| Intuitive Surgical | Rejected association | [Intuitive Research and Technology Corporation's official careers page](https://irtc-hq.com/careers/) links to `intuitive.wd1.myworkdayjobs.com/irtc_careers`. It is a different company from Intuitive Surgical. Disabled the incorrect site association. |

The six admissions have names, corporate domains, industries and real source URLs. These decisions do not supply contacts or new scores; subsequent enrichment and scoring are separate pipeline steps.

## Confirmed repeated errors

- **Ordinary-word false signals — two independent companies:** Abbott has two signals about time spent working; Cisco has three signals about the ordinary working day. The case-insensitive keyword check accepted these as Workday software references, and two Cisco claims even received 0.9 confidence through a generic “Build” verb. Moved all five claims to two closed, rejected-evidence review records with no company assignment. Raw captures, quotes, dates and extraction references remain intact. These two extra rejected records are evidence quarantine records, not two additional rejected companies.
- **Wrong employer/site association — two independent companies:** Western Digital/Western Colorado University and Intuitive Surgical/Intuitive Research and Technology. Both came from first-word tenant guesses. Logged for the corporate/Workday identity-check work owned by Stefan and Avan (tasks 2–3); manual rejection alone does not demonstrate that automatic identity verification is fixed.
- **Accenture site selection — one case:** shortest-site selection chose a subsidiary's site despite the correct site being present in the robots response. Corrected this record; one case does not yet establish a recurring error of this separate type.

The shared GitHub `data-quality` issue list remains the single error log. This document records the completed audit, not a second ongoing tracker.

Logged cases: [Abbott #38](https://github.com/advitarora5/Mando-CUBE/issues/38), [Cisco #39](https://github.com/advitarora5/Mando-CUBE/issues/39), [Western #40](https://github.com/advitarora5/Mando-CUBE/issues/40), [Intuitive #41](https://github.com/advitarora5/Mando-CUBE/issues/41), and [Accenture #42](https://github.com/advitarora5/Mando-CUBE/issues/42). The first two pairs have the recurring-error label; Accenture is a single occurrence.

## Prevention change and validation

The extraction change rejects the observed everyday-word contexts before creating structured signals or calling a model. Branded Workday references, lowercase references with technical context, and title-only Workday roles remain eligible. This is a conservative rule for the reproduced cases, not a universal semantic classifier or the task 2 AI identity check.

- All **266 offline tests on the current main baseline** pass, including audited false-positive examples and valid comparison inputs.
- TypeScript checking and ESLint on the changed code/test pass. Restored the missing local `lucide-react` package from the exact lockfile-pinned registry archive, verified its integrity, and changed no manifests.
- Backed up affected records outside Git before writing; row-level comparison checks and locks protected the review batch from concurrent changes.
- An independent readback verified all nine decisions, six companies' names/domains/industries/source URLs, signal/site assignments, both disabled wrong-site associations and all five quarantined claims.
- All **623 score rows, 238 contacts and 425 weekly snapshots** have unchanged counts and whole-table content digests.
- No schema change, paid enrichment, scheduler activation, merge or deployment performed. Code prevention takes effect after PR review/integration; existing record corrections are already live.

## Previous workstream and next handoff

The shared error log was added in PR #31 (merged to main). The earlier quote-window/date fixes in PR #33 merged into `aadi-pipeline`, and free-contact gating PR #32 merged into `refined-pipeline`; those branch merges do not by themselves establish production deployment. The new admissions still need the team's scoring/contact steps. The prior local screenshot reconciliation remains open in issue #34 until the actual local exports are supplied.

## November 2 completion follow-up on this branch

Independently re-read the nine original decisions: six approvals, one NVIDIA merge and two rejected associations are still saved, with **zero pending reviews**. Both wrong-company sites remain disabled and unassigned. Read-only table counts remain **160 companies, 623 scores, 238 contacts and 425 weekly snapshots**. This follow-up made no production writes and did not rerun the completed batch; matching counts alone are not a new whole-table digest audit.

Two operational gaps are now covered by code and regressions:

- **Reject safely:** migration `202611020001_review_rejection_safety.sql` makes `review_resolve` disable unassigned Workday sites for a rejected review in the same transaction as the decision. Signals retain their rejected review reference, so they stay quarantined rather than becoming matching candidates again. Sites already attached to a verified company are not disabled. Invalid status/company combinations fail before any update, and completed decisions remain final. The in-memory store mirrors rejection and rejects nonexistent merge targets.
- **Preserve the Accenture correction:** resolver metadata and job collection now prefer a tenant-branded external site over a shorter sibling site (`AccentureCareers` over `AvanadeCareers`). Existing external/internal filters and the prior fallback remain. This is site selection, not identity verification: a `western` tenant/site still does not prove Western Digital owns it. Tasks 2–3 remain separate.

Validation: **273 offline tests pass**, TypeScript checking and full-repository ESLint pass. Applied every repository migration to a disposable local PostgreSQL 16 database and exercised approve, merge, reject, invalid decisions, decision finality, signal quarantine, protection of assigned sites and revoked public RPC execution; all assertions passed and test writes were rolled back. The Supabase REST integration suite passes its independent guard test and skips six database-backed tests because a local Supabase API is not running; the new rejection integration regression is included for that environment.

Deployment still requires PR integration, applying the new migration through the normal database release process, and deploying the collector changes. The migration changes future decisions only; it does not rewrite historical reviews or run enrichment/scoring. Do not represent this branch push as a production deployment. Accenture remains one confirmed site-choice occurrence in shared issue #42; the two wrong-identity cases remain tracked under #40/#41 for the separate AI identity work.
