-- Read-path index and planner-statistics corrections, measured at the volume the
-- catalog release actually ships (10,928 published foods / 15,777 aliases) and at
-- plan-read scale (1,503 plans / 10,521 days / 34,147 meals / 61,623 grocery rows
-- / 16,758 diary entries). Three independent changes, one ledger entry, because
-- they are one round of "make the declared indexes the ones the reads use".
--
--   1. catalog_food_aliases.search_vector — a STORED generated tsvector and a GIN
--      index over it, so the alias full-text branch of the catalog search stops
--      recomputing to_tsvector for every alias in the table on every request.
--   2. meal_plans — the read index realigned to the statement that actually runs.
--   3. Extended statistics on four correlated column pairs, so the planner stops
--      multiplying independent selectivities down to a one-row estimate.
--
-- WHAT PRISMA CAN AND CANNOT EXPRESS HERE, because the schema-diff gate depends
-- on the split. The generated expression in (1) is written here and nowhere else:
-- prisma/schema.prisma declares the column as `Unsupported("tsvector")?` and the
-- GIN index with `map:` pinning this name, which is exactly how
-- catalog_foods.search_vector is already carried, so the only drift the gate sees
-- is the `ALTER COLUMN ... DROP DEFAULT` line that a generated column always
-- produces. The `@@index` in (2) is fully expressible and is updated in step. The
-- statistics objects in (3) are invisible to Prisma's datamodel and to its diff,
-- so they live here alone and docs/meal-planning/schema-catalog-evidence.sql is
-- not the place to read them back either — pg_statistic_ext is.

-- ---------------------------------------------------------------------------
-- 1. The alias full-text branch reads a stored vector instead of building one.
-- ---------------------------------------------------------------------------
--
-- Before this column existed, the alias full-text contribution of
-- `catalogMatchSet` projected `to_tsvector('english', a.alias)` through a
-- CROSS JOIN LATERAL and tested the PROJECTION, which no index can answer.
-- Measured on the shipped release, the branch planned as:
--
--     Nested Loop (actual 44.988 ms, rows=2153)
--       Nested Loop (actual 29.434 ms)
--         Join Filter: (to_tsvector('english', a.alias) @@ s.tsq)
--         Rows Removed by Join Filter: 13624
--         -> Seq Scan on catalog_food_aliases a (rows=15777)
--
-- — 49.6% of the whole match-set Append, and a FIXED cost: a query matching
-- nothing paid the same 15,777 to_tsvector calls (Rows Removed by Join Filter:
-- 15777), which is why an unmatched term still cost ~62 ms end to end.
--
-- The expression is byte-identical to the one catalog_foods.search_vector uses,
-- and the 'english' configuration must stay equal to TEXT_SEARCH_CONFIG in
-- src/services/catalog.service.ts: the query builds its tsquery with that
-- configuration, and a column generated under a different one silently
-- under-matches rather than failing. coalesce() is redundant today because alias
-- is NOT NULL, and is kept because the generated expression must be immutable
-- against a future nullable column rather than quietly producing NULL rows that
-- `@@` would drop.
ALTER TABLE "catalog_food_aliases"
    ADD COLUMN "search_vector" tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce("alias", ''))) STORED;

-- GIN, matching idx_catalog_foods_search_vector: the `@@` operator is what the
-- branch tests and tsvector_ops is the default class for it. The tsquery arrives
-- as a nested-loop parameter from the `search` CTE rather than as a plan-time
-- constant, which a GIN index condition accepts — unlike the prefix branches,
-- whose `~>=~`/`~<~` range bounds must be derived at plan time and which is why
-- those still bind their pattern as a literal.
CREATE INDEX "idx_catalog_food_aliases_search_vector"
    ON "catalog_food_aliases" USING GIN ("search_vector");

