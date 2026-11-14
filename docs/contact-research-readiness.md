# Contact discovery and completion

A newly admitted Workday company can have fewer than 25 Budget + Release + Timing points and no
contact-research request. Waiting for that total before discovering contacts leaves Authority and
Reachability without inputs. Evidence collection and purchase-readiness scoring serve different purposes.

The enrichment stage now permits bounded free people research for an in-scope company with a website,
no contacts, and a fresh known-customer or hiring signal. The signal needs a source URL, a quote and an
observation within the configured freshness period. Stored confidence does not decide this: a company that
passed admission is already verified, and a verified company can still carry a 0.6 discovery signal.
Generic events, malformed URLs, empty quotes, and invalid/future timestamps do not qualify.
Email completion uses the same evidence eligibility, without a latest-score requirement or a
Budget + Release + Timing threshold. `ready_for_contacts_threshold` and all scoring formulas remain
unchanged. Daily, all, and standalone enrich plans complete existing contacts even when discovery was
previously marked done or no enrichment request existed. Missing addresses use work-email lookup and
independent verification; existing unverified addresses use verification only; verified addresses skip
both. Known employer mismatches remain excluded. New addresses must match the corporate domain.

Explicit free-only runs never buy email calls. Enrichment dry runs make no provider calls or contact
writes. Paid runs retain their run budget, per-call ceiling, and at most two new email lookups per company
per stage; verification has its own budget reservation. A budget pause after lookup reuses the saved
lookup response next time. Neither a successful empty lookup nor an uncertain call is repurchased.

Free research uses the existing Treg transport, requests zero maximum cost with paid fallback disabled,
and requires a zero-cost response. Provider failures stay pending for retry. Authentication, billing and
rate-limit failures stop further people searches for that stage. An unexpected charge is recorded and
reported as a failure, and the response is not used to create contacts. Successful empty searches retain
the existing `no_contacts_found` status. Terminal discovery statuses prevent repeating discovery, but do not prevent completing saved contacts.

People search starts with Workday and HR systems titles and uses broader titles if it finds no usable
candidates. Enrichment keeps up to 50 results in the candidate pool and runs up to ten free public
evidence searches per company, starting with roles with the highest potential Authority. It checks
the indexed profile against a recent, independently published attribution of the person's role and
employer. It saves the source and quoted evidence with the contact. Profiles without sufficient
evidence stay provisional, and a documented employer mismatch is excluded. The pipeline ranks the
pool by per-contact Authority, then Reachability, and saves the top three.

Daily or standalone enrichment also revisits saved provider profiles in place. Provisional
profiles can be checked again after seven days. Automatically confirmed roles become eligible
for another check at 76 days, two weeks before the existing 90-day expiration. An inconclusive
check records the attempt and keeps the previous evidence. A changed role decision triggers a
targeted rescore. Manual reviews and existing contact IDs are preserved.

To use manually checked public evidence, point
`PIPELINE_CONTACT_REVIEWS_FILE` at a JSON array. Each entry includes `company_domain`, `linkedin_url`
(the provider's profile URL), `reviewed_on` (YYYY-MM-DD), and `source` (the public evidence URL).
Use `status: "confirmed"` with the current `title` and an optional `workday_source` for documented
Workday responsibility, or `status: "different_employer"` to exclude a documented mismatch.

Confirmed reviews take priority before the shortlist is trimmed. Enrichment applies reviews to
matching saved contacts as well and rescores those companies. Confirmed-role credit expires after
90 days. A documented employer mismatch stays excluded until a new review replaces it. An
unconfirmed profile can earn the provisional Authority band. Email verification remains separate.
Already researched companies reuse contacts and durable paid-call results.
The normal per-run company/contact caps still apply.

Unit fixtures cover the final cutoff, stale employers, insufficient verification evidence, free
provider failures, below-threshold completion, budget gates, overlap, and manual-edit preservation. The three-company pilot used live people search and public
evidence with an isolated in-memory store.

## Shared checkpoints and rollout

Both workers use `contact_completion_locks` and `contact_completion_calls`. Company locks have no expiry:
a crashed worker cannot be replaced while its provider request may still be running. Calls are claimed
before dispatch with a unique company/operation key. Successful responses can be replayed locally after
an interrupted save; running/blocked calls require reconciliation, with no automatic paid retries.
Completion provenance is appended under `contact_sources.contact_completion`, retaining older provenance.
A compare-and-set database update preserves the contact ID and rejects a stale save after manual edits.
Both insertion paths use the same company lock and identity deduplication rules.

Migration `202611130001_contact_completion.sql` is required before either updated worker runs. It creates
the shared tables and service-role RPCs, preserves historical pipeline lookup blockers, locks companies
with unresolved legacy queued calls, and requeues previously successful jobs with incomplete contacts.
It does not change scores or readiness settings, enable schedules, or issue provider calls. Stop both
old worker versions before applying it; mixed old/new workers do not share the new lock protocol.
The migration has only been tested offline, not applied to the shared database.

Reconcile provider charges and recover stored results before releasing a stranded company lock or
resolving a running/blocked checkpoint. Never delete a checkpoint simply to make a retry possible.
Historical pipeline failures that were never checkpointed cannot be reconstructed automatically; audit
those calls before rollout. Legacy completed queued calls are read through their original request hashes.
Company/name lookup keys intentionally favor avoiding duplicate spending over resolving same-name people;
ambiguous identities, changed domains and alias/subsidiary email domains need operator review.

The queued worker retains its existing admission-based scope (all admitted companies), while pipeline
plans retain `scoring_scope` and fresh evidence checks. Neither worker changes admission policy.
Per-run budgets are independent; these locks prevent duplicate spending for the same operation, but do
not introduce an organization-wide daily budget across different companies or concurrent runs.

Offline checks: `npm test`, `npm run typecheck`, `npm run lint`. Embedded PostgreSQL migration checks:
`PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js node --test tests/integration/contact-completion-offline.test.mjs`.
The embedded test is optional when that external test-only package is absent and never connects to Supabase.
