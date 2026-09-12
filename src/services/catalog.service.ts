// The read side of the internal food catalog: the three `GET /api/catalog/*`
// use cases — full-text search over published foods, the dislike-suggestion
// chips, and the operator status report.
//
// Orchestration only (Rule backend-architecture §5). Every decision this file
// needs already belongs to a neighbour and is delegated to it:
//
//  * `catalog.logic.ts` owns the rules. `parseCatalogSearchQuery` validates
//    `?q=` and is called by the CONTROLLER, not here — a 2-to-60-character
//    bound is a request-validation verdict (§4), and a service that re-decided
//    it would own the rule twice. `q` arrives already trimmed and bounded.
//  * `catalog.mapper.ts` owns the row -> DTO boundary, including the closed-set
//    narrowing of every TEXT code column. No response shape is assembled here.
//  * `utils/pagination.ts` owns the pagination block and the `limit` cap, both
//    at the controller boundary. This file returns `{items, total}` and never
//    the `{page, limit, total, totalPages}` envelope (§4).
//
// THE ONE SANCTIONED EXCEPTION TO §5.1. Rule backend-architecture §5.1 requires
// `user_id` in every `where`; the reads below carry no tenant predicate,
// deliberately, because `catalog_foods` and its child tables hold no `user_id`
// at all. The catalog is shared reference data — the same ten thousand foods
// for every user — so there is no owner to scope to and no cross-user row to
// leak. These are the only authenticated reads in the backend without a tenant
// predicate; a synthetic user scope here would be fiction, not safety. Every
// other query in this folder carries the owner key, and a per-user catalog
// concept (a personal food) already has its own owned table, `foods`.
//
// The same exception is why no function below takes `userId` first, as §5's
// signature convention otherwise requires: that parameter exists to scope the
// query, and a parameter accepted only to be ignored would misrepresent these
// reads as owned. The routes are still authenticated — they mount after
// `authenticateFirebaseToken` — so the caller is known; the DATA simply is not
// theirs to begin with.
//
// WHAT THIS FILE DOES NOT DO, each for a stated reason:
//
//  * NO WRITES. The catalog is populated exclusively by the offline scripts
//    (`catalog-import-usda`, `catalog-generate-ai`, `catalog-validate`,
//    `catalog-load`). The request path is read-only, which is what makes
//    "search never mutates the catalog" a property of the architecture rather
//    than a convention.
//  * NO VENDOR CALL. Neither `usda.service.ts` nor `openrouter.service.ts` is
//    imported. After seeding, catalog search makes no live USDA or model call —
//    an explicit product guarantee, pinned by `src/__tests__/api/offline.test.ts`
//    with both API keys unset and the network mocked to throw.
//  * NO RECIPE READS. `recipe.service.ts::getRecipeVersionForUser` is the single
//    owner of recipe reads; `GET /api/recipes/:recipeVersionId` reaches it
//    through `catalog.controller.ts`. The only recipe column touched here is a
//    `COUNT` for the operator status report.
//  * NO FEATURE FLAG. `/catalog/*` is never gated — Add Food's catalog section
//    does not depend on meal planning — and the gate for `/recipes/*` is applied
//    by the controller through `utils/featureFlags.ts`.
//  * NO TYPED ERROR OF ITS OWN. None of the three use cases has a failure the
//    client must distinguish: an unmatched search is an empty page, an empty
//    suggestion set is an empty list, and a catalog with no release loaded
//    reports nulls. The one fault that can occur is a stored row contradicting
//    the response contract, which is `catalog.mapper.ts`'s `CatalogMappingError`
//    and belongs to that boundary.
//
// THIS SERVICE IS A MEASURED UNIT. `scripts/search-benchmark.ts` times
// `searchPublishedFoods` IN PROCESS, so the p50/p95 it reports is the search
// itself with no HTTP round trip. Nothing here may add per-call work that is not
// part of answering the query: no warm-up, no memoisation, no cache, and no
// logging in the hot path.

