-- Coach (adaptive TDEE) foundations — see tdee-coach-plan.md §3.1.
-- Phase 0/1: profile columns, weigh-in unit provenance, coach tables.
-- (devices / notification tables land with Phase 3 in a separate migration.)

-- AlterTable: profile fields for the Coach cold-start estimate + scheduling.
ALTER TABLE "users" ADD COLUMN "sex" TEXT,
ADD COLUMN "birth_date" DATE,
ADD COLUMN "height_cm" DOUBLE PRECISION,
ADD COLUMN "weight_unit" TEXT,
ADD COLUMN "timezone" TEXT,
ADD COLUMN "last_active_at" TIMESTAMP(3);

-- AlterTable: unit provenance for weigh-ins. Null = legacy row; backfilled
-- lazily from the user's current weight_unit on profile sync.
ALTER TABLE "body_weight_entries" ADD COLUMN "unit" TEXT;

-- CreateTable
CREATE TABLE "coach_profiles" (
    "user_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "rate_pct_bw" DOUBLE PRECISION NOT NULL,
    "protein_pref" DOUBLE PRECISION,
    "fat_bias" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "expenditure_snapshots" (
    "user_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "trend_weight_kg" DOUBLE PRECISION,
    "tdee_kcal" INTEGER NOT NULL,
    "confidence" TEXT NOT NULL,

    CONSTRAINT "expenditure_snapshots_pkey" PRIMARY KEY ("user_id", "day")
);

-- CreateTable
CREATE TABLE "coach_weekly_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "week_start" DATE NOT NULL,
    "calories" INTEGER NOT NULL,
    "protein_g" INTEGER NOT NULL,
    "carbs_g" INTEGER NOT NULL,
    "fat_g" INTEGER NOT NULL,
    "tdee_kcal" INTEGER NOT NULL,
    "rationale" JSONB NOT NULL,
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_weekly_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unique_user_week_start" ON "coach_weekly_plans"("user_id", "week_start");

-- CreateIndex
CREATE INDEX "idx_coach_weekly_plans_user_id" ON "coach_weekly_plans"("user_id");

-- AddForeignKey
ALTER TABLE "coach_profiles" ADD CONSTRAINT "coach_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "expenditure_snapshots" ADD CONSTRAINT "expenditure_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coach_weekly_plans" ADD CONSTRAINT "coach_weekly_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
