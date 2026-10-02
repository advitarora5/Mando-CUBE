# Working boundaries

Suggested Group 1 allocation:

- Stefan: src/features/company-list and src/features/weekly-history.
- Nikhil: src/features/company-detail, src/features/company-editor and src/features/csv-import.
- Anushka: route integration, branding, dependencies, deployment coordination and review.
- Group 2: src/domain/scoring, src/data and scripts.

Joint contract: src/domain/contracts and docs/database-setup.md. Agree changes before implementation. Keep route pages thin as features are extracted from the initial preview.

Assign one migration owner and one dependency/lockfile owner. Coordinate global style changes. Use small feature branches and PRs against the agreed integration branch. Develop with synthetic fixtures rather than committing contact data or secrets.

Empty future feature folders are not tracked by Git until they contain implementation. No GitHub usernames were assumed for CODEOWNERS.
