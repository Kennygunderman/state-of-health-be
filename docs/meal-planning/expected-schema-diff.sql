-- Committed schema-drift evidence for the meal-planning schema.
--
-- Nothing executes this file. The executed ledger is
-- prisma/migrations/20260908000000_meal_planning/migration.sql; this is the
-- record of everything in that ledger which prisma/schema.prisma cannot
-- express, so that removing or quietly changing one of those constructs fails a
-- check instead of passing unnoticed.
--
-- It has two sections because one command cannot see all of it:
--
--   SECTION A  what `prisma migrate diff` reports between the ledger and the
--              datamodel. Prisma's schema describer models plain columns,
--              defaults, plain indexes and foreign keys, so this section covers
--              those - including the STORED generated column, which Prisma
--              reads through the column-default slot and therefore reconciles
--              back to a plain tsvector column.
--
--   SECTION B  the constructs `prisma migrate diff` is BLIND to, read straight
--              back out of a migrated database by the query embedded below.
--              Measured against prisma 6.9.0 on PostgreSQL 16 by tampering with
--              a throwaway database and re-running the diff:
--
--                dropped the lower(alias) expression index      -> NOT reported
--                dropped a partial unique index entirely        -> NOT reported
--                changed a partial index's WHERE predicate      -> NOT reported
--                dropped NOT NULL from a TEXT[] column          -> NOT reported
--                made a partial index non-partial               -> reported
--                dropped the GIN index (it is in the datamodel) -> reported
--                replaced the generated column with a plain one -> reported
--
--              The first four are why this section exists: the expression
--              index, the five partial indexes and the twelve required-array
--              NOT NULL constraints carry real invariants (one search row per
--              food, one active plan per start date, one current version per
--              recipe, one default portion per food, live logged status, and
--              non-null lists behind the DTO contract) and a one-statement
--              comparison could not detect their loss.
--
-- The two sections also watch different things, which is why both are kept.
-- SECTION A compares the LEDGER with the datamodel through a disposable shadow
-- database, so it catches a migration and prisma/schema.prisma drifting apart.
-- SECTION B reads a MIGRATED DATABASE, so it also catches a construct that was
-- dropped from the migration, or changed by hand in the database it reads.
--
-- Regenerate both sections from backend/ after any change to schema.prisma or
-- the migration. SHADOW_DATABASE_URL must name a DISPOSABLE database - the
-- first command resets it - and DATABASE_URL a development or test database
-- with the ledger applied (`npx prisma migrate deploy`):
--
--   npx prisma migrate diff \
--     --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma \
--     --shadow-database-url "$SHADOW_DATABASE_URL" \
--     --exit-code --script                                    # -> SECTION A
--
--   sed -n 's/^-- @@Q //p' docs/meal-planning/expected-schema-diff.sql \
--     | psql "$DATABASE_URL" -tA -f -                         # -> SECTION B
--
-- SECTION A must come back with exit code 2 (differences found). 0 means this
-- file is stale - the datamodel and the ledger now agree and there is nothing
-- left to record. 1 means the command failed, usually an unreachable or
-- non-empty shadow database.
--
-- The gate is the `Schema-drift evidence gate` step of .github/workflows/ci.yml,
-- which runs both captures against a freshly migrated database and compares
-- them with the two sections below, ignoring `--` comments, blank lines and
-- trailing whitespace. It fails on any difference in either direction, so an
-- added construct is as loud as a removed one. Run it locally with the two
-- commands above plus:
--
--   awk '/^-- @@SECTION B/{f=1;next} /^-- @@SECTION /{f=0} f' \
--     docs/meal-planning/expected-schema-diff.sql | grep -vE '^\s*--|^\s*$'
--
-- Fix a failure in prisma/schema.prisma and the migration, never by editing
-- this file to match - unless the change to those two was the intended one, in
-- which case regenerate this file and review the new content.
--
-- The query is deliberately schema-wide rather than a list of the tables this
-- feature adds: an unmanaged construct introduced anywhere in `public` shows up
-- here and has to be reviewed. It reports, in this order, every index
-- PostgreSQL holds with a predicate, an expression or a non-btree access
-- method; every STORED generated column; and every NOT NULL array column.
-- (templates.exercise_ids is a pre-existing nullable array and is correctly
-- absent.)
--
-- Use line comments only in this file. A block comment would survive the
-- comment strip and be compared as content.
--
-- Captured against prisma and @prisma/client 6.9.0 on PostgreSQL 16.15, ledger
-- prisma/migrations through 20260908000000_meal_planning.

