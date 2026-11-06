# Sequential discovery batch — disabled until approved

`node scripts/discovery-batch-approved.mjs` prepares a five-candidate plan without
database access or writes. Execution requires `--execute`, the existing exact-target,
AI, schema and single-writer gates, plus `DISCOVERY_BATCH_EXECUTION_ENABLED=true`
and `DISCOVERY_BATCH_APPROVED_CANDIDATES=5`. Do not configure these approval gates
until the named production batch is authorized.

Bounds: at most five workers, each checking/admitting at most one company, at most
ten minutes each and fifty minutes overall. The first worker collects the full
source plan; later workers process saved candidates only. Twenty requests per
source, zero paid services, same pinned local model and unchanged identity policy.
Five attempts may admit zero companies; this is not a throughput guarantee.

The outer batch holds `var/discovery/execution.lock` across every worker. Inner
supervisor artifacts live under `var/discovery/batches/<id>/runs/`; the batch
checkpoint is `batch-summary.json`. Ordinary runs on this computer are blocked
while the batch owns the lock. This is not a distributed lock: coordinate other
computers and hosted jobs separately.

Unresolved candidates have the local per-target one-hour retry cooldown. Changes
to tracked site/review evidence allow earlier retries. Existing outcomes from
before this feature do not automatically populate retry state. No eligible work,
processing failure, missing checkpoint, overlap or timeout stops further workers.
Archive collection failure remains visible while successful processing may continue.
Recorded admissions remain in the summary if a subsequent score step fails.
Database writes are not rolled back by interruption; inspect checkpoints before
any retry. Unknown writes after a lost checkpoint require direct database auditing.

This command does not install a recurring scheduler or persist credentials. The
operator must configure the server-side credential privately in the runner session.
Use one designated awake computer with local Ollama. Source health, company
accuracy, scoring evidence and dashboard visibility still require auditing after
execution. The generic release-score baseline issue remains separate and unresolved.
