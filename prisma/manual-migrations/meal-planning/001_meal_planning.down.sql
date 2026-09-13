-- Meal planning - schema REMOVAL (OPERATOR REFERENCE COPY, never executed by tooling)
--
-- The exact inverse of this folder's up script
--   prisma/manual-migrations/meal-planning/001_meal_planning.sql
-- and therefore of the authoritative ledger it copies
--   prisma/migrations/20260908000000_meal_planning/migration.sql
-- It removes the sixteen meal-planning tables, the four columns this feature
-- added to "meal_entries", and the three indexes it added to that table. It
-- removes nothing else: no pre-existing table, no pre-existing column, and no
-- index, constraint or type belonging to any other feature. No database-level or
-- schema-level object is touched and no row is deleted from any table - the data
-- loss below is the consequence of removing the tables that hold it.
--
-- THIS IS NOT PART OF ANY DEPLOY, AND NOT PART OF ROLLBACK. Redeploying an
-- earlier backend commit needs no schema change at all: every object here is
-- additive and inert once the two feature gates are closed, so a rollback simply
-- leaves it in place (docs/meal-planning/release-and-recovery.md). Nothing
-- executes THIS file: no npm script, no CI step, no Prisma command and no
-- source file invokes it, Prisma only ever reads prisma/migrations, and
-- `prisma/manual-migrations` is listed in .dockerignore, so the runtime image
-- does not contain it. Two documents do point at it, deliberately - README.md
-- in this folder and docs/meal-planning/release-and-recovery.md - and that
-- documentation is the whole of its presence in the repository. The one
-- automated reader of this folder is the ledger-equivalence gate in
-- src/__tests__/api/compat.test.ts, which applies the up script beside this one
-- to a disposable database to prove the two ledgers agree; it never reads this
-- file. This file exists so that removal, if it is ever genuinely required, is a
-- reviewed procedure rather than DDL improvised under pressure.
-- These are the first DROP statements anywhere under prisma/, which is why the
-- warning is this long.
--
-- BEFORE RUNNING IT
--   1. Name the target yourself, and do not let any command below read an
--      ambient DATABASE_URL. In this project's development environment that
--      variable arrives holding the PRODUCTION URL unless the shell overrides
--      it, so a destructive command that defaults to it is one forgotten export
--      away from the wrong database. Type the database name out - it is the
--      affirmation that both this procedure and the guard in section 0 check -
--      and build the URL beside it:
--        REMOVAL_TARGET_DB='<the disposable database you intend to strip>'
--        REMOVAL_TARGET_URL="postgresql://<user>@<host>:<port>/$REMOVAL_TARGET_DB"
--   2. Prove that URL is that database, before anything else touches it. Put
--      steps 2 to 4 in a file and run it with `bash -euo pipefail` rather than
--      pasting them loose: the check below has to END the run, not print a
--      warning that scrolls past into the backup and the removal. Under
--      errexit, an unreachable host or a refused login aborts here too, because
--      the failing psql takes the script down with it.
--        ACTUAL_DB=$(psql "$REMOVAL_TARGET_URL" -tAc 'SELECT current_database()')
--        if [ "$ACTUAL_DB" != "$REMOVAL_TARGET_DB" ]; then
--          echo "STOP: that URL is $ACTUAL_DB, not $REMOVAL_TARGET_DB" >&2
--          exit 1
--        fi
--        psql "$REMOVAL_TARGET_URL" -tAc \
--          'SELECT current_database(), current_user, inet_server_addr(), inet_server_port()'
--      Read that last line before continuing: only a database you are prepared
--      to lose belongs here. Never production, and never one holding user data
--      you have not just backed up. Nothing in this file can tell those apart
--      for you - see section 0.
--   3. Take a fresh backup of that same database and confirm it restores. It is
--      the only way back:
--        pg_dump --format=custom "$REMOVAL_TARGET_URL" \
--          > "$REMOVAL_TARGET_DB-pre-removal.dump"
--   4. Run it from the backend/ directory - the path below is relative to it -
--      in a reviewed maintenance window, with the API stopped or both feature
--      gates closed, so nothing is mid-write. The SET is not optional: section 0
--      refuses to drop anything without it, and refuses again if the name and
--      the connection disagree.
--        psql "$REMOVAL_TARGET_URL" -v ON_ERROR_STOP=1 \
--          -c "SET meal_planning.removal_target = '$REMOVAL_TARGET_DB'" \
--          -f prisma/manual-migrations/meal-planning/001_meal_planning.down.sql
--   5. Reconcile the Prisma migration history afterwards, against that same
--      $REMOVAL_TARGET_URL. That step is an operator decision rather than DDL,
--      so it is documented in README.md in this folder and in
--      docs/meal-planning/release-and-recovery.md, not here.
--
-- WHAT IS DESTROYED - permanently, absent the backup from step 3
--   - every user's weekly plans, plan days and planned meals, including swap
--     history ("previous_recipe_version_id") and incompatibility flags;
--   - every grocery list, with the check state and the increase flags a user
--     built up while shopping;
--   - every user's meal-planning preferences and the bookkeeping that recorded
--     how their targets were confirmed ("confirmed_targets", "target_source",
--     "targets_revision", "estimated_targets");
--   - every recipe and recipe version with its ingredient rows, including the
--     per-100g nutrition and allergen snapshots frozen at publication;
--   - the entire food catalog: foods, aliases, portions, derived components and
--     the per-item validation records that evidence each published item;
--   - the import-run and generation-batch history, and with it the model-call
--     budget ledger those batches carry;
--   - the idempotency ledger in "meal_plan_actions", so a client retrying a
--     keyed generate, regenerate, swap or log can no longer be answered with the
--     stored result of its first attempt.
--   Retained vendor-derived data goes with those tables: the USDA identity and
--   description fields on "catalog_foods", the ingredient snapshots on
--   "recipe_ingredients", "meal_plans"."targets_snapshot" and
--   "meal_plan_actions"."response_snapshot".
--
-- WHAT A LOAD CAN PUT BACK, AND WHAT ONLY THE BACKUP CAN
--   These are two different recoveries, and only one of them returns the rows
--   this file destroyed.
--   - A fresh load - `npm run catalog:load -- --release <v>` of a reviewed,
--     checksummed release, then `npm run recipes:seed` - rebuilds the shared
--     catalog and recipe content from the artefact committed in this repository
--     (data/meal-planning/catalog/releases/), by the same route step 4 of the
--     release order uses. It is never a restore of the dropped rows: the
--     identifiers are new ones, so nothing that referenced the old rows finds
--     them again, and the detached diary entries described below stay detached.
--     It also rebuilds that shared content ONLY. Plans, grocery lists and their
--     check marks, preferences, the confirmed-target bookkeeping and the
--     "meal_plan_actions" ledger are user data that no release contains, so no
--     load brings them back.
--   - The backup from step 3 is the only thing that returns those exact rows -
--     the same ids, the same plan and shopping history, the same stored
--     responses. That is why step 3 is a precondition of this file and not a
--     precaution around it.
--   Whether the load path can run at all in the tree you are holding is tracked
--   in one place, the status table in
--   docs/meal-planning/release-and-recovery.md, and every stage reports its own
--   unmet inputs on stderr and exits non-zero rather than half-loading, so
--   `npm run catalog:load -- --release v1` answers the question directly. As
--   this file is committed the answer is no - the stages verify their inputs,
--   including the release manifest, and stop before any database write - which
--   makes the backup the only way back to either kind of data today, as well as
--   the only way back to the exact rows.
--
-- WHAT SURVIVES
--   Diary history is left intact, which is the point of the ordering below. The
--   three links this feature added to "meal_entries" are nullable columns, so
--   dropping them DETACHES planned and catalog-logged entries instead of
--   deleting them: every row keeps its name, serving text, servings and calorie
--   and macro snapshot exactly as it was logged, and day totals do not move. The
--   visible consequence is that those rows lose their provenance captions - the
--   "From meal plan" origin label and the source-backed / estimated labels - and
--   read as ordinary diary entries.
--   "users"."target_calories" and the three matching macro columns are NOT
--   touched: they predate this feature (prisma/manual-migrations/macros/) and
--   remain the values Account, the Diary and Progress read, so confirmed targets
--   keep working after removal even though the record of how they were confirmed
--   is gone with "meal_plan_preferences".
--   Everything else pre-existing is untouched: users, meals and meal entries,
--   personal foods, workouts, templates, runs, weigh-ins, records, AI usage and
--   the USDA response cache.
--
-- Every DROP is guarded with IF EXISTS, so re-running the file is a no-op once
-- the guard in section 0 is satisfied again, and an interrupted run can be
-- re-run to completion. It is not a repair tool
-- for a partially applied schema in the other direction: it will not add
-- anything back. README.md in this folder explains when an operator would reach
-- for this file; docs/meal-planning/release-and-recovery.md carries the release
-- and rollback procedure. Neither is repeated here.