import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import {
    CatalogFoodResponse,
    CatalogPublicationStatus,
    CatalogStatusResponse,
    CatalogSuggestionsResponse,
} from '../types/catalog';
import {
    CatalogFoodPortionRow,
    CatalogFoodRow,
    CatalogReleaseRunRow,
    CatalogStatusCounts,
    mapCatalogFood,
    mapCatalogStatus,
    mapCatalogSuggestion,
} from './catalog.mapper';

/* ---------------------------------------------------------------------------
 * What the catalog considers visible
 * ------------------------------------------------------------------------- */

/**
 * The only status a read below will surface. `candidate`, `quarantined` and
 * `rejected` have never been published; `retired` was published once and a
 * newer release no longer contains it.
 *
 * `retired` IS NOT `deleted`, and the distinction is why this single predicate
 * is correct rather than merely convenient: a retired row keeps its primary key
 * so the `recipe_ingredients` and `meal_entries` foreign keys that reference it
 * still resolve and a historical recipe or diary entry stays readable, while the
 * food stops being findable in search, in the suggestion chips and in new
 * recipe eligibility. Filtering on `published` gets both halves right at once.
 */
const PUBLISHED: CatalogPublicationStatus = 'published';

/**
 * The text-search configuration, which MUST equal the one the generated column
 * uses: `prisma/migrations/20260908000000_meal_planning/migration.sql` defines
 * `search_vector` as
 * `to_tsvector('english', coalesce(search_text, '')) STORED`. A query built with
 * a different configuration would stem differently from the stored vector and
 * silently under-match, so it is written once and reused for the alias vectors
 * and the query itself.
 */
const TEXT_SEARCH_CONFIG = 'english';

/**
 * The rank a prefix-only match contributes.
 *
 * `ts_rank` is strictly positive for a real full-text hit, so zero places every
 * prefix match below every stemmed match — the ordering a user expects when
 * they have typed a partial word. Prefix matches then order among themselves by
 * the name and `source_key` tiebreakers, which are total, so the page stays
 * deterministic even when nothing matched on meaning.
 */
const PREFIX_MATCH_RANK = 0;

/**
 * `LIKE` metacharacters, escaped before a caller's text becomes a pattern.
 *
 * Not cosmetic: a `q` of `%` builds the pattern `%%`, which matches every
 * published row and turns a search into a full-catalog scan. Backslash is
 * `LIKE`'s default escape character and the pattern is a bound parameter, so
 * escaping the three characters here is the whole fix. This is SQL-pattern
 * mechanics that cannot be separated from the statement below, not a business
 * rule that belongs in `catalog.logic.ts`.
 */
const LIKE_METACHARACTERS = /[\\%_]/g;

/* ---------------------------------------------------------------------------
 * Search
 * ------------------------------------------------------------------------- */

/**
 * What one page of search results is, before it becomes a wire shape.
 *
 * `total` is the size of the whole match set, not of `items`, and the controller
 * turns it into the `pagination` block with `toPaginationBlock` — the same split
 * `food.service.ts` and `food.controller.ts` already use for `GET /api/foods`.
 */
export interface CatalogSearchResult {
    items: CatalogFoodResponse[];
    total: number;
}

