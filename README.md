Backend platform for: https://github.com/Kennygunderman/state-of-health-tracker

## Meal planning

Meal planning is documented under `docs/meal-planning/`:

- [`README.md`](./docs/meal-planning/README.md) — setup and every command in execution order; the catalog release and the recipe seed must be loaded and verified before the feature is enabled.
- [`api.md`](./docs/meal-planning/api.md) — the endpoint contracts.
- [`catalog-policy.md`](./docs/meal-planning/catalog-policy.md) — the coverage plan, validation checks and bounds, provenance model, evidence policy and benchmark thresholds.
- [`planning-policy.md`](./docs/meal-planning/planning-policy.md) — the target-estimate, planning-constraint and grocery-aggregation policies.
- [`release-and-recovery.md`](./docs/meal-planning/release-and-recovery.md) — the operator release order and rollback.
- [`requirement-evidence-checklist.md`](./docs/meal-planning/requirement-evidence-checklist.md) — requirement → evidence mapping.

Before running anything:

- `MEAL_PLANNING_ENABLED` is off unless it is exactly `true`, and until it is set the meal-planning and recipe routes answer `503 feature_disabled`; `/catalog/*` and `/meal-planning/targets*` are never gated.
- The schema is applied by `npx prisma migrate deploy` at container boot; `prisma/manual-migrations/meal-planning/` is a reference copy for operators that no tooling runs.

## Running the test suite

The suite truncates tables, so it runs only against a database it has checked.
Three variables are mandatory, and all three are exact:

| Variable | Required value |
| --- | --- |
| `NODE_ENV` | `test` |
| `ALLOW_DB_TRUNCATE` | `true` |
| `DATABASE_URL` | a database named `*_test` (optionally with a clone index, as in `soh_test_46`) or exactly `ci`, on `localhost`, `127.0.0.1` or `postgres` |

Apply the migrations to that database first, then run the suite:

```sh
export DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/soh_test
npx prisma migrate deploy
NODE_ENV=test ALLOW_DB_TRUNCATE=true npm test
```

Two gates in `src/__tests__/setup/testDb.ts` run before any test. Jest owns
them: `jest.config.ts` registers `src/__tests__/setup/jestSetup.ts` as a
`setupFiles` entry, whose first statement is the identity gate — so it runs
before any application module or Prisma client can load — and whose exported
setup function awaits the schema gate before the first test. `npm test` needs
no lifecycle hook to get them. To ask the same two questions without running
the suite, run the module directly:
`npx ts-node --project tsconfig.test.json src/__tests__/setup/testDb.ts`.

- **Identity** — may this run destroy this database? Anything outside the table
  above is refused.
- **Schema freshness** — is this database the migrations in `prisma/migrations`?
  Every `_prisma_migrations` row's checksum is compared with the sha256 of the
  migration file on disk. A database that cannot be reached, or that has no
  applied migration, is reported and skipped rather than failed, so the suites
  that need no database keep running.

### When a test database is stale

`prisma migrate deploy` compares migration *names*, not checksums. If a
migration file changed after a database recorded it, deploy reports that there
is nothing to apply while that database keeps the old schema, and every query
touching the difference fails inside Prisma instead. The schema-freshness gate
names the database, the migration and the missing columns; recreating the test
database is the fix.

`psql` never reads `DATABASE_URL`: libpq takes its target from
`PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE` or its own defaults, and neither
`scripts/lib/dbGuard.ts` nor `src/__tests__/setup/testDb.ts` sees a raw `psql`
call — both guard Node entry points. So the script below names its connection
itself: an admin URI on the local, non-production server, pointed at the
`postgres` **maintenance** database, because a database cannot be dropped from
inside itself. `DROP DATABASE` deletes every row in the database it names and
nothing here restores them, so only a test database you are prepared to lose
belongs in `TEST_DB` — the name is held to the rule the suite's own guard
applies (`isTestDatabaseName` in `scripts/lib/dbGuard.ts`: a name ending
`_test`, optionally with a clone index, or exactly `ci`). Save it and run it
with `bash`; each stop is an `exit 1`, which would close an interactive shell it
was pasted into:

```sh
set -euo pipefail

ADMIN_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/postgres'
TEST_DB='soh_test'

printf '%s' "$TEST_DB" | grep -Eq '(_test(_[0-9]+)?|^ci)$' || {
  echo "refusing to drop \"$TEST_DB\": not a test database name" >&2
  exit 1
}

# Read this back before continuing — it is the server, port and account the
# drop is about to run against.
psql "$ADMIN_URL" -tAc \
  'SELECT current_database(), current_user, inet_server_addr(), inet_server_port()'

# The name reaches psql as a variable and psql quotes it as an identifier
# (`:"target"`) rather than it being spliced into the statement. psql
# interpolates variables only in input it reads as a script, never in a `-c`
# string, so the two statements arrive on stdin.
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v target="$TEST_DB" <<'SQL'
DROP DATABASE IF EXISTS :"target";
CREATE DATABASE :"target";
SQL

npx prisma migrate deploy
```
