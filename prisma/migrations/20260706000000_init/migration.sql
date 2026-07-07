-- CreateTable
CREATE TABLE "daily_exercises" (
    "id" UUID NOT NULL,
    "workout_day_id" UUID NOT NULL,
    "exercise_id" UUID NOT NULL,
    "order" INTEGER DEFAULT 0,

    CONSTRAINT "daily_exercise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercise_sets" (
    "id" UUID NOT NULL,
    "daily_exercise_id" UUID NOT NULL,
    "reps" INTEGER,
    "weight" DOUBLE PRECISION,
    "added_weight" DOUBLE PRECISION,
    "duration_seconds" INTEGER,
    "distance_meters" DOUBLE PRECISION,
    "rpe" DOUBLE PRECISION,
    "is_warmup" BOOLEAN DEFAULT false,
    "completed" BOOLEAN DEFAULT false,
    "set_number" INTEGER,
    "completed_at" DATE,

    CONSTRAINT "exercise_set_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_exercises" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "exercise_type" TEXT NOT NULL,
    "exercise_body_part" TEXT NOT NULL,
    "logging_type" TEXT NOT NULL DEFAULT 'WEIGHT_REPS',
    "user_id" TEXT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "exercise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "email" TEXT NOT NULL,
    "target_calories" INTEGER,
    "target_protein_g" INTEGER,
    "target_carbs_g" INTEGER,
    "target_fat_g" INTEGER,
    "avatar_base64" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workout_days" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "has_synced" BOOLEAN DEFAULT false,
    "updated_at" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "workout_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "exercise_ids" TEXT[],

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personal_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "exercise_id" UUID NOT NULL,
    "record_type" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "reps_at_record" INTEGER,
    "exercise_set_id" UUID,
    "achieved_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER NOT NULL,
    "distance_meters" DOUBLE PRECISION NOT NULL,
    "avg_pace_sec_per_km" DOUBLE PRECISION,
    "elevation_gain_m" DOUBLE PRECISION,
    "elevation_loss_m" DOUBLE PRECISION,
    "avg_heart_rate" INTEGER,
    "max_heart_rate" INTEGER,
    "calories" INTEGER,
    "run_type" TEXT NOT NULL DEFAULT 'OUTDOOR',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "route_polyline" TEXT,
    "notes" TEXT,
    "has_synced" BOOLEAN DEFAULT false,
    "updated_at" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "body_weight_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "logged_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "body_weight_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_splits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "split_number" INTEGER NOT NULL,
    "distance_meters" DOUBLE PRECISION NOT NULL,
    "duration_seconds" INTEGER NOT NULL,
    "pace_sec_per_km" DOUBLE PRECISION,

    CONSTRAINT "run_splits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_personal_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "record_type" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "run_id" UUID,
    "achieved_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_personal_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "foods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serving_amount" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "serving_unit" TEXT,
    "calories" INTEGER NOT NULL,
    "protein_g" INTEGER NOT NULL,
    "carbs_g" INTEGER NOT NULL,
    "fat_g" INTEGER NOT NULL,
    "brand" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "foods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "meals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "meal_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "food_id" UUID,
    "name" TEXT NOT NULL,
    "serving_text" TEXT,
    "servings" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "calories" INTEGER NOT NULL,
    "protein_g" INTEGER NOT NULL,
    "carbs_g" INTEGER NOT NULL,
    "fat_g" INTEGER NOT NULL,
    "input_method" TEXT NOT NULL DEFAULT 'library',
    "raw_input" TEXT,
    "logged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "meal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usda_api_cache" (
    "cache_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usda_api_cache_pkey" PRIMARY KEY ("cache_key")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "user_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("user_id","day")
);

-- CreateIndex
CREATE INDEX "idx_daily_exercises_exercise_id" ON "daily_exercises"("exercise_id");

-- CreateIndex
CREATE INDEX "idx_user_exercises_user_id" ON "user_exercises"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "unique_user_date" ON "workout_days"("user_id", "date");

-- CreateIndex
CREATE INDEX "idx_templates_user_id" ON "templates"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "unique_user_template_name" ON "templates"("user_id", "name");

-- CreateIndex
CREATE INDEX "idx_personal_records_user_id" ON "personal_records"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "unique_user_exercise_record_type" ON "personal_records"("user_id", "exercise_id", "record_type");

-- CreateIndex
CREATE INDEX "idx_runs_user_id_started_at" ON "runs"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "idx_body_weight_entries_user_id_logged_at" ON "body_weight_entries"("user_id", "logged_at");

-- CreateIndex
CREATE UNIQUE INDEX "unique_run_split_number" ON "run_splits"("run_id", "split_number");

-- CreateIndex
CREATE UNIQUE INDEX "unique_user_run_record_type" ON "run_personal_records"("user_id", "record_type");

-- CreateIndex
CREATE INDEX "idx_foods_user_id_name" ON "foods"("user_id", "name");

-- CreateIndex
CREATE INDEX "idx_meals_user_id_date" ON "meals"("user_id", "date");

-- CreateIndex
CREATE INDEX "idx_meal_entries_user_id_date" ON "meal_entries"("user_id", "date");

-- CreateIndex
CREATE INDEX "idx_meal_entries_meal_id" ON "meal_entries"("meal_id");

-- AddForeignKey
ALTER TABLE "daily_exercises" ADD CONSTRAINT "daily_exercise_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "user_exercises"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "daily_exercises" ADD CONSTRAINT "daily_exercise_workout_day_id_fkey" FOREIGN KEY ("workout_day_id") REFERENCES "workout_days"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exercise_sets" ADD CONSTRAINT "exercise_set_daily_exercise_id_fkey" FOREIGN KEY ("daily_exercise_id") REFERENCES "daily_exercises"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_exercises" ADD CONSTRAINT "user_exercise_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "personal_records" ADD CONSTRAINT "personal_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "personal_records" ADD CONSTRAINT "personal_records_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "user_exercises"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "body_weight_entries" ADD CONSTRAINT "body_weight_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "run_splits" ADD CONSTRAINT "run_splits_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "run_personal_records" ADD CONSTRAINT "run_personal_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "run_personal_records" ADD CONSTRAINT "run_personal_records_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "foods" ADD CONSTRAINT "foods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meals" ADD CONSTRAINT "meals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meal_entries" ADD CONSTRAINT "meal_entries_meal_id_fkey" FOREIGN KEY ("meal_id") REFERENCES "meals"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meal_entries" ADD CONSTRAINT "meal_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meal_entries" ADD CONSTRAINT "meal_entries_food_id_fkey" FOREIGN KEY ("food_id") REFERENCES "foods"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