-- ---------------------------------------------------------------------------
-- 0. Removal-target guard. Nothing below this runs unless it passes.
--
-- The operator states, in the same session, which database the removal is for;
-- this block raises unless that name is the database the connection is actually
-- on. That is what makes the procedure fail closed rather than prose-closed: a
-- session that declares nothing drops nothing at all - which is what an
-- invocation that just hands psql an ambient connection string does, whatever
-- that string happens to hold - and a session that declares one database while
-- connected to another drops nothing either.
--
-- What it proves is intent, not safety. It cannot tell a production database
-- from a scratch copy, and it will accept any name that matches the connection,
-- so it is no substitute for steps 1 to 3 above: it establishes that this
-- removal was aimed at a named database on purpose, and nothing more.
--
--   SET meal_planning.removal_target = '<the name typed in step 1 above>';
--
-- Pass it with `-c` before `-f`, as step 4 does, or run it as the first
-- statement of the same session in a SQL console. The setting is session
-- scoped: it is never written to the database and cannot be left behind as a
-- standing permission. Run the file with -v ON_ERROR_STOP=1 (or inside a single
-- transaction) so the raise stops the script rather than being logged and
-- stepped over.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    declared_target text := btrim(coalesce(current_setting('meal_planning.removal_target', true), ''));
BEGIN
    IF declared_target = '' THEN
        RAISE EXCEPTION
            'meal-planning removal refused: this session declared no removal target, and the database to strip is not guessed from the connection (currently %)',
            current_database()
            USING HINT =
                'Run SET meal_planning.removal_target = ''<database name>''; in this same session, naming the disposable database you have just backed up. See BEFORE RUNNING IT at the top of this file.';
    END IF;

    IF declared_target <> current_database() THEN
        RAISE EXCEPTION
            'meal-planning removal refused: this session declared % but is connected to %',
            declared_target, current_database()
            USING HINT =
                'The declared name and the connection URL have to be the same database. Check which URL was passed to psql before changing either of them.';
    END IF;

    RAISE NOTICE 'meal-planning removal proceeding against database % as %', current_database(), current_user;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Detach "meal_entries" first.
