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
-- leaves it in place (docs/meal-planning/release-and-recovery.md). Nothing in
-- this repository runs this folder - no npm script, no CI step, and no Prisma
-- command, since Prisma only ever reads prisma/migrations - and
-- `prisma/manual-migrations` is listed in .dockerignore, so the runtime image
-- does not contain this file. It exists so that removal, if it is ever genuinely
-- required, is a reviewed procedure rather than DDL improvised under pressure.
-- These are the first DROP statements anywhere under prisma/, which is why the
-- warning is this long.
--
-- BEFORE RUNNING IT
--   1. Take a fresh backup and confirm it restores. It is the only way back:
--        pg_dump --format=custom "$DATABASE_URL" > pre-removal.dump
--   2. Point it only at a database you are prepared to lose. Never at production,
--      and never at a database holding user data you have not just backed up.
--   3. Run it in a reviewed maintenance window, with the API stopped or both
--      feature gates closed, so nothing is mid-write:
--        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 001_meal_planning.down.sql
--   4. Reconcile the Prisma migration history afterwards. That step is an
--      operator decision rather than DDL, so it is documented in README.md in
--      this folder and in docs/meal-planning/release-and-recovery.md, not here.
--
-- WHAT IS DESTROYED - permanently, absent the backup from step 1
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
--   "meal_plan_actions"."response_snapshot". Re-populating a catalog afterwards
--   is a `catalog:load` of a committed release plus `recipes:seed`, not a
--   restore - the identifiers will not be the ones these rows used.
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
-- Every statement is guarded with IF EXISTS, so re-running the file is a no-op,
-- and an interrupted run can be re-run to completion. It is not a repair tool
-- for a partially applied schema in the other direction: it will not add
-- anything back. README.md in this folder explains when an operator would reach
-- for this file; docs/meal-planning/release-and-recovery.md carries the release
-- and rollback procedure. Neither is repeated here.

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
