# Initial Ollama extraction test set

Twelve cases containing fourteen captures. Selection favors clear examples and likely attribution/date mistakes; these are test cases, not the best outreach prospects. Expected results are a manually authored draft based on saved text, ready for team review. No model was run and no database edits were made.

| Case | Source | What it tests |
|---|---|---|
| case-01 | Capital One — recent internal hiring | Open procurement; Active implementation inferred from ordinary responsibilities |
| case-02 | Hays Electrical Services — explicit project, missing date | Known go-live date; Still active today without corroboration |
| case-03 | Advantage Solutions — closed vacancy | Current open vacancy; Removal date used as publication date |
| case-04 | Miami University — event date and scale units | 20,000 employees; Exact October go-live day |
| case-05 | OneDigital — multiple sources and metric granularity | Three distinct companies; 10+ process areas equated to 13 modules |
| case-06 | Modaxo and Volaris Group — legal-entity separation | Merge Modaxo and Volaris Group; Infer CSI product usage from corporate relationship |
| case-07 | Kognitiv customer index — multiple subjects | Transfer one customer’s savings or modules to another; Treat Kognitiv as the end customer |
| case-08 | KPMG index — explicit versus contextual attribution | Brown & Brown has directly confirmed Workday usage from teaser alone; Apply all index statements to all customers |
| case-09 | Tyson Foods — completed historical implementation | Currently implementing because roadmap language exists; Exact completion day |
| case-10 | MMD Services — unnamed staffing client | MMD Services is proven internal Workday customer; Guess client identity from geography or industry |
| case-11 | Reddit — anonymous delayed multi-module rollout | Guess employer from countries/modules; Assign an exact year to 11/1, 11/9 or 1/1 |
| case-12 | Reddit — tentative OpenGov attribution | Confirmed commenter employer; Confirmed procurement |

## How to record expected results

For each case, review original source segments in inputs.json. Edit the corresponding entry in expected-results.json. For every expected assertion, record the field, expected value, capture ID, segment ID and a short verbatim supporting passage. Record unknown fields explicitly; do not fill them through external research. Mark named organizations as customer, provider, parent or tentative candidate. Distinguish posting/publication dates from project, closure and webinar dates, and preserve the stated date precision.

The existing required_claims entries are a starting answer key. A reviewer can approve each case by changing review_status to approved after checking the passages and interpretation. Add extra claims only when evidence supports them. For paragraphs naming several customers, quote the passage specific to each customer. For Reddit replies, retain ancestry and distinguish each speaker’s employer from the post author’s.

## Example annotation

Hays Electrical Services: company identity explicit; HCM explicit; active implementation described; parallel payroll/benefits testing described; publication and go-live dates unknown; current status unverified. The phrase “this role starts by supporting the active implementation” supports the project claim. It does not establish when go-live happens, licensed Payroll/Benefits modules or buying budget.

## Running the eventual evaluation

Give Ollama only inputs.json and the agreed extraction prompt/schema. Keep expected-results.json out of its context. Compare the result with required claims, evidence references, unknowns and forbidden inferences. Accept equivalent wording; require factual values and attribution to agree. Compare lower bounds and partial dates without forcing exact values.

Track correct company attribution, supported claims recovered, unsupported claims added, date/status errors and valid evidence references. Inspect errors per case rather than treating a single accuracy percentage as proof of production readiness. After tuning, use a separate unseen sample; this small handpicked set is for development, not a reliable estimate of overall performance.

Database deduplication is a later evaluation. Do not show the model Supabase matches or earlier collector observations during extraction.
