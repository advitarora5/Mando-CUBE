# Mando CUBE

Local Next.js dashboard scaffold for enterprise prospect qualification.

## Run locally

Requires Node.js LTS and npm.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000. Development binds to 127.0.0.1. Set `DASHBOARD_PASSWORD` and `SESSION_SECRET` before signing in. Missing credentials display fictional, unscored sample companies.

## Database

Project: https://fkhychihxpregusklggo.supabase.co

The initial SQL migration has been applied to the connected Supabase project. New database projects should apply `supabase/migrations/202610020001_initial_schema.sql` once. See [database setup](docs/database-setup.md).

Set `SUPABASE_SECRET_KEY` in `.env.local` to a Supabase server-only secret key (legacy service-role keys also work). Never use a publishable/anon key for this adapter or put secrets in chat or NEXT_PUBLIC variables. Restart after environment changes.

RLS denies public database access. The server adapter uses a privileged key; the shared-password login protects dashboard reads and editing. Database errors display an error instead of sample data.

## Verification

```bash
npm run lint
npm run typecheck
npm run build
```

## Scope

- Next.js App Router, TypeScript, Tailwind, ESLint.
- Dashboard preview and server-side company reads.
- SQL schema and company/score contracts.
- Supabase, validation and CSV libraries installed for subsequent work.
- Company detail pages support editing company fields, buyer insight overrides, and contacts, plus adding contacts. Imports, scoring automation, weekly refresh, and deployment are not implemented.
- Preliminary PDF-derived colors; Arial fallback until Figtree assets are configured.

See [ownership](docs/ownership.md).

## Company input automation

Group 2's collectors discover verified exact Workday HCM go-live dates and
Workday-related employer postings. Run `npm run inputs:refresh -- --companies
src/data/research/workday-companies.json --out src/data/input-automation/latest.json`
for a dry run. See [input automation](scripts/input-automation.md) for search
configuration, evidence review, database apply, scheduled runs, and scoring
handoff. No schema changes or weekly rank/history writes are included.

Production builds use the supported Webpack option because Turbopack worker port creation is restricted in this execution environment.

## Fictional demo fixture

`npm run seed:demo` writes nine fictional companies named Demo Company 1–9, with John Smith contacts and Google placeholder links. Totals range from 38 to 95, including tier boundaries of 55 and 80. Stable IDs avoid duplicates, and Company 1 reuses the original demo record. Existing assessments are preserved; reruns reset demo company/contact fields and generated insights but preserve manual insight overrides. These are testing fixtures, not researched prospects or automated scoring results. The source spreadsheet is not imported.

## Company detail

Click a company name on the dashboard to open `/companies/[id]`. The detail page shows the saved total/tier, five-category evidence, company information, days since the Workday signal (Chicago calendar days), generated buyer insights and overrides, and contact links.

Each editable section has Save/Cancel controls. Company and insight updates detect stale versions and ask the user to refresh rather than overwriting a concurrent edit. Contact updates are currently last-write-wins. Saving blank insight overrides restores the generated value. Scores remain the latest saved assessment; automatic recalculation awaits the approved scoring engine. Source links accept HTTP/HTTPS only.

No SQL migration is required for detail editing. Reads and mutations require a valid shared-password session, including on Vercel. Weekly history is deferred.

## Dashboard controls

Search matches company names, domains, industry, headquarters, why-now text, and contact names/titles. Filters combine tier and inclusive minimum/maximum total scores on the confirmed 100-point rubric. Invalid ranges show an error. Unscored records are excluded when a score limit is applied. Reset restores all records and the default highest-score-first sort.

Click the Rank, Company A–Z, Total /100, or Tier column header to toggle ascending/descending ordering. Arrows and accessible sort states indicate the active direction. Rank defaults to ascending (highest scores first); tier descending places Qualified before Maybe and Disqualified, with unscored records last. Missing values sort last; company names sort naturally. Ranks are computed from the full scored dataset before filtering or display sorting. Ties share a competition rank (1, 2, 2, 4); unscored companies have no rank. Portfolio counts describe the full dataset, while the result count describes the filtered list. Filters are currently local page state and reset on a reload.

Run `npm test` for focused ranking/filtering checks.

## Tier eligibility

The shared tier evaluator recomputes totals from the five category scores and derives the displayed tier on both list and detail reads. Qualified requires 80+, Maybe requires 55+, and both require Authority and Reachability evidence formatted as `http(s)://source | nonempty reason`. Timing-only assessments (no Authority, Reachability or Budget points) are Disqualified. Invalid/out-of-range category values fail closed. The detail page explains the result.

Evidence checks validate presence and format, not factual accuracy or buying authority. Research verification and evidence-to-score generation remain separate. Existing database assessment rows are not rewritten; displayed tiers are evaluated using current rules. New demo assessments also use the evaluator. Future import/scoring/snapshot writers must call the same evaluator before saving a tier. No SQL migration is needed for this application change.

