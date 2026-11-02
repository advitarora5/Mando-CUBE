# Shared company-data error log

Task 7, workstream beginning October 22, 2026.

- [Shared log: all company-data reports, open and closed](https://github.com/advitarora5/Mando-CUBE/issues?q=is%3Aissue%20label%3Adata-quality)
- [Coordination and setup tracker](https://github.com/advitarora5/Mando-CUBE/issues/30)
- [Report a company-data error](https://github.com/advitarora5/Mando-CUBE/issues/new?template=company-data-error.yml)
- [Recurring errors requiring a pipeline investigation](https://github.com/advitarora5/Mando-CUBE/issues?q=is%3Aissue%20is%3Aopen%20label%3Arecurring-data-error)

The report form becomes available after this change merges into the default branch.
Until then, open a regular issue, copy the fields below and apply `data-quality`.
The issue list is the shared log; do not maintain a second spreadsheet or copy of the same cases.

## Responsibilities

Nevin maintains the log and checks for repeated patterns. Avan's company verification supplies findings.
Coordinate pipeline changes with Stefan and Aadi, and duplicate cleanup with Veeraz, following the team's current split.
These names describe coordination, not automatic GitHub assignments or notifications.

## Report each finding

Search the log by company ID/name and error type before opening a report.
Add another check of the same field and source to the existing report, rather than counting it twice.
An independent company or capture with the same problem gets its own report, linked to related cases.

| Field | What to record |
| --- | --- |
| Company | Dashboard name and company page URL/UUID; capture ID for an unsaved candidate |
| Error type | The controlled category from the issue form; specify the field for `Other` |
| Original source | Source family, original URL and source ID/capture ID/run link where available |
| What was wrong | Incorrect or missing field value and why it fails verification |
| Correct value | Supported replacement, or `not available`; never guess |
| Verification evidence | Supporting URL, short quote or explanation, and date checked |
| Correction | What changed on the dashboard, who changed it and when, or why it is still pending |
| Status and owner | Current state, reviewer and person responsible for the next action |
| Pipeline follow-up | Related reports, suspected cause, fix issue/PR and verification result |

GitHub records the reporter and creation/update timestamps. Put the actual source-check and correction dates in the report.
Keep credentials, private contact details and full provider responses out of issues.

## Separate a finding from a confirmed error

Start at **Needs review** unless a source check confirms the error.
A blocked or deleted page means the source cannot currently be checked; it does not establish that the company does not use Workday.
A job on a Workday-hosted site does not by itself prove additional modules, a recent implementation or a go-live date.
Distinguish a hiring signal or article publication date from a confirmed go-live date.
Do not turn missing information into an invented value or an unsupported score.

Fix supported company fields using the existing dashboard controls. Record the exact change and verification source in the issue.
If a correction requires a code change, unsupported field, evidence replacement or record merge, record it as pending and coordinate with the relevant owner.
For a duplicate company, follow [Duplicate companies](../README.md#duplicate-companies): preview the merge, apply it, add the old name to the alias list, and record both company IDs and the merge report in the issue.
Preserve the original source reference in the report so the pipeline mistake can still be traced after the dashboard row changes.
See the [pipeline runbook](ingestion-runbook.md) for collector, extraction, matching and review-queue boundaries.

## Trigger an investigation at two occurrences

1. Count **confirmed, independent occurrences** of the same error type across the shared log, including corrected/closed reports. Reopening an issue or checking the same bad field again is not another occurrence. Exclude `Needs review` and `Not an error` reports.
2. At **two occurrences**, apply `recurring-data-error` to the related reports. Link them to one root-cause issue or fix PR. Keep the case count and links in that issue.
3. Compare source IDs, capture/run references, field names and symptoms. The threshold triggers investigation; it does not prove the reports have the same root cause. Split the investigation if the causes differ.
4. Trace the failure to the responsible collector, extractor, company matcher or persistence step with the pipeline owner. Fix it on a branch and submit a PR. Do not change production scheduling, paid-call settings or database structure just to maintain this log.
5. Verify a code fix against the offending inputs and a valid comparison input. Check a later ingestion result when available. Record the evidence and whether existing affected records also need correction.

Correcting a company row fixes that record. It does not demonstrate that the pipeline cause is fixed.
Use **Pipeline fix pending** or **Monitoring a pipeline fix** until the upstream work is verified.
For an isolated error with no required pipeline change, close the case once its correction and recurrence check are documented.
For a recurring error, resolve the related cases only after documenting both record correction and the verified upstream fix.

## Review after each verification batch

Nevin reviews new reports from the day's newest-company checks and updates:

- Newly confirmed errors, grouped by error type and original source.
- Any error type reaching its second independent occurrence.
- Record corrections still pending, and linked pipeline fixes awaiting verification.
- Cases resolved with supporting evidence.

Use actual issue counts and links. The absence of reports does not mean that the database or a source has passed an audit.
This setup creates the log and reporting process. It does not audit companies, repair data or enable a daily automation by itself.
