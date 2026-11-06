# Archive candidate windows

Repeated index downloads were consuming the source deadline before live tenant checks
could begin. Common Crawl and Wayback now stop enumeration once a bounded window has
enough untried names. Supervised execution targets at least six candidates for a two-site
batch; this window is not a complete archive export.

Windows are stored as raw_captures with meta.kind=workday_index_cache, using the existing
schema with no new migration. Snapshots record source/configuration signature and capture
time. Each source reads only its own cache. Entries require valid tenant/pod shapes and
matching configured pods/signature, and expire after 24 hours. Exhausted windows cause
index enumeration to resume, skipping names already known or attempted.

Every untried candidate must still pass a live Workday check. Cache records produce no
signals, sites or model calls during extraction. They cannot supply identity, admission
or scoring evidence. Existing website/admission rules remain unchanged.

A source that times out after enumerating candidates can retain that window for a later
batch. Cache read failure falls back to the index; cache write failure is reported without
discarding collected candidates. Dry runs do not persist snapshots to a supplied store.

Offline coverage checks reuse, fresh live verification, expiry, no evidence from cache,
early enumeration exit and cancellation preserving work. A new database regression checks
retrieval with the existing metadata filter and requires CI or a local database to run.

GitHub CI for PR 44 at 4280f01 passed 468 offline tests and nine database tests with no
skips. The upstream migration-version fix and contact worker have since been integrated
locally. Their code being present does not activate contact research or apply migrations.

Remaining: live archive productivity, updated supervised database-backed validation,
teammate review of identity integration, and explicit production configuration/scheduling
approval. Fixture tests do not establish live yield.
