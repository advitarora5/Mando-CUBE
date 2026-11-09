# Reuse existing pipeline sources

Following the request to broaden source reuse, Workday employer job descriptions
are now checked before starting additional website research. This remains behind
PIPELINE_EMPLOYEE_WEB_RESEARCH. Captures must come from an enabled exact-name tenant
linked to the company, carry the same company ID, and use that tenant/site's exact
Workday API path. Captures last observed more than 30 days ago are excluded. No new
external requests, migration, paid endpoint or contact changes are introduced.

The description is parsed as employer-authored HTML. Current undated statements use
the capture's last observation date, not today's lookup date or the job posting date.
Explicit reporting dates retain their original basis. Conflicting counts for the
same date require review. Read failures fall back to ordinary research/scoring.
The pipeline reports employee_evidence_workday separately from web and SEC evidence.

Employee synonyms now include staff and associates. “Roughly” and “some” are correctly
marked approximate, preventing those qualifiers from accidentally becoming exact
counts. Approximate counts at/above the bonus boundary still require review; no new
arbitrary tolerance or assumed lower bound has been introduced.

Other repository sources were inspected: SEC names, Common Crawl and Wayback find
company/tenant identities; Reddit supplies discussion signals; PredictLeads Workday
usage is paid and off by default. These do not themselves establish employer headcount.
The people-enrichment response type also has an employee_count string, but this is
not currently accompanied by verified workforce source/date/scope and is not used
for automatic bonus credit. Corporate pages and reports are already supported by
the official-site reader. These discovery sources can help locate documents without
making snippets or technology-installation counts workforce evidence.

Five focused tests cover capture ownership/freshness, scope and future-claim rejection,
wording/precision, and the normal scoring entry point awarding the existing +3.
No current database credentials are configured, so actual additional Workday coverage
and current company score changes remain unmeasured. The earlier 4/20 and 5/20 web
benchmarks predate this extension and must not be presented as its coverage.

Validation: 644 unit tests passed; TypeScript, lint and production build passed.
Captures created before admission with no company_id are conservatively skipped
until collection records the now-linked company; no append-only raw metadata is rewritten.
GitHub account permissions were confirmed as push:true, while both cloud Git and
connector writes remained blocked by 403. No current database secrets are configured.
