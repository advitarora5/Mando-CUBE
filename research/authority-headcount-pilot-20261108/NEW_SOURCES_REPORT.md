# Expanded company statements and Workday source research

This supersedes the unchanged-coverage result in BENCHMARK_RERUN.md. New targeted
web searches and original-source reads were used to investigate missed statements,
rather than merely rerunning the existing URL set. Source discovery used ChatGPT web
search, not the production treg search provider. Company pages were then fetched live.

## Results on the same 20-company roster

| Method | Before | Now | Threshold-supported counts now |
| --- | --- | --- | --- |
| Bounded direct company-site crawl | 4/20 | 4/20 | 2/20 |
| Replayed discovery URLs + live company-page fetches | 5/20 | 7/20 | 4/20 |
| Public evidence located including separate targeted live Workday audit | 5/20 | 8/20 | 5/20 |

The final row is investigator-assisted source coverage, not an automatic pipeline
or live-provider benchmark. The Workday audit fetched one active posting, verified
its corporate reciprocal link, and replayed that actual JSON through the saved-capture
extractor. It did not read a production raw_captures row or run the pipeline collector.
The automatic web benchmark still has 13 unresolved companies. There are 12 unresolved
companies after including the separate audited Workday evidence. No actual score
promotions are established without current contacts and assessments.

New evidence:

- HubSpot: the corporate newsroom's short fact card states 9K+ global employees.
  https://www.hubspot.com/company-news
  This supports a 9,000 lower bound, observed November 8, not an invented reporting date.
- Zapier: its About page describes 800+ people across 38 countries.
  https://zapier.com/about
  This supports an 800 lower bound, observed November 8, below the bonus threshold.
- Medtronic: an active Senior Customer Experience posting describes 95,000 employees
  working across more than 150 countries. The API returned canApply=true, start date
  October 30 and closing date November 27, 2026. These posting dates are not used as
  headcount effective dates: the workforce statement is an observation on November 8.
  https://medtronic.wd1.myworkdayjobs.com/wday/cxs/medtronic/MedtronicCareers/job/Senior-Customer-Experience-Specialist_R70106
  The official corporate careers page links to the exact MedtronicCareers tenant/site:
  https://www.medtronic.com/en-us/our-company/careers.html

Source hashes, evidence and method labels are in new-source-audit.json. The prior
accepted GEA, Ferring, Atlassian, GitLab and Automattic sources remain accepted by
this web run. New web artifacts preserve the base revision plus extractor SHA256,
since the benchmark ran against the working implementation before its commit.

## Implementation changes

- Accept contractions such as “we’re” and “we’ve” in workforce statements, and
  explicitly dated “we had” claims. Keep the original wording in the stored excerpt.
- Read short employee-only corporate fact cards. Require publisher identity and a
  corporate profile/newsroom landing page; customer cards, unrelated publishers and
  arbitrary articles do not qualify. Numeric units and lower-bound precision survive.
- A separately numbered customer population after an employee count does not veto
  an otherwise valid employee statement. Customer-owned employee figures remain rejected.
- Reuse pre-admission Workday captures after the exact-name tenant/site is confirmed
  for the current company. Do not rewrite append-only captures. A conflicting company
  ID still prevents use. Require an explicit employer mention in the description;
  a parent-company email/URL alone cannot identify a subsidiary's workforce.
- Retain existing future/negation/scope/unit/range/approximation safeguards, date
  labels and freshness policies. No threshold changes or assumed approximate lower
  bounds were introduced. No Budget/contact-discovery logic changed.

## Remaining investigation

HubSpot's filing HTML and report URLs returned HTTP 403 here, so their indexed
employee counts were not accepted from snippets. The accessible corporate newsroom
provided the usable evidence instead. Workday's frontend HTML did not expose Medtronic's
job text, while its actual job-detail JSON did. Canva's accessible article described
its team but did not establish a publication/reporting date; it remains unresolved.
A Norconsult tenant search surfaced a Nordic Office of Architecture posting, which
cannot automatically establish Norconsult group size. Search matches mentioning
Datadog or HubSpot as tools used by another employer were not their workforce evidence.
Other original access, report-table and entity-scope gaps remain as documented.

## Database access

The running cloud environment still reports no Supabase secret bindings. The user
has vault entries sourced from .env.pipeline.local, but the Supabase project is not
owned by their account and current project access is unconfirmed. A dedicated Supabase
plugin was discovered and suggested through Plugin Management; it is not confirmed
connected. Connecting a plugin does not grant project membership. No database was
read, written, migrated, or activated. An owner invitation or authorized read-only
export is needed for actual pipeline coverage and score previews. Development and
public-source validation can proceed independently.

Validation: 647 unit tests passed; TypeScript, ESLint and production build passed.
No migration or schema changes were needed for these extraction improvements.
