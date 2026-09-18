-- Supplementary schema-drift evidence for the meal-planning schema: what the
-- migration ledger holds that `prisma migrate diff` cannot see, read back out
-- of the database's own catalogs and compared against a reviewed expected
-- result.
--
-- Nothing applies this file. The executed ledger is prisma/migrations, whose
-- meal-planning DDL is 20260908000000_meal_planning/migration.sql and whose
-- catalog indexes are completed by 20260910000000_catalog_prefix_fold_indexes;
-- the captured migrate-diff evidence of it is
-- docs/meal-planning/expected-schema-diff.sql, and this file is the second
-- capture that one cannot make. Together they are
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
-- datamodel cannot express: the generated search_vector expression, the alias
-- expression index on catalog_food_aliases, and the partial indexes'
-- predicates. Measured against prisma 6.9.0 it carries only the first.
-- Prisma's schema describer leaves expression indexes, index predicates and
-- scalar-list NOT NULL out of both sides of its comparison, so deleting an
-- expression index, changing a partial index's predicate, or dropping NOT
-- NULL from a required array column each leave that output and its exit code
-- untouched.
--
-- The alias index the plan names as `lower(alias)` is now the ASCII fold
-- `translate(alias, 'ABC...', 'abc...')`, and the same fold is indexed over
-- catalog_foods.display_name and .canonical_name. That is not drift from the
-- plan but the other half of it: 0.9.3 requires two independently loaded
-- databases to produce identical ranks and page sequences, and `lower()`
-- resolves through the database's collation while the JavaScript side of the
-- same comparison does not, so the prefix branch of catalog.service.ts found a
-- food carrying a non-ASCII capital on one server and not on another.
-- prisma/migrations/20260910000000_catalog_prefix_fold_indexes carries the
-- reasoning in full. That is a recorded AAP-versus-tool divergence, and the sections
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
-- pg_get_indexdef functions that format their contents.
--
-- CI renders it with a small node + `pg` helper rather than with psql, and the
-- reason is not availability: `ubuntu-latest` ships the PostgreSQL 16 client
-- tools. The helper is the right instrument because it depends on no
-- image-provided tooling at all - it uses the `pg` package this repository
-- already installs, so the gate cannot break on a runner image that drops or
-- moves a client binary - and because it can ASSERT ON THE SHAPE of the result,
-- which `psql -tA` cannot: it runs the committed section inside
-- `BEGIN TRANSACTION READ ONLY` so a write introduced into it fails instead of
-- reaching the database, and it refuses the section unless it is ONE statement
-- (`pg` answers several with an array of results) whose result carries exactly
-- one field descriptor, named `line`, of PostgreSQL type `text` (OID 25) - read
-- from the result's own descriptors, so selecting `line` beside a second column
-- is refused rather than rendered - and unless every value under it really is
-- text (a text column still yields null for a NULL). Each of those is a way the
-- evidence could quietly stop measuring what it claims to, and each refusal
-- names the condition that failed and what it found. Its output is
-- byte-identical to `psql -tA` - one row per line, one trailing newline - so
-- the regeneration command above and the gate compare the same bytes.
--
-- WHY THE OPERATOR CLASS IS READ SEPARATELY. `pg_get_indexdef(oid, k, ...)`
-- renders the k-th key expression and OMITS its operator class - measured at
-- both pretty=true and pretty=false - so an index's class is invisible in
-- key_text. That is not cosmetic here: idx_catalog_food_aliases_fold_alias is
-- declared `translate(alias, 'ABC...', 'abc...') text_pattern_ops` - and so are
-- the two catalog_foods indexes over the same fold - because a btree derives
-- LIKE range bounds only under a `*_pattern_ops` class or a C column
-- collation, and under
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
-- src/__tests__/api/compat.test.ts. That gate measures the copy twice - against
-- 20260908000000_meal_planning alone, on a database carrying the init schema
-- plus one file and nothing later, which is the only place the copy's own
-- reproduction of a construct a later entry then retires can be seen; and
-- against the whole ledger in both of 0.9.1's orders, on columns, indexes,
-- constraints and a normalised pg_dump. All three artefacts are complementary -
-- a ledger-against-ledger comparison cannot see a construct missing from both,
-- and neither comparison can see a construct a later entry breaks, which is
-- precisely what these sections catch.
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
-- hand-edited - so deleting evidence lines cannot buy a pass either. Those
-- three counts are FLOORS: the section carries nine indexes since the prefix
-- fold indexes landed, and a larger set passes while a smaller one cannot.
--
-- Captured against prisma and @prisma/client 6.9.0 on PostgreSQL 16.15, ledger
-- prisma/migrations through 20260910000000_catalog_prefix_fold_indexes.

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
-- Nine hand-managed indexes: the three ASCII-fold expression indexes the
-- prefix branches read (the two over catalog_foods partial on
-- publication_status), the GIN index over search_vector, and the five other
-- partial-index predicates.
index catalog_food_aliases.idx_catalog_food_aliases_fold_alias am=btree unique=false keys=(translate(alias, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'::text, 'abcdefghijklmnopqrstuvwxyz'::text)) opclasses=(text_pattern_ops) predicate=-
index catalog_food_portions.unique_default_catalog_food_portion am=btree unique=true keys=(catalog_food_id) opclasses=(uuid_ops) predicate=is_default
index catalog_foods.idx_catalog_foods_fold_canonical_name am=btree unique=false keys=(translate(canonical_name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'::text, 'abcdefghijklmnopqrstuvwxyz'::text)) opclasses=(text_pattern_ops) predicate=publication_status = 'published'::text
index catalog_foods.idx_catalog_foods_fold_display_name am=btree unique=false keys=(translate(display_name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'::text, 'abcdefghijklmnopqrstuvwxyz'::text)) opclasses=(text_pattern_ops) predicate=publication_status = 'published'::text
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
