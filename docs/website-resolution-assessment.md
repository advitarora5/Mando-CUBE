# Website resolution: findings and next implementation

Investigated October 24, 2026. Goal: resolve a company's corporate website from traceable sources without consuming the group's treg contact-research credit.

## Follow-up: Treg tested and selected for the next step

The subsequent live evaluation supersedes the SEC-first recommendation below. See [Treg lookup evaluation](treg-domain-lookup-evaluation.md). The existing CUBE credential now works in the ignored local pipeline environment, and three calls through the repository's HTTP transport explicitly reported zero charges. Treg is a source-independent candidate provider; independent website confirmation, retry caching and eligible pending-review recovery are now implemented and tested locally. See the website-confirmation section of `docs/ingestion-runbook.md`; a live local batch is the next validation step.

## Verified findings

- SEC `company_tickers.json` provides company names, ticker symbols, and CIK identifiers, not corporate websites. The current resolver reduces these entries to company names and normalized names.
- Recorded NVIDIA and Target Workday job responses have empty `hiringOrganization.url` values. Their `externalUrl` values identify Workday postings rather than corporate websites.
- The recorded job descriptions contain potentially useful employer links, but also benefits sites and shortened URLs. Selecting the first external domain would be unsafe.
- Live HTTP checks of the NVIDIA and Target career homepages returned 200. NVIDIA's initial HTML did not expose a corporate link; Target's description included a corporate benefits link. This is useful candidate evidence, not a general website-resolution contract.
- Both companies' SEC annual reports explicitly identify their corporate websites. This provides a potential direct source tied to the company's CIK rather than a name-based website guess.
- Three direct SEC submissions-profile requests were denied with HTTP 403. Those research requests identified the project but did not include a contact email. A compliant contact address is needed for the next access test; adding one is not a guarantee that the service will allow the requests.
- The current treg domain finder requests a zero-cost route, but service billing was not verified. No treg calls were made during this investigation.

## Admission fix implemented first

Previously, `decideMatch` could attach signals to an existing company solely because an **unconfirmed** suggested domain matched that company's domain. Website confirmation was only checked later, when creating a new company.

Require confirmation for domain-based attachment as well as creation. Regression tests reproduce an unrelated-company attachment through the actual fixture-backed matching stage and verify that it now goes to review with no stored guessed domain. This does not change the lookup provider or enable automated approval of pending reviews.

## Historical SEC-first proposal (superseded by the tested Treg implementation)

1. Retain or recover an unambiguous SEC CIK for each discovered company. Handle normalized-name collisions and multiple registrants explicitly.
2. Fetch the company's SEC submissions profile with an identified User-Agent, pacing, request limits, and normal access-denied handling. Evaluate any corporate website field actually supplied; do not assume it is populated.
3. If needed, select a recent annual report through its filing metadata and extract explicit corporate-website declarations. Retain the filing URL, exact supporting text, CIK, company identity, and retrieval time. A random URL mentioned in a filing is not sufficient.
4. Check URL validity, conflicting candidates, redirects, and corporate subdomains. In particular, avoid duplicating a company represented by both a root domain and a corporate subdomain. Do not guess a registrable domain by blindly taking the last two hostname labels.
5. Cache grounded results and feed confirmed domains into matching. Continue requiring Workday evidence separately; a company's website does not prove Workday usage.
6. Keep missing or ambiguous results in review. Decide separately how recoverable pending reviews should be reconsidered once better website evidence arrives.
7. Validate coverage on a representative live sample before selecting this as the default unattended resolver. Treg can remain an explicit alternative, rather than a silently enabled fallback using personal credit.

The SEC-specific proposal above was not implemented. The chosen Treg-based implementation is documented in the follow-up and runbook.

## Primary references

- [SEC API documentation](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [SEC automated-access guidance](https://www.sec.gov/about/webmaster-frequently-asked-questions)
- [NVIDIA annual report, Available Information](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000021/nvda-20260125.htm)
- [Target annual report, Available Information](https://www.sec.gov/Archives/edgar/data/27419/000002741926000016/tgt-20260131.htm)
