# Public benchmark rerun after Workday-source extension

Reran all 20 companies using extractor revision ab2830b, the same roster and the
same curated discovery URLs as the previous benchmark. Four independent company
partitions ran concurrently, with direct then replay reads for each partition.
Production crawler limits and per-host pacing were unchanged. No database was accessed.

| Mode | Previous | Rerun | Counts at least 3,000 |
| --- | --- | --- | --- |
| Direct official crawl | 4/20 | 4/20 | 2/20 |
| Replayed URL discovery, live document reads | 5/20 | 5/20 | 3/20 |

The accepted employer sets were unchanged. GEA (18,000 lower bound), Atlassian
(12,000), GitLab (2,500) and Automattic (1,347) were found directly. Ferring
(7,500 lower bound) was additionally found with replayed discovery. Original
sources for all five were fetched again; the current parser reproduced their
counts, precision and date bases. See accepted-source-audit-followup.json for
source URLs, source hashes, timestamps and evidence.

There is no measured improvement in public-crawl coverage from the wording changes.
The Workday reuse extension reads saved employer job descriptions, which this
public-only benchmark does not load. Its additional real-company coverage remains
unmeasured until authorized database reads can inspect those captures. Actual live
treg search was not run; replayed URL discovery must not be described as a live
provider result. Fifteen companies remain unresolved in replay mode.

For database validation, use private environment configuration for SUPABASE_URL
and SUPABASE_SECRET_KEY, or a suitably authorized read-only credential. Existing
server secret/service-role keys can write; a GET-only preview limits the operation,
not the credential's privileges. Never paste keys into chat or commit .env files.
Read companies, contacts and scores for current-score previews, plus workday_sites,
raw_captures and signals for saved Workday evidence (and company_origins for pipeline
scope). Do not run the normal pipeline against shared data to obtain this preview.
The existing preview-employee-evidence.mjs is GET-only, but previews supplied reviewed
inputs; it does not by itself measure the new saved-Workday collector. That measurement
requires a separate read-only pass through the collector and then score comparison.
No migration or feature activation is needed merely to read existing records.
