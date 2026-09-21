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

Recreating it is one guarded command — the same module as the two gates above,
with `--recreate` added. Do not do it by hand: a `DROP DATABASE` typed into
`psql` is checked by nothing that knows **which server answers**. A name ending
`_test` is a naming convention, and on an SSH tunnel or a forwarded container
port that name resolves on `127.0.0.1` to a production server; this project's
development environment also exports a production `DATABASE_URL` into every new
shell that does not override it, which is the value a bare
`npx prisma migrate deploy` would use.

```sh
export DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/soh_test

NODE_ENV=test ALLOW_DB_TRUNCATE=true \
  npx ts-node --project tsconfig.test.json src/__tests__/setup/testDb.ts \
  --recreate --confirm-target soh_test
```

`DROP DATABASE` deletes every row in the database it names and nothing restores
them, so the command refuses unless all of the following hold. Each refusal
exits 1, says which condition failed — naming the host and the database wherever
it judged one — and reaches no server it has not already cleared:

- **The suite's own identity gate passes** — `NODE_ENV`, `ALLOW_DB_TRUNCATE` and
  the `DATABASE_URL` rules in the table above, unchanged and shared with
  `scripts/lib/dbGuard.ts`: a local host, a name ending `_test` (optionally with
  a clone index) or exactly `ci`, no query parameter that can move the
  connection (`?host=`, `?dbname=`…) or the schema (`?schema=`, `?options=-c
  search_path=…`), and no percent-encoded database name. A URL that fails any of
  these is refused before a driver is even loaded.
- **You named the target** — `--confirm-target` must spell the database the URL
  points at. An inherited `DATABASE_URL` is a target nobody read, so it cannot
  satisfy this.
- **The database answered for itself** — the command opens a connection to the
  target and refuses unless `current_database()` is the name the URL displays
  and an unqualified statement in it resolves in `public`. That second check is
  the one a string cannot make: `ALTER ROLE … SET search_path` and
  `ALTER DATABASE … SET search_path` redirect where the replayed migrations
  would create their tables, and no URL shows it.
- **The drop reaches the server that was verified** — the `DROP`/`CREATE` pair is
  issued from the `postgres` maintenance database on the same authority (a
  database cannot be dropped from inside itself), and that session must report
  the same server as the read-back did.

Then, and only then, it drops and recreates the database, applies
`prisma/migrations` with `prisma migrate deploy` against a `DATABASE_URL` it
derives from the validated target rather than from your shell, and reads
`public._prisma_migrations` back to confirm the fresh database carries the
ledger. It prints the statements it issued. A database that does not exist yet is
created without a drop.

Two things it does not do for you: it will not close another session's
connection (`DROP DATABASE` fails while one is open — stop any running suite or
`npm run dev` first), and it will not guess the target — the `DATABASE_URL` and
the `--confirm-target` name have to agree, which is where a mistyped one is
stopped instead of executed.
