# Free contact research versus paid lookup readiness

A newly admitted Workday company can have fewer than 25 Budget + Release + Timing points and no
contact-research request. Waiting for that total before discovering contacts leaves Authority and
Reachability without inputs. Evidence collection and purchase-readiness scoring serve different purposes.

The enrichment stage now permits bounded free people research for an in-scope company with a website,
no contacts, and a fresh trusted known-customer or hiring signal. The signal needs a source URL, a quote,
confidence at least 0.9 and at most 1, and an observation within the configured freshness period.
Weak evidence, generic events, malformed URLs, empty quotes, and invalid/future timestamps do not qualify.
The existing paid-readiness route remains available.

Paid email lookup still requires the latest assessment's Budget + Release + Timing to meet
`ready_for_contacts_threshold`, plus the existing spend and idempotency checks. No threshold, scoring
weight, database schema, deployment setting or schedule is changed. Already-present contacts without
an enrichment request are not implicitly enrolled for paid lookup.

Free research uses the existing Treg transport, requests zero maximum cost with paid fallback disabled,
and requires a zero-cost response. Provider failures stay pending for retry. Authentication, billing and
rate-limit failures stop further people searches for that stage. An unexpected charge is recorded and
reported as a failure, and the response is not used to create contacts. Successful empty searches retain
the existing `no_contacts_found` status. Existing terminal decisions remain respected.

Discovered contacts retain `linkedin_status=unconfirmed` and provider provenance. They are not verified
current decision-makers. The existing scorer can award the unconfirmed Authority band; LinkedIn alone
does not become a verified reachable route. Touched companies are rescored, and score errors propagate.
Already researched companies below paid readiness do not consume new-research slots or repeat searches.
The normal per-run company/contact caps still apply.

No live provider or database was used to verify this change locally. Unit/fixture tests cover low-score
research, paid gating and budget, duplicate prevention, scope, zero-item caps, evidence quality, retries,
provider blocking, score provenance and unconfirmed roles. The in-memory store now selects the later
insert when two fixture assessments share a timestamp. Real database integration remains a required
review check; its expected score count includes the additional contact-enriched assessments.

This change does not fix the separate release-scoring baseline or enable scheduling. It is intended as a
small PR into `refined-pipeline`; Aadi's broader additions and the earlier combined draft remain separate.
