Backend platform for: https://github.com/Kennygunderman/state-of-health-tracker

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

Two gates in `src/__tests__/setup/testDb.ts` run before any test, and
`npm run check:test-db` runs both on their own (`npm test` runs it once, before
Jest starts):

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
database is the fix:

```sh
psql -c 'DROP DATABASE "soh_test"' -c 'CREATE DATABASE "soh_test"'   # from another database
npx prisma migrate deploy
```
