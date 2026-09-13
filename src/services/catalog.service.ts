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
//  * `utils/pagination.ts` owns the offset scheme end to end: the
//    `{page, limit, total, totalPages}` envelope and the per-route `limit` cap
//    at the controller boundary, and `rowWindowFor` — the bounded `LIMIT` and
//    `OFFSET` a paged statement runs with — here, so request input is turned
//    into query arithmetic in one audited place rather than per service. This
//    file returns `{items, total}` and never the envelope (§4).
//
// A SANCTIONED EXCEPTION TO §5.1. Rule backend-architecture §5.1 requires
// `user_id` in every `where`; the reads below carry no tenant predicate,
// deliberately, because `catalog_foods` and its child tables hold no `user_id`
// at all. The catalog is shared reference data — the same rows for every user,
// loaded from a reviewed release — so there is no owner to scope to and no
// cross-user row to leak. A synthetic user scope here would be fiction, not
// safety. A per-user catalog concept (a personal food) already has its own
// owned table, `foods`, and every meal-planning query that touches a
// user-owned table does carry the owner key — but that is a statement about
// meal planning and nothing wider. This file makes no claim about
// `src/services` as a whole, because two queries there would contradict it; see
// the accounting immediately below.
//
// Within meal planning these catalog reads, and the recipe reads that belong to
// `recipe.service.ts`, are the only authenticated reads without a tenant
// predicate. They are NOT the only untenanted queries in the backend, and the
// difference matters to anyone auditing §5.1. Two pre-existing ones are
// legitimate and are recorded here so this comment cannot be read as erasing
// them:
//
//  * `usda.service.ts` reads `usda_api_cache` by `cache_key` alone while
//    serving the authenticated `GET /api/macros/search-branded-foods` and
//    `GET /api/macros/branded-food/:foodId`, because a cached vendor response
//    has no owner either. Same shape of exception as this file's, same
//    justification.
//  * `food.service.ts::updateFood` resolves the row with an owner-scoped
//    `findFirst` and then issues its `update` by `id` alone. The authorization
//    is real — a foreign id never reaches the update — but the WRITE predicate
//    itself carries no `user_id`, so it is not an example of the rule being
//    met, and citing it as one would be wrong. It is shipped behaviour this
//    feature does not touch.
//
// Any further untenanted query is a new exception and needs its own
// justification.
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
//    imported, so after seeding catalog search cannot make a live USDA or model
//    call — an explicit product guarantee, and at this checkpoint a structural
//    one: the import list below is the whole of the proof. The end-to-end proof
//    planned for it, `src/__tests__/api/offline.test.ts` with both API keys
//    unset and the network mocked to throw (AAP §0.9.2), is not in this
//    checkout, so nothing here may be read as measured offline behaviour.
//  * NO RECIPE READS. The only recipe column touched here is a `COUNT` for the
//    operator status report. Recipe reads belong to
//    `recipe.service.ts::getRecipeVersionForUser` as their single owner, which
//    `GET /api/recipes/:recipeVersionId` is to reach through
//    `catalog.controller.ts` — planned wiring (AAP §0.7.1 Groups 3 and 4), not
//    present wiring: neither of those modules exists in this checkout, `app.ts`
//    mounts no catalog router, and nothing calls the three functions below yet.
//    This file is written to that contract so the chain reads
//    `catalog.routes → catalog.controller → recipe.service` the moment the two
//    land, and so no recipe query is ever added or re-exported here.
//  * NO FEATURE FLAG. `/catalog/*` is never gated — Add Food's catalog section
//    does not depend on meal planning — and the gate for `/recipes/*` belongs to
//    that same controller, through `utils/featureFlags.ts`, once it exists.
//  * NO TYPED ERROR OF ITS OWN. None of the three use cases has a failure the
//    client must distinguish: an unmatched search is an empty page, an empty
//    suggestion set is an empty list, and a catalog with no release loaded
//    reports nulls. The one fault that can occur is a stored row contradicting
//    the response contract, which is `catalog.mapper.ts`'s `CatalogMappingError`
//    and belongs to that boundary.
//
// THIS SERVICE IS THE MEASURED UNIT OF THE SEARCH BENCHMARK — BY CONTRACT, NOT
// YET BY MEASUREMENT. `data/meal-planning/search-benchmark.v1.json` names
// `catalog.service.searchPublishedFoods` as its `measuredUnit` and declares the
// protocol around it: one untimed warm-up pass, three timed passes, sequential,
// a single connection, timed in process so no HTTP round trip is included (AAP
// §0.9.3). `scripts/search-benchmark.ts` is the runner that contract belongs to,
// and at this checkpoint it validates its inputs and refuses with
// `stage_pipeline_pending` — it does not import this module, time anything or
// write a report — so NO p50/p95 figure for this service exists anywhere yet.
//
// The constraint that contract places on this file holds regardless of when the
// runner's measurement body lands, because it is what makes a later measurement
// mean anything: nothing here may add per-call work that is not part of
// answering the query — no warm-up, no memoisation, no cache, and no logging in
// the hot path. The one exception is deliberate and is the protocol's own: each
// use case opens a single transaction so its statements read one snapshot on one
// connection, which is both a correctness requirement (below) and the
// `sequential`/`connections: 1` execution the benchmark declares it measures.

