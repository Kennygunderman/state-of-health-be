# `prisma/manual-migrations/meal-planning`

An operator reference copy of the meal-planning DDL. **No tooling runs this
folder** — it is excluded from the Docker image by `.dockerignore`, no npm script
points at it, and Prisma only ever looks at `prisma/migrations`.

| File | What it is |
| --- | --- |
| `001_meal_planning.sql` | The idempotent copy of `prisma/migrations/20260908000000_meal_planning/migration.sql` — the same DDL, statement for statement, with `IF NOT EXISTS` on tables, columns and indexes and one table-scoped `DO $$` guard per foreign key. |
| `001_meal_planning.down.sql` | The inverse of that file, for the one case below where removal is genuinely required. Reference only: it is part of no deploy and no rollback. |

## Which ledger actually runs

`prisma/migrations/20260908000000_meal_planning/migration.sql`. It is applied
automatically in both places that matter:

- **Deployment** — the image's final command is
  `npx prisma migrate deploy && node dist/server.js` (`Dockerfile`), so the
  schema is applied at container boot.
- **CI** — the `Apply the migration ledger` step of `.github/workflows/ci.yml`
  runs `npx prisma migrate deploy` against a throwaway `postgres:16-alpine`
  service before the schema-drift gate and the test suite.

So the normal answer to "should I run the file in this folder?" is **no**.

## When you would run it, and what to do afterwards

Run it by hand only when Prisma cannot be used at all — for example applying the
schema through a DBA-operated SQL console, or bringing a database up to date
where the `_prisma_migrations` bookkeeping table must be reconciled afterwards:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/manual-migrations/meal-planning/001_meal_planning.sql
# then, immediately, so `migrate deploy` does not try to re-apply the same DDL:
npx prisma migrate resolve --applied 20260908000000_meal_planning
```

Without that `resolve`, the next `prisma migrate deploy` treats the migration as
pending and fails on objects that already exist.

Re-running the file on a database that already has the schema is a no-op. It is
**not** a repair tool for a half-applied schema: `CREATE TABLE IF NOT EXISTS`
will not add a missing column, and it will not add a missing `NOT NULL` to a
column that already exists. Restore from a backup instead.

## Removing the schema — `001_meal_planning.down.sql`

**Rolling the backend back does not need this file.** Everything the migration
adds is additive and inert once the two feature gates are closed, so redeploying
an earlier commit leaves it in place; that is the documented rollback
(`docs/meal-planning/release-and-recovery.md`). The down file exists for the
separate case where a database must genuinely be returned to the pre-feature
schema, so that removal is a reviewed procedure rather than DDL improvised
under pressure. Take a backup you have confirmed restores, stop the API or close
both gates, then:

```bash
pg_dump --format=custom "$DATABASE_URL" > pre-removal.dump
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/manual-migrations/meal-planning/001_meal_planning.down.sql
```

It drops the sixteen tables, the four columns the feature added to
`meal_entries` and the three indexes it added to that table, in an order that
needs no `CASCADE`. Diary history survives: those columns are nullable links, so
planned and catalog-logged entries are **detached, not deleted** — each keeps its
name, servings and macro snapshot and simply loses its provenance caption. Every
statement is guarded, so re-running it is a no-op. Everything held in the tables
themselves — plans, grocery state, preferences, recipes and the whole catalog —
is gone with them, which is what the backup is for.

Then reconcile the ledger. `_prisma_migrations` still records the migration as
applied, so `prisma migrate deploy` would report nothing pending and leave the
database without the schema. Remove that one row and re-apply normally:

```bash
psql "$DATABASE_URL" -c "DELETE FROM _prisma_migrations WHERE migration_name = '20260908000000_meal_planning';"
npx prisma migrate deploy   # re-applies the migration when you want the feature back
```

`npx prisma migrate resolve --rolled-back 20260908000000_meal_planning` does
**not** work here and is not the step to use: Prisma 6 accepts `--rolled-back`
only for a migration in a *failed* state and answers `P3012 … cannot be rolled
back because it is not in a failed state` for one that applied cleanly
(reproduced against Prisma 6.9.0). Deleting the row is the reconciliation, and
`migrate deploy` is the way back.

## Three constructs that are not Prisma's output

`prisma/schema.prisma` cannot express any of these, so both ledgers carry them by
hand and they must be kept in step:

1. the `STORED` generated expression on `catalog_foods.search_vector`;
2. the block of expression and partial indexes before the foreign keys — the
   `lower(alias)` index and the five partial indexes behind "one published
   identity per canonical name and state", "one active plan per start date",
   "one current version per recipe", "one default portion per food" and the live
   logged-status lookup;
3. `NOT NULL` on the twelve required `TEXT[]` / `UUID[]` columns — Prisma never
   emits it for a scalar list, so without it the datamodel's required lists
   would be nullable arrays in storage.

All three are recorded in `docs/meal-planning/expected-schema-diff.sql` and
compared against a freshly migrated database by the `Schema-drift evidence gate`
step in CI.

## Proving this copy still matches the authoritative ledger

Two throwaway databases, the two application orders, and one dump comparison.
Point `DATABASE_URL` at a development or test database — never at data you want
to keep, since both databases are created and dropped here:

```bash
# Order A: Prisma first, then this copy (which must change nothing)
createdb ledger_a
DATABASE_URL=postgresql://…/ledger_a npx prisma migrate deploy
psql postgresql://…/ledger_a -v ON_ERROR_STOP=1 -f prisma/manual-migrations/meal-planning/001_meal_planning.sql
pg_dump --schema-only postgresql://…/ledger_a > /tmp/ledger_a.sql

# Order B: this copy first, then reconcile the ledger
createdb ledger_b
psql postgresql://…/ledger_b -v ON_ERROR_STOP=1 -f prisma/migrations/20260706000000_init/migration.sql
psql postgresql://…/ledger_b -v ON_ERROR_STOP=1 -f prisma/manual-migrations/meal-planning/001_meal_planning.sql
DATABASE_URL=postgresql://…/ledger_b npx prisma migrate resolve --applied 20260706000000_init
DATABASE_URL=postgresql://…/ledger_b npx prisma migrate resolve --applied 20260908000000_meal_planning
DATABASE_URL=postgresql://…/ledger_b npx prisma migrate deploy   # must report no pending migrations
pg_dump --schema-only postgresql://…/ledger_b > /tmp/ledger_b.sql

# Compare, ignoring pg_dump's own preamble and per-run \restrict token
norm() { grep -vE '^(--|SET |SELECT pg_catalog\.set_config|\\restrict|\\unrestrict|$)' "$1"; }
diff <(norm /tmp/ledger_a.sql) <(norm /tmp/ledger_b.sql) && echo "ledgers equivalent"
```

Both orders currently produce identical schemas, order A's second step reports
only `already exists, skipping` notices, and order B's `migrate deploy` reports
`No pending migrations to apply.`

## Editing either ledger

Change `prisma/schema.prisma`, regenerate the authoritative migration, re-apply
the three hand-written constructs above, mirror the result here, then regenerate
`docs/meal-planning/expected-schema-diff.sql` (its header carries the two
commands) and re-run the equivalence check above. A migration that has already
been applied anywhere must never be edited — add a new one instead.
