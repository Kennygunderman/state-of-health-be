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
# From backend/. Save this block to a file and run it with `bash -euo pipefail`,
# as the script's own header advises: every check here is meant to END the run,
# not print a warning that scrolls past into the backup and then the DROPs.
set -euo pipefail

# Type the name once. Only a plain PostgreSQL identifier is accepted.
REMOVAL_TARGET_DB='<the disposable database you intend to strip>'
if [[ ! $REMOVAL_TARGET_DB =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "STOP: '$REMOVAL_TARGET_DB' is not a plain database identifier" >&2
  exit 1
fi

REMOVAL_TARGET_URL="postgresql://<user>@<host>:<port>/$REMOVAL_TARGET_DB"

# Prove that URL is that database before anything else touches it.
ACTUAL_DB=$(psql "$REMOVAL_TARGET_URL" -tAc 'SELECT current_database()')
if [ "$ACTUAL_DB" != "$REMOVAL_TARGET_DB" ]; then
  echo "STOP: that URL is $ACTUAL_DB, not $REMOVAL_TARGET_DB" >&2
  exit 1
fi

# Read this line yourself: only a database you can lose belongs here.
psql "$REMOVAL_TARGET_URL" -tAc \
  'SELECT current_database(), current_user, inet_server_addr(), inet_server_port()'

# The only way back. Confirm it restores before going on.
pg_dump --format=custom "$REMOVAL_TARGET_URL" \
  > "./$REMOVAL_TARGET_DB-pre-removal.dump"

# The declaration arrives on stdin (-f -) rather than through -c, because psql
# expands its variables only in the input it lexes: `-c "… :'target' …"` is sent
# to the server untouched and fails with `syntax error at or near ":"`.
echo "SELECT set_config('meal_planning.removal_target', :'target', false);" \
  | psql "$REMOVAL_TARGET_URL" -v ON_ERROR_STOP=1 -v target="$REMOVAL_TARGET_DB" \
      -f - \
      -f prisma/manual-migrations/meal-planning/001_meal_planning.down.sql
```

The first check is about the name rather than the removal, because the name
reaches three places at once: a SQL literal, the path component of the URL, and
the dump filename. Requiring a plain identifier closes all three with one test:
a name of that shape needs no percent-encoding to sit in a URL's path and cannot
carry a path separator or a leading dash into a filename, so the absence of
encoding below is that check's consequence rather than an omission. A name
holding a quote, a slash or a space would otherwise break or redirect the command
long before the guard in section 0 could refuse anything. The `./` on the dump
path restates the point: the file lands where you are standing, and cannot be
read as a path or an option. If a database's real name cannot satisfy the
pattern — a quoted name, or one carrying a dash, a dot or a space — its removal
needs an invocation reviewed for that name rather than one improvised here.

The target is then handed to psql as a variable and quoted by psql, instead of
being spliced into SQL by the shell: `-v target="$REMOVAL_TARGET_DB"` binds the
value, and `:'target'` expands it as a properly quoted SQL literal with any
quote inside it doubled. That is the whole of the difference, and it is why the
statement is piped in rather than passed with `-c`: psql interpolates its
variables only into input it lexes, so a `-c` string reaches the server with the
`:'target'` still in it and errors out. What the statement sets is what the
script documents: a `set_config` whose third argument is `false` is
session-scoped exactly as `SET` is, and psql runs every `-f` — `-f -` for stdin
included — in one session in the order given, so the setting is in force when
the removal script runs. It is also exactly what section 0's guard reads: that
block takes `current_setting('meal_planning.removal_target', true)` and raises
unless it equals `current_database()`, so a session that declares nothing still
drops nothing.

The script's own header carries this same procedure — the identifier check, the
read-back, the backup, the psql variable — with the reasoning for each step, the
complete inventory of what is destroyed, and why the run belongs in a reviewed
maintenance window with the API stopped. Read it before running any of this. The
two agree — the same checks in the same order, the same commands — so either
copy can be used: the header's step 4 binds the name with
`-v target="$REMOVAL_TARGET_DB"` and lets psql quote it exactly as the block
above does, and neither splices it into the `SET` statement.

Everything the dropped tables hold goes with them: plans, grocery state,
preferences, recipes and the whole catalog, including the retained USDA-derived
snapshot data. Diary history survives, by design — the links this feature added
to `meal_entries` are nullable, so dropping them **detaches** planned and
catalog-logged entries rather than deleting them, each row keeping its name,
servings and macro snapshot and losing only its provenance caption.

Re-populating afterwards is not the same as restoring, and both halves of a
fresh load do write. `catalog:load` reconciles a reviewed, checksummed release
into `catalog_foods` and its aliases, portions, compositions and validation
records — verifying every manifest digest before it writes anything, and
retiring rather than deleting a published food a newer release no longer
carries. `recipes:seed` then publishes the 42 committed recipe files as
`recipe_versions` rows with their frozen ingredient snapshots, idempotent by
slug. Between them they rebuild the shared catalog and recipe content, with
**new identifiers** — so nothing that referenced the dropped rows finds them
again, and the diary entries the column drops detached stay detached.

They rebuild that shared content and nothing beside it. Plans, grocery state and
the check marks on it, preferences, the confirmed-target bookkeeping and the
`meal_plan_actions` ledger are user data: they appear in no release, so no load
brings them back. Only the backup returns those exact rows — the same ids, the
same plan and shopping history, the same stored responses — which is why the
`pg_dump` this section opens with is a precondition of the removal and not a
precaution around it. The release-side procedure for the load itself — which
release, from where, and what each writer does to the database it is pointed at
— is settled under **What a release loads** in
[`docs/meal-planning/release-and-recovery.md`](../../../docs/meal-planning/release-and-recovery.md#what-a-release-loads),
and not repeated here.

The Prisma ledger then needs reconciling, because `_prisma_migrations` still
records the migration as applied: `migrate deploy` would report nothing pending
while the schema is gone. Delete that one row, and re-apply normally whenever the
feature is wanted back — same `REMOVAL_TARGET_URL`, same `backend/` directory,
and the same checks in front of it, because a `DELETE` and a `migrate deploy` are
no safer than the URL they are handed. The migration name is a fixed literal and
needs no quoting of its own:

```bash
set -euo pipefail

# The same shell as the block above, or its checks again: an unset
# $REMOVAL_TARGET_URL is not "no target", it is whatever ambient connection
# libpq and Prisma would each fall back to.
: "${REMOVAL_TARGET_DB:?run the validated block above first, in this same shell}"
: "${REMOVAL_TARGET_URL:?run the validated block above first, in this same shell}"
if [[ ! $REMOVAL_TARGET_DB =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "STOP: '$REMOVAL_TARGET_DB' is not a plain database identifier" >&2
  exit 1
fi
ACTUAL_DB=$(psql "$REMOVAL_TARGET_URL" -tAc 'SELECT current_database()')
if [ "$ACTUAL_DB" != "$REMOVAL_TARGET_DB" ]; then
  echo "STOP: that URL is $ACTUAL_DB, not $REMOVAL_TARGET_DB" >&2
  exit 1
fi

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
