# Queued contact research

Task 6 adds contact discovery, email finding, and independent mailbox verification through treg.
It does not implement the three company-source crawlers or change the legacy task-5 readiness setting.
The new worker does not use scores or that setting: every company admitted to `companies` is eligible.
Candidates held only in `review_queue` are not researched.

## Enable after review and credit availability

1. Apply `supabase/migrations/202610310001_contact_research_pipeline.sql` after the existing migrations.
   This creates an admission trigger and queues **all existing companies**, including manually added companies.
   Applying the migration alone makes no provider requests and spends nothing.
2. Configure server-only `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `TREG_TOKEN` privately.
   Local commands read `.env.local`; do not commit tokens or contact results.
3. Preview the next batch: `npm run contacts:research`. This only reads pending job IDs and prints counts.
4. Authorize spending explicitly: `npm run contacts:research -- --apply`.
5. For automatic hourly processing, set the same three GitHub Actions secrets and set repository
   variable `CONTACT_RESEARCH_ENABLED=true`. Leave it unset/false until credits are available.
   The workflow runs only on the default branch, with concurrency protection. It also supports manual dispatch.

Defaults are five companies, three contacts per company, a $1 reservation budget per run, and $0.10 per call.
Local overrides use `CONTACT_RESEARCH_MAX_COMPANIES`, `CONTACT_RESEARCH_MAX_CONTACTS`,
`CONTACT_RESEARCH_MAX_RUN_USD`, and `CONTACT_RESEARCH_MAX_CALL_USD`. The workflow pins its own limits.
Hourly runs can authorize up to $24/day at the default per-run budget; there is no separate daily cap.
The worker conservatively reserves each call's entire ceiling against its run budget, even for cheap/free responses.
Budget exhaustion returns the job to pending; the next run reuses saved successful calls rather than buying them again.
Treg enforces `X-Treg-Route-Max-Cost` as its documented reservation guard; actual charges are recorded from
`X-Treg-Cost-Micro`, not guessed from response bodies. Unknown/pending charges are reported separately.

## Research and verification rules

- Search uses `treg.people.search` with the corporate domain, `title=Workday`, and a bounded row limit.
  Strict filters are required. Only named Workday/HR-systems/HR-leadership contacts with explicit matching
  employer-domain or exact employer-name evidence are accepted. Rows with unsupported provider shapes,
  missing employer evidence, unrelated titles, or conflicting domains are skipped rather than guessed.
- Missing emails use `treg.people.email.find` with the full name and corporate domain.
  Off-domain mailboxes and explicit domain mismatches are discarded. Legitimate subsidiary/alias domains
  therefore require manual research; the worker does not infer corporate ownership.
- Every discovered email, including directory emails, goes through `treg.people.email.verify`.
  Only `status=valid` **and** `valid=true` sets `email_verified=true`. Risky, catch-all, invalid,
  unknown and absent addresses remain unverified. Verification means mailbox deliverability, not
  independently confirmed current employment or consent to outreach. No outreach is sent.
- Existing matching contacts are preserved, not refreshed or overwritten. Matches use normalized name,
  profile URL, or email within the company. An atomic database function serializes worker inserts per company.
  Concurrent manual imports do not share that lock, so retain the existing one-import-at-a-time policy.
- Provider attribution, call IDs, employer domain and verification verdicts are stored in `contact_sources`.
  Existing dashboard verification labels already read `email_verified` and `email_status`; no UI change is needed.
- Phone discovery is not enabled; this implementation researches named contacts, profile links and work emails.

## Operations and recovery

`contact_research_jobs` tracks pending/running/succeeded/blocked companies. `summary` reports returned and
accepted candidates, preserved contacts, added contacts, verification counts and rejected emails.
Zero accepted candidates is a completed search, not proof that no suitable person exists; inspect its
search checkpoint and research manually if the provider returned unsupported or mismatched rows.
`pipeline_runs` records run state, request counts, known charges and unknown-charge counts. No personal
contact data or provider bodies are printed to Actions logs. These tables have RLS enabled without public policies.
Job summaries describe the most recent completed attempt; run counts include contacts saved before a pause or failure.

Every paid request gets a durable `contact_research_calls` checkpoint **before** dispatch. Completed responses
are reused. A timeout, lost response, HTTP 202, missing charge metadata, provider error, ignored filter,
or failed database write stops the worker. It never automatically retries an uncertain paid call.
One blocked company stops that run; later hourly runs can continue with other pending companies.

For a blocked job, inspect its `error` and call checkpoints using privileged database access. For pending
provider operations, use treg's documented poll descriptor; for a known successful call ID, retrieve its
stored result rather than purchasing another call. Reconcile charges and response before marking a
checkpoint succeeded. Only remove a failed/running checkpoint if you have confirmed that it cannot still
complete or charge. Then set the company's job back to `pending` and clear its `error` to resume.
The same reconciliation is required for `running` jobs left by a terminated worker; they are intentionally
not reclaimed automatically. Keep successful checkpoints to avoid repeat charges. Changing a company's
domain or correcting provider results also requires an explicit review/requeue, not an automatic refresh.

Provider contracts checked against the public treg documentation and catalog on October 31, 2026:

```text
https://treg.to/docs
https://treg.to/skill.md
https://treg.to/catalog/endpoints/treg.people.search
https://treg.to/catalog/endpoints/treg.people.email.find
https://treg.to/catalog/endpoints/treg.people.email.verify
```

Offline checks: `node --test tests/contact-research.test.mjs`, then `npm test`, `npm run lint`,
`npm run typecheck`, and `npm run build`. No live credit-consuming test is part of these commands.
`tests/contact-research.sql` is an additional rollback-only smoke test for a disposable PostgreSQL database
with the migrations applied and Supabase roles present; it checks admission, claiming, deduplication and RPC permissions.
