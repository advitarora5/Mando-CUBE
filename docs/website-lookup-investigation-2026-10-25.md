# Website lookup investigation — October 25, 2026

## Findings

The existing Hunter API call uses the documented input correctly. Its full legal-name lookup for
`CISCO SYSTEMS, INC.` nevertheless returns `senderbase.org`, `fittechnologies.net`, and `cisco1.ru`,
all labeled Cisco Systems. Those labels previously prevented the normalized-name retry, even after
website checks failed. This is poor candidate coverage rather than proof that the website is inaccessible.

Two bounded live probes demonstrated better discovery:

- Hunter queried with `Cisco` returned `cisco.com`, `cisco.edu`, and `cisco.com.bz`.
  We did not add automatic first-word alias guessing: it can confuse unrelated companies.
- TinyFish web search for Cisco's corporate website/careers returned `cisco.com`,
  `careers.cisco.com`, and the observed Cisco Workday site. The same search also returned job-board
  results, demonstrating why search ranking alone cannot establish ownership.

Both probe calls explicitly reported $0 cost. TinyFish is a separate search provider reached through
the existing Treg gateway; no new account/key was needed. The catalog lists its endpoint as free.
The implementation does not use the broader routed search endpoint, whose fallback providers can
charge even when no useful result is found.

## Changes

When Hunter candidates fail confirmation, the resolver now performs one free TinyFish search.
This fallback runs after verification, so correct-looking provider labels no longer suppress it.
It inspects at most ten result rows, checks at most three safe distinct hostnames, deduplicates
against already checked domains, and saves the search query, selected URLs and titles with the
resolution. Search snippets are not fetched or accepted as company evidence. The existing URL,
public DNS, robots, redirect, response-size and request limits still apply.

Both HTTP and CLI transports require explicit zero-charge metadata for this endpoint. Calls cap
route cost at zero and disable paid waterfall. Malformed responses, rate limits and unexpected
charges remain errors. Successful Hunter confirmations do not incur a search request.

Cisco's homepage uses `Cisco` in metadata, while its explicit copyright element names
`Cisco Systems, Inc.`. Identity extraction now recognizes an exact full legal owner in a marked
copyright element, excluding comments/scripts and requiring a copyright marker. This does not
accept arbitrary body mentions or fuzzy company-name matches. The verifier version advances to 7
so existing cached resolutions can be re-evaluated. No database migration is needed.

## Live validation and remaining blocker

A targeted dry-run read Cisco's saved local Workday evidence and used real provider/website
requests. It found `cisco.com` and independently extracted `Cisco Systems, Inc.` from its footer.
The check used 16 website HTTP requests and $0 paid spending. Company rows were unchanged;
no website resolution or review decision was written. Production was not accessed.

Cisco still does **not** pass full confirmation. The current policy additionally requires either
a corporate page linking to the exact observed Workday tenant/site, or a saved Workday job linking
to the corporate domain. Its linked careers pages did not expose the required Workday anchor in
the HTML traversed. All five saved job descriptions lacked URLs/anchors, and their
`hiringOrganization.url` fields were empty. Search results placing both websites together do not
satisfy that rule. Initial candidate connection errors and an Indeed 403 also remain visible;
the existing rule does not ignore unreadable competing candidates.

Thus candidate discovery now works for this case, but automatic admission/scoring remains
unproven. The next work is to evaluate additional first-party corroboration or explicitly revise
the confirmation policy with evidence-based criteria. Do not describe this change as successful
Cisco admission or enable schedules on that basis.

Private responses, HTML inspection, and dry-run evidence are saved under ignored
`var/website-search-*`, `var/cisco-*`, and `var/hunter-domain-catalog.json`.
The focused website tests and full offline suite pass; typecheck and lint also pass.

Provider references: [Hunter Domain Finder](https://hunter.io/api-documentation/v2#domain-finder),
[TinyFish Search API](https://docs.tinyfish.ai/api-reference/search-the-web),
and [Treg API documentation](https://treg.to/docs).
