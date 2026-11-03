# Treg domain lookup evaluation

## Configuration and scope

Used the existing default credential in the signed-in CUBE account. No new key or permissions were created. Configured `TREG_TOKEN`, `TREG_ORG=cube`, and `TREG_DISABLE_CLI=1` in the ignored `.env.pipeline.local` file with owner-only permissions. Paid budget remains zero. Production configuration and database records were not changed.

The pipeline already supports direct HTTP calls through `HttpTreg`; installing the Treg CLI is unnecessary when the token is configured. This is still a Node HTTP request, authenticated and routed through Treg to the provider.

## Live results

Browser tests used `hunter.x.domain-finder`, limit 3. All nine requests returned HTTP 200 and the UI explicitly reported a zero provider charge.

| Query | Exact mode | Returned domains |
| --- | --- | --- |
| NVIDIA CORP | false | nvidia.com, nvidia.co.id, nvidia.support |
| TARGET CORP | false | target.com, target.ae, target.com.au |
| Epic Systems Corporation | false | epicgames.com, epic.com, epic.ca |
| Mayo Clinic | false | mayoclinic.org, mayo.edu, mayoclinic.com |
| University of Iowa | false | uiowa.edu, hawkstudio.com, benefitiowa.com |
| Zz Mando Nonexistent Fixture Company 947281 | false | none |
| Epic Systems Corporation | true | none |
| Epic | true | epic.com, epic.ca, epic.my |
| NVIDIA CORP | true | nvidia.com, nvidia.co.id, nvidia.support |

These are provider suggestions, not independently verified website assignments. Exact mode can still return several domains with the same company label, and full legal names can miss a useful shorter brand name.

Repeated NVIDIA, Epic Systems Corporation, and the nonexistent-company control using the repository's `HttpTreg` transport. Each returned HTTP 200 with `x-treg-cost-micro: 0`. Requests set `X-Treg-Route-Max-Cost: 0` and `X-Treg-Route-Waterfall: 0`. The probe made no database calls. Local raw results and the probe script are ignored under `var/` and contain no credential.

The endpoint catalog identifies this endpoint as free and not consuming credits. These calls therefore did not use the $1 contact-research budget. This finding applies to this endpoint; it does not establish that other Treg endpoints are free. Availability and provider rate limits still need normal failure handling.

## Implementation completed in step 1

1. Keep Treg as the source-independent candidate lookup, using explicit zero-cost routing.
2. Separate a returned candidate from a verified website. The existing name-only confirmation rule is insufficient for ambiguous brands or multiple same-name domains. Preserve the lookup candidates and corroborating source evidence before assigning a website.
3. Leave unresolved/conflicting cases in review. Add deliberate retry/reconsideration of pending website reviews so improved evidence can unblock them.
4. Cache verified results and handle transient provider failures separately from an empty successful lookup. Avoid querying the same company on every scheduled run.
5. Test the matching/admission changes on a small local batch, checking name, website, Workday evidence, and duplicate behavior before enabling scheduling or production writes.

The subsequent implementation now adds independent website confirmation, persistent evidence/retry caching, recovery of eligible pending reviews, human-decision protection, fresh-evidence admission and normalized parent/subdomain duplicate review. See `docs/ingestion-runbook.md` for the exact rule and limitations. Validation passed 287 offline tests, typecheck, lint, and two local database checks (full flow and atomic review admission). This evaluation did not run a live ingestion batch; that is step 2. Production and schedules remain unchanged.

## References

- [Domain finder endpoint](https://treg.to/catalog/endpoints/hunter.x.domain-finder)
- [Treg API documentation](https://treg.to/docs)