-- ---------------------------------------------------------------------------
-- 2. The meal_plans read index matches the plan-lifecycle statement.
-- ---------------------------------------------------------------------------
--
-- `(user_id, status, start_date)` had no reader and no writer. Measured over 301
-- plan-lifecycle reads at scale its idx_scan stayed 0, because the two statement
-- shapes that exist both go elsewhere:
--
--   * The lifecycle list (`loadPlanLifecycleStates`) carries NO status predicate
--     — it selects every plan of one user and orders by (start_date, id), because
--     `resolveCurrentAndUpcoming` and `requireNonConflictingWeek` classify the
--     rows in memory rather than in SQL. The planner therefore took the narrower
--     user_id prefix of meal_plans_user_id_generation_key_key and added a Sort.
--   * The flag-recompute statements (user_id + status = 'active' + end_date >=
--     today, ordered by start_date) are served by the partial index
--     unique_active_meal_plan_start_date, which is narrower still because it
--     indexes only active rows. That remains true after this change.
--
-- Leading with start_date and carrying id makes the lifecycle statement an
-- ordered index scan with no Sort node (measured: 4 shared buffers to 2), and the
-- index count is unchanged, so nothing new is paid on insert or update. AAP
-- §0.5.1 names `(user_id, status, start_date)`; the intent it states — an index
-- serving the plan reads — is what this delivers, and the literal column list
-- changes because no statement filters on status without the partial index
-- already being the better answer.
-- IF EXISTS, for the same reason 20260910000000_catalog_prefix_fold_indexes
-- drops idx_catalog_food_aliases_lower_alias that way: this statement RETIRES a
-- construct that prisma/manual-migrations/meal-planning/001_meal_planning.sql
-- also creates, and the dual-ledger gate applies the two in both orders. In the
-- order that runs the manual copy first the index is here to drop; in the order
-- that runs it last the copy's own to_regclass guard has already declined to
-- create it, and this drop must not fail for finding nothing.
DROP INDEX IF EXISTS "meal_plans_user_id_status_start_date_idx";

CREATE INDEX "meal_plans_user_id_start_date_id_idx"
    ON "meal_plans" ("user_id", "start_date", "id");

-- ---------------------------------------------------------------------------
-- 3. Extended statistics for the correlated pairs every plan read filters on.
-- ---------------------------------------------------------------------------
--
-- Every user-owned plan table denormalizes user_id so that no read or write
-- predicate needs a join to prove ownership. The consequence is that plan reads
-- filter `meal_plan_id = $1 AND user_id = $2`, where meal_plan_id already
-- determines user_id. PostgreSQL assumes column independence, multiplies the two
-- selectivities and clamps the product to one row. Measured before these objects
-- existed: meal_plan_days estimated 1 against 7 actual, meal_plan_meals 1 against
-- 22, grocery_items 1 against 41. The correct index was still chosen and every
-- node stayed sub-millisecond, so this is not a present defect — a one-row
-- estimate feeding a join is the standard precondition for a nested-loop
-- blow-up once a plan carries hundreds of grocery rows.
--
-- `dependencies` is the kind that answers an equality conjunction, and it is what
-- fixes these three: after ANALYZE the estimates measured 7 (exact), 23 (against
-- 22 actual) and 41 (exact). `ndistinct` is requested alongside it because it is
-- what a GROUP BY over the same pair needs, and the pair is grouped when a plan is
-- summarised.
CREATE STATISTICS "meal_plan_days_meal_plan_id_user_id_stx" (ndistinct, dependencies)
    ON "meal_plan_id", "user_id" FROM "meal_plan_days";

CREATE STATISTICS "meal_plan_meals_meal_plan_id_user_id_stx" (ndistinct, dependencies)
    ON "meal_plan_id", "user_id" FROM "meal_plan_meals";

CREATE STATISTICS "grocery_items_meal_plan_id_user_id_stx" (ndistinct, dependencies)
    ON "meal_plan_id", "user_id" FROM "grocery_items";

-- meal_entries is the one pair of the four where `dependencies` records NOTHING,
-- and that is the honest outcome rather than a misconfiguration: a user has many
-- diary dates and a date has many users, so neither column determines the other
-- and pg_statistic_ext_data.stxddependencies comes back empty. Measured, the
-- equality-conjunction estimate for `user_id = $1 AND date = $2` is unchanged at
-- one row, and adding `mcv` does not move it either, because with thousands of
-- (user, date) combinations of a handful of rows each no single pair is frequent
-- enough to enter a most-common-values list. What `ndistinct` does deliver here is
-- exact: the number of distinct (user_id, date) combinations, which a GROUP BY
-- over the pair would otherwise estimate as the product of the two column
-- cardinalities. The object is therefore declared for the kind that works, and
-- `dependencies` is kept so that it populates on its own if the data ever develops
-- one, rather than needing a second migration to start collecting it.
CREATE STATISTICS "meal_entries_user_id_date_stx" (ndistinct, dependencies)
    ON "user_id", "date" FROM "meal_entries";

-- A statistics object is empty until a table is analysed, and autovacuum only
-- gets there after enough rows have changed — so a database migrated onto an
-- existing dataset would keep planning against the old estimates for an
-- indeterminate period. ANALYZE is bounded by the statistics sample (30,000 rows
-- at the default target) rather than by table size, and it runs correctly inside
-- the transaction `prisma migrate deploy` wraps this file in, unlike VACUUM.
ANALYZE "meal_plan_days";
ANALYZE "meal_plan_meals";
ANALYZE "grocery_items";
ANALYZE "meal_entries";
