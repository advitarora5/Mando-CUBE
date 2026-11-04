# Approved AI pilot — prepared, not activated

Read-only inspection of the user-supplied project on November 3 found that
`website_resolutions` and `pipeline_admit_review` are missing. The migration history
contains only one recorded entry, despite existing pipeline foundation objects.
Reconcile the actual schema before deployment; do not replay all migrations blindly.
No production SQL or schema changes were performed in this inspection.

The approved entry point can now connect the tested Ollama admission policy to one
explicitly approved Supabase project. No activation flags, secrets, production data,
migration history or schedules were changed while building this path. Gate tests use
simulated model replies and simulated remote store objects; they never contact a
production project. The shared admission/scoring behavior was tested on disposable
Supabase, including one real local admission and assessment.

## Runtime

This command runs on the computer hosting local Ollama. Keep that computer awake and
connected. Vercel serves the dashboard and reads the shared database; it does not host
this Ollama process. The existing hosted discovery workflow remains model-free.

## Required approval and private configuration

Before activation, review the current commit, actual database target, migration history,
other writers (including the separate contact worker), model revision and evidence for
the intended small batch. Obtain explicit permission for that named production pilot.
Configure database credentials privately on the runner; do not paste them into chat,
PR descriptions or run reports. See [rollout preparation](discovery-rollout.md).

| Name | Required check |
| --- | --- |
| `DISCOVERY_EXECUTION_ENABLED` | Leave absent/false until execution is approved |
| `DISCOVERY_AI_EXECUTION_ENABLED` | Additional AI-admission approval; leave absent/false |
| `DISCOVERY_SINGLE_WRITER_CONFIRMED` | Requires actual coordination with other writers |
| `DISCOVERY_SCHEMA_CONFIRMED` | Leave absent/false until required schema and functions are verified |
| `DISCOVERY_APPROVED_PROJECT_REF` | Exact approved 20-character project reference |
| `PIPELINE_ALLOW_REMOTE` | Must equal that reference |
| `PIPELINE_SUPABASE_URL` | Exact `https://<approved-ref>.supabase.co`, matching Vercel's project |
| `PIPELINE_SUPABASE_KEY` | Authorized server-side key configured privately |
| `DISCOVERY_APPROVED_MODEL_DIGEST` | Exact reviewed 64-character model digest from local `/api/tags` |
| `OLLAMA_HOST` | Loopback HTTP URL with explicit port; default `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | `qwen2.5:7b` (or absent, which selects that same model) |

Both execution flags, schema confirmation and writer confirmation must be exactly `true` for the approved
path to start. The factory rechecks the actual store's target and rejects model revision
changes before inference. The approved capability is bound to that concrete store;
cloning it or moving it to another context/store cannot authorize another database.
The original local CLI still refuses remote projects even when approval variables exist.

## First command, only after approval and reviewed configuration

The proposed first pilot processes already collected candidates, then scores the one
admission if identity is confirmed:

```sh
node scripts/discovery-execute-approved.mjs --approved-ai --ai-admission-only
```

This example is not an instruction to run it now. Required flags remain unset/false.
It permits one candidate, at most three model checks, a four-minute request timeout,
and a ten-minute supervisor deadline. It admits at most one company. For a later
separately approved full-discovery pilot, omit `--ai-admission-only`; source collection
remains bounded. No migrations or contact-enrichment steps are included.

Both model and Treg clients on the ordinary pipeline context must be absent for approved
AI admission. Only the internally constructed loopback Ollama provider can supply the
verdict. Its response must report zero API cost. Unsupported evidence, uncertainty,
exhausted limits, model errors and conflicting sites stay held. Human decisions,
duplicate checks and atomic review admission are preserved. Guessed domains are only
input candidates, never admission evidence. The checker threshold has not been lowered.

## Review the outcome

Inspect the safe run summary and its stage counts. Audit each admitted company and
assessment in the target database and Vercel dashboard; fixture tests do not substitute
for that audit. Model evidence/results remain local in the run's `identity/` folder and
are not uploaded by the existing summary artifact pattern. Do not share raw provider
output or private contact records in the shared issue log.

The first real local targeted run admitted and scored one company in about 200 seconds;
this does not establish sustained throughput or real-company accuracy. Common Crawl
and Wayback remain unreliable. Successful admission-only checks do not establish
three-source discovery health.

## Stop and recover

Setting either execution flag to false blocks future approved AI starts; it does not
cancel an active batch, whose approval is a fixed snapshot. Stop an active run explicitly
and inspect stage checkpoints. In-flight database writes may have completed. Do not
assume rollback, delete admitted companies automatically, or apply migrations as recovery.
Recurring scheduling still requires separate approval and configuration.
