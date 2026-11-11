# Employee headcount collection

[Exact teammate setup](TEAMMATE_SETUP.md): dependencies, migration/roles, source
defaults, local configuration, default-on configuration, explicit opt-out and readiness diagnostics.

[Current-company audit](CURRENT_COMPANIES_AUDIT.md): **8/207 companies** have accepted
automatic headcount evidence. No additional points are supported against saved
Authority scores. The audit separates automatic coverage from manual/investigator
evidence and evaluates Authority independently of qualification tiers.

[November 10 Advantech case](ADVANTECH_EXTRACTION_20261110.md): bounded report
discovery and dated workforce-table extraction now recover 9,512 employees;
the saved-score discrepancy remains held. This targeted check is separate from
the 207-company audit. [Estimate admission proposal](ESTIMATE_POLICY_PROPOSAL.md)
awaits team/client decision; current admission rules are unchanged.

## Behavior and configuration

Source precedence is reviewed domain-matched evidence, employee facts reused from
the existing SEC financial response (including still-current retained SEC evidence
on temporary lookup failure), saved company-bound Workday descriptions, then optional
official-site HTML/PDF/structured-data research. SEC requires the existing SEC-list
capture and `PIPELINE_CONTACT`; no extra SEC request is added for headcount.

Evidence preserves employer scope, source, excerpt, precision and date basis.
Effective/publication evidence expires after 548 days; undated current corporate
statements are labeled observations and expire after 30 days. Ambiguous scope,
future/negated claims and unsupported threshold claims earn no bonus. The existing
+3 requires a confirmed relevant contact, sourced exact/lower-bound 3,000+ headcount,
and room under the 25-point Authority cap. The read-only audit avoids duplicate
awards and does not repair historical rubrics or unrelated scores.

Use existing private environment files; never commit keys or database snapshots.

| Variable | Purpose |
| --- | --- |
| `PIPELINE_EMPLOYEE_EVIDENCE_FILE` | Optional reviewed JSON. [Sample](reviewed-evidence.example.json) is manual evidence, not automatic coverage. Recheck entity, date and source before use. |
| `PIPELINE_EMPLOYEE_WEB_RESEARCH` | Enabled by default, including unset/empty; `0`, `false`, `off`, `no` or `disable(d)` explicitly disables new Workday/website research. |
| `PIPELINE_EMPLOYEE_WEB_MAX_COMPANIES` | New website-research cap per context: default 5, bounded to 1–20. |

The fallback uses six documents, eighteen HTTP requests and 45 seconds per company,
with public-DNS, robots, redirect and response-size safeguards. Optional zero-cost
search discovers URLs only; snippets never establish workforce size. Research-cache
leases protect ownership; matching evidence refreshes in 30 days, unresolved cases
retry in 7 days, source failures in 1 day. Entity changes invalidate cached evidence.
A bounded, read-only startup RPC verifies storage and actual permissions. Missing
setup skips website collection with a warning; saved Workday reuse and unrelated
stages continue. Failed lookups retain only still-valid, previously awarded/cache-
bound evidence and never invent a bonus.
The prepared migration is `supabase/migrations/202611080001_employee_research.sql`;
the startup probe also needs `202611100001_employee_research_readiness.sql`. Both
are one-time database release prerequisites; neither is auto-applied. Teammates
must run the updated code.

## GET-only current-company audit

Run on Node 24 with installed locked dependencies. Using an existing authorized
private environment containing `SUPABASE_URL`/`SUPABASE_SECRET_KEY` (or the pipeline
aliases), set the expected project explicitly:

```sh
HEADCOUNT_AUDIT_PROJECT=fkhychihxpregusklggo node --env-file=/path/to/private.env scripts/audit-headcount-coverage.mjs --output /private/tmp/headcount-audit.json
```

This entry point imports no pipeline runner or mutation store, rejects non-GET
requests and exposes only read methods to the collectors. It checks existing SEC
responses, saved Workday descriptions and bounded direct public sites without manual
inputs or a search provider. It bypasses research-cache writes for the audit only;
it does not enable the production feature. Output includes per-company unresolved
reasons and Authority before/after, not contact details. Keep output outside Git.

## Validation

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
```

The prior headcount commit passed **660 offline tests**, TypeScript, lint, build
and CI disposable-Supabase/PostgREST integration. Setup follow-up verification is
recorded in [the setup verification note](SETUP_VERIFICATION_20261110.md).
Shared-environment and live search-provider validation remain unperformed.
Integration tests write data: run them only against an isolated local Supabase or
dedicated disposable PostgreSQL container, never the shared project. The SQL test
entry point is `tests/integration/employee-research-postgres.test.mjs`; the REST test
is `tests/integration/employee-research-db.test.mjs`. Their fixtures and migration
remain in place.

### Retained public-source evidence (November 8, 2026)

These historical 20-company results are separate from the current 207-company audit:
4/20 direct counts, 7/20 replay-assisted counts, 8/20 including a separately audited
Workday posting. Replay-assisted discovery and investigator-audited Workday evidence
are not automatic live-provider coverage or confirmed score increases.

[Validation inputs and results](validation/20261108/) retain the final roster,
recorded discovery URLs, direct/replay per-document outcomes, accepted-source hashes,
new-source/Workday audit and the separate seven-company SEC availability check.
Earlier handoff notes, superseded summaries and intermediate runs are recoverable
from Git history rather than kept as competing instructions.

Reproduce public direct and replay runs without private configuration:

```sh
node scripts/benchmark-employee-web.mjs research/authority-headcount/validation/20261108/companies.json
node scripts/benchmark-employee-web.mjs research/authority-headcount/validation/20261108/companies.json research/authority-headcount/validation/20261108/discovery-urls.json
```

The second command replays discovery URLs while fetching pages live; it does not
exercise the live search provider. Historical runs used `EMPLOYEE_BENCHMARK_DOH=1`
(actual Cloudflare HTTPS DNS answers), preserving private-IP checks. Dates and
available source content change, so replays need not reproduce historical counts.
Tests generate their own extraction/PDF fixtures; none depend on removed research
outputs. Source metadata/hashes are retained unchanged, including implementation
provenance predating later extraction fixes.