/**
 * The match set: every published food that matches `q`, with each food's own
 * best contribution, before ranking or paging.
 *
 * Built once and shared by both statements of a search, which is the point of
 * extracting it. The page and the count must describe the SAME set — a count
 * computed from a differently-worded predicate is a `totalPages` that lies and a
 * client that pages into an empty result — and the only way to guarantee that is
 * one definition with two tails. It is a parameterised `Prisma.Sql` fragment, so
 * composition keeps `q` a bound parameter and never becomes string building.
 *
 * FOUR CONTRIBUTIONS, EACH FOR A REASON THE OTHERS CANNOT COVER:
 *
 *  1. The food's own `search_vector` — the STORED generated column, read
 *     through the GIN index. This is the ordinary relevance path, and it is what
 *     makes plurals work: `plainto_tsquery` stems "mushrooms" to `mushroom` and
 *     matches a vector built from "Mushrooms, white".
 *  2. Every alias, scored on the fly. Aliases carry no tsvector column of their
 *     own, so their vector is computed per row; a LATERAL binds it once so the
 *     `@@` test and the `ts_rank` do not each recompute it. This branch is
 *     load-bearing rather than redundant: it is what lets a food be found by a
 *     word that appears in none of its own columns — "eggplant" reaching
 *     "Aubergine" — and nothing guarantees a food's `search_text` repeats its
 *     aliases.
 *  3. and 4. A prefix fallback over the food's names and over its aliases. A
 *     stemmed query has no prefix semantics at all, so a two-character `q` such
 *     as "mu" matches NOTHING through 1 or 2 while a user is still typing. The
 *     comparison is written `lower(col) LIKE pattern` rather than `col ILIKE`
 *     because that is the form able to use the committed
 *     `idx_catalog_food_aliases_lower_alias` index, and left-anchored because a
 *     prefix is what the index can serve; an interior whole word is already
 *     covered by 1 and 2, which tokenise every word of the text.
 *
 * The alias branches read the whole published alias set for a query, because the
 * schema declares no GIN index over aliases and a trigram index would need
 * `CREATE EXTENSION pg_trgm`, which this schema deliberately does not use. That
 * cost is stated here rather than hidden, and it is what
 * `npm run search:benchmark` measures against the p95 threshold.
 */
const catalogMatchSet = (q: string): Prisma.Sql => {
    const prefixPattern = `${q.toLowerCase().replace(LIKE_METACHARACTERS, '\\$&')}%`;

    return Prisma.sql`
        WITH search AS (
            SELECT
                plainto_tsquery(${TEXT_SEARCH_CONFIG}::regconfig, ${q}) AS tsq,
                ${prefixPattern} AS prefix
        ),
        contributions AS (
            SELECT f.id, ts_rank(f.search_vector, s.tsq) AS rank
            FROM catalog_foods f
            CROSS JOIN search s
            WHERE f.publication_status = ${PUBLISHED}
                AND f.search_vector @@ s.tsq

            UNION ALL

            SELECT f.id, ${PREFIX_MATCH_RANK}::real AS rank
            FROM catalog_foods f
            CROSS JOIN search s
            WHERE f.publication_status = ${PUBLISHED}
                AND (lower(f.display_name) LIKE s.prefix OR lower(f.canonical_name) LIKE s.prefix)

            UNION ALL

            SELECT a.catalog_food_id AS id, ts_rank(alias_vector.value, s.tsq) AS rank
            FROM catalog_food_aliases a
            JOIN catalog_foods f ON f.id = a.catalog_food_id
            CROSS JOIN search s
            CROSS JOIN LATERAL (
                SELECT to_tsvector(${TEXT_SEARCH_CONFIG}::regconfig, a.alias) AS value
            ) alias_vector
            WHERE f.publication_status = ${PUBLISHED}
                AND alias_vector.value @@ s.tsq

            UNION ALL

            SELECT a.catalog_food_id AS id, ${PREFIX_MATCH_RANK}::real AS rank
            FROM catalog_food_aliases a
            JOIN catalog_foods f ON f.id = a.catalog_food_id
            CROSS JOIN search s
            WHERE f.publication_status = ${PUBLISHED}
                AND lower(a.alias) LIKE s.prefix
        )
    `;
};

/**
 * One ranked page of matching foods.
 *
 * ONE ROW PER FOOD, WHATEVER MATCHED. `contributions` yields one row per
 * matching name and per matching alias, so a food with four matching aliases
 * appears five times; `MAX(rank) ... GROUP BY id` collapses that to a single row
 * and, in the same step, decides the food's rank by its BEST contribution — so
 * the closest-matching alias is what ranks the food. Without the aggregation
 * "Mushrooms, white" would occupy four of the twenty-five slots on page one and
 * the total would count it four times.
 *
 * THE ORDER IS TOTAL AND PORTABLE: `rank DESC, display_name ASC, source_key
 * ASC`. The `source_key` tiebreaker is load-bearing rather than decorative —
 * primary keys are `gen_random_uuid()` and therefore differ between two
 * independently loaded databases, so an order that fell back to `id` would
 * produce different page sequences on two machines holding the same release, and
 * a row could be both skipped and repeated across pages. `source_key` is
 * deterministic (`usda:<fdcId>` / `ai:<category>:<name>:<state>`), which is what
 * makes pagination stable and lets the benchmark evidence release determinism by
 * comparing two freshly loaded databases.
 */
