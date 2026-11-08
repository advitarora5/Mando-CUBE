# Free contact research versus paid lookup readiness

A newly admitted Workday company can have fewer than 25 Budget + Release + Timing points and no
contact-research request. Waiting for that total before discovering contacts leaves Authority and
Reachability without inputs. Evidence collection and purchase-readiness scoring serve different purposes.

The enrichment stage now permits bounded free people research for an in-scope company with a website,
no contacts, and a fresh known-customer or hiring signal. The signal needs a source URL, a quote and an
observation within the configured freshness period. Stored confidence does not decide this: a company that
passed admission is already verified, and a verified company can still carry a 0.6 discovery signal.
Generic events, malformed URLs, empty quotes, and invalid/future timestamps do not qualify.
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

People search starts with Workday and HR systems titles and uses broader titles if it finds no usable
candidates. Enrichment keeps up to 50 results in the candidate pool and runs up to five free public
evidence searches per company, starting with roles with the highest potential Authority. It checks
the indexed profile against a recent, independently published attribution of the person's role and
employer. It saves the source and quoted evidence with the contact. Profiles without sufficient
evidence stay provisional, and a documented employer mismatch is excluded. The pipeline ranks the
pool by per-contact Authority, then Reachability, and saves the top three.

To use manually checked public evidence, point
`PIPELINE_CONTACT_REVIEWS_FILE` at a JSON array. Each entry includes `company_domain`, `linkedin_url`
(the provider's profile URL), `reviewed_on` (YYYY-MM-DD), and `source` (the public evidence URL).
Use `status: "confirmed"` with the current `title` and an optional `workday_source` for documented
Workday responsibility, or `status: "different_employer"` to exclude a documented mismatch.

Confirmed reviews take priority before the shortlist is trimmed. Enrichment applies reviews to
matching saved contacts as well and rescores those companies. Confirmed-role credit expires after
90 days. A documented employer mismatch stays excluded until a new review replaces it. An
unconfirmed profile can earn the provisional Authority band. Email verification remains separate.
Already researched companies below paid readiness do not consume new-research slots or repeat searches.
The normal per-run company/contact caps still apply.

Unit fixtures cover the final cutoff, stale employers, insufficient verification evidence, free
provider failures, and paid gating. The three-company pilot used live people search and public
evidence with an isolated in-memory store.
