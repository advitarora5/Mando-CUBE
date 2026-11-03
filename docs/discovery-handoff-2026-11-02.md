# Discovery recovery handoff — November 2, 2026

Built on `refined-pipeline` commit `49decd515c6eeed6a55597ae353a76da62f862b2`.

## What changed

- Tenant-aware primary-site ranking selects ShellCareers ahead of NOVCareers.
- Job collection recovers observed alternatives from saved discovery responses. It tries at most three sites and only falls back after a successful unfiltered empty result. Access failures stop that tenant; disabled sites stay disabled.
- Opt-in corporate-careers discovery verifies company identity on public pages, follows exact HTTPS Workday links, and retains the source HTML and anchor. It recovered Bank of America's `ghr` tenant and Caterpillar's `cat` tenant without manually supplied company URLs.
- New careers-link signals remain at 0.6 confidence. Existing admission rules and the shadow identity checker are unchanged.

## Fixed-list comparison

The same [twenty names](../research/discovery-20-2026-11-02/selected-sec.json) were used in both runs.

| Result | Original | Revised |
|---|---:|---:|
| Company tenants/sites found | 1 | 3 |
| Job-detail captures | 0 | 15 |
| Admitted | 0 | 0 |
| Held | 1 | 3 |

The revised sites are `ghr.wd1/lateral-us` (Bank of America), `cat.wd5/CaterpillarCareers` (Caterpillar), and `shell.wd3/ShellCareers` (Shell). The baseline selected Shell's empty NOVCareers site.

Of the twenty revised searches, three found sites, eight produced completed misses and nine had retryable corporate access/transport failures. Misses are not proof that a company does not use Workday. See the [baseline](../research/discovery-20-2026-11-02/baseline-summary.json) and [revised](../research/discovery-20-2026-11-02/revised-summary.json) stage reports.

The original used scoped local Supabase and the revised experiment used an isolated MemoryStore with live HTTP. Public pages were fetched at different times. This measures discovery behavior; it is not a PostgreSQL integration test or a production error-rate estimate. No new AI accuracy claim is made.

## Checks

- `npm test`: 374 passed, zero failed.
- `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- Patch application against the original commit was checked.

## Reproduce

Use Node 24, run `npm ci`, then:

```sh
node scripts/pipeline-discovery-comparison.mjs
```

The runner reads the frozen list and repository `sec.json`, scopes the resolver to exactly those twenty names, enables corporate discovery only in that isolated run, and writes timestamped results under `var/discovery-comparison-*`. It uses public HTTP with an in-memory store, no real database writes, no Treg service, no model calls and no paid APIs. It does not need production credentials. The runner exits on a source block; inspect stage statuses and errors rather than treating command completion as discovery success.

The normal resolver's corporate-careers path remains opt-in through source config `corporate_discovery: true`. See [the runbook](ingestion-runbook.md#discovery-recovery-local-experiment) for bounds and optional candidate URL configuration. The full-name `.com` hypothesis is limited and is not a substitute for a configured website-lookup service.

## Where to continue

**Automatic admission remains unresolved.** All three recovered candidates are held as `no_website`. Website confirmation has not completed; the team lookup service is unconfigured, and the new careers-link/hiring signals remain below the existing trusted-signal threshold. Shell is the only candidate with a trusted discovery signal in this run.

The next implementation work is to carry captured corporate-link provenance into the existing website-verification path, then evaluate what independently verified evidence should qualify a discovery signal as trusted. Use teammate review and fresh independently labeled wrong pairings before changing admission behavior. Do not treat the positive recovery cases as evidence of a zero false-positive rate.

All code is for review. This handoff does not merge, deploy, enable schedules, approve held companies, or alter production data. Original evaluation and evidence ZIPs remain separate from this source change.