--
-- This ordering is a correctness requirement, not a preference. Three of the
-- four foreign keys this feature added are declared ON the legacy
-- "meal_entries" table and point AT new tables ("meal_plan_meals",
-- "catalog_foods", "recipe_versions"), with a fourth composite key onto
-- "meal_plan_meals"("id", "user_id"). While those keys exist they block the
-- table drops in section 2. Dropping the columns drops the four keys with them,
-- which is what unblocks it. The table itself is never dropped.
-- ---------------------------------------------------------------------------

-- DropIndex
DROP INDEX IF EXISTS "idx_meal_entries_meal_plan_meal_id";

-- DropIndex
DROP INDEX IF EXISTS "idx_meal_entries_recipe_version_id";

-- AlterTable
-- Dropping these columns also drops "meal_entries_meal_plan_meal_id_fkey",
-- "meal_entries_catalog_food_id_fkey", "meal_entries_recipe_version_id_fkey"
-- and "meal_entries_meal_plan_meal_id_user_id_fkey". No row is removed.
ALTER TABLE IF EXISTS "meal_entries" DROP COLUMN IF EXISTS "meal_plan_meal_id",
DROP COLUMN IF EXISTS "catalog_food_id",
DROP COLUMN IF EXISTS "recipe_version_id",
DROP COLUMN IF EXISTS "nutrition_provenance";

