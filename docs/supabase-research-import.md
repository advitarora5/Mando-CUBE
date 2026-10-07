# Research import — October 5, 2026

Imported into the existing Supabase project `fkhychihxpregusklggo` using its authenticated SQL Editor, after inspecting the live schema and running a transaction that rolled back as a preview.

- Added 110 source-confirmed Workday HCM companies.
- Added 19 employer-listed, public-profile-matched contacts across 18 companies, with source and LinkedIn links. Their roles were checked October 5; recheck before outreach. This does not prove buying authority or reachability.
- Preserved the existing 26 companies, 20 contacts, 26 score records, 26 insights and 26 weekly snapshots.
- Result: 136 companies and 39 contacts in the database.
- Read-only verification confirmed exact field matches for all 110 imported companies and 19 contacts, zero score records for the new cohort, and RLS enabled on all five permanent tables. A repeat preview added zero companies and zero contacts. All 17 repository tests passed.
- The 54 historical-role contact leads remain in the research review dataset, not the live contacts table. They require current-role checks before import. The complete research dataset still contains 73 leads across 72 companies.
- No scores, qualification tiers, go-live dates, insights or weekly history were invented. No database schema or permanent-table security settings were changed.

## Repeatable import

`node scripts/research-supabase-sql.mjs preview.sql` generates a transaction that performs the import checks and inserts, reports counts, then rolls back. Add `--apply` to generate the committing version. Run the preview in the project's SQL Editor first.

The script matches companies by normalized exact name or exact confirmation-source URL, aborts ambiguous matches and ID collisions, remaps contacts to existing company IDs, and preserves existing fields. Contacts are deduplicated by their normalized LinkedIn profile URL; conflicting employers and same-name/different-profile records abort for review. Related entities and new aliases need a human check before importing a changed cohort. Only contacts marked `company_listed_role_checked` are selected.

All staging tables are temporary and dropped at transaction end. Supabase may display its generic missing-RLS warning for these session-only tables; the script does not change RLS on any permanent table.

## Still needed

Group 1 must review/merge PR #2 and deploy it to make the methodology and research-review page available on the hosted dashboard. The existing database-backed company list can read the imported records independently of that merge. Qualification scoring and weekly ranking are the scoring owners' work; newly imported research companies have no assessment yet. Contact coverage remains incomplete, especially HRIS and IT operations roles. Existing demo records were preserved for Group 1 to manage.
