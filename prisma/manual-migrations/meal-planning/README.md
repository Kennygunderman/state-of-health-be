# `prisma/manual-migrations/meal-planning`

An operator reference copy of the meal-planning DDL, plus a reference-only
removal script. **The ledger that actually runs is
`prisma/migrations/20260908000000_meal_planning/migration.sql`**, applied by
Prisma. Nothing in this folder is ever applied automatically, and none of it
introduces a second migration system.

Both exist because two instructions had to be honoured at once: the feature
request asked for additive SQL under `prisma/manual-migrations/meal-planning/`,
while this repository's deployment practice is a boot-time
`prisma migrate deploy`. So the Prisma migration is the executed ledger, and this
folder is the operator reference — the same DDL, written so a human can apply it
by hand if Prisma ever cannot be used. The folder holds exactly these three
files:

| File | Role |
| --- | --- |
| `001_meal_planning.sql` | Idempotent copy of the authoritative migration's DDL — the same statements, guarded so re-running is safe. |
| `001_meal_planning.down.sql` | Reference-only removal script. Part of no deploy and no rollback; see [Removing the schema](#removing-the-schema). |
| `README.md` | This file: which ledger is authoritative, and what to do if you apply the copy by hand. |

## How the schema actually reaches a database

`prisma migrate deploy`, in both places that matter:

- **Deploy** — the image's final command is
  `npx prisma migrate deploy && node dist/server.js` (`Dockerfile`), so the
  migration is applied at container boot.
- **CI** — the `Apply the migration ledger` step in `.github/workflows/ci.yml`
  runs the same command against a throwaway PostgreSQL service.

Normal operation therefore needs no manual step in this folder at all.

## What runs this folder

Nothing that builds, deploys or migrates: no npm script, no CI step, no Prisma
command and no runtime code applies these files. Prisma only ever reads
`prisma/migrations`, and `prisma/manual-migrations` is listed in `.dockerignore`,
so the runtime image does not even contain them.

One test is the exception to that sentence, and it reads the up script only: the
ledger-equivalence gate — `describe('migration ledgers')` in
`src/__tests__/api/compat.test.ts` — applies `001_meal_planning.sql` to
disposable databases it creates and drops itself, purely to prove that both
ledgers produce the same schema and that legacy rows survive either order. The
equivalence claim above is therefore tested, not asserted. Nothing, that gate
included, ever runs the down script.

## If you apply the copy by hand

Do this only when Prisma cannot be used — applying the schema through a
DBA-operated SQL console, for example. Immediately afterwards, run the command
below **from the `backend/` directory** — Prisma resolves `prisma/schema.prisma`
relative to the working directory and `package.json` declares no `prisma.schema`
path, so it fails from anywhere else, including this folder — and against the
database you just applied the copy to:

```bash
# Name the target explicitly. This project's development environment exports a
# production DATABASE_URL into every new shell unless that shell overrides it,
# and this command writes a row to whichever database it is handed.
TARGET_DATABASE_URL='postgresql://<user>@<host>:<port>/<database you just applied it to>'
DATABASE_URL="$TARGET_DATABASE_URL" npx prisma migrate resolve --applied 20260908000000_meal_planning
```

The copy applies the DDL without writing a row to Prisma's `_prisma_migrations`
bookkeeping table, so without that command the next `prisma migrate deploy` still
considers the migration pending and tries to apply the same DDL a second time.
`resolve --applied` records it as already applied instead. The argument is the
migration's **directory name**, and it has to match character for character.

Re-running the copy against a database that already has the schema is a no-op:
every statement is guarded — `IF NOT EXISTS` on tables, columns and indexes, and
a `DO $$` block that checks `pg_constraint` before each foreign key, because
`ADD CONSTRAINT` has no `IF NOT EXISTS` form. In the other direction, the
`resolve` step above is what stops Prisma re-applying the migration over work the
copy already did.

It is re-runnable, not a repair tool. `CREATE TABLE IF NOT EXISTS` skips a table
that already exists, so it will not add a missing column to a partially created
one. Restore from a backup instead.

## Removing the schema

`001_meal_planning.down.sql` is reference-only. It is part of no deploy and of no
rollback — rolling the backend back needs no schema change, because everything
the migration adds is additive and inert once the feature gates are closed. It
exists so that removal, if it is ever genuinely required, is a reviewed procedure
rather than DDL improvised under pressure. Run it only after a fresh `pg_dump`
you have confirmed restores, and only against a disposable database you are
prepared to lose.

Whether a database is disposable is your judgement, and nothing in the script can
make it: it cannot tell production from a scratch copy. What it does enforce is
that the removal was aimed deliberately — its first section refuses to drop
anything unless the session running it names the target database, and refuses
again unless that name is the database the connection is actually on. A command
that relies on whatever `DATABASE_URL` happens to hold — in this project's
development environment, the production URL unless the shell overrides it —
therefore removes nothing:

```bash
# From backend/. Both the name and the URL are yours to type; the script raises
# if they are not the same database, and raises if the SET is missing entirely.
REMOVAL_TARGET_DB='<the disposable database you intend to strip>'
REMOVAL_TARGET_URL="postgresql://<user>@<host>:<port>/$REMOVAL_TARGET_DB"
psql "$REMOVAL_TARGET_URL" -v ON_ERROR_STOP=1 \
  -c "SET meal_planning.removal_target = '$REMOVAL_TARGET_DB'" \
  -f prisma/manual-migrations/meal-planning/001_meal_planning.down.sql
```

The script's own header carries the full procedure — the read-back that proves
the URL is that database, the backup, the maintenance window — and the complete
inventory of what is destroyed. Read it before running any of this.

Everything the dropped tables hold goes with them: plans, grocery state,
preferences, recipes and the whole catalog, including the retained USDA-derived
snapshot data. Diary history survives, by design — the links this feature added
to `meal_entries` are nullable, so dropping them **detaches** planned and
catalog-logged entries rather than deleting them, each row keeping its name,
servings and macro snapshot and losing only its provenance caption. Loading a
catalog back afterwards is a fresh load rather than a restore, and the pipeline
that does it is still landing on this branch — `docs/meal-planning/release-and-recovery.md`
tracks what is wired — so the backup is the only way back to that data today.

The Prisma ledger then needs reconciling, because `_prisma_migrations` still
records the migration as applied: `migrate deploy` would report nothing pending
while the schema is gone. Delete that one row, and re-apply normally whenever the
feature is wanted back — same `REMOVAL_TARGET_URL`, same `backend/` directory:

```bash
psql "$REMOVAL_TARGET_URL" -v ON_ERROR_STOP=1 \
  -c "DELETE FROM _prisma_migrations WHERE migration_name = '20260908000000_meal_planning';"
DATABASE_URL="$REMOVAL_TARGET_URL" npx prisma migrate deploy
```

`prisma migrate resolve --rolled-back` is not the step here: Prisma 6 accepts it
only for a migration in a failed state and answers `P3012` for one that applied
cleanly.

## Never against production

Never point `DATABASE_URL` at production, never reset a database that holds user
data, and run any SQL from this folder only against a disposable non-production
database.

## Where the release narrative lives

`docs/meal-planning/release-and-recovery.md` — the release order, the
`MEAL_PLANNING_ENABLED` sequencing and the rollback procedure. None of it is
repeated here.