-- ---------------------------------------------------------------------------
-- 2. Drop the sixteen tables, children before parents.
--
-- The order is the reverse of the foreign-key graph in the authoritative
-- migration, so each table is already unreferenced when its turn comes and no
-- drop needs CASCADE. CASCADE is deliberately not used anywhere in this file:
-- it would silently remove dependent objects outside this feature if the graph
-- ever changed. Every table's own indexes, unique constraints and foreign keys
-- go with it, which is why they are not listed individually.
--
-- Two places in the order are load-bearing:
--   - "recipes" and "recipe_versions" reference each other
--     ("recipes"."current_version_id" and "recipe_versions"."recipe_id"), so
--     neither can go first. They are dropped in one statement, which PostgreSQL
--     resolves as a unit.
--   - the catalog tail runs "catalog_foods" then "catalog_generation_batches"
--     then "catalog_import_runs", because "catalog_foods"."generation_batch_id"
--     references a batch and every batch references its run.
-- ---------------------------------------------------------------------------

-- DropTable
DROP TABLE IF EXISTS "meal_plan_actions";

-- DropTable
DROP TABLE IF EXISTS "grocery_items";

-- DropTable
DROP TABLE IF EXISTS "meal_plan_meals";

-- DropTable
DROP TABLE IF EXISTS "meal_plan_days";

-- DropTable
DROP TABLE IF EXISTS "meal_plans";

-- DropTable
DROP TABLE IF EXISTS "meal_plan_preferences";

-- DropTable
DROP TABLE IF EXISTS "recipe_ingredients";

-- DropTable
-- The circular pair, dropped together (see the note above).
DROP TABLE IF EXISTS "recipe_versions", "recipes";

-- DropTable
DROP TABLE IF EXISTS "catalog_validation_records";

-- DropTable
DROP TABLE IF EXISTS "catalog_food_components";

-- DropTable
DROP TABLE IF EXISTS "catalog_food_portions";

-- DropTable
DROP TABLE IF EXISTS "catalog_food_aliases";

-- DropTable
-- Carries the STORED generated "search_vector" column and its GIN index; both
-- go with the table, so neither is named separately.
DROP TABLE IF EXISTS "catalog_foods";

-- DropTable
DROP TABLE IF EXISTS "catalog_generation_batches";

-- DropTable
DROP TABLE IF EXISTS "catalog_import_runs";

-- ---------------------------------------------------------------------------
-- 3. Drop the last object this feature added to a pre-existing table.
--
-- "meal_entries_id_user_id_key" is a unique index over ("id", "user_id") - two
-- columns that already existed - so nothing above removes it implicitly. It
-- could not be dropped in section 1 either: "meal_plan_actions" carried the
-- tenant foreign key onto ("id", "user_id") that depended on this index, so it
-- only becomes droppable once that table is gone. After this statement
-- "meal_entries" is byte-for-byte the table the init migration created.
-- ---------------------------------------------------------------------------

-- DropIndex
DROP INDEX IF EXISTS "meal_entries_id_user_id_key";
