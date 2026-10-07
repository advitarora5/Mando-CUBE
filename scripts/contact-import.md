# Contacts-only import

This command never imports companies, scores, or insights and never changes dashboard UI. Existing contacts and original research metadata remain untouched.

Offline extraction, without credentials or database access:

```sh
node scripts/import-contacts.mjs /Users/avanteuer/Downloads/companies.csv --offline
```

Database-aware preview (only when database reads are authorized; credentials supplied through the environment):

```sh
node scripts/import-contacts.mjs /Users/avanteuer/Downloads/companies.csv
node scripts/import-contacts.mjs /path/to/reviewed-contacts.csv --reviewed
```

Apply reviewed contacts (only when writes are authorized):

```sh
node scripts/import-contacts.mjs /path/to/reviewed-contacts.csv --reviewed --apply
```

The command defaults to preview. `--offline` and `--apply` cannot be combined. Prose input cannot be saved directly: extraction does not constitute approval.

## Input formats

Original company CSV: `company`, `linkedin contact / target`, and optional `evidence / source`. Header whitespace is normalized. Only a narrow single-person grammar is extracted: explicit person name, optional recognized credentials, explicit role, company suffix matching the full name, its explicit parenthesized alias, or the name without Inc./plc. Multiple-person prose, qualifications, title-only targets, and unverified candidates go to review. No comma/and heuristic attempts to reconstruct arbitrary prose. Extracted prose always requires review; source links are not guessed from general evidence notes.

Reviewed CSV required headers: `company,name,title,approved,original_notes`. Optional: `linkedin_url,source,mutual_connection,evidence / source`. Quote fields containing commas or newlines using normal CSV quoting. One named person per row. `approved` must be `yes`; absent approval never saves. Keep the original target wording, qualifications, and evidence context in `original_notes` and the evidence column. Resolve any unverified/conflicting claims before approval. Names can carry recognized comma-separated credentials (JD, CHCIO, CPA, CEP, CECP, PhD, MBA, MD); other forms require review. Links must be HTTP(S); profile links must be individual LinkedIn `/in/` URLs. Leave missing fields blank. Supply a source only after confirming that it explicitly supports this person, not merely the company. Never turn a connection degree into a mutual count.

Output is one JSON record per row containing action, reason, candidate fields, original notes, evidence context, and resolved company/ID when available. Actions include Add, Preserve existing, Needs review, and No named person. Offline output has no database matching and no contacts approved for saving. A reviewed offline row marked Candidate is eligible for matching, not yet Add.

## Preservation and limitations

Company matching trims, collapses whitespace, and ignores case; missing or multiple matches require review. Existing contacts are compared within the company by deterministic ID, normalized name (excluding recognized trailing credentials), or normalized profile URL. Conflicting identities/multiple matches require review. Identical input candidates collapse; conflicting duplicates require review. IDs use company ID plus normalized name, excluding mutable title/source/profile fields.

Saving uses primary-key conflict-ignore insertion; it never updates an existing contact, including a team-edited deterministic-ID row. It preserves manual contacts matched by name/profile. Changed names or concurrent manual additions can still create semantic duplicates because the existing schema has no person uniqueness/provenance constraint. Run one import at a time and review matches. No schema changes are included.

Raw notes and evidence appear in the review output and remain in existing company research metadata. The contacts table has no notes column, so this importer does not store additional raw notes there; retain the reviewed CSV outside Git. Qualifications without a schema field remain in those notes. Apply does not rewrite metadata or create new assessments. Keep real contact files out of the repository; tests use synthetic data.

Checks: `npm test`, `npm run lint`, `npm run typecheck`.
