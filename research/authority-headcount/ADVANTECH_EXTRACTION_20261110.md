# Advantech extraction — November 10, 2026

The improved collector discovers and extracts **9,512 employees as of March 31,
2026**, using only public GETs from the stored `advantech.com` domain. No manually
injected search URL, company-specific code/count, Treg call or database access was
used. The successful crawl used **17 requests**, within the unchanged six-document,
18-request and 45-second limits. This is one validated company, not a new full
207-company coverage audit.

## Why the previous collector missed it

The November 9 audit stopped before reading a document: `website robots redirect
limit reached` after four requests. Live reproduction shows apex → www locale →
localized robots → corporate error hosts → terminal 404, beyond the original
three-redirect allowance. Headcount research now permits at most six robots
redirects. The shared helper defaults to three for all existing other callers;
DNS/private-address, challenge, robots-disallow, size, request and deadline checks
are preserved. A redirect loop still fails; terminal 404 means no published rules,
not permission to bypass a disallow or challenge.

Two additional gaps existed past that blocker. Investor/report navigation ranked
below general About pages and broad sustainability links consumed document slots.
The annual-report index labels the latest PDF only “Download” beneath a “2025
Annual Report” heading. Headcount discovery now prefers investor/report navigation,
skips direct self-links, distinguishes report links from general sustainability
pages, and associates a generic download with the nearest completed heading within
1,200 HTML characters. It does not inherit an unrelated or distant heading.

Finally, the PDF's employee-information section contains dated columns, Direct
staff, Indirect staff and Total, rather than the prose sentence the old parser
expected. A narrow general table parser now requires an identified employer,
unqualified workforce section, historical year columns and one explicit dated
column, exactly aligned integer rows, and component/total agreement in every
column. It selects the explicitly dated total, even when it is below 3,000. It
does not infer December 31 from a year, accept estimates/FTEs, or borrow regional,
customer, parent or subsidiary counts. Conflicting latest-date evidence is held.
Other table layouts remain unresolved; this is not a universal PDF table reader.

## Source, entity scope and provenance

Discovery path: corporate homepage → investor page → annual-report index →
[official 2025 annual-report PDF](https://advcloudfiles.advantech.com/investor/Shareholder-Annual-Report/115/1-en.pdf#page=166).
The workforce table is at PDF page 166.
It lists 2024 total 8,849, 2025 total 9,494 and March 31, 2026 total **9,512**;
the final components are 3,025 direct plus 6,487 indirect staff. The extracted
record retains the exact source URL, original table excerpt, `basis: exact`,
`as_of: 2026-03-31`, `date_basis: effective`, and `observed_on: 2026-11-10`.

This is the annual-report reporting-company/group workforce for the stored
Advantech employer, not a new country/subsidiary-specific count. It must not be
transferred to a different regional employer. No hard-coded group alias or mapping
was added. The parser remains conservative about explicit group/region qualifiers.

The [public validation artifact](validation/20261110/advantech-direct-and-preview.json)
records source PDF SHA-256, the successful crawl, evidence and a snapshot-based
Authority preview. The small test fixture contains public report text excerpts;
raw report bytes and fetched HTML remain outside Git.

## Read-only Authority impact

No current shared database credentials are available in this checkout: its private
pipeline environment targets localhost. Therefore the preview uses the existing
**November 9, 2026 read-only audit**, not a claimed fresh Supabase read. That audit's
Advantech saved assessment is dated October 28; latest score/contact eligibility
must be rechecked before any future application.

| Comparison | Result |
| --- | --- |
| Contact-based Authority without size, from the saved audit | 15 |
| Same contact calculation with the accepted official count | 18 (15 + 3) |
| Cap | 25; does not bind this calculation |
| Documented existing size award in that audit | None |
| Saved Authority in the audit | 5 |
| Supported automatic saved-score update | **Held** (`saved_authority_not_reproduced`) |
| Additional points against saved score | **Undetermined**, not +13 and not an automatic +3 |

The new evidence supports the size component, but does not explain the pre-existing
5-versus-15 discrepancy. No historical score repair is included. Existing awards,
already size-inclusive saved calculations and the cap still suppress duplicate
awards through the unchanged preview logic. Tests cover those outcomes. Prologis
and Hunter-only bonuses remain held. No estimate-admission behavior changed;
the short [estimate policy](ESTIMATE_POLICY_PROPOSAL.md) is explicitly a proposal.

Validation: **660 offline tests**, TypeScript, ESLint and production build pass; targeted
tests exercise table column/date/total failures, below-threshold totals, entity and
geographic scope, FTE/estimate rejection, source provenance, same-date conflicts,
report-download discovery, bounded robots chains, unsafe redirects and disallow.
No shared integration/mutation tests, migration, score write, merge or activation.
Normal pipeline paid budget remains zero. This work spends no additional credits.