const selectSearchPage = (matchSet: Prisma.Sql, limit: number, offset: number) =>
    prisma.$queryRaw<CatalogFoodRow[]>`
        ${matchSet},
        ranked AS (
            SELECT id, MAX(rank) AS rank
            FROM contributions
            GROUP BY id
        )
        SELECT
            f.id,
            f.display_name,
            f.category,
            f.food_state,
            f.identity_source,
            f.nutrition_provenance,
            f.nutrition_basis,
            f.basis_amount,
            f.calories,
            f.protein_g,
            f.carbs_g,
            f.fat_g,
            f.fiber_g,
            f.allergen_tags,
            f.allergen_status,
            f.food_group
        FROM ranked r
        JOIN catalog_foods f ON f.id = r.id
        ORDER BY r.rank DESC, f.display_name ASC, f.source_key ASC
        LIMIT ${limit} OFFSET ${offset}
    `;

/**
 * The size of the whole match set.
 *
 * `COUNT(DISTINCT id)` over the same contributions the page is built from, so it
 * counts the DE-DUPLICATED set the client will actually be paged through and not
 * the pre-aggregation join rows.
 */
const countSearchMatches = (matchSet: Prisma.Sql) =>
    prisma.$queryRaw<{ count: bigint }[]>`
        ${matchSet}
        SELECT COUNT(DISTINCT id) AS count FROM contributions
    `;

/**
 * The default portions of one page of foods, grouped by food.
 *
 * A partial unique index allows at most one `is_default` portion per food, so
 * this returns one row per food that has one. Only the default is fetched
 * because that is the only portion `CatalogFoodResponse` exposes — the rest
 * inform conversions the server performs elsewhere, and a measured search should
 * not carry them.
 *
 * A food whose default portion is missing is left with an empty list rather than
 * patched here: `mapCatalogFood` raises `CatalogMappingError` for it, which is
 * the correct outcome, because validation quarantines a candidate without a
 * portion of known gram weight and the alternative is inventing the gram weight
 * every recipe and grocery quantity would then be computed from.
 */
const defaultPortionsByFood = async (
    foodIds: readonly string[],
): Promise<Map<string, CatalogFoodPortionRow[]>> => {
    const portions = await prisma.catalog_food_portions.findMany({
        where: { catalog_food_id: { in: [...foodIds] }, is_default: true },
        select: {
            catalog_food_id: true,
            description: true,
            amount: true,
            unit: true,
            gram_weight: true,
            is_default: true,
        },
    });

    const byFood = new Map<string, CatalogFoodPortionRow[]>();
    for (const { catalog_food_id, ...portion } of portions) {
        const forFood = byFood.get(catalog_food_id) ?? [];
        forFood.push(portion);
        byFood.set(catalog_food_id, forFood);
    }

    return byFood;
};

/**
 * `GET /api/catalog/foods` — one page of published catalog foods matching `q`.
 *
 * `q` is expected trimmed and within the bounds `parseCatalogSearchQuery`
 * enforces at the controller; an out-of-range query is that parser's verdict and
 * never an exception from here. A caller that passes no search term at all gets
 * an empty page without a query being issued, because an empty prefix pattern is
 * the match-all `%` and returning the entire catalog is the one answer that
 * would be wrong in every case.
 *
 * `limit` IS ACCEPTED AS GIVEN AND DELIBERATELY NOT CLAMPED. `MAX_LIMIT` lives
 * in `utils/pagination.ts` and is applied by the controller, so the HTTP route
 * caps a page at 50 while this function does not: `scripts/search-benchmark.ts`
 * reads a single `limit=75` reference page in process to prove that pages 1 to 3
 * at `limit=25` concatenate to it with no duplicate and no missing id. A clamp
 * here would silently truncate that reference and make the pagination check pass
 * vacuously.
 */
