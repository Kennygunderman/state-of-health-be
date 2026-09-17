-- Supplementary schema-drift evidence for the meal-planning schema: what the
-- migration ledger holds that `prisma migrate diff` cannot see, read back out
-- of the database's own catalogs and compared against a reviewed expected
-- result.
--
-- Nothing applies this file. The executed ledger is
-- prisma/migrations/20260908000000_meal_planning/migration.sql; the captured
-- migrate-diff evidence of it is docs/meal-planning/expected-schema-diff.sql,
-- and this file is the second capture that one cannot make. Together they are
-- committed so that the ledger, prisma/schema.prisma and the applied database
-- cannot drift apart unnoticed.
--
-- TWO SECTIONS, each delimited by its own `-- >>> BEGIN <name>` and
-- `-- >>> END <name>` marker line. The gate extracts them by those markers, so
-- each marker appears exactly once and the sections keep this order:
--
--   pg-catalog-query      the extraction SQL itself, committed as the query so
--                         CI and a local run cannot use different ones.
--   pg-catalog-expected   that query's expected output against a database
--                         holding the applied ledger.
--
-- Inside each section, every line beginning with `--` and every empty line is
-- deleted from both sides (`sed '/^--/d;/^$/d'`) and what remains is compared
-- byte for byte, in both directions - an added line fails as loudly as a
-- removed one. Whitespace inside or around a payload line is content. Use line
-- comments only, each starting at column 0: a block comment, or a `--` that
-- starts after a space, survives the strip and is compared as payload.
--
-- WHY THIS FILE EXISTS. Agent Action Plan 0.5.1 and 0.9.1 specify
-- docs/meal-planning/expected-schema-diff.sql as the output of `prisma migrate
-- diff` and expect that output to carry the three constructs the Prisma
-- datamodel cannot express: the generated search_vector expression, the
-- lower(alias) expression index on catalog_food_aliases, and the partial
-- indexes' predicates. Measured against prisma 6.9.0 it carries only the first.
-- Prisma's schema describer leaves expression indexes, index predicates and
-- scalar-list NOT NULL out of both sides of its comparison, so deleting the
-- lower(alias) index, changing a partial index's predicate, or dropping NOT
-- NULL from a required array column each leave that output and its exit code
-- untouched. That is a recorded AAP-versus-tool divergence, and the sections
-- below are the mechanism that closes the two classes the tool omits: they pin
-- the generated column's expression, every hand-managed index's access method,
-- uniqueness, key expressions, OPERATOR CLASSES and predicate, and every array
-- column's NOT NULL and default. The query is scoped to those three classes, so
-- an ordinary scalar column or a plain btree index added later cannot churn the
-- evidence.
--
-- REGENERATING pg-catalog-expected. From backend/, with DATABASE_URL naming a
-- non-production database that `npx prisma migrate deploy` has already brought
-- up to this ledger. The query is section one of this file, so it is piped
-- straight out of it and the two cannot drift:
--
--   sed -n '/^-- >>> BEGIN pg-catalog-query$/,/^-- >>> END pg-catalog-query$/p' \
--     docs/meal-planning/schema-catalog-evidence.sql | psql "$DATABASE_URL" -tA
--
-- The query only reads system catalogs - pg_attribute, pg_attrdef, pg_class,
-- pg_index, pg_am, pg_opclass, pg_namespace and pg_type - and the pg_get_expr /
-- pg_get_indexdef functions that format their contents, and CI runs it inside
-- `BEGIN TRANSACTION READ ONLY` so a write introduced into the section cannot
-- execute. CI renders it with a small node + `pg` helper rather
-- than psql, which the runner does not have; that helper's output is
-- byte-identical to `psql -tA` - one row per line, one trailing newline.
--
-- WHY THE OPERATOR CLASS IS READ SEPARATELY. `pg_get_indexdef(oid, k, ...)`
-- renders the k-th key expression and OMITS its operator class - measured at
-- both pretty=true and pretty=false - so an index's class is invisible in
-- key_text. That is not cosmetic here: idx_catalog_food_aliases_lower_alias is
-- declared `lower(alias) text_pattern_ops` because a btree derives LIKE range
-- bounds only under a `*_pattern_ops` class or a C column collation, and under
-- the default `text_ops` the planner refuses the index for the only predicate
-- the index exists to serve. Rendering key_text alone, this gate was measured to
-- produce byte-identical output for a patched and an unpatched ledger, so the
-- class could be changed or silently revert and pass. The `opclasses=(...)`
-- field is therefore captured from pg_opclass by the per-key oid in
-- pg_index.indclass (an oidvector, zero-based, hence `k - 1`), one name per key
-- in key order, and it is what makes that reversion loud.
--
-- WHICH LEDGER THIS MEASURES. The sections below read the database that
-- `npx prisma migrate deploy` builds from prisma/migrations - the authoritative
-- ledger, as applied, rather than as written. They say nothing about the
-- operator copy under prisma/manual-migrations/meal-planning/, which this gate
-- never applies: what holds that copy to the authoritative migration is the
-- ledger-equivalence gate, describe('migration ledgers') in
-- src/__tests__/api/compat.test.ts, which applies both and compares the
-- resulting columns, indexes and constraints. The two are complementary - that
-- gate compares one ledger against the other and so cannot see a construct
-- dropped from both, which is precisely what these sections catch.
--
-- A RED GATE is fixed in prisma/schema.prisma and the migration, never by
-- editing this file to match - unless the DDL change was the intended one, in
-- which case regenerate the expected section with the command above, replace
-- its payload, and review the new content.
--
-- THE GATE is the `Schema-drift evidence gate` step of
-- .github/workflows/ci.yml, which polices this file beside
-- expected-schema-diff.sql. It executes pg-catalog-query read-only against the
-- database the `Apply the migration ledger` step migrated and compares
-- pg-catalog-expected with the result; and it requires that section to keep at
-- least one generated column, seven hand-managed indexes and twelve NOT NULL
-- array columns - the three classes the migration's own header names as
-- hand-edited - so deleting evidence lines cannot buy a pass either.
--
-- Captured against prisma and @prisma/client 6.9.0 on PostgreSQL 16.15, ledger
-- prisma/migrations through 20260908000000_meal_planning.

