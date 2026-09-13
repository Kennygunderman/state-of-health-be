-- Meal planning - additive schema (OPERATOR REFERENCE COPY, not the executed ledger)
--
-- The authoritative migration - the one that is actually applied - is
--   prisma/migrations/20260908000000_meal_planning/migration.sql
-- This file is that migration's DDL, statement for statement, rewritten so it can
-- be re-run safely. No npm script, CI step or Prisma command runs this folder.
--
-- Running it by hand is normally unnecessary, because the Prisma migration is
-- applied automatically: the container's final command is
-- `npx prisma migrate deploy && node dist/server.js` (see Dockerfile), and CI
-- applies the same ledger with `npx prisma migrate deploy` against its own
-- throwaway PostgreSQL service before the schema gate and the test suite (see
-- the "Apply the migration ledger" step in .github/workflows/ci.yml).
-- `prisma/manual-migrations` is listed in .dockerignore, so the runtime image
-- does not even contain this file.
--
-- IF YOU DO APPLY THIS FILE BY HAND, immediately follow it with
--   npx prisma migrate resolve --applied 20260908000000_meal_planning
-- so the next `prisma migrate deploy` does not try to apply the same DDL again.
--
-- Every statement is guarded: `IF NOT EXISTS` on tables, columns and indexes, and
-- a `DO $$` block per foreign key, since `ADD CONSTRAINT` has no `IF NOT EXISTS`
-- form. This is the first file under prisma/ to need those constructs. Re-running
-- it is therefore a no-op, but it is NOT a repair tool for a partially applied
-- schema: `CREATE TABLE IF NOT EXISTS` will not add a missing column - or a
-- missing NOT NULL - to a table that already exists.
--
-- Three things here are deliberate and are not Prisma's output, so do not
-- "correct" them against prisma/schema.prisma: the STORED generated expression
-- on catalog_foods.search_vector, the block of expression and partial indexes
-- before the foreign keys, and NOT NULL on the twelve required TEXT[]/UUID[]
-- columns. Prisma cannot express any of them, which is why the authoritative
-- migration writes them by hand and this copy repeats them verbatim. Of the
-- three, the generated expression is the one `prisma migrate diff` reports:
-- docs/meal-planning/expected-schema-diff.sql is that command's committed
-- output and CI compares it on every run. The expression index, the partial
-- indexes and the array NOT NULLs are invisible to that command - a shortfall
-- against what the Agent Action Plan expects of that file, recorded there as an
-- open conflict rather than settled - so for now what holds this copy to the
-- authoritative migration for them is the ledger-equivalence gate in
-- src/__tests__/api/compat.test.ts, which applies both and compares the
-- resulting columns, indexes and constraints.
--
-- README.md in this folder explains when an operator would run this file and how
-- to prove it still matches the authoritative ledger;
-- docs/meal-planning/release-and-recovery.md carries the release and rollback
-- procedure. Neither is repeated here.

-- AlterTable
ALTER TABLE "meal_entries" ADD COLUMN IF NOT EXISTS "catalog_food_id" UUID,
ADD COLUMN IF NOT EXISTS "meal_plan_meal_id" UUID,
ADD COLUMN IF NOT EXISTS "nutrition_provenance" TEXT,
ADD COLUMN IF NOT EXISTS "recipe_version_id" UUID;

