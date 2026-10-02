# Mando CUBE

Local Next.js dashboard scaffold for enterprise prospect qualification.

## Run locally

Requires Node.js LTS and npm.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000. Development binds to 127.0.0.1 because access control is deferred. Missing credentials display fictional, unscored sample companies.

## Database

Project: https://fkhychihxpregusklggo.supabase.co

The SQL migration in `supabase/migrations/202610020001_initial_schema.sql` has NOT been applied. See [database setup](docs/database-setup.md).

Set `SUPABASE_SECRET_KEY` in `.env.local` to a Supabase server-only secret key (legacy service-role keys also work). Never use a publishable/anon key for this adapter or put secrets in chat or NEXT_PUBLIC variables. Restart after environment changes.

RLS denies public database access. The server adapter uses a privileged key; there is no app login yet. Keep local until authorization is implemented. Database errors display an error instead of sample data.

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
- Editing, imports, scoring, authentication, weekly refresh, and deployment are not implemented.
- Preliminary PDF-derived colors; Arial fallback until Figtree assets are configured.

See [ownership](docs/ownership.md).

Production builds use the supported Webpack option because Turbopack worker port creation is restricted in this execution environment.

## Fictional demo fixture

`npm run seed:demo` writes a clearly labeled fictional company, John Smith contact, a five-category assessment totaling 83, and sample insights into the configured database. Links use google.com as placeholders. The fixture is explicitly not an approved scoring methodology. Stable IDs prevent duplicate demo records on reruns. Rerunning resets the fixture values; do not rerun after using its score in weekly snapshots. The source spreadsheet is not imported.