import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import {
    CatalogFoodResponse,
    CatalogPublicationStatus,
    CatalogStatusResponse,
    CatalogSuggestionsResponse,
} from '../types/catalog';
import { rowWindowFor } from '../utils/pagination';
import {
    CatalogFoodPortionRow,
    CatalogFoodRow,
    CatalogReleaseRunRow,
    CatalogStatusCounts,
    CatalogSuggestionRow,
    mapCatalogFood,
    mapCatalogStatus,
    mapCatalogSuggestion,
} from './catalog.mapper';

/* ---------------------------------------------------------------------------
 * How a use case reads
 * ------------------------------------------------------------------------- */

/**
 * The client the statements of one use case run on.
 *
 * Always a transaction client, never the pool: the reads that make up a single
 * response have to agree with each other, and Prisma hands each independent
 * statement whatever connection is free, each with its own snapshot. A catalog
 * load publishing and retiring rows between two of them is not hypothetical —
 * `catalog-load.ts` is an ordinary operator command that can run while the API
 * serves traffic — and the result would be a page of twenty-five rows beside a
 * total taken from a different catalog: a `totalPages` that lies, a client that
 * pages into a gap, and an operator status report whose published count and
 * release pointer describe different moments.
 *
 * `Prisma.TransactionClient` is the pool client minus the methods a transaction
 * cannot offer (`$transaction`, `$connect`, `$disconnect`, …); `$queryRaw` and
 * the model delegates are all retained, so every read below is written exactly
 * as it would be against the pool.
 */
type SnapshotClient = Prisma.TransactionClient;

/**
 * How each use case opens that snapshot.
 *
 * REPEATABLE READ rather than the default READ COMMITTED because that is the
 * whole point: under READ COMMITTED every statement takes a fresh snapshot even
 * inside one transaction, so grouping them would buy the single connection and
 * none of the coherence. Under REPEATABLE READ the first statement fixes the
 * snapshot and the rest read it.
 *
 * These transactions are read-only and short — three indexed statements for a
 * search, five for the status report — so they take no locks a writer can queue
 * behind, and Prisma's default `timeout` applies unchanged. Statements inside
 * one are awaited SEQUENTIALLY: an interactive transaction is one connection, so
 * issuing them together would not parallelise anything, and it is also the
 * execution the benchmark protocol declares (`sequential: true`,
 * `connections: 1`).
 */
