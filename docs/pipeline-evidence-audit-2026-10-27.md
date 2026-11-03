# Pipeline evidence audit — October 27, 2026

## Handoff checks

PR #32 remains open against `refined-pipeline`. Its latest test job passed:
https://github.com/advitarora5/Mando-CUBE/actions/runs/40602204182/job/122532852412
This does not establish that the production pipeline or deployment includes that branch.
The shared error-log setup in PR #31 has merged.

## Screenshot batch versus production

Read-only Supabase inspection found 154 companies. The supplied screenshots are local pipeline results, not a matching production export. No production rows were changed during this audit.

| Company | Screenshot | Production readback | Next evidence needed |
| --- | --- | --- | --- |
| nVent | 33; missing industry; three unconfirmed contacts | No company found under this name | Local company/capture IDs, full job body and dated contact sources |
| Novartis AG | 32; missing industry; three unconfirmed contacts | `Novartis`, ID `04ab1e68-508b-4454-b862-045d2e6f06bb`; 16; industry `pharmaceutical industry`; zero contacts | Export the local result before comparing contact and budget calculations |
| Nexstar Media Group, Inc. | 31; missing industry; three unconfirmed contacts | No company found under this name | Local company/capture IDs and full job quote; the screenshot truncation alone cannot establish invalid evidence |

Production Novartis has Authority 0, Reachability 0, Budget 0, Release 8 and Timing 8. Its latest assessment was saved October 21, 2026. Six captured signals were inspected, including the customer careers site and five hiring signals. The October 21 integration internship capture explicitly describes integrating Workday; dated August/October recruitment captures also describe maintaining Workday data. Its recent-hiring score is supported by the captured dated evidence. This is not a newly confirmed go-live date.

Original production source: https://novartis.wd3.myworkdayjobs.com/Novartis_Careers

Unconfirmed people-search roles warrant review, not automatic Authority upgrades. A discovered LinkedIn URL is not a confirmed current role or verified contact route. Do not replace missing evidence with higher scores.

## Reproduced code defects and fixes

1. **Long hiring quotes:** extraction previously kept the first 60 words even when Workday appeared later. The quote could therefore omit the product supporting the signal. The new bounded, verbatim window retains the Workday mention and original whitespace. Regression cases place Workday at the beginning, middle and end, with valid short and unrelated controls.
2. **Undated hiring:** timing previously substituted collection date for a missing posting date, awarding 8 recent-hiring points without dated evidence. It now requires a signal date for that band; undated hiring retains the existing 5-point operational baseline. Regression cases cover undated, old and recent postings.

These are reproducible code defects, not two confirmed company occurrences of one error. The local Nexstar screenshot cannot establish that the extractor bug caused its displayed excerpt. No recurring-company-error threshold is claimed.

## Validation and remaining handoff

- All 345 offline tests pass on the `aadi-pipeline` baseline with these changes.
- No paid enrichment, scheduler change, database migration, merge or deployment performed.
- Obtain actual local exports for the three companies before certifying or correcting their company/contact records. Required fields: company/capture IDs, URLs, full quotes, capture and publication dates, assessment reasons and scores.
- After review and integration, replay those captures and inspect the resulting saved assessments. Existing scores are not recalculated merely by merging code.