## Scoring

The rubric lives in `src/domain/scoring/rubric.ts`: the five categories with their weights (Authority 25, Reachability 25, Budget 20, Release 15, Timing 15), the tier thresholds (Qualified 80, Maybe 55), the go-live bands and `RUBRIC_VERSION`. Change numbers there only.

Writers (import, weekly refresh) build a score row with `buildAssessment(companyId, input)` from `src/domain/scoring/assessment.ts`. Each category takes `{ score, source, reason }`. Any category that earns points must have an HTTP(S) source link and a one-line reason, otherwise the result is `{ ok: false, errors }` and nothing should be saved. On success, `row` can be inserted into `scores` as is (it leaves out `total`, which Postgres generates).

`goLiveTiming(workday_signal_date, source)` produces the Timing Trigger input from the go-live date (Chicago calendar days): announced more than 180 days out scores 6, announced within 180 days scores 12, 0-30 days post go-live scores 10, 31-90 days scores 15, 91-180 days scores 13, 181-365 days scores 6, and older scores 0. A missing date scores 0. The bands are `goLiveBands` in `src/domain/scoring/rubric.ts`.

The Timing Trigger does not read the Workday release calendar; that belongs to Release Alignment. `src/domain/scoring/releases.ts` holds the calendar for that purpose: Workday ships R1 in March and R2 in September to every tenant on the same Saturday. Confirmed dates are listed there; later ones are estimated as the second Saturday of March and third Saturday of September.

`releaseAlignment(source)` produces the Release Alignment input from days until the next release (Chicago calendar days): under 2 weeks scores 3, 2-6 weeks scores 9, 6-12 weeks scores 15, 12-18 weeks scores 10, and more than 18 weeks scores 5. The bands are `releaseBands` in `src/domain/scoring/rubric.ts`. The score depends only on the date, so it is the same for every company on a given day; it does not yet use company-specific evidence. Nothing in the app calls it yet.

The company page shows each category as points out of its weight with the reason and source link, flags any score that lacks evidence, and shows the go-live score next to days since signal.

## Saving assessments

`npm run score:save -- "path/to/assessments.csv"` checks a sheet of reviewed scores and prints what would be saved. Add `--apply` to append the rows to the `scores` table. If any row has a problem, nothing is saved.

The CSV has one row per company and these headers: `company_id` or `company` (exact name as stored), then `<category>_score`, `<category>_source` and `<category>_reason` for each of `authority`, `reachability`, `budget`, `release` and `timing`. Rows go through `buildAssessment`, so points without a source link and reason are rejected.

A blank score counts as 0, with two exceptions, and a row with no scores at all is rejected rather than saved as Disqualified. If `timing_score` is blank and `timing_source` is filled, Timing is calculated from the company's `workday_signal_date`. If `release_score` is blank and `release_source` is filled, Release is calculated from the release calendar. Assessments are appended, not overwritten, and running the same sheet twice does not add duplicates.

`scripts/assessments-demo.csv` is a ready-made sheet for the nine fictional demo companies from `npm run seed:demo`. It matches them by name and lets Timing and Release be calculated.

## Shared password and Vercel

Set `DASHBOARD_PASSWORD` to the team's chosen password in ignored `.env.local`. Set `SESSION_SECRET` to a random value of at least 32 characters (generate with `openssl rand -hex 32`). Quote environment values containing `#` or spaces. Restart the development server after changes. Never prefix these variables with `NEXT_PUBLIC_` or commit the password.

Visitors sign in at `/login`. All visitors have the same editing access, without accounts or user tracking. A signed HttpOnly, SameSite=Lax cookie lasts seven days and uses Secure in production. Log out removes the browser cookie; changing the password or session secret invalidates all existing cookies. Missing auth configuration blocks access. Data repositories and each save action enforce authentication independently.

Login attempts are limited to ten per fifteen minutes per IP within each server instance (one bucket locally). This temporary in-memory counter resets on restart and is not shared across Vercel instances. For a consistent production limit, configure a Vercel Firewall rate-limit rule for POST requests to `/login`. These counters do not identify users or persist activity history.

Import this GitHub repository into Vercel as a Next.js project using the root directory and `npm run build`. Configure `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DASHBOARD_PASSWORD`, and `SESSION_SECRET` in Vercel Settings → Environment Variables for Production and any Preview environment in use. GitHub Actions secrets are not automatically provided to Vercel; `.env.local` is not uploaded through Git. Redeploy after changing environment values. The existing Supabase database stays in place.

Before sharing the production URL, verify logged-out dashboard and direct company links redirect to login, a wrong password fails, login succeeds, editing persists, and logout blocks access again. Preview deployments pointed at the same database can modify the same records.