export const searchPublishedFoods = async (
    q: string,
    page: number,
    limit: number,
): Promise<CatalogSearchResult> => {
    if (q.trim().length === 0) {
        return { items: [], total: 0 };
    }

    const matchSet = catalogMatchSet(q.trim());
    // The offset belongs to whoever runs the query, which `utils/pagination.ts`
    // states explicitly. Floored at zero because PostgreSQL rejects a negative
    // OFFSET outright: `parsePagination` already guarantees `page >= 1`, so this
    // only keeps a direct caller's bad page from becoming a 500. It is a floor
    // on the offset, NOT a cap on `limit` — see the note above.
    const offset = Math.max(0, (page - 1) * limit);

    const [rows, totals] = await Promise.all([
        selectSearchPage(matchSet, limit, offset),
        countSearchMatches(matchSet),
    ]);

    const portions = await defaultPortionsByFood(rows.map((row) => row.id));

    return {
        // Mapped in the order the statement returned, so the ranking survives:
        // the portion lookup is keyed by id and must not reorder the page.
        items: rows.map((row) => mapCatalogFood(row, portions.get(row.id) ?? [])),
        total: Number(totals[0]?.count ?? 0),
    };
};

/* ---------------------------------------------------------------------------
 * Suggestions
 * ------------------------------------------------------------------------- */

/**
 * The kinds of suggestion the catalog can offer. One value today — the dislike
 * chips on the food-preferences step — and it stays a parameter so that a
 * second kind is an added row in {@link SUGGESTION_FILTERS} rather than a new
 * endpoint.
 */
export type CatalogSuggestionKind = 'dislike';

/**
 * Which published foods each kind draws from.
 *
 * `is_common_dislike` is a curated hint carried by the coverage plan and loaded
 * with the release, not a computed property, so selecting a kind is a lookup
 * rather than a rule — and the `(is_common_dislike, publication_status)` index
 * exists for exactly this predicate, which is why the flag leads it.
 */
const SUGGESTION_FILTERS: Record<CatalogSuggestionKind, Prisma.catalog_foodsWhereInput> = {
    dislike: { is_common_dislike: true },
};

/**
 * `GET /api/catalog/foods/suggestions` — the chips shown beside the food-search
 * field, so a user can decline a common ingredient without searching for it.
 *
 * The order is stable and portable for the same reason the search page's is:
 * `display_name` then `source_key`, never the `gen_random_uuid()` primary key,
 * so two databases holding the same release offer the same chips in the same
 * order. Without a total order a re-render could reshuffle the chips under the
 * user's finger.
 *
 * `limit` is accepted as given, as in {@link searchPublishedFoods}: the cap
 * belongs to `parsePagination` at the controller.
 */
export const getSuggestions = async (
    kind: CatalogSuggestionKind,
    limit: number,
): Promise<CatalogSuggestionsResponse> => {
    const foods = await prisma.catalog_foods.findMany({
        where: { publication_status: PUBLISHED, ...SUGGESTION_FILTERS[kind] },
        orderBy: [{ display_name: 'asc' }, { source_key: 'asc' }],
        take: limit,
        select: { id: true, display_name: true, food_group: true },
    });

    return { items: foods.map(mapCatalogSuggestion) };
};

/* ---------------------------------------------------------------------------
 * Operator status
 * ------------------------------------------------------------------------- */