const SNAPSHOT_OPTIONS = {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
} as const;

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
 * ASC`, with both text keys sorted under an explicit collation. Two independent
 * things make it portable, and the order needs both:
 *
 *  1. `source_key` as the final key. Primary keys are `gen_random_uuid()` and
 *     therefore differ between two independently loaded databases, so an order
 *     that fell back to `id` would produce different page sequences on two
 *     machines holding the same release, and a row could be both skipped and
 *     repeated across pages. `source_key` is deterministic
 *     (`usda:<fdcId>` / `ai:<category>:<name>:<state>`), so it settles every tie
 *     the same way everywhere.
 *  2. `COLLATE "C"` on both text keys. Without it the comparison is the
 *     DATABASE's default collation, which is a property of how the database was
 *     created rather than of this release — and the orders genuinely differ.
 *     Measured on PostgreSQL 16 over five catalog-shaped names ('Beans, black',
 *     'Beans black', 'beans, green', 'Beans-lima', 'BEANS, navy'), `C` yields
 *     `BEANS, navy | Beans black | Beans, black | Beans-lima | beans, green`
 *     while `und-x-icu` — the default a database created with the ICU locale
 *     provider gets — yields
 *     `Beans black | Beans-lima | Beans, black | beans, green | BEANS, navy`.
 *     That is a different page sequence for the same catalog, which AAP §0.9.3
 *     forbids ("identical ranks and page sequences" on a second independently
 *     loaded database), and the `source_key` tiebreaker cannot rescue it because
 *     it is consulted only after `display_name` has already compared unequal —
 *     and would itself be collation-dependent for the same reason.
 *
 * `C` is byte order over the stored UTF-8, built into every PostgreSQL server
 * and needing no extension or locale to be installed, so it is available and
 * identical in every environment. Sorting by bytes rather than by language does
 * mean 'Zucchini' precedes 'apple'; that is the price of an order two machines
 * agree on, and the ordering contract in
 * `data/meal-planning/search-benchmark.v1.json` records it as the pinned choice.
 */
const selectSearchPage = (db: SnapshotClient, matchSet: Prisma.Sql, limit: number, offset: number) =>
    db.$queryRaw<CatalogFoodRow[]>`
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
        ORDER BY r.rank DESC, f.display_name COLLATE "C" ASC, f.source_key COLLATE "C" ASC
        LIMIT ${limit} OFFSET ${offset}
    `;

/**
 * The size of the whole match set.
 *
 * `COUNT(DISTINCT id)` over the same contributions the page is built from, so it
 * counts the DE-DUPLICATED set the client will actually be paged through and not
 * the pre-aggregation join rows. Run on the caller's snapshot client, so the
 * count describes the same catalog the page came from.
 */
const countSearchMatches = (db: SnapshotClient, matchSet: Prisma.Sql) =>
    db.$queryRaw<{ count: bigint }[]>`
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
    db: SnapshotClient,
    foodIds: readonly string[],
): Promise<Map<string, CatalogFoodPortionRow[]>> => {
    const portions = await db.catalog_food_portions.findMany({
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
 * `page` AND `limit` ARE BOUNDED, NOT CAPPED AT THE ROUTE'S NUMBERS.
 * `rowWindowFor` in `utils/pagination.ts` turns the pair into the `LIMIT` and
 * `OFFSET` this query runs with, and it is what keeps request input out of the
 * statement: `page` and `limit` arrive as text through Express, and
 * `(page - 1) * limit` on a twenty-digit page is a number PostgreSQL rejects for
 * `OFFSET` — a 500 from a query parameter. Deriving the window in the shared
 * helper rather than here means the bound holds for the HTTP path and for the
 * direct callers that never meet `parsePagination` alike.
 *
 * What it does NOT do is apply `MAX_LIMIT`. That cap is the HTTP contract (a
 * page of `GET /catalog/foods` is at most 50) and is applied by the controller,
 * because `scripts/search-benchmark.ts` reads a single `limit=75` reference page
 * in process to prove that pages 1 to 3 at `limit=25` concatenate to it with no
 * duplicate and no missing id. Capping at 50 here would silently truncate that
 * reference and make the pagination check pass vacuously, which is why
 * `rowWindowFor`'s own guard (`MAX_ROWS`) sits far above the route's cap.
 *
 * THE THREE STATEMENTS READ ONE SNAPSHOT. Page, total and default portions are a
 * single answer: the total describes the set the page came from, and every
 * returned food must have the portion that food actually has. Read through
 * separate pool connections they can straddle a catalog load, so they run
 * sequentially inside one REPEATABLE READ transaction — see {@link
 * SnapshotClient} for what that prevents and {@link SNAPSHOT_OPTIONS} for why
 * that isolation level.
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
    const { limit: rowLimit, offset } = rowWindowFor(page, limit);

    return prisma.$transaction(async (db) => {
        const rows = await selectSearchPage(db, matchSet, rowLimit, offset);
        const totals = await countSearchMatches(db, matchSet);
        const portions = await defaultPortionsByFood(
            db,
            rows.map((row) => row.id),
        );

        return {
            // Mapped in the order the statement returned, so the ranking
            // survives: the portion lookup is keyed by id and must not reorder
            // the page.
            items: rows.map((row) => mapCatalogFood(row, portions.get(row.id) ?? [])),
            total: Number(totals[0]?.count ?? 0),
        };
    }, SNAPSHOT_OPTIONS);
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
 * Which published foods each kind draws from, as the predicate its statement
 * carries.
 *
 * `is_common_dislike` is a curated hint carried by the coverage plan and loaded
 * with the release, not a computed property, so selecting a kind is a lookup
 * rather than a rule — and the `(is_common_dislike, publication_status)` index
 * exists for exactly this predicate, which is why the flag leads it.
 *
 * A `Prisma.Sql` fragment rather than a `catalog_foodsWhereInput` because the
 * statement below has to be raw (see {@link getSuggestions}); it is a
 * parameterised fragment, so composing it keeps every value a bound parameter.
 */
const SUGGESTION_FILTERS: Record<CatalogSuggestionKind, Prisma.Sql> = {
    dislike: Prisma.sql`f.is_common_dislike = true`,
};

/**
 * `GET /api/catalog/foods/suggestions` — the chips shown beside the food-search
 * field, so a user can decline a common ingredient without searching for it.
 *
 * The order is stable and portable for the same reasons the search page's is,
 * and needs the same two devices: `display_name` then `source_key` rather than
 * the `gen_random_uuid()` primary key, and `COLLATE "C"` on both so the sequence
 * is a property of the release and not of the collation the database happened to
 * be created with. Without a total order a re-render could reshuffle the chips
 * under the user's finger; without the explicit collation two databases holding
 * one release could offer the same chips in different orders.
 *
 * WRITTEN RAW FOR THAT COLLATION, and for nothing else. Prisma's `orderBy`
 * cannot express `COLLATE`, and there is no argument by which it could, so the
 * only way to pin the comparison is the statement itself. The shape is otherwise
 * exactly the `findMany` it replaces — same predicate, same three selected
 * columns ({@link CatalogSuggestionRow}), same `LIMIT` — and it is a single
 * statement, so it needs no snapshot transaction: one statement is already one
 * snapshot.
 *
 * `limit` is bounded by {@link rowWindowFor}'s row guard rather than by the
 * route's cap, as in {@link searchPublishedFoods}, so a direct caller cannot put
 * a non-finite value into `LIMIT`; the per-route maximum belongs to
 * `parsePagination` at the controller.
 */
export const getSuggestions = async (
    kind: CatalogSuggestionKind,
    limit: number,
): Promise<CatalogSuggestionsResponse> => {
    const { limit: rows } = rowWindowFor(1, limit);

    const foods = await prisma.$queryRaw<CatalogSuggestionRow[]>`
        SELECT f.id, f.display_name, f.food_group
        FROM catalog_foods f
        WHERE f.publication_status = ${PUBLISHED}
            AND ${SUGGESTION_FILTERS[kind]}
        ORDER BY f.display_name COLLATE "C" ASC, f.source_key COLLATE "C" ASC
        LIMIT ${rows}
    `;

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
 * It is what the release checklist queries to confirm the published-food and
 * recipe counts the release gate requires BEFORE `MEAL_PLANNING_ENABLED` is
 * switched on (AAP §0.7.5 sets those numbers; this endpoint only reports what is
 * there), and what a post-deploy verification reads to confirm the expected
 * release is live. It is therefore deliberately cheap — four aggregates and one
 * indexed row, five reads in total, never a row dump — because a diagnostic that
 * is expensive to run is one nobody runs at the moment it matters.
 *
 * Every count is a separate aggregate rather than a grouped scan so that each
 * one is independently readable, and the five reads run SEQUENTIALLY INSIDE ONE
 * REPEATABLE READ SNAPSHOT rather than concurrently. That is the point of the
 * endpoint: a report whose release pointer came from before a load and whose
 * published count came from after it describes no state the catalog was ever in,
 * and it is exactly the report an operator reads while a load is running. Five
 * indexed reads on one connection are cheap enough that coherence costs nothing
 * worth having.
 */
export const getStatus = async (): Promise<CatalogStatusResponse> => {
    const { releaseLoad, counts } = await prisma.$transaction(async (db) => {
        const activeLoad = await db.catalog_import_runs.findFirst({
            where: { kind: RELEASE_LOAD_RUN_KIND, status: RUN_STATUS_SUCCEEDED },
            orderBy: { started_at: 'desc' },
            select: { manifest_version: true, finished_at: true, started_at: true },
        });

        const snapshotCounts: CatalogStatusCounts = {
            publishedCount: await db.catalog_foods.count({
                where: { publication_status: PUBLISHED },
            }),
            quarantinedCount: await db.catalog_foods.count({
                where: { publication_status: QUARANTINED },
            }),
            rejectedCount: await db.catalog_foods.count({
                where: { publication_status: REJECTED },
            }),
            recipeCount: await db.recipe_versions.count({
                where: { status: CURRENT_RECIPE_VERSION_STATUS },
            }),
        };

        return { releaseLoad: activeLoad, counts: snapshotCounts };
    }, SNAPSHOT_OPTIONS);

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