-- CreateTable
CREATE TABLE IF NOT EXISTS "catalog_import_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "manifest_version" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "cursor" JSONB,
    "counts" JSONB,
    "log" JSONB,

    CONSTRAINT "catalog_import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "catalog_generation_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "batch_key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "candidate_count" INTEGER NOT NULL DEFAULT 0,
    "accepted_count" INTEGER NOT NULL DEFAULT 0,
    "model_calls_reserved" INTEGER NOT NULL DEFAULT 0,
    "model_calls_used" INTEGER NOT NULL DEFAULT 0,
    "tokens_used" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "catalog_generation_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "catalog_foods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_key" TEXT NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "food_state" TEXT NOT NULL,
    "identity_source" TEXT NOT NULL,
    "identity_status" TEXT NOT NULL,
    "nutrition_provenance" TEXT NOT NULL,
    "nutrition_version" INTEGER NOT NULL,
    "metadata_version" INTEGER NOT NULL,
    "nutrition_basis" TEXT NOT NULL,
    "basis_amount" DOUBLE PRECISION NOT NULL,
    "calories" DOUBLE PRECISION,
    "protein_g" DOUBLE PRECISION,
    "carbs_g" DOUBLE PRECISION,
    "fat_g" DOUBLE PRECISION,
    "fiber_g" DOUBLE PRECISION,
    "density_g_per_ml" DOUBLE PRECISION,
    "usda_fdc_id" INTEGER,
    "usda_data_type" TEXT,
    "usda_description" TEXT,
    "source_version" TEXT,
    "source_cache_key" TEXT,
    "generation_batch_id" UUID,
    "publication_status" TEXT NOT NULL,
    "allergen_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allergen_status" TEXT NOT NULL,
    "diet_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "food_group" TEXT NOT NULL,
    "is_common_dislike" BOOLEAN NOT NULL DEFAULT false,
    "cost_class" SMALLINT NOT NULL,
    "search_text" TEXT,
    "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_text, ''))) STORED,
    "imported_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_foods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "catalog_food_aliases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "catalog_food_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,

    CONSTRAINT "catalog_food_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "catalog_food_portions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "catalog_food_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "gram_weight" DOUBLE PRECISION NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,

    CONSTRAINT "catalog_food_portions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "catalog_food_components" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "catalog_food_id" UUID NOT NULL,
    "component_catalog_food_id" UUID NOT NULL,
    "quantity_grams" DOUBLE PRECISION NOT NULL,
    "yield_factor" DOUBLE PRECISION NOT NULL,
    "component_nutrition_version" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "catalog_food_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "catalog_validation_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "catalog_food_id" UUID NOT NULL,
    "canonical_identity" JSONB NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "category" TEXT NOT NULL,
    "food_state" TEXT NOT NULL,
    "identity_source" TEXT NOT NULL,
    "identity_status" TEXT NOT NULL,
    "nutrition_provenance" TEXT NOT NULL,
    "nutrition_method" TEXT NOT NULL,
    "nutrition_assumptions" TEXT,
    "portion_units" JSONB NOT NULL,
    "identity_evidence" JSONB NOT NULL,
    "checks" JSONB NOT NULL,
    "llm_review" JSONB,
    "outcome" TEXT NOT NULL,
    "reviewed_at" TIMESTAMP(3) NOT NULL,
    "publication_status" TEXT NOT NULL,
    "source_versions" JSONB NOT NULL,
    "history" JSONB NOT NULL,

    CONSTRAINT "catalog_validation_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "recipes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "current_version_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "recipe_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipe_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon_key" TEXT NOT NULL,
    "instructions" JSONB NOT NULL,
    "yield_servings" DOUBLE PRECISION NOT NULL,
    "serving_description" TEXT NOT NULL,
    "prep_minutes" INTEGER NOT NULL,
    "cook_minutes" INTEGER NOT NULL,
    "total_minutes" INTEGER NOT NULL,
    "meal_slots" TEXT[] NOT NULL,
    "diet_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allergen_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allergen_status" TEXT NOT NULL,
    "budget_tier" SMALLINT NOT NULL,
    "badges" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "nutrition_provenance" TEXT NOT NULL,
    "per_serving_calories" DOUBLE PRECISION NOT NULL,
    "per_serving_protein_g" DOUBLE PRECISION NOT NULL,
    "per_serving_carbs_g" DOUBLE PRECISION NOT NULL,
    "per_serving_fat_g" DOUBLE PRECISION NOT NULL,
    "sourced_calories_note" TEXT,
    "status" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "recipe_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "recipe_ingredients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipe_version_id" UUID NOT NULL,
    "catalog_food_id" UUID NOT NULL,
    "catalog_nutrition_version" INTEGER NOT NULL,
    "catalog_metadata_version" INTEGER NOT NULL,
    "snapshot_per_100g" JSONB NOT NULL,
    "snapshot_name" TEXT NOT NULL,
    "snapshot_provenance" TEXT NOT NULL,
    "snapshot_allergen_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "snapshot_diet_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "gram_weight" DOUBLE PRECISION NOT NULL,
    "display_text" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_optional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "meal_plan_preferences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "time_zone" TEXT,
    "setup_status" TEXT NOT NULL,
    "setup_step" TEXT,
    "review_start_date" DATE,
    "target_route" TEXT,
    "goal" TEXT,
    "goal_weight_kg" DOUBLE PRECISION,
    "pace_lb_per_week" DOUBLE PRECISION,
    "age" INTEGER,
    "height_cm" DOUBLE PRECISION,
    "weight_kg" DOUBLE PRECISION,
    "weight_source" TEXT,
    "sex_for_estimate" TEXT,
    "height_unit_pref" TEXT,
    "weight_unit_pref" TEXT,
    "activity_level" TEXT,
    "diet" TEXT,
    "allergens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "disliked_food_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "disliked_food_groups" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "meal_schedule" TEXT,
    "meal_times" JSONB,
    "cooking_time_limit_min" INTEGER,
    "budget_amount" INTEGER,
    "budget_currency" TEXT,
    "no_budget_preference" BOOLEAN NOT NULL DEFAULT false,
    "budget_tier" SMALLINT,
    "target_source" TEXT,
    "targets_revision" INTEGER NOT NULL DEFAULT 0,
    "confirmed_targets" JSONB,
    "targets_input_revision" INTEGER,
    "estimated_targets" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "meal_plan_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "meal_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "generation_attempt" INTEGER NOT NULL,
    "preferences_revision" INTEGER NOT NULL,
    "targets_revision" INTEGER NOT NULL,
    "targets_snapshot" JSONB NOT NULL,
    "generation_seed" TEXT NOT NULL,
    "generation_key" TEXT NOT NULL,
    "replaced_plan_id" UUID,
    "incompatibility_flags" JSONB,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meal_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "meal_plan_days" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "meal_plan_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "day_index" SMALLINT NOT NULL,
    "planned_calories" DOUBLE PRECISION NOT NULL,
    "planned_protein_g" DOUBLE PRECISION NOT NULL,
    "planned_carbs_g" DOUBLE PRECISION NOT NULL,
    "planned_fat_g" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "meal_plan_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "meal_plan_meals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "meal_plan_day_id" UUID NOT NULL,
    "meal_plan_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "slot_time" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "recipe_version_id" UUID NOT NULL,
    "portion_multiplier" DOUBLE PRECISION NOT NULL,
    "planned_calories" DOUBLE PRECISION NOT NULL,
    "planned_protein_g" DOUBLE PRECISION NOT NULL,
    "planned_carbs_g" DOUBLE PRECISION NOT NULL,
    "planned_fat_g" DOUBLE PRECISION NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "previous_recipe_version_id" UUID,
    "swapped_at" TIMESTAMP(3),

    CONSTRAINT "meal_plan_meals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "grocery_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "meal_plan_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "catalog_food_id" UUID NOT NULL,
    "food_state" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity_grams" DECIMAL(10,2) NOT NULL,
    "display_quantity" DOUBLE PRECISION NOT NULL,
    "display_unit" TEXT NOT NULL,
    "display_text" TEXT NOT NULL,
    "is_checked" BOOLEAN NOT NULL DEFAULT false,
    "checked_at" TIMESTAMP(3),
    "previous_quantity_grams" DECIMAL(10,2),
    "flagged_at" TIMESTAMP(3),
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "grocery_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "meal_plan_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "meal_plan_id" UUID,
    "meal_plan_meal_id" UUID,
    "meal_entry_id" UUID,
    "response_status" SMALLINT,
    "response_snapshot" JSONB,
    "plan_revision_after" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meal_plan_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_import_runs_kind_started_at_idx" ON "catalog_import_runs"("kind", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_generation_batches_batch_key_key" ON "catalog_generation_batches"("batch_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_foods_publication_status_category_idx" ON "catalog_foods"("publication_status", "category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_foods_food_group_idx" ON "catalog_foods"("food_group");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_foods_is_common_dislike_publication_status_idx" ON "catalog_foods"("is_common_dislike", "publication_status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_foods_source_key_key" ON "catalog_foods"("source_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_foods_usda_fdc_id_key" ON "catalog_foods"("usda_fdc_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_food_aliases_catalog_food_id_alias_key" ON "catalog_food_aliases"("catalog_food_id", "alias");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_food_portions_catalog_food_id_description_key" ON "catalog_food_portions"("catalog_food_id", "description");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_food_components_catalog_food_id_component_catalog_f_key" ON "catalog_food_components"("catalog_food_id", "component_catalog_food_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_validation_records_catalog_food_id_key" ON "catalog_validation_records"("catalog_food_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "recipes_slug_key" ON "recipes"("slug");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "recipe_versions_recipe_id_version_key" ON "recipe_versions"("recipe_id", "version");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "recipe_ingredients_recipe_version_id_idx" ON "recipe_ingredients"("recipe_version_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "meal_plan_preferences_user_id_key" ON "meal_plan_preferences"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meal_plans_user_id_status_start_date_idx" ON "meal_plans"("user_id", "status", "start_date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "meal_plans_user_id_generation_key_key" ON "meal_plans"("user_id", "generation_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "meal_plans_id_user_id_key" ON "meal_plans"("id", "user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meal_plan_days_user_id_idx" ON "meal_plan_days"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "meal_plan_days_meal_plan_id_date_key" ON "meal_plan_days"("meal_plan_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "meal_plan_days_id_user_id_key" ON "meal_plan_days"("id", "user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meal_plan_meals_meal_plan_id_user_id_idx" ON "meal_plan_meals"("meal_plan_id", "user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meal_plan_meals_user_id_idx" ON "meal_plan_meals"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meal_plan_meals_recipe_version_id_idx" ON "meal_plan_meals"("recipe_version_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meal_plan_meals_previous_recipe_version_id_idx" ON "meal_plan_meals"("previous_recipe_version_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "meal_plan_meals_meal_plan_day_id_slot_key" ON "meal_plan_meals"("meal_plan_day_id", "slot");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "meal_plan_meals_id_user_id_key" ON "meal_plan_meals"("id", "user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "grocery_items_user_id_idx" ON "grocery_items"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "grocery_items_meal_plan_id_catalog_food_id_food_state_key" ON "grocery_items"("meal_plan_id", "catalog_food_id", "food_state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meal_plan_actions_meal_plan_id_idx" ON "meal_plan_actions"("meal_plan_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meal_plan_actions_meal_plan_meal_id_idx" ON "meal_plan_actions"("meal_plan_meal_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meal_plan_actions_meal_entry_id_idx" ON "meal_plan_actions"("meal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "meal_plan_actions_user_id_idempotency_key_key" ON "meal_plan_actions"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_meal_entries_recipe_version_id" ON "meal_entries"("recipe_version_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "meal_entries_id_user_id_key" ON "meal_entries"("id", "user_id");

-- CreateIndex
-- Hand-written from here to the foreign keys: constructs the Prisma datamodel
-- cannot express. `prisma migrate diff` reports none of them and does not
-- notice their loss either - measured, and recorded in
-- docs/meal-planning/expected-schema-diff.sql - so the check that holds this
-- block to the authoritative migration is the ledger-equivalence gate in
-- src/__tests__/api/compat.test.ts, which compares the two schemas index for
-- index.
CREATE INDEX IF NOT EXISTS "idx_catalog_foods_search_vector" ON "catalog_foods" USING GIN ("search_vector");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_catalog_food_aliases_lower_alias" ON "catalog_food_aliases"(lower("alias"));

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "unique_published_catalog_food_identity" ON "catalog_foods"("canonical_name", "food_state") WHERE "publication_status" = 'published';

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "unique_active_meal_plan_start_date" ON "meal_plans"("user_id", "start_date") WHERE "status" = 'active';

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "unique_current_recipe_version" ON "recipe_versions"("recipe_id") WHERE "status" = 'current';

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "unique_default_catalog_food_portion" ON "catalog_food_portions"("catalog_food_id") WHERE "is_default";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_meal_entries_meal_plan_meal_id" ON "meal_entries"("meal_plan_meal_id") WHERE "deleted_at" IS NULL;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_entries_meal_plan_meal_id_fkey'
          AND conrelid = '"meal_entries"'::regclass
    ) THEN
        ALTER TABLE "meal_entries" ADD CONSTRAINT "meal_entries_meal_plan_meal_id_fkey" FOREIGN KEY ("meal_plan_meal_id") REFERENCES "meal_plan_meals"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_entries_catalog_food_id_fkey'
          AND conrelid = '"meal_entries"'::regclass
    ) THEN
        ALTER TABLE "meal_entries" ADD CONSTRAINT "meal_entries_catalog_food_id_fkey" FOREIGN KEY ("catalog_food_id") REFERENCES "catalog_foods"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_entries_recipe_version_id_fkey'
          AND conrelid = '"meal_entries"'::regclass
    ) THEN
        ALTER TABLE "meal_entries" ADD CONSTRAINT "meal_entries_recipe_version_id_fkey" FOREIGN KEY ("recipe_version_id") REFERENCES "recipe_versions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_entries_meal_plan_meal_id_user_id_fkey'
          AND conrelid = '"meal_entries"'::regclass
    ) THEN
        ALTER TABLE "meal_entries" ADD CONSTRAINT "meal_entries_meal_plan_meal_id_user_id_fkey" FOREIGN KEY ("meal_plan_meal_id", "user_id") REFERENCES "meal_plan_meals"("id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'catalog_generation_batches_run_id_fkey'
          AND conrelid = '"catalog_generation_batches"'::regclass
    ) THEN
        ALTER TABLE "catalog_generation_batches" ADD CONSTRAINT "catalog_generation_batches_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "catalog_import_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'catalog_foods_generation_batch_id_fkey'
          AND conrelid = '"catalog_foods"'::regclass
    ) THEN
        ALTER TABLE "catalog_foods" ADD CONSTRAINT "catalog_foods_generation_batch_id_fkey" FOREIGN KEY ("generation_batch_id") REFERENCES "catalog_generation_batches"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'catalog_food_aliases_catalog_food_id_fkey'
          AND conrelid = '"catalog_food_aliases"'::regclass
    ) THEN
        ALTER TABLE "catalog_food_aliases" ADD CONSTRAINT "catalog_food_aliases_catalog_food_id_fkey" FOREIGN KEY ("catalog_food_id") REFERENCES "catalog_foods"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'catalog_food_portions_catalog_food_id_fkey'
          AND conrelid = '"catalog_food_portions"'::regclass
    ) THEN
        ALTER TABLE "catalog_food_portions" ADD CONSTRAINT "catalog_food_portions_catalog_food_id_fkey" FOREIGN KEY ("catalog_food_id") REFERENCES "catalog_foods"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'catalog_food_components_catalog_food_id_fkey'
          AND conrelid = '"catalog_food_components"'::regclass
    ) THEN
        ALTER TABLE "catalog_food_components" ADD CONSTRAINT "catalog_food_components_catalog_food_id_fkey" FOREIGN KEY ("catalog_food_id") REFERENCES "catalog_foods"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'catalog_food_components_component_catalog_food_id_fkey'
          AND conrelid = '"catalog_food_components"'::regclass
    ) THEN
        ALTER TABLE "catalog_food_components" ADD CONSTRAINT "catalog_food_components_component_catalog_food_id_fkey" FOREIGN KEY ("component_catalog_food_id") REFERENCES "catalog_foods"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'catalog_validation_records_catalog_food_id_fkey'
          AND conrelid = '"catalog_validation_records"'::regclass
    ) THEN
        ALTER TABLE "catalog_validation_records" ADD CONSTRAINT "catalog_validation_records_catalog_food_id_fkey" FOREIGN KEY ("catalog_food_id") REFERENCES "catalog_foods"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'recipes_current_version_id_fkey'
          AND conrelid = '"recipes"'::regclass
    ) THEN
        ALTER TABLE "recipes" ADD CONSTRAINT "recipes_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "recipe_versions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'recipe_versions_recipe_id_fkey'
          AND conrelid = '"recipe_versions"'::regclass
    ) THEN
        ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'recipe_ingredients_recipe_version_id_fkey'
          AND conrelid = '"recipe_ingredients"'::regclass
    ) THEN
        ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_version_id_fkey" FOREIGN KEY ("recipe_version_id") REFERENCES "recipe_versions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'recipe_ingredients_catalog_food_id_fkey'
          AND conrelid = '"recipe_ingredients"'::regclass
    ) THEN
        ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_catalog_food_id_fkey" FOREIGN KEY ("catalog_food_id") REFERENCES "catalog_foods"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_preferences_user_id_fkey'
          AND conrelid = '"meal_plan_preferences"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_preferences" ADD CONSTRAINT "meal_plan_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plans_user_id_fkey'
          AND conrelid = '"meal_plans"'::regclass
    ) THEN
        ALTER TABLE "meal_plans" ADD CONSTRAINT "meal_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plans_replaced_plan_id_fkey'
          AND conrelid = '"meal_plans"'::regclass
    ) THEN
        ALTER TABLE "meal_plans" ADD CONSTRAINT "meal_plans_replaced_plan_id_fkey" FOREIGN KEY ("replaced_plan_id") REFERENCES "meal_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plans_replaced_plan_id_user_id_fkey'
          AND conrelid = '"meal_plans"'::regclass
    ) THEN
        ALTER TABLE "meal_plans" ADD CONSTRAINT "meal_plans_replaced_plan_id_user_id_fkey" FOREIGN KEY ("replaced_plan_id", "user_id") REFERENCES "meal_plans"("id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_days_meal_plan_id_user_id_fkey'
          AND conrelid = '"meal_plan_days"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_days" ADD CONSTRAINT "meal_plan_days_meal_plan_id_user_id_fkey" FOREIGN KEY ("meal_plan_id", "user_id") REFERENCES "meal_plans"("id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_days_user_id_fkey'
          AND conrelid = '"meal_plan_days"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_days" ADD CONSTRAINT "meal_plan_days_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_meals_meal_plan_day_id_user_id_fkey'
          AND conrelid = '"meal_plan_meals"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_meals" ADD CONSTRAINT "meal_plan_meals_meal_plan_day_id_user_id_fkey" FOREIGN KEY ("meal_plan_day_id", "user_id") REFERENCES "meal_plan_days"("id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_meals_meal_plan_id_user_id_fkey'
          AND conrelid = '"meal_plan_meals"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_meals" ADD CONSTRAINT "meal_plan_meals_meal_plan_id_user_id_fkey" FOREIGN KEY ("meal_plan_id", "user_id") REFERENCES "meal_plans"("id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_meals_user_id_fkey'
          AND conrelid = '"meal_plan_meals"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_meals" ADD CONSTRAINT "meal_plan_meals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_meals_recipe_version_id_fkey'
          AND conrelid = '"meal_plan_meals"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_meals" ADD CONSTRAINT "meal_plan_meals_recipe_version_id_fkey" FOREIGN KEY ("recipe_version_id") REFERENCES "recipe_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_meals_previous_recipe_version_id_fkey'
          AND conrelid = '"meal_plan_meals"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_meals" ADD CONSTRAINT "meal_plan_meals_previous_recipe_version_id_fkey" FOREIGN KEY ("previous_recipe_version_id") REFERENCES "recipe_versions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'grocery_items_meal_plan_id_user_id_fkey'
          AND conrelid = '"grocery_items"'::regclass
    ) THEN
        ALTER TABLE "grocery_items" ADD CONSTRAINT "grocery_items_meal_plan_id_user_id_fkey" FOREIGN KEY ("meal_plan_id", "user_id") REFERENCES "meal_plans"("id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'grocery_items_user_id_fkey'
          AND conrelid = '"grocery_items"'::regclass
    ) THEN
        ALTER TABLE "grocery_items" ADD CONSTRAINT "grocery_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'grocery_items_catalog_food_id_fkey'
          AND conrelid = '"grocery_items"'::regclass
    ) THEN
        ALTER TABLE "grocery_items" ADD CONSTRAINT "grocery_items_catalog_food_id_fkey" FOREIGN KEY ("catalog_food_id") REFERENCES "catalog_foods"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_actions_user_id_fkey'
          AND conrelid = '"meal_plan_actions"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_actions" ADD CONSTRAINT "meal_plan_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_actions_meal_plan_id_fkey'
          AND conrelid = '"meal_plan_actions"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_actions" ADD CONSTRAINT "meal_plan_actions_meal_plan_id_fkey" FOREIGN KEY ("meal_plan_id") REFERENCES "meal_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_actions_meal_plan_meal_id_fkey'
          AND conrelid = '"meal_plan_actions"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_actions" ADD CONSTRAINT "meal_plan_actions_meal_plan_meal_id_fkey" FOREIGN KEY ("meal_plan_meal_id") REFERENCES "meal_plan_meals"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_actions_meal_entry_id_fkey'
          AND conrelid = '"meal_plan_actions"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_actions" ADD CONSTRAINT "meal_plan_actions_meal_entry_id_fkey" FOREIGN KEY ("meal_entry_id") REFERENCES "meal_entries"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_actions_meal_plan_id_user_id_fkey'
          AND conrelid = '"meal_plan_actions"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_actions" ADD CONSTRAINT "meal_plan_actions_meal_plan_id_user_id_fkey" FOREIGN KEY ("meal_plan_id", "user_id") REFERENCES "meal_plans"("id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_actions_meal_plan_meal_id_user_id_fkey'
          AND conrelid = '"meal_plan_actions"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_actions" ADD CONSTRAINT "meal_plan_actions_meal_plan_meal_id_user_id_fkey" FOREIGN KEY ("meal_plan_meal_id", "user_id") REFERENCES "meal_plan_meals"("id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'meal_plan_actions_meal_entry_id_user_id_fkey'
          AND conrelid = '"meal_plan_actions"'::regclass
    ) THEN
        ALTER TABLE "meal_plan_actions" ADD CONSTRAINT "meal_plan_actions_meal_entry_id_user_id_fkey" FOREIGN KEY ("meal_entry_id", "user_id") REFERENCES "meal_entries"("id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;
END $$;
