# SEC sections: assignment preview

Step 1 provides a fixed assignment list and read-only previews. Section execution and progress tracking will follow in later steps. These commands never initialize database or research-provider clients, make network requests, or write pipeline data.

```bash
npm run pipeline -- sections
npm run pipeline -- section 3 --preview
```

Choose a number from **1 through 10**. Agree on one person per section; with nine people the tenth section can be assigned later. A section number is required for every preview; there is no default or saved personal setting. The section preview prints every assigned issuer, its CIK, and its position in the deduplicated list. The overview prints all section boundaries and counts. Positions are one-based and inclusive.

## Fixed assignments

Assignment `sec-sections-v1` pins the repository's existing `sec.json` by SHA-256 in `src/data/sec-sections-v1.json`. It was frozen on November 15, 2026; this is the assignment freeze date, not a claim about when the SEC originally published or fetched the saved data.

The snapshot contains 10,445 ticker rows and 8,028 unique issuers. Deduplication uses CIK, retaining the first occurrence and its company name in snapshot order. Sections 1–8 have 803 issuers each; sections 9–10 have 802 each. An issuer is assigned exactly once, even if it has multiple tickers. Companies with different CIKs retain separate assignments even when names match; company identity matching happens later.

Assignments are calculated before any pipeline eligibility, existing-company, or completed-work filtering. Every teammate using the same assignment version and checksum gets the same sections. `PIPELINE_SEC_FILE` and live SEC updates do not override this assignment snapshot. Changing `sec.json` causes previews to fail checksum validation. Coordinate a new assignment version before changing the pinned snapshot or partition algorithm; never quietly repartition active work.

## Database target and current limits

Previews show the hostname configured by `PIPELINE_SUPABASE_URL`, labeled local or remote. A remote hostname alone does not identify whether a project is production or staging; verify the intended project through the team's deployment configuration. Missing database configuration is allowed for previews. No credentials, URL user information, paths, or query parameters are displayed.

Completed and remaining counts are not available yet. The preview lists assigned issuers regardless of existing progress. `section 3` without `--preview`, execution options such as `--limit`, and invalid section numbers are refused. The existing `run` command also rejects section options instead of silently ignoring them. Existing unsectioned pipeline commands retain their original behavior and must not be used as a substitute for section execution.

Do not use these previews as authorization to begin nine concurrent production runs. Later steps must enforce section scope through discovery and evidence processing, make admission safe under concurrency, and add the shared scoring queue.