/**
 * The two columns that identify the active release load, and the status the
 * run must have reached to count.
 *
 * THE ACTIVE-RELEASE RULE IS OWNED ELSEWHERE AND MIRRORED HERE. The active
 * catalog release is the newest `catalog_import_runs` row with
 * `kind = 'release_load'` and `status = 'succeeded'`; `scripts/lib/checkpoint.ts`
 * owns that definition (`RELEASE_LOAD_RUN_KIND`, `getActiveReleaseLoad`) and
 * documents why this file re-implements it instead of importing it: the
 * dependency direction is one-way — `scripts/` imports `../src/*`, never the
 * reverse — and `.dockerignore` keeps `scripts/` out of the runtime image, so
 * an import reaching from `src/` into `scripts/` would break the very build the
 * API ships in. The duplication is therefore deliberate and load-bearing: if
 * the two ever disagree, the operator-facing pointer and this endpoint disagree
 * about which catalog is live, so a change to one is a change to both.
 *
 * Nothing but a succeeded load reaches this state, which is what makes a failed
 * or partial load harmless — the previous release simply stays active.
 */
const RELEASE_LOAD_RUN_KIND = 'release_load';
const RUN_STATUS_SUCCEEDED = 'succeeded';

/** The statuses reported beside the published count, as a validation breakdown. */
const QUARANTINED: CatalogPublicationStatus = 'quarantined';
const REJECTED: CatalogPublicationStatus = 'rejected';

/**
 * A recipe version that planning may currently use. A partial unique index
 * allows one per recipe, so counting these counts distinct usable recipes —
 * which is the number the release gate checks, and the reason the count is not
 * over `recipes`: a row there whose `current_version_id` is null has no
 * plannable version and must not inflate the gate.
 */
const CURRENT_RECIPE_VERSION_STATUS = 'current';

/**
 * `GET /api/catalog/status` — which release is loaded, when, and how the
 * catalog breaks down.
 *
 * OPERATOR AND ACCEPTANCE EVIDENCE ONLY: this endpoint has no mobile consumer.
 * It is what the release checklist queries to confirm
 * `publishedCount >= 10,000` and `recipeCount >= 40` BEFORE
 * `MEAL_PLANNING_ENABLED` is switched on, and what a post-deploy verification
 * reads to confirm the expected release is live. It is therefore deliberately
 * cheap — five aggregates and one indexed row, never a row dump — because a
 * diagnostic that is expensive to run is one nobody runs at the moment it
 * matters.
 *
 * Every count is a separate aggregate rather than a grouped scan so that each
 * one is independently readable, and all six reads are issued concurrently.
 */
export const getStatus = async (): Promise<CatalogStatusResponse> => {
    const [releaseLoad, publishedCount, quarantinedCount, rejectedCount, recipeCount] =
        await Promise.all([
            prisma.catalog_import_runs.findFirst({
                where: { kind: RELEASE_LOAD_RUN_KIND, status: RUN_STATUS_SUCCEEDED },
                orderBy: { started_at: 'desc' },
                select: { manifest_version: true, finished_at: true, started_at: true },
            }),
            prisma.catalog_foods.count({ where: { publication_status: PUBLISHED } }),
            prisma.catalog_foods.count({ where: { publication_status: QUARANTINED } }),
            prisma.catalog_foods.count({ where: { publication_status: REJECTED } }),
            prisma.recipe_versions.count({ where: { status: CURRENT_RECIPE_VERSION_STATUS } }),
        ]);

    const counts: CatalogStatusCounts = {
        publishedCount,
        quarantinedCount,
        rejectedCount,
        recipeCount,
    };

    // `manifest_version` carries the release id for a release_load run ('v1' for
    // data/meal-planning/catalog/releases/v1) and is what `catalogRelease`
    // reports. `finished_at` falls back to `started_at` for the same reason
    // `getActiveReleaseLoad` does: the two are written in one statement when a
    // run succeeds, so the fallback keeps `lastLoadedAt` non-null rather than
    // describing a state that occurs. Both are null before any release is
    // loaded, which is the one state the nullable members of the response
    // describe.
    const activeRelease: CatalogReleaseRunRow | null = releaseLoad
        ? {
              manifest_version: releaseLoad.manifest_version,
              finished_at: releaseLoad.finished_at ?? releaseLoad.started_at,
          }
        : null;

    return mapCatalogStatus(activeRelease, counts);
};