-- >>> BEGIN pg-catalog-query
WITH generated_columns AS (
  SELECT 1 AS section,
         format('generated_column %s.%s %s %s %s',
                c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
                CASE a.attgenerated::text WHEN 's' THEN 'stored' ELSE a.attgenerated::text END,
                pg_get_expr(d.adbin, d.adrelid, true)) AS line
    FROM pg_attribute a
    JOIN pg_class        c ON c.oid = a.attrelid
    JOIN pg_namespace    n ON n.oid = c.relnamespace
    JOIN pg_attrdef      d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attgenerated <> ''
), index_keys AS (
  SELECT i.indexrelid,
         string_agg(pg_get_indexdef(i.indexrelid, k::int, true), ', ' ORDER BY k) AS key_text,
         string_agg(oc.opcname, ', ' ORDER BY k) AS opclass_text
    FROM pg_index i
    CROSS JOIN LATERAL generate_series(1, i.indnkeyatts) AS k
    JOIN pg_opclass oc ON oc.oid = i.indclass[k - 1]
   GROUP BY i.indexrelid
), hand_managed_indexes AS (
  SELECT 2 AS section,
         format('index %s.%s am=%s unique=%s keys=(%s) opclasses=(%s) predicate=%s',
                tc.relname, ic.relname, am.amname,
                CASE WHEN i.indisunique THEN 'true' ELSE 'false' END,
                ik.key_text, ik.opclass_text,
                COALESCE(pg_get_expr(i.indpred, i.indrelid, true), '-')) AS line
    FROM pg_index i
    JOIN pg_class     ic ON ic.oid = i.indexrelid
    JOIN pg_class     tc ON tc.oid = i.indrelid
    JOIN pg_namespace n  ON n.oid  = tc.relnamespace
    JOIN pg_am        am ON am.oid = ic.relam
    JOIN index_keys   ik ON ik.indexrelid = i.indexrelid
   WHERE n.nspname = 'public'
     AND (i.indexprs IS NOT NULL OR i.indpred IS NOT NULL OR am.amname <> 'btree')
), array_columns AS (
  SELECT 3 AS section,
         format('array_column %s.%s %s not_null=%s default=%s',
                c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
                CASE WHEN a.attnotnull THEN 'true' ELSE 'false' END,
                COALESCE(pg_get_expr(d.adbin, d.adrelid, true), '-')) AS line
    FROM pg_attribute a
    JOIN pg_class        c ON c.oid = a.attrelid
    JOIN pg_namespace    n ON n.oid = c.relnamespace
    JOIN pg_type         t ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND a.attnum > 0 AND NOT a.attisdropped
     AND t.typcategory = 'A'
), collected AS (
            SELECT section, line FROM generated_columns
  UNION ALL SELECT section, line FROM hand_managed_indexes
  UNION ALL SELECT section, line FROM array_columns
), normalised AS (
  SELECT section, regexp_replace(line, '\s+', ' ', 'g') AS line FROM collected
)
SELECT line FROM normalised ORDER BY section, line COLLATE "C";
-- >>> END pg-catalog-query

