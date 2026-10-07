# Input automation (Krish)

Two preview-only collectors. Neither writes to the database, assigns
scores, or invents facts. Both print reviewer-ready JSON a person must
approve before anything reaches `workday_signal_date`, evidence strings,
or the scoring engine.

## Signal dates

```sh
node scripts/collect-signal-dates.mjs --companies <file.json> [--out <file.json>]
```

Input: `[{ "name": "Acme", "domain": "acme.example", "source": "https://www.workday.com/.../customer-stories/acme.html" }]`.
Accepts an array or `{ companies: [...] }` (Nevin's research JSON uses the
latter shape). The Workday story URL is fetched first; the domain homepage
is a fallback. Companies with neither are skipped, never guessed.

A row is `storable: true` only for a day-level date ("March 4, 2024",
"4 March 2024", "03/04/2024", ISO) beside a go-live statement, and even
then a reviewer must confirm HCM scope before storing. Announcement and
selection dates, finance-only launches, month/year-only and year-only
phrases, quarters, and ranges are always `storable: false`. Every row
carries the source URL and surrounding context as the reason.

## Job postings

```sh
node scripts/collect-job-postings.mjs --boards <file.json> [--out <file.json>]
```

Input: `[{ "company": "Acme", "board": "greenhouse", "board_token": "acme" }]`
(accepts `{ boards: [...] }`). Boards are `greenhouse` (public
boards-api board token) or `lever` (Lever site name). Board mappings must
be supplied by a human; they are never guessed. Output rows carry title,
posting URL, requisition, location, employer, checked date, and active
status. Empty boards and bad tokens produce explicit recheck rows.

Matches the research methodology's posting record (URL, requisition,
employer, checked date, active/expired). Company-owned Workday-team
postings versus consultant postings still need human review.

## Checks

`npm test` runs `tests/input-automation.test.mjs` (offline: fetch is
injected, no network). Then `npm run lint`, `npm run typecheck`,
`npm run build` before opening the PR into `main`.
