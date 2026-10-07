# Nevin: company research handoff

Company research cutoff: 2026-10-04. Contact follow-up: 2026-10-05. Scope: the company/contact dataset and research methodology. No database schema, scoring algorithm, authentication, weekly snapshot, or deployment changes.

## Deliverables

- `src/data/research/workday-companies.json`: 110 distinct organizations with company-specific Workday HCM confirmation, 73 sourced contacts across 72 companies, and evidence/review notes keyed by existing IDs. The October 5 follow-up adds 19 contacts across 18 previously uncovered companies, supported by employer sources and matching public profiles. 38 companies still have no matched contact.
- `src/data/research/methodology.json`: canonical methodology rendered by `/methodology`, linked from the dashboard footer.
- `scripts/research-data.mjs`: validates existing table fields, IDs, source coverage, LinkedIn profile format, and research gaps; optionally exports CSVs and JSON. It performs no database writes and makes no network requests.
- `docs/company-research-methodology.md`: readable methodology export for Group 1 review.
- `src/data/research/prior-tracker-leads.json`: 16 additional Week 1 research leads from the user-supplied tracker, sorted by its original score, with exact sheet/cell references. These are outside the 110 confirmed-company cohort. The tracker was read without editing or changing its sharing permissions.

## Validate and export

Run `node scripts/research-data.mjs` from the repository root. To export, run `node scripts/research-data.mjs --export <destination-directory>`. Run the existing test, typecheck, lint, and build commands for project integration.

The company and contact CSVs use the exact existing `companies` and `contacts` fields. Empty CSV values mean null, not zero or a guessed value. Preserve UTF-8 names. Company and contact UUIDs are deterministic so repeated imports can match the same records.

## What the evidence supports

Every company links to an official Workday story whose product list explicitly includes Human Capital Management. 102 have a sourced workforce snapshot of at least 3,000. Seven have no extracted workforce count; CL Grupo Industrial’s approximately-3,000 threshold remains unresolved and is stored as null. Counts are historical/rounded source snapshots, not audited current headcounts. Veolia UK & Ireland and Sopra Steria Scandinavia use regional figures. The British Heart Foundation source contains conflicting 4,000/4,500 figures, disclosed in its evidence note.

The contact source establishes a reported employer/role; the identity source links to the matching public profile or a primary biography that links it. Nineteen contacts are marked `company_listed_role_checked`, with October 5 employer-source/profile evidence; 54 older leads remain marked `requires_current_role_review`. A company listing does not establish direct buying authority, reachability or a warm connection. Recheck before outreach. Broader HR/IT leadership and systems-owner equivalents retain their actual titles; they are not mislabeled VP HR or IT Operations Manager. Mutuals are null because none were visible. Companies with no confidently matched target contact have an explicit gap rather than a fabricated person.

Known stale/ambiguous candidates were excluded, including Nathalie Carruthers at Blue Yonder, Brian Seely at Shake Shack, Fredrik Wetterlundh at Scandic, and same-name Topcon profiles. Follow-up found company-listed replacements Jamie Griffin at Shake Shack and Elin Ekrol at Scandic. Natalie Bickford is not added for Sanofi: her public profile indicates a move to Diageo. Sanofi lists Véronique Jaillet as interim CPO, but a matching profile was not confidently resolved. Jennifer Hornery’s older record explicitly flags that her public profile points to Cochlear Foundation; her sourced operating-company role is historical.

## Integration with Group 2’s importer and scorer

Use the existing tables. `dataset.companies` and `dataset.contacts` contain only existing schema fields; `company_evidence` and `contact_evidence` are file-level research metadata, not new database tables or columns. Preserve this provenance file when importing. Resolve existing IDs/domains/names/reviewed aliases first, remap contact foreign keys to any existing company ID, and deduplicate LinkedIn profile URLs before inserting. Do not blindly upsert over hand-edited records. Check parent/subsidiary scope manually; do not count a rebrand as a new company.

On October 5, 110 companies and 19 role-checked contacts were imported into the existing Supabase project, preserving the team's existing records. The 54 historical-role leads remain staged for review. See `docs/supabase-research-import.md` for the receipt and safe repeatable SQL importer. The database now contains 136 companies and 39 contacts; scores, insights and snapshots remain at 26 each. Keep any import credentials in ignored local environment files, never in Git or a PR.

No numeric category scores, total, tier, or qualification rank are supplied. The existing repository includes tier evaluation, but the evidence-to-category assessment rubric and real company assessments are not available here. Public profile access alone does not establish reachability or authority; workforce scale alone does not establish budget. Exact HCM go-live dates and active internal Workday jobs are unverified in this cohort. Those fields stay null/unverified. The file’s research queue puts sourced size and matched contacts first, then names alphabetically; it must not be presented as a scored TAM ranking.

The supplied `Mando_TAM_Tracker.xlsx` does contain 16 historical scores, preserved separately as research priorities. Its rubric is Gone Live 25, Buyer Persona 25, Job Posting 25, Customer Budget 15, Warm Channel 10, with tiers at 70/50. Those categories and thresholds do not match the current dashboard. Its company/contact notes are useful leads, but several sources are generic landing pages, named targets are not all identified people, and announcement dates are not exact HCM go-live dates. Do not import those legacy scores, dates, or placeholder contacts into current assessments without reassessment. `/methodology` exposes the earlier priority order and its provenance; the export command adds a separate priority CSV.

After reviewers assign evidenced assessments, the existing dashboard orders the latest scores highest first and applies the existing tier rules. Keep its current 100-point rubric (25/25/20/15/15); the older workstream’s timing-10 discrepancy is not changed in this PR. Leave generated insights and human overrides to the assigned scoring workstream. Append assessments and use existing weekly snapshots rather than overwriting history.

## Dashboard review

Open `/methodology` in the existing app to read the methodology and expand any of the 110 research records. The page displays all company confirmation links, workforce caveats, contact/profile/identity sources, and open research gaps without requiring Supabase access. This is a review of the versioned cohort, not a replacement for the database-backed dashboard. It becomes available on the hosted app after Group 1 reviews, merges, and deploys the PR.
