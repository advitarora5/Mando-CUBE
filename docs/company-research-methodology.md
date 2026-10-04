# Workday company research methodology

Research cutoff: 2026-10-04

## Build the customer universe

The goal is a ranked universe of Workday customers. This first cohort contains 110 distinct organizations with company-specific HCM evidence; it is a starting sample, not an exhaustive TAM. We reviewed Workday’s public customer-story sitemap and prioritized organizations with a sourced workforce snapshot of at least 3,000 people. The subsequently supplied Week 1 tracker provides 16 additional research priorities, preserved separately with its historical scores. Verify those leads before adding them to the confirmed universe.

Discover additional candidates through employer announcements and careers pages, Workday customer stories, implementation-partner case studies and press releases, public LinkedIn announcements, news, and r/workday. Community posts and search snippets are discovery leads; confirm the actual customer with a named primary source. Read public LinkedIn pages manually through normal browsing or search; do not scrape LinkedIn, use automated profile collection, or bypass a login.

## Confirm the company and product

Require a company-specific source that explicitly identifies the organization using Workday HCM. A careers site hosted on Workday, a partner logo, or an Adaptive Planning-only reference does not by itself confirm HCM use. In this cohort, every confirmation links to an official Workday customer story whose product list includes Human Capital Management.

Record the source URL, a one-line reason, product, entity scope, and research date. A customer story establishes reported use at the time of the story; it does not establish a new deployment or an active buying process. Workforce figures are source snapshots, sometimes rounded or historical, and must be refreshed before treating them as current. Regional deployments retain their regional headcount. Unknown domain, headquarters, and exact dates stay null.

## Research priorities and ranking

Research confirmed customers with 3,000+ employees first, then prioritize an explicitly dated recent HCM go-live and active internal Workday jobs. Suggested research windows are go-lives within 180 days and postings checked within seven days; these are research heuristics, not new scoring rules. Record posting URL, requisition, employer, checked date, and active/expired status. Distinguish a company’s own Workday team from consulting jobs serving other customers.

Use an exact HCM go-live date only when a source states it. Announcement dates, project starts, selection dates, finance-only launches, and phrases like ‘went live in 2025’ must not become exact signal dates. Preserve approximate dates as research notes for review. The initial cohort leaves exact signal dates and job status unverified; it makes no recency claim.

Qualification order comes from the existing scoring engine and latest assessments, highest total first, with a stable name tie-break. The current main branch uses maxima 25/25/20/15/15 and thresholds 80/55; this contribution does not change that rubric. Public profiles do not prove purchasing authority, a warm introduction, customer budget, or release urgency. No scores or tiers are invented. Unscored rows remain unscored; research order is a separate queue, not a qualification rank.

The supplied Week 1 tracker uses different categories: Gone Live 25, Buyer Persona 25, Job Posting 25, Customer Budget 15, and Warm Channel 10, with Qualified at 70 and Maybe at 50. Retain these historical scores as supplied and research the highest scores first. Do not map them directly into current category scores or tiers. Review its announcement-date signals, approximate dates, target-title placeholders, expired jobs, and entity ambiguity against primary sources before using them as qualification evidence.

## Find and verify buyer contacts

Look for up to three contacts per employer: an HR executive (VP HR, CHRO, or equivalent), an HRIS/Workday systems owner, and an IT operations or enterprise technology owner. Store the person’s actual name and title, public LinkedIn URL, and a source connecting the person and role to the employer. Broader CIO and engineering roles are identified as IT leadership; they are not relabeled IT Operations Manager. Technical influencers are not assumed to control budget.

Match employer, role context, and identity before including a profile. Exclude known departures, consultants serving the customer, and ambiguous same-name matches from an active buyer list. Preserve a historical case-study contact only as an explicitly flagged research lead. Case-study titles are reported roles; they may be historical. Every included contact is flagged for current-role review before outreach, and missing contacts remain an explicit research gap. The file contains fewer than three contacts per company where matching evidence was insufficient.

Only record mutual connections actually visible through an authorized team or Adi account. Public ‘can introduce you to people’ text is not evidence of a mutual with our team. All mutuals in this cohort are null/not verified; no account access or team roster was available to establish them.

## Deduplicate without losing evidence

Match canonical company domain when verified, stable ID, normalized company name, and reviewed aliases. Normalize case, whitespace, punctuation, and legal suffixes for candidate matching, but retain the display name. Review acquisitions, rebrands, parent/subsidiary relationships, and regional deployments manually. Keep distinct buying entities separate; MGM China and MGM Resorts International, for example, are separate research entities.

Deduplicate contacts using a canonical LinkedIn profile URL. Name plus employer is a review signal, not sufficient proof of identity. Resolve conflicting sources and duplicate records before import, retaining the stronger evidence and its checked date. The supplied companies and contacts use the existing table fields; research notes live in a versioned file keyed by those IDs. There are no schema changes.

## Weekly additions, evidence, and review

Each week, search the discovery sources, compare candidates to the existing universe, confirm product and entity, and add genuinely new employers. Recheck high-priority companies’ workforce scope, HCM go-live evidence, active postings, and current contacts. Log changed facts, source dates, reviewer corrections, and unresolved gaps. Check a public Workday Rising speaker/session list when available; flag only company-specific evidence with the event year. Participation is not proof of a new HCM go-live.

Before assigning a category score, retain its source URL and one-line reason in the existing evidence string format: ‘https://source | reason’. Apply the project’s authority/reachability evidence requirements and timing-only safeguard. Use the existing date calculation only for verified exact signal dates. The scoring owner reviews assessments and generated persona/level/why-now; human overrides remain intact.

Append weekly assessments and use the project’s existing snapshots to preserve each week’s score and rank. Do not overwrite historical score rows or infer a previous rank for a newly added company. Publish a weekly completeness report: distinct companies, contact coverage, refreshed sources, verified signals, and open gaps. This research contribution leaves scoring, live database loading, weekly automation, and deployment to their assigned owners.