-- >>> BEGIN pg-catalog-expected
-- One generated column: the STORED search_vector expression.
generated_column catalog_foods.search_vector tsvector stored to_tsvector('english'::regconfig, COALESCE(search_text, ''::text))
-- Seven hand-managed indexes: the lower(alias) expression index, the GIN
-- index over search_vector, and the five partial-index predicates.
index catalog_food_aliases.idx_catalog_food_aliases_lower_alias am=btree unique=false keys=(lower(alias)) opclasses=(text_pattern_ops) predicate=-
index catalog_food_portions.unique_default_catalog_food_portion am=btree unique=true keys=(catalog_food_id) opclasses=(uuid_ops) predicate=is_default
index catalog_foods.idx_catalog_foods_search_vector am=gin unique=false keys=(search_vector) opclasses=(tsvector_ops) predicate=-
index catalog_foods.unique_published_catalog_food_identity am=btree unique=true keys=(canonical_name, food_state) opclasses=(text_ops, text_ops) predicate=publication_status = 'published'::text
index meal_entries.idx_meal_entries_meal_plan_meal_id am=btree unique=false keys=(meal_plan_meal_id) opclasses=(uuid_ops) predicate=deleted_at IS NULL
index meal_plans.unique_active_meal_plan_start_date am=btree unique=true keys=(user_id, start_date) opclasses=(text_ops, date_ops) predicate=status = 'active'::text
index recipe_versions.unique_current_recipe_version am=btree unique=true keys=(recipe_id) opclasses=(uuid_ops) predicate=status = 'current'::text
-- Thirteen array columns: the twelve required TEXT[]/UUID[] columns the
-- migration marks NOT NULL by hand, plus templates.exercise_ids from the
-- init migration, which is legacy and correctly pinned nullable.
array_column catalog_foods.allergen_tags text[] not_null=true default=ARRAY[]::text[]
array_column catalog_foods.diet_tags text[] not_null=true default=ARRAY[]::text[]
array_column catalog_validation_records.aliases text[] not_null=true default=ARRAY[]::text[]
array_column meal_plan_preferences.allergens text[] not_null=true default=ARRAY[]::text[]
array_column meal_plan_preferences.disliked_food_groups text[] not_null=true default=ARRAY[]::text[]
array_column meal_plan_preferences.disliked_food_ids uuid[] not_null=true default=ARRAY[]::uuid[]
array_column recipe_ingredients.snapshot_allergen_tags text[] not_null=true default=ARRAY[]::text[]
array_column recipe_ingredients.snapshot_diet_tags text[] not_null=true default=ARRAY[]::text[]
array_column recipe_versions.allergen_tags text[] not_null=true default=ARRAY[]::text[]
array_column recipe_versions.badges text[] not_null=true default=ARRAY[]::text[]
array_column recipe_versions.diet_tags text[] not_null=true default=ARRAY[]::text[]
array_column recipe_versions.meal_slots text[] not_null=true default=-
array_column templates.exercise_ids text[] not_null=false default=-
-- >>> END pg-catalog-expected
