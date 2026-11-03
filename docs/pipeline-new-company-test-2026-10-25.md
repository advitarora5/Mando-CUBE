# New-company local pipeline cycle — October 25, 2026

## Outcome

Completed one full discovery-to-scoring cycle and a daily-plan repeat against local Supabase.
Discovery and extraction worked, but automatic admission was **not demonstrated**: the one
discovered company, Cisco, remains pending because its corporate website could not be confirmed.
Both invocations exited with status 1 because matching was partial; later stages still ran.
No production database access, deployment, schedule changes, or paid spending occurred.

## Scope and method

- Database: `http://127.0.0.1:54321`, containing the existing 154-company development copy.
- Input: saved `sec.json`, originally 10,445 rows. A private local wrapper selected 10,277 names
  absent from the dashboard by the current similarity rule and absent from prior reviews/sites.
  This did **not** test a fresh SEC download.
- Live external requests: Workday robots.txt, Workday job JSON, free Treg domain lookup, and
  candidate website checks. LLM disabled; Treg paid budget and command spend limit both $0.
- Only the SEC, Workday resolver, and Workday career-site collectors were enabled in memory.
  Admission was capped at five; scoring scope was pipeline-only and contact enrichment was disabled.
- The wrapper excluded pre-existing diagnostic queues and reviews, and historical resolver refresh
  candidates. It preserved persistent settings, previous decisions, and the original company rows.
  Production pipeline source was not modified or mocked; the wrapper only constrained this sample.
- Commands used `--plan all --limit 5 --no-llm --max-spend 0 --enrich-companies 0`, then
  `--plan daily` with the same options and scope. Discovery was not repeated, so the second invocation
  tested the same site instead of advancing to another batch.

## Results

| Check | Full cycle | Daily repeat |
| --- | --- | --- |
| Runtime | 257.7 seconds | 6.5 seconds |
| Overall result | Failed: two partial matching stages | Failed: partial matching stage |
| Discovery | 30 completed company attempts, 238 probes, one site | Not repeated |
| Job collection | Five new job captures | Same five captures unchanged |
| Signals | One career-site and five hiring signals | Five hiring signals refreshed; none added |
| Review queue | One new `no_website` review | Same review ID retained |
| Company count | 154; no additions | 154; no additions |
| Scores added | Zero | Zero |
| Paid Treg / LLM spending | $0 / $0 | $0 / $0 |

The discovered site was [Cisco Careers](https://cisco.wd5.myworkdayjobs.com/Cisco_Careers).
The tenant was found through a first-word guess, initially confidence 0.6. Two job signals reached
0.9 through the existing extraction rules, so the final matching stage had a trusted candidate.
Every one of the six stored signal quotes verified against its saved source capture.

An example qualifying job was
[Engineering Product Manager](https://cisco.wd5.myworkdayjobs.com/Cisco_Careers/job/Lysaker-Norway/Engineering-Product-Manager_2027642).
Its evidence remains attached to the pending review, not to a newly created company.

## Website blocker

The free Treg lookup for `CISCO SYSTEMS, INC.` returned `senderbase.org`, `fittechnologies.net`,
and `cisco1.ru`, all labeled Cisco Systems. Candidate checks failed through connection errors or
a timeout; no domain was confirmed. The saved job descriptions supplied no employer links that
the current confirmation rule could use. The second matching stage and daily repeat reused the
cached error rather than repeatedly calling the provider. The error retry becomes eligible after
one day, unless new relevant evidence changes the confirmation input signature sooner.

The normalized-name fallback query currently runs only when the first response has no usable
exact-name candidate. These provider labels passed that initial filter, so a fallback query was
not attempted even though verification subsequently failed. A focused next change to evaluate is
a bounded zero-cost alternate query after all initial candidates fail confirmation. That would
still require independent company identity and Workday corroboration before admission; accepting
a provider label or manually injecting a domain would not validate automatic admission.

The low discovery yield (one site from 30 names) also needs attention before projecting company
growth. A completed miss means the configured tenant/pod guesses found no site, not that the
company does not use Workday.

## Data preservation and repeat checks

Comparing the first and final audits showed the same seven new captures, six new signals, one
review ID, and zero new companies or scores. The repeat added no duplicate records. The first
seven captures comprise one filtered SEC capture, one robots.txt capture, and five job captures.

All original exported rows and fields remained unchanged in the local copy:
154 companies, 234 contacts, 623 scores, 139 company insights, 271 weekly snapshots,
one outreach-settings row, and eight outreach drafts. Production was not queried for these checks;
comparison used the previously saved export.

The real new site, captures, signals, review, website evidence, and run logs remain in local
Supabase for inspection. Private sampling inputs, baseline, command logs, reports, and audits are
under ignored `var/new-company-cycle-2026-10-25/`. Credentials and the copied database export
are not included in this document. No additional regression suite was run for this live test.

## Next milestone before scheduling

Improve candidate lookup coverage for cases like Cisco, then rerun its eligible pending review
with fresh confirmation evidence. Demonstrate at least one real new company admitted with name,
confirmed website, source proof, and a score; repeat collection to verify stable admission and
scoring. Only then test scheduled execution against the local database. Live SEC refresh and
production rollout remain separate unvalidated steps.
