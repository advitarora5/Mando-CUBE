# Scheduling integration status

Historical initial integration checkpoint. See discovery-operation.md and
discovery-archive-cache.md for later controls and cache behavior. Database integration
subsequently passed in local testing and GitHub CI.

## Completed locally

Branch: anushka/scheduled-discovery. Base main: 1ffff55.
Integrated refined-pipeline: bc66d9796d4081e1a695b5f1c8016ab72cc0f87f.
No remote push, production deployment, provider calls or database changes were performed.

The integration preserves main's reviewed aliases, ordinary-working-day rejection,
rejected-review site disabling and duplicate merge support. The incoming branch adds
the three-source discovery, website proof, attempt progression, financial scoring and
experimental identity tools. Those incoming changes are team work, not newly implemented
scheduling behavior. Experimental identity admission remains local-only; the discovery
command does not invoke it.

Three conflicts were resolved in matching, Workday collection and matching-stage
orchestration. Reviewed alias attachment and confirmed-domain matching are both retained.
An empty tenant-branded site no longer falls through to a potentially unrelated sibling
employer. The saved-score history test now checks the latest pre-refresh assessment,
which includes the incoming contact-enrichment assessment, rather than the first assessment.

Discovery now materializes discovered sites before job collection. A fixture-backed
test with no Treg or model admits and scores 12 synthetic companies on the first run,
then adds no duplicate companies, captures, signals or scores on the second run.
Common Crawl and Wayback are invoked with empty index fixtures in that end-to-end test;
their nonempty-source and repeat-run behavior is covered by separate collector tests.
This result does not establish live yield or validate PostgreSQL behavior.

Validation: all 423 offline tests pass. Database integration remains unrun because no
local database has been set up or migrated with approval for this task.

## Expected dashboard behavior

There is no dashboard layout or page change. Once approved production ingestion is
operational, admitted companies and assessments are saved to the shared database and
appear when the dashboard is refreshed or reopened. The main dashboard uses dynamic
server rendering. Companies with missing qualification evidence may display Needs evidence;
discovery alone does not produce verified contacts or Qualified status. Held candidates
stay in the pipeline review structures rather than being automatically counted as admitted.

## Remaining before unattended production use

1. Review combined branch scope, including the incoming scoring and admission changes.
2. Obtain approval to create a disposable local Supabase database and apply the repository's
   migrations there. Run database integration and bounded network benchmarks against it.
3. Confirm model-hosting and identity-check integration with tasks 2/3 owners.
4. Implement and validate a production execution deadline, bounded downstream processing,
   durable run history/failure reporting and a single-writer lock strategy.
5. Measure admission yield and runtime per source, then select a conservative cadence.
6. Prepare the reviewed production configuration, database migration plan and rollback plan.
7. Obtain explicit approval for production migrations, target credentials and schedule activation.

Keep contact research PR 37 separate and paid execution disabled until authorized.
The current manual workflow prepares a plan only. It cannot collect production companies.