-- @@Q SELECT statement
-- @@Q FROM (
-- @@Q     SELECT 1 AS part,
-- @@Q            c.relname AS sort_key,
-- @@Q            pg_get_indexdef(i.indexrelid) || ';' AS statement
-- @@Q     FROM pg_index i
-- @@Q     JOIN pg_class c ON c.oid = i.indexrelid
-- @@Q     JOIN pg_class t ON t.oid = i.indrelid
-- @@Q     JOIN pg_namespace n ON n.oid = t.relnamespace
-- @@Q     JOIN pg_am am ON am.oid = c.relam
-- @@Q     WHERE n.nspname = 'public'
-- @@Q       AND (i.indpred IS NOT NULL OR i.indexprs IS NOT NULL OR am.amname <> 'btree')
-- @@Q     UNION ALL
-- @@Q     SELECT 2 AS part,
-- @@Q            t.relname || '.' || a.attname AS sort_key,
-- @@Q            format('ALTER TABLE public.%I ADD COLUMN %I %s GENERATED ALWAYS AS (%s) STORED;',
-- @@Q                   t.relname, a.attname, format_type(a.atttypid, a.atttypmod),
-- @@Q                   pg_get_expr(d.adbin, d.adrelid)) AS statement
-- @@Q     FROM pg_attribute a
-- @@Q     JOIN pg_class t ON t.oid = a.attrelid
-- @@Q     JOIN pg_namespace n ON n.oid = t.relnamespace
-- @@Q     JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
-- @@Q     WHERE n.nspname = 'public' AND a.attgenerated = 's' AND NOT a.attisdropped
-- @@Q     UNION ALL
-- @@Q     SELECT 3 AS part,
-- @@Q            t.relname || '.' || a.attname AS sort_key,
-- @@Q            format('ALTER TABLE public.%I ALTER COLUMN %I SET NOT NULL;', t.relname, a.attname) AS statement
-- @@Q     FROM pg_attribute a
-- @@Q     JOIN pg_class t ON t.oid = a.attrelid
-- @@Q     JOIN pg_namespace n ON n.oid = t.relnamespace
-- @@Q     JOIN pg_type ty ON ty.oid = a.atttypid
-- @@Q     WHERE n.nspname = 'public' AND t.relkind = 'r' AND a.attnum > 0
-- @@Q       AND NOT a.attisdropped AND a.attnotnull AND ty.typcategory = 'A'
-- @@Q ) AS evidence
-- @@Q ORDER BY part, sort_key, statement;

-- @@SECTION A
-- The generated expression on catalog_foods.search_vector, seen through the
-- column-default slot. Any other statement here means prisma/schema.prisma and
-- prisma/migrations/20260908000000_meal_planning/migration.sql have diverged.

-- AlterTable
ALTER TABLE "catalog_foods" ALTER COLUMN "search_vector" DROP DEFAULT;

-- @@SECTION B
-- 1. Expression, partial and non-btree indexes (7).
CREATE INDEX idx_catalog_food_aliases_lower_alias ON public.catalog_food_aliases USING btree (lower(alias));
CREATE INDEX idx_catalog_foods_search_vector ON public.catalog_foods USING gin (search_vector);
CREATE INDEX idx_meal_entries_meal_plan_meal_id ON public.meal_entries USING btree (meal_plan_meal_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX unique_active_meal_plan_start_date ON public.meal_plans USING btree (user_id, start_date) WHERE (status = 'active'::text);
CREATE UNIQUE INDEX unique_current_recipe_version ON public.recipe_versions USING btree (recipe_id) WHERE (status = 'current'::text);
CREATE UNIQUE INDEX unique_default_catalog_food_portion ON public.catalog_food_portions USING btree (catalog_food_id) WHERE is_default;
CREATE UNIQUE INDEX unique_published_catalog_food_identity ON public.catalog_foods USING btree (canonical_name, food_state) WHERE (publication_status = 'published'::text);
-- 2. STORED generated columns (1). Printed as the ADD COLUMN form the migration
--    uses, which is how the expression reads in PostgreSQL 16.
ALTER TABLE public.catalog_foods ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(search_text, ''::text))) STORED;
-- 3. NOT NULL array columns (12). Prisma never emits NOT NULL for a scalar
--    list, so the migration adds it by hand and these are the only record of it.
ALTER TABLE public.catalog_foods ALTER COLUMN allergen_tags SET NOT NULL;
ALTER TABLE public.catalog_foods ALTER COLUMN diet_tags SET NOT NULL;
ALTER TABLE public.catalog_validation_records ALTER COLUMN aliases SET NOT NULL;
ALTER TABLE public.meal_plan_preferences ALTER COLUMN allergens SET NOT NULL;
ALTER TABLE public.meal_plan_preferences ALTER COLUMN disliked_food_groups SET NOT NULL;
ALTER TABLE public.meal_plan_preferences ALTER COLUMN disliked_food_ids SET NOT NULL;
ALTER TABLE public.recipe_ingredients ALTER COLUMN snapshot_allergen_tags SET NOT NULL;
ALTER TABLE public.recipe_ingredients ALTER COLUMN snapshot_diet_tags SET NOT NULL;
ALTER TABLE public.recipe_versions ALTER COLUMN allergen_tags SET NOT NULL;
ALTER TABLE public.recipe_versions ALTER COLUMN badges SET NOT NULL;
ALTER TABLE public.recipe_versions ALTER COLUMN diet_tags SET NOT NULL;
ALTER TABLE public.recipe_versions ALTER COLUMN meal_slots SET NOT NULL;
