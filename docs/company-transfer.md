# Import reviewed local discovery companies

The transfer tool exports an explicit reviewed selection from the local database and prepares SQL for a target database. It never executes SQL. Production stays untouched until we explicitly decide to run the generated import there. No new migration or model endpoint is required.

## 1. Select the reviewed companies

Create an ignored file such as `var/company-transfer/reviewed.json`:

```json
{
  "companies": [
    {
      "local_company_id": "00000000-0000-4000-8000-000000000001",
      "review": {
        "approved": true,
        "reviewed_at": "2026-11-10T18:00:00Z",
        "note": "Confirmed company identity and Workday employer connection.",
        "evidence_urls": ["https://example.com/careers"]
      }
    }
  ]
}
```

Only explicitly selected IDs are exported. Review the earlier batches before including them; the candidate count of 22 is not itself an approval. Exclude Accenture's incorrect Avanade admission and any held candidates.

```sh
mkdir -p var/company-transfer
npm run companies:transfer -- export --manifest var/company-transfer/reviewed.json --out var/company-transfer/package.json
npm run companies:transfer -- prepare --input var/company-transfer/package.json --out var/company-transfer/preview.sql
```

Both commands load `.env.pipeline.local`. Export accepts a local source only. Preparation reads the configured target's company identities and writes a per-company `.report.json` alongside SQL. A remote target requires the existing explicit `PIPELINE_ALLOW_REMOTE` project setting. Do that only when authorized to access that target.

## 2. Review and test locally

Exact normalized domains attach to existing companies. Ambiguous names, parent/subdomains, conflicting aliases and duplicate normalized target domains are held. Resolve these deliberately and prepare again. Existing company fields are preserved. A held company blocks generating runnable SQL for the batch.

To execute the default preview on our local Supabase instance:

```sh
docker exec -i supabase_db_Mando-CUBE psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 < var/company-transfer/preview.sql
```

The preview runs the real inserts and conflict checks inside a transaction, prints the ID mapping, and rolls everything back. Table locks last for that transaction; use a short quiet window for the eventual production import. Conflicting ownership of an existing signal or Workday site aborts the entire transaction. A changed target company list also aborts: prepare a fresh preview.

## 3. Apply only when ready

`prepare ... --apply` writes the same transaction ending in `COMMIT`. It still performs no database writes. Execute that file against the approved target only after reviewing the preview. Always use `psql -v ON_ERROR_STOP=1`, or an SQL editor that executes the entire transaction together. Never run individual statements separately.

The package carries company facts, signals, raw captures, extraction output, Workday sites, and human review provenance. Original evidence timestamps stay intact. Target IDs are mapped for related records; new companies retain their local UUID. Sources missing on the target are added disabled with no provider configuration. Existing sources, company facts and site collection settings stay intact. Local run/review foreign keys are replaced with target references; import run metadata records the local ID mapping and review notes.

Re-running an unchanged apply file reuses companies, captures, extractions, signals and sites. A new audit run is recorded. Evidence dates merge using the original earliest/latest observations, never the import time. If target company identities changed in the meantime, prepare again.

Scores, insights, snapshots, contacts, discovery queues and model/provider settings are excluded. New companies receive pipeline origin so the current scoring engine can process them later. After importing, use the mapping report's target IDs to define the rescore cohort; importing itself never starts scoring or contact research.
