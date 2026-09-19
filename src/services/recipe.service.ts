// The read side of recipes: `GET /api/recipes/:recipeVersionId` and the three
// internal reads the planner and the swap flow are built on — the plannable
// candidate set, the planning projection behind a set of version ids, and the
// whole rows the swap's alternatives and preview are rendered from.
//
// THIS FILE IS THE SINGLE OWNER OF RECIPE READS, which is not a style
// preference but a stated boundary: `catalog.service.ts`'s own docblock says so
// ("NO RECIPE READS. `recipe.service.ts::getRecipeVersionForUser` is the single
// owner of recipe reads"), and the AAP routes `GET /api/recipes/:id` through
// `catalog.controller.ts` into this module for exactly that reason. A second
// place that queried `recipe_versions` would be a second place that could get
// the visibility rule below wrong.
//
// BEING THE SINGLE OWNER IS ALSO WHERE THE READ COST OF THE CORPUS IS PAID.
// `getRecipeVersionsForPlanning` loads the WHOLE plannable corpus, and both the
// swap alternatives list and the swap preview need it, so it ran on every one
// of those requests. It is now served from a process-local cache validated on
// every call by a content hash of exactly the rows and columns it projects —
// the one place that can hold such a cache, because it is the one place that
// issues the read. The decision, and the invalidation designs rejected on the
// way to it, are recorded with `PLANNING_CORPUS_STAMP_STATEMENT` below.
//
// Orchestration only (Rule backend-architecture §5). Every decision belongs to
// a neighbour and is delegated to it:
//
//  * `recipe.mapper.ts` owns the row -> DTO boundary. `mapRecipeVersion` builds
//    every `RecipeVersionResponse` this file returns, including the narrowing of
//    each TEXT code column; no response shape is assembled here (§6).
//  * `recipe.logic.ts` owns every recipe RULE — nutrition derivation, badge and
//    tag derivation, portion scaling, staleness, planning eligibility. Nothing
//    below recomputes a stored derived column or re-decides eligibility.
//  * `mealPlan.logic.ts` owns the candidate shape the planner consumes
//    (`PlanRecipeCandidate`) and the search that consumes it. This file only
//    loads rows into that shape.
//
// WHY A MISSING VERSION IS `null` AND NOT A THROWN ERROR. The shared error
// vocabulary in `mealPlanning.errors.ts` has one class per *resource* whose
// absence the client must distinguish (`PlanNotFoundError`,
// `CatalogFoodNotFoundError`) and deliberately none for a recipe version. So
// these reads report absence the way `nutrition.service.ts` already does —
// `null` — and the controller maps that to 404 (§4 "Missing resource -> 404,
// not an empty 200"; §8 "Return `null` from the service"). The important half
// is what that makes indistinguishable: "no such version" and "not your
// version" produce the SAME `null`, so a caller cannot probe for the existence
// of a recipe version it may not see (§1.5, §8 "Never distinguish 'doesn't
// exist' from 'isn't yours'").
//
// §5.1 AND ITS ONE SANCTIONED EXCEPTION. Rule backend-architecture §5.1
// requires the owner key in every `where`, and the two USER-scoped predicates
// below carry it: the `meal_plan_meals` and `meal_entries` reference checks are
// filtered by `user_id`, never by recipe id alone. But `recipes`,
// `recipe_versions` and `recipe_ingredients` hold no `user_id` at all — they are
// shared reference data, the same forty recipes for every user, exactly as
// `catalog_foods` is — so the row read itself has no owner to scope to and no
// cross-user row to leak. That is the same exception `catalog.service.ts`
// documents, and it is why {@link getRecipeVersionsForPlanning} takes no
// `userId`: a parameter accepted only to be ignored would misrepresent a shared
// read as an owned one. Visibility of a recipe version is therefore a
// REFERENCE question, and answering it is this file's job.

import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import { NutritionProvenance } from '../types/nutrition';
import { RecipeVersionResponse } from '../types/recipe';
import { describeErrorSafely, logSafeEvent } from '../utils/safeLogger';
import { isCatalogAllergenStatus, isCatalogNutritionProvenance } from './catalog.logic';
import { PlanRecipeCandidate } from './mealPlan.logic';
import { RecipeVersionRow, mapRecipeVersion } from './recipe.mapper';
import {
    PlanningRecipeVersion,
    RecipeAllergenStatus,
    RecipeIngredientIdentity,
    RecipeVersionStatus,
} from './recipe.logic';

/* ---------------------------------------------------------------------------
 * What a recipe read projects
 * ------------------------------------------------------------------------- */

/**
 * The only status planning will ever use, and the status that makes a version
 * publicly readable. A partial unique index allows exactly one per recipe, so
 * "the current version" is a single row by construction rather than by
 * convention.
 *
 * `retired` is the other stored value: still READABLE through the reference
 * rule below, because a historical plan and a months-old diary entry must keep
 * resolving, and never plannable again.
 */
const CURRENT_VERSION_STATUS: RecipeVersionStatus = 'current';

/**
 * The `recipe_versions` columns `mapRecipeVersion` needs, and no others.
 *
 * Projected explicitly rather than fetched whole so the omissions are
 * deliberate: `sourced_calories_note` is an internal record of a rounding
 * divergence and not a client contract, and `published_at`/`retired_at` have no
 * consumer. `satisfies` keeps the object literal checked against Prisma's
 * select type while still giving the delegate a precise payload type, so no
 * caller below carries a cast.
 */
const VERSION_DETAIL_SELECT = {
    id: true,
    recipe_id: true,
    version: true,
    name: true,
    description: true,
    icon_key: true,
    instructions: true,
    yield_servings: true,
    serving_description: true,
    prep_minutes: true,
    cook_minutes: true,
    total_minutes: true,
    meal_slots: true,
    diet_tags: true,
    allergen_tags: true,
    allergen_status: true,
    budget_tier: true,
    badges: true,
    nutrition_provenance: true,
    per_serving_calories: true,
    per_serving_protein_g: true,
    per_serving_carbs_g: true,
    per_serving_fat_g: true,
    status: true,
} satisfies Prisma.recipe_versionsSelect;

/**
 * The `recipe_ingredients` columns the recipe DTO carries — the frozen
 * `snapshot_*` set plus the recipe's own quantity facts.
 *
 * No `catalog_foods` join: `recipe.mapper.ts`'s load-bearing rule is that an
 * ingredient's displayed name and provenance come from the snapshot columns and
 * never from the live catalog row, so the response for a retired version keeps
 * reporting what the recipe was published with. Joining the live row here would
 * hand the mapper a second, tempting source for facts it is required to read
 * from the snapshot.
 */
const INGREDIENT_DETAIL_SELECT = {
    catalog_food_id: true,
    catalog_nutrition_version: true,
    catalog_metadata_version: true,
    snapshot_per_100g: true,
    snapshot_name: true,
    snapshot_provenance: true,
    snapshot_allergen_tags: true,
    snapshot_diet_tags: true,
    quantity: true,
    unit: true,
    gram_weight: true,
    display_text: true,
    is_optional: true,
} satisfies Prisma.recipe_ingredientsSelect;

/**
 * The ingredient order every read uses: `sort_order`, then `catalog_food_id` as
 * the tiebreaker.
 *
 * TOTAL ON PURPOSE. `sort_order` alone is not unique, so two ingredients
 * sharing one would come back in whatever order the scan produced and an
 * instruction step that says "the second ingredient" could name a different
 * food between two requests. The tiebreaker is the same one
 * `recipe.logic.ts::orderIngredients` applies to its own canonical order, so a
 * derivation and the response it describes walk the list identically.
 */
const INGREDIENT_ORDER: Prisma.recipe_ingredientsOrderByWithRelationInput[] = [
    { sort_order: 'asc' },
    { catalog_food_id: 'asc' },
];

/**
 * One version row with its ingredients, in canonical order — the shared shape
 * both DTO-returning reads below map.
 *
 * `findUnique` on the primary key: a version id is a v4 UUID validated by the
 * controller's parser, and a row either exists or does not.
 */
const loadVersionWithIngredients = (recipeVersionId: string, db: Prisma.TransactionClient) =>
    db.recipe_versions.findUnique({
        where: { id: recipeVersionId },
        select: {
            ...VERSION_DETAIL_SELECT,
            recipe_ingredients: { select: INGREDIENT_DETAIL_SELECT, orderBy: INGREDIENT_ORDER },
        },
    });

/* ---------------------------------------------------------------------------
 * Visibility — the rule AAP §0.5.2 states for GET /api/recipes/:id
 * ------------------------------------------------------------------------- */

/**
 * Whether this user holds a reference to this recipe version.
 *
 * Three references count, and each exists because a screen would otherwise
 * break on a version that is no longer `current`:
 *
 *  * `meal_plan_meals.recipe_version_id` — the meal as it stands now, including
 *    on a superseded or ended plan, which stays readable for history.
 *  * `meal_plan_meals.previous_recipe_version_id` — what the meal WAS before a
 *    swap. The plan card's logged-then-swapped caption names it, so the recipe
 *    behind that name has to be openable.
 *  * `meal_entries.recipe_version_id`, not soft-deleted — a diary entry logged
 *    from a plan. "View in diary" leads to a row whose recipe may since have
 *    been retired by a catalog refresh; a 404 there would strand a meal the
 *    user actually ate. A DELETED entry is not a reference: the user removed
 *    it, and keeping the visibility it granted would outlive the reason for it.
 *
 * BOTH PREDICATES CARRY `user_id` (§5.1). Matching on the recipe id alone would
 * make any other user's plan or diary a grant of access to every recipe version
 * they have ever been served.
 *
 * The two reads run in sequence rather than concurrently, for two reasons: the
 * planned-meal check answers the common case (a swap preview, a plan card) and
 * short-circuits the second query entirely, and `db` may be an interactive
 * transaction client, which is one connection — issuing its queries one at a
 * time keeps this read honest inside a caller's transaction.
 */
const isVersionReferencedByUser = async (
    userId: string,
    recipeVersionId: string,
    db: Prisma.TransactionClient,
): Promise<boolean> => {
    const plannedMeal = await db.meal_plan_meals.findFirst({
        where: {
            user_id: userId,
            OR: [
                { recipe_version_id: recipeVersionId },
                { previous_recipe_version_id: recipeVersionId },
            ],
        },
        select: { id: true },
    });

    if (plannedMeal !== null) {
        return true;
    }

    const diaryEntry = await db.meal_entries.findFirst({
        where: { user_id: userId, recipe_version_id: recipeVersionId, deleted_at: null },
        select: { id: true },
    });

    return diaryEntry !== null;
};

/**
 * `GET /api/recipes/:recipeVersionId` — one recipe version, if this caller may
 * see it.
 *
 * `recipeVersionId` ARRIVES ALREADY VALIDATED. Its only route-facing caller,
 * `catalog.controller.ts::getRecipeVersionController`, runs
 * `recipe.logic.ts::parseRecipeVersionPath` over `req.params` before it calls
 * this function and answers a refusal itself with `400 invalid_request` naming
 * `recipeVersionId` (§0.5.2: "server-side validation applied before any Prisma
 * or planning work"; §0.7.2: `getUserId` → parse → one service call). So a
 * value that could never denote a version no longer reaches the `uuid`
 * predicate below — it never reaches this function at all — and this signature
 * carries no HTTP-shaped verdict: a request judgement belongs to the pure
 * parser at the boundary, not to a service (Rule backend-architecture §4, §8).
 *
 * The rule, exactly as AAP §0.5.2 states it: a version is visible when its
 * `status` is `current`, OR when the caller owns a `meal_plan_meals` row whose
 * `recipe_version_id` or `previous_recipe_version_id` is it, OR when the caller
 * owns a non-deleted `meal_entries` row whose `recipe_version_id` is it.
 * Anything else is `null`.
 *
 * The `current` clause comes first because it is the cheap, common answer and
 * needs no user-scoped query at all: the currently published recipes are shared
 * reference data that any authenticated caller may read. The reference clauses
 * are what extend that to a RETIRED version — the one the user's own plan or
 * diary still points at — without opening every retired version to everybody.
 *
 * `null` covers three different situations on purpose — no such id, a retired
 * version nobody here references, and a version referenced only by someone else
 * — and the caller cannot tell them apart. That is the requirement, not a
 * shortcut: distinguishing them would confirm the existence of a resource the
 * caller has no right to (§1.5).
 *
 * `db` accepts an open transaction so a caller that already holds the per-user
 * lock reads the same snapshot it is about to write in, and defaults to the
 * shared client for a plain request read — the convention `nutrition.service.ts`
 * established for every meal-planning read.
 *
 * A row that contradicts the response contract is the one thing this read does
 * NOT answer with `null`: `recipe.mapper.ts` raises `RecipeMappingError` for a
 * code column outside its closed set, a required safety list that is absent,
 * and instructions that are absent or empty. That surfaces as a 500 rather than
 * a 404 on purpose — the resource exists and the caller may see it; what failed
 * is the data behind it, and the quiet alternatives would be a recipe presented
 * as free of allergens or as having no steps. `null` keeps its single meaning:
 * you may not see this, or it is not there.
 */
export const getRecipeVersionForUser = async (
    userId: string,
    recipeVersionId: string,
    db: Prisma.TransactionClient = prisma,
): Promise<RecipeVersionResponse | null> => {
    const version = await loadVersionWithIngredients(recipeVersionId, db);

    if (version === null) {
        return null;
    }

    if (version.status !== CURRENT_VERSION_STATUS) {
        const referenced = await isVersionReferencedByUser(userId, recipeVersionId, db);

        if (!referenced) {
            return null;
        }
    }

    return mapRecipeVersion(version, version.recipe_ingredients);
};

/**
 * The same read WITHOUT the visibility rule, for a caller that has already
 * established the user's right to see this version.
 *
 * NOT A ROUTE-FACING ENTRY POINT, and no id reaching it was ever typed by a
 * client: its `id` is the swap preview's INTERNAL read of a candidate that came
 * from the plannable set — `swap.logic.ts::selectSwapCandidates` run against the
 * user's own plan — so the value was produced by this server from a stored
 * column. A client-supplied path segment is judged at the boundary it actually
 * reaches, `catalog.controller.ts::getRecipeVersionController` ahead of
 * {@link getRecipeVersionForUser}, which is why neither read here parses
 * anything.
 *
 * Exactly one kind of caller qualifies, and the swap preview is it: the
 * candidate it is previewing came from `swap.logic.ts::selectSwapCandidates`
 * run against the user's OWN plan, so the right was established by the
 * selection itself — and re-deriving it here would fail, because a candidate is
 * not yet referenced by any meal or entry of this user. Re-running the
 * reference check would therefore refuse a version the caller has already
 * proved the user may see, which is why this function exists rather than a
 * second `userId`-shaped read that quietly answers `null`.
 *
 * The trade is deliberate and narrow: this function establishes NO visibility
 * of its own, so a caller that reaches it without having established the user's
 * right would leak a recipe version. Every route-facing read goes through
 * {@link getRecipeVersionForUser} instead — there is no controller path to this
 * one.
 */
export const getRecipeVersionDetail = async (
    recipeVersionId: string,
    db: Prisma.TransactionClient = prisma,
): Promise<RecipeVersionResponse | null> => {
    const version = await loadVersionWithIngredients(recipeVersionId, db);

    if (version === null) {
        return null;
    }

    return mapRecipeVersion(version, version.recipe_ingredients);
};

/* ---------------------------------------------------------------------------
 * The planner's candidate set
 * ------------------------------------------------------------------------- */

/**
 * What a planning candidate reads about each of its ingredients.
 *
 * THE SNAPSHOT COLUMNS ARE THE SOURCE for identity, provenance and safety —
 * `snapshot_name`, `snapshot_provenance`, `snapshot_allergen_tags`,
 * `snapshot_diet_tags` — never the live `catalog_foods` row, for the same
 * reason the DTO reads them: a catalog refresh renames foods and re-derives
 * nutrition, and eligibility judged against live tags would restate a SAFETY
 * claim the published recipe never made.
 *
 * `catalog_foods.food_group` is the ONE live column joined here, and
 * `recipe.logic.ts` asks for it in those words: "the planner's service supplies
 * `food_group` (live identity metadata, matched against a live user
 * preference — never nutrition)". It has to be live because the other side of
 * the comparison is: a dislike stores the food id AND its group, so a food
 * whose group was assigned after the recipe was published must still be
 * excluded by a user who disliked that group. Reading a stale group would
 * under-exclude, and under-exclusion is the failure the user notices — the
 * ingredient they declined appearing in their week.
 *
 * `allergen_status` is the SECOND live column, joined for the same reason and
 * subject to the same requirement. `recipe_ingredients` does not snapshot it —
 * the table carries the allergen TAGS but not the review that produced them —
 * so `catalog_foods.allergen_status` is the only place the per-ingredient
 * review exists, and `recipe.logic.ts` declares the field optional precisely
 * because it is the supplier's to provide, exactly as it says of `food_group`.
 *
 * IT MUST BE SUPPLIED, and omitting it is not a safe default but a silent
 * refusal of everything. `evaluatePlanningEligibility` reads anything other
 * than an explicit `known` as unreviewed, including the absent value, and it
 * does NOT fall back to the recipe's rollup — the rollup is an ADDITIONAL
 * clause there, never a substitute. Leaving this column out therefore makes
 * every ingredient unreviewed, every recipe ineligible, and the planner
 * unable to fill a single slot: generation answers `no_matching_meals`
 * forever, swap alternatives come back empty forever, and flag recomputation
 * marks every planned meal. `deriveAllergenStatus` rolls the recipe-level
 * column UP from these per-ingredient values, which is the proof of direction:
 * the ingredient review is the primary fact and the recipe column is the
 * frozen record of it.
 *
 * Reading it LIVE is also the correct direction for safety. A catalog
 * re-review that withdraws a food's allergen review stops that recipe being
 * planned again, which is the outcome we want from losing evidence; the
 * allergen CLAIMS a user is matched against remain the frozen
 * `snapshot_allergen_tags` above, so no published claim is restated.
 */
const PLANNING_INGREDIENT_SELECT = {
    catalog_food_id: true,
    snapshot_name: true,
    snapshot_provenance: true,
    snapshot_allergen_tags: true,
    snapshot_diet_tags: true,
    is_optional: true,
    catalog_foods: { select: { food_group: true, allergen_status: true } },
} satisfies Prisma.recipe_ingredientsSelect;

/**
 * The provenance a stored code outside the closed set is read as.
 *
 * `user_entered` is the honest reading rather than a fabricated one: it is the
 * class the AAP assigns to every value "the server cannot verify", and it is
 * the one member of the union that planning eligibility can never admit. So an
 * unrecognised code can only ever make a recipe INELIGIBLE — it cannot promote
 * one — which is the direction a fallback has to fail in. Substituting a
 * plausible code such as `source_backed` would state a fact about the recipe
 * that nothing established, and throwing would take the whole planner down over
 * one row that is provably unplannable anyway.
 */
const UNVERIFIABLE_PROVENANCE: NutritionProvenance = 'user_entered';

/**
 * The allergen review status a stored code outside the closed set is read as.
 *
 * `unknown` for the same reason: it is exactly "we cannot describe this food",
 * which is true when the column holds a value we cannot read, and it is what
 * `recipe.logic.ts` documents as the safe default. A food we cannot describe is
 * never certified safe for anyone.
 */
const UNREVIEWED_ALLERGEN_STATUS: RecipeAllergenStatus = 'unknown';

/**
 * The only rolled-up nutrition grade and the only rolled-up allergen review a
 * plannable version may carry — the two recipe-level halves of the plannable
 * universe {@link getRecipeVersionsForPlanning} selects.
 *
 * Typed against the unions rather than written as bare strings in the `where`,
 * so a column value that stops being a member of its union fails to compile
 * here instead of silently matching nothing at runtime — the same construction
 * the fallbacks above use.
 */
const SOURCE_BACKED_PROVENANCE: NutritionProvenance = 'source_backed';

const REVIEWED_ALLERGEN_STATUS: RecipeAllergenStatus = 'known';

/**
 * Reads a stored provenance column into the union the rules are typed against.
 *
 * The membership DECISION stays in the logic layer — `catalog.logic.ts`'s
 * `isCatalogNutritionProvenance` is the closed set, built from the wire type
 * itself — and this boundary only applies it, so no closed set is restated
 * here (§7.1).
 */
const readNutritionProvenance = (stored: string): NutritionProvenance =>
    isCatalogNutritionProvenance(stored) ? stored : UNVERIFIABLE_PROVENANCE;

/** Reads a stored allergen review column into the union, via the same logic-layer guard. */
const readAllergenStatus = (stored: string): RecipeAllergenStatus =>
    isCatalogAllergenStatus(stored) ? stored : UNREVIEWED_ALLERGEN_STATUS;

/** One `recipe_ingredients` row projected for planning, as the select above returns it. */
interface PlanningIngredientRow {
    catalog_food_id: string;
    snapshot_name: string;
    snapshot_provenance: string;
    snapshot_allergen_tags: string[];
    snapshot_diet_tags: string[];
    is_optional: boolean;
    catalog_foods: { food_group: string; allergen_status: string };
}

/**
 * One ingredient as the eligibility rules read it.
 *
 * `sort_order` is used to ORDER the array (see {@link INGREDIENT_ORDER}) and is
 * not carried on the identity: `RecipeIngredientIdentity` declares no such
 * member, and the array order is what every derivation walks.
 *
 * Both live columns are narrowed through the logic layer's own guards rather
 * than cast, so a column holding a value outside its closed set degrades to the
 * least-permissive reading — `unknown` for a review, which can only ever make a
 * recipe ineligible — instead of entering the rules as an unchecked string.
 */
const toIngredientIdentity = (row: PlanningIngredientRow): RecipeIngredientIdentity => ({
    catalog_food_id: row.catalog_food_id,
    snapshot_name: row.snapshot_name,
    snapshot_provenance: readNutritionProvenance(row.snapshot_provenance),
    snapshot_allergen_tags: row.snapshot_allergen_tags,
    snapshot_diet_tags: row.snapshot_diet_tags,
    is_optional: row.is_optional,
    food_group: row.catalog_foods.food_group,
    allergen_status: readAllergenStatus(row.catalog_foods.allergen_status),
});

/**
 * The version status a stored code outside the closed set is read as.
 *
 * `retired` completes the same least-privilege pattern: a status we cannot read
 * is never planned again, while the version stays readable through the
 * reference rule. The set is keyed off `RecipeVersionStatus` itself, so widening
 * that union stops this literal compiling until the new status is handled — the
 * same construction `recipe.mapper.ts` uses for the columns `recipe.logic.ts`
 * exports no guard for.
 */
const VERSION_STATUSES: Readonly<Record<RecipeVersionStatus, true>> = {
    current: true,
    retired: true,
};

const RETIRED_VERSION_STATUS: RecipeVersionStatus = 'retired';

const readVersionStatus = (stored: string): RecipeVersionStatus =>
    Object.prototype.hasOwnProperty.call(VERSION_STATUSES, stored)
        ? (stored as RecipeVersionStatus)
        : RETIRED_VERSION_STATUS;

/** The `recipe_versions` columns the eligibility rules read, as the select returns them. */
interface PlanningVersionRow {
    status: string;
    nutrition_provenance: string;
    allergen_status: string;
    total_minutes: number;
    meal_slots: string[];
    recipe_ingredients: PlanningIngredientRow[];
}

/** A planning row that also carries the planner's portable identity and nutrition. */
interface PlanCandidateRow extends PlanningVersionRow {
    id: string;
    recipe_id: string;
    version: number;
    budget_tier: number;
    per_serving_calories: number;
    per_serving_protein_g: number;
    per_serving_carbs_g: number;
    per_serving_fat_g: number;
    recipes: { slug: string };
}

/**
 * One row as `recipe.logic.ts::evaluatePlanningEligibility` reads it.
 *
 * `status` IS narrowed from the column here rather than assumed, because this
 * mapper serves both callers: the candidate set below filters to `current`,
 * while {@link getPlanningRecipeVersionsByIds} deliberately does not — a
 * planned meal may point at a version a catalog refresh has since retired, and
 * "this meal's recipe is retired" is a fact the eligibility verdict must be
 * able to state.
 */
const toPlanningRecipeVersion = (row: PlanningVersionRow): PlanningRecipeVersion => ({
    status: readVersionStatus(row.status),
    nutrition_provenance: readNutritionProvenance(row.nutrition_provenance),
    allergen_status: readAllergenStatus(row.allergen_status),
    total_minutes: row.total_minutes,
    meal_slots: row.meal_slots,
    ingredients: row.recipe_ingredients.map(toIngredientIdentity),
});

/**
 * One row as `mealPlan.logic.ts` consumes it.
 *
 * `per_serving` carries the stored columns at FULL PRECISION, unrounded.
 * `recipe.logic.ts`'s rounding contract rounds planned-portion nutrition only
 * where it is displayed or snapshotted; rounding here would feed the search's
 * tolerance arithmetic pre-rounded numbers and move which weeks are feasible.
 */
const toPlanRecipeCandidate = (row: PlanCandidateRow): PlanRecipeCandidate => ({
    ...toPlanningRecipeVersion(row),
    recipe_version_id: row.id,
    recipe_id: row.recipe_id,
    slug: row.recipes.slug,
    version: row.version,
    budget_tier: row.budget_tier,
    per_serving: {
        calories: row.per_serving_calories,
        protein: row.per_serving_protein_g,
        carbs: row.per_serving_carbs_g,
        fat: row.per_serving_fat_g,
    },
});

/**
 * The recipe versions behind a set of planned meals, keyed by version id.
 *
 * The read flag recomputation and the swap flow need, and the reason it lives
 * HERE rather than in the service that recomputes flags: this file is the
 * single owner of recipe reads, so the projection, the snapshot rule and the
 * closed-set narrowing above exist once. A caller passes the `recipe_version_id`
 * values it read from its own user-scoped tables and gets back the eligibility
 * input for each — and a Map rather than a list, because a plan week points at
 * the same version more than once and every caller needs it by id.
 *
 * NOT filtered by `status`: a meal planned last week may point at a version a
 * catalog refresh has since retired, and that meal still has to be evaluated.
 * Eligibility, not this read, decides what a retired version means.
 *
 * An id with no row is simply absent from the Map. `meal_plan_meals`'s
 * RESTRICT foreign key makes that unreachable for a planned meal, so the
 * absence is the caller's to notice rather than this function's to paper over
 * with a fabricated row.
 */
export const getPlanningRecipeVersionsByIds = async (
    recipeVersionIds: readonly string[],
    db: Prisma.TransactionClient = prisma,
): Promise<Map<string, PlanningRecipeVersion>> => {
    if (recipeVersionIds.length === 0) {
        return new Map();
    }

    const versions = await db.recipe_versions.findMany({
        where: { id: { in: [...new Set(recipeVersionIds)] } },
        select: {
            id: true,
            status: true,
            nutrition_provenance: true,
            allergen_status: true,
            total_minutes: true,
            meal_slots: true,
            recipe_ingredients: { select: PLANNING_INGREDIENT_SELECT, orderBy: INGREDIENT_ORDER },
        },
    });

    return new Map(versions.map((version) => [version.id, toPlanningRecipeVersion(version)]));
};

/**
 * The whole `recipe_versions` rows behind a set of version ids, keyed by id.
 *
 * THE FOURTH READ PATH THROUGH THIS FILE, added rather than duplicated: the
 * swap's alternatives list renders each candidate through
 * `recipe.mapper.ts::mapSwapAlternative`, which takes a full
 * {@link RecipeVersionRow}, and `swap.service.ts` previously issued that query
 * itself. Two modules querying `recipe_versions` is how two subtly different
 * projections come about, and this file's header states the guarantee that
 * prevents it — the planner, the swap engine and the planned-log service call in
 * rather than reading the table themselves.
 *
 * READ WHOLE rather than projected, deliberately and unlike the two planning
 * reads above: `RecipeVersionRow` is twenty-four of this table's columns, so an
 * explicit select would restate the table with one more way to fall behind it —
 * the same judgement `VERSION_DETAIL_SELECT`'s neighbours document. The row is
 * the mapper's input contract, so `select: undefined` is what keeps the two in
 * step.
 *
 * BOUNDED BY THE CALLER: the swap asks for at most eight ids, because its list
 * is truncated before this runs. It is not a search — there is no predicate
 * beyond the ids — so it stays cheap by construction.
 *
 * NOT filtered by `status`, for the reason {@link getPlanningRecipeVersionsByIds}
 * gives: a version a catalog refresh has since retired still has to render, or a
 * user's own week would show a blank card. What a retired version MEANS is
 * eligibility's decision, never this read's.
 *
 * NO `userId` PARAMETER, by the §5.1 exception this file's header states:
 * `recipe_versions` carries no owner column, so there is nothing to scope to.
 * The ids reach here from a selection made against the caller's own plan, so the
 * function cannot be turned into a probe by a caller that follows the rule.
 *
 * An id with no row is simply absent from the Map, and the caller decides what
 * that means — `swap.service.ts` treats it as a data fault rather than silently
 * shortening its list.
 */
export const getRecipeVersionRowsByIds = async (
    recipeVersionIds: readonly string[],
    db: Prisma.TransactionClient = prisma,
): Promise<Map<string, RecipeVersionRow>> => {
    if (recipeVersionIds.length === 0) {
        return new Map();
    }

    const versions = await db.recipe_versions.findMany({
        where: { id: { in: [...new Set(recipeVersionIds)] } },
    });

    return new Map(versions.map((version) => [version.id, version]));
};

/* ---------------------------------------------------------------------------
 * Keeping the candidate projection off the request path
 * ------------------------------------------------------------------------- */

/**
 * The plannable universe, as one statement's worth of predicate.
 *
 * Extracted as a `Prisma.Sql` fragment rather than written three times inside
 * {@link PLANNING_CORPUS_STAMP_STATEMENT} so the freshness check and the
 * projection cannot come to describe different sets: the fragment is bound from
 * the SAME three typed constants the `findMany` below filters on, so a change
 * to any of them moves both sides together. `v` is the `recipe_versions` alias
 * every subquery of the stamp statement uses.
 */
const PLANNABLE_VERSION_PREDICATE = Prisma.sql`
    v.status = ${CURRENT_VERSION_STATUS}
    AND v.nutrition_provenance = ${SOURCE_BACKED_PROVENANCE}
    AND v.allergen_status = ${REVIEWED_ALLERGEN_STATUS}
`;

/**
 * What one execution of the freshness statement answers: three content hashes
 * covering everything the candidate projection reads.
 *
 * Three columns rather than one so that a diagnosis can say WHICH part of the
 * corpus moved — the versions, their ingredients or the live catalog rows
 * behind those ingredients. They are concatenated into a single stamp by
 * {@link readPlanningCorpusStamp}, which is the only value the cache compares.
 */
interface PlanningCorpusStampRow {
    /** `recipe_versions` ⋈ `recipes`: identity, publication state and every projected column. */
    versions_stamp: string;
    /** `recipe_ingredients` of those versions: identity, snapshots, optionality and order. */
    ingredients_stamp: string;
    /** The LIVE `catalog_foods` columns the projection joins, plus `updated_at`. */
    foods_stamp: string;
}

/**
 * THE FRESHNESS CHECK: an ordered content hash of exactly what the candidate
 * projection reads, in ONE statement.
 *
 * WHY A PER-READ CHECK IS THE ONLY CORRECT INVALIDATION HERE. Every writer of
 * this corpus is a SEPARATE OPERATOR PROCESS — `scripts/recipes-seed.ts`,
 * `catalog-load.ts`, `catalog-import-usda.ts`, `catalog-generate-ai.ts`,
 * `catalog-validate.ts`, `catalog-release.ts` and the libraries they share. No
 * service in `src/` writes `recipe_versions` or `catalog_foods` at all. An
 * in-process invalidation hook could therefore never observe a publication: the
 * API process that holds the cache is not the process that changes the data, so
 * "invalidate on release load / recipe seed" can only be implemented as a check
 * the reader makes against the database itself.
 *
 * AND NOT A TIME-TO-LIVE, for the same reason turned around: a TTL states how
 * long a stale answer may be served, and the answer here carries an allergen
 * review. There is no acceptable window for "this recipe was safe a minute ago",
 * so freshness is asked per read and the cost of asking is what was minimised
 * instead.
 *
 * WHY A HASH AND NOT A CHEAPER KEY. Two cheaper keys were considered and both
 * admit a stale answer:
 *
 *  * The active release id in `catalog_import_runs` is O(1) but insufficient —
 *    a recipe version can be published with no run row at all (every test
 *    factory does exactly that), and `catalog-validate.ts` can change a food's
 *    `allergen_status` without writing one.
 *  * Row counts plus maximum timestamps are insufficient for the same class of
 *    reason: `recipe_versions` carries NO `updated_at` column (only `status`,
 *    `published_at` and `retired_at`), and fixtures publish with a FIXED
 *    `published_at` literal, so a truncate-and-reseed between two tests can
 *    reproduce a count and a maximum stamp while holding entirely different
 *    rows — and the next read would be served the previous corpus.
 *
 * So the stamp hashes the IDENTITY AND THE CONTENT of the projected set, in a
 * total order: the version rows (ordered by the same `slug, version` the
 * projection is ordered by, with the id as the final tiebreaker), the ingredient
 * rows of those versions ordered by id, and the live `catalog_foods` columns the
 * projection joins — `allergen_status`, `food_group` and `updated_at`, which
 * PostgreSQL bumps on any write because the column is `@updatedAt`. Anything
 * that could change a single field of a single candidate changes the stamp.
 *
 * THAT IS WHAT PRESERVES THE AAP §0.7.3 SAFETY GUARANTEE. The projection reads
 * `catalog_foods.{food_group, allergen_status}` live per row precisely so a
 * withdrawn allergen review stops a recipe being planned immediately; hashing
 * those very columns means a cached candidate set cannot outlive the review it
 * was built from. The cache is invisible to eligibility: nothing is narrowed in
 * SQL, so `recipe.logic.ts::evaluatePlanningEligibility` remains the single
 * implementation and the candidate pre-order stays `(slug, version,
 * portion_multiplier)`.
 *
 * ONE ROUND TRIP, BY CONSTRUCTION. Three correlated subqueries in one `SELECT`
 * with no `FROM`, so a cache HIT costs a single statement against the
 * four-statement projection it replaces. `concat_ws(chr(31), …)` separates
 * fields and `chr(30)` separates rows — control characters that cannot occur in
 * a slug, a name or a tag — so no concatenation of two fields can impersonate a
 * third, and every nullable column is `coalesce`d so an absent value is
 * distinguishable rather than skipped by `concat_ws`.
 */
const PLANNING_CORPUS_STAMP_STATEMENT = Prisma.sql`
    SELECT
        md5(coalesce((
            SELECT string_agg(
                       concat_ws(chr(31),
                           v.id::text, r.slug, v.version::text, v.status,
                           coalesce(v.published_at::text, ''), coalesce(v.retired_at::text, ''),
                           v.nutrition_provenance, v.allergen_status, v.total_minutes::text,
                           v.meal_slots::text, v.budget_tier::text,
                           v.per_serving_calories::text, v.per_serving_protein_g::text,
                           v.per_serving_carbs_g::text, v.per_serving_fat_g::text),
                       chr(30) ORDER BY r.slug, v.version, v.id)
            FROM recipe_versions v
            JOIN recipes r ON r.id = v.recipe_id
            WHERE ${PLANNABLE_VERSION_PREDICATE}
        ), '')) AS versions_stamp,
        md5(coalesce((
            SELECT string_agg(
                       concat_ws(chr(31),
                           i.id::text, i.recipe_version_id::text, i.catalog_food_id::text,
                           i.snapshot_name, i.snapshot_provenance,
                           i.snapshot_allergen_tags::text, i.snapshot_diet_tags::text,
                           i.is_optional::text, i.sort_order::text),
                       chr(30) ORDER BY i.id)
            FROM recipe_ingredients i
            JOIN recipe_versions v ON v.id = i.recipe_version_id
            WHERE ${PLANNABLE_VERSION_PREDICATE}
        ), '')) AS ingredients_stamp,
        md5(coalesce((
            SELECT string_agg(
                       concat_ws(chr(31), f.id::text, f.allergen_status, f.food_group,
                           f.updated_at::text),
                       chr(30) ORDER BY f.id)
            FROM catalog_foods f
            WHERE EXISTS (
                SELECT 1
                FROM recipe_ingredients i
                JOIN recipe_versions v ON v.id = i.recipe_version_id
                WHERE i.catalog_food_id = f.id AND ${PLANNABLE_VERSION_PREDICATE}
            )
        ), '')) AS foods_stamp
`;

/**
 * The stamp of the corpus THIS caller can see, or `null` when the database did
 * not answer the question.
 *
 * Run on the caller's own client, which is what makes the check honest inside
 * an interactive transaction: a caller reading a REPEATABLE READ snapshot
 * stamps THAT snapshot, so it is served candidates matching what it can
 * actually see rather than what a pooled connection would see now.
 *
 * A FAILED CHECK FALLS THROUGH TO A FULL LOAD rather than failing the request —
 * the posture `usda.service.ts` already documents for its own cache reads. The
 * cache is an optimisation and must never be the reason a plannable set cannot
 * be produced, and the fall-through is exactly the pre-cache behaviour: read the
 * corpus. It is logged at `warn` because a check that cannot run means every
 * later read pays the full projection again, which is an operator-visible cost
 * and not a silent one.
 */
const readPlanningCorpusStamp = async (db: Prisma.TransactionClient): Promise<string | null> => {
    try {
        const rows = await db.$queryRaw<PlanningCorpusStampRow[]>(PLANNING_CORPUS_STAMP_STATEMENT);
        const stamp = rows[0];

        if (stamp === undefined) {
            logSafeEvent('warn', 'planning_corpus_stamp_empty', { rows: rows.length });

            return null;
        }

        return `${stamp.versions_stamp}:${stamp.ingredients_stamp}:${stamp.foods_stamp}`;
    } catch (error) {
        logSafeEvent('warn', 'planning_corpus_stamp_failed', describeErrorSafely(error));

        return null;
    }
};

/**
 * The candidate set as one corpus produced it, held against the stamp that
 * describes that corpus.
 *
 * `candidates` is `readonly` because the array inside this entry is never
 * handed out: {@link getRecipeVersionsForPlanning} returns a shallow copy, so a
 * consumer that sorts its result in place — `swap.logic.ts` and
 * `mealPlan.logic.ts` both sort derived arrays today, and a future one may sort
 * this one — cannot reorder the shared set behind every other caller.
 */
interface PlanningCandidateCacheEntry {
    readonly stamp: string;
    readonly candidates: readonly PlanRecipeCandidate[];
}

/**
 * The one cached corpus, or `null` before the first load.
 *
 * SINGLE-ENTRY AND CONTENT-ADDRESSED, deliberately. Holding several stamps
 * would serve two different corpora at once — useful only while a stale
 * snapshot is still open — and would need an eviction policy to bound it. One
 * entry costs at most one extra load when a caller reading an older snapshot
 * interleaves with one reading the current corpus, and it can never serve the
 * wrong content to either: the stamp is compared on EVERY call, so the entry is
 * used only by a caller whose corpus hashes to it.
 *
 * PROCESS-LOCAL, so nothing here survives a restart and no invalidation has to
 * cross a process boundary — which is the property that makes the per-read
 * check above sufficient rather than merely convenient.
 */
let planningCandidateCache: PlanningCandidateCacheEntry | null = null;

/**
 * The loads that have not finished yet, keyed by the stamp each one is loading.
 *
 * Without this, N concurrent first requests would each run the full
 * four-statement projection — the cold-start stampede the cache exists to
 * prevent. The promise is the value, for the same reason
 * `usda.service.ts::pendingRefreshes` holds promises: a later caller JOINS the
 * load already running instead of starting a second one.
 *
 * An entry is removed by the load that owns it, whether it resolved or rejected,
 * so a failed load is retried by the next caller rather than being remembered.
 */
const inFlightPlanningLoads = new Map<string, Promise<readonly PlanRecipeCandidate[]>>();

/**
 * The projection itself — the read this module has always issued, unchanged.
 *
 * Split out from the exported function so the cache above wraps it rather than
 * being interleaved with it: the `where`, the `select` and the `orderBy` below
 * are the plannable universe and the load-bearing pre-order documented on
 * {@link getRecipeVersionsForPlanning}, and nothing in the caching layer may
 * narrow or reorder them.
 */
const loadPlanningCandidates = async (
    db: Prisma.TransactionClient,
): Promise<readonly PlanRecipeCandidate[]> => {
    const versions = await db.recipe_versions.findMany({
        where: {
            status: CURRENT_VERSION_STATUS,
            nutrition_provenance: SOURCE_BACKED_PROVENANCE,
            allergen_status: REVIEWED_ALLERGEN_STATUS,
        },
        select: {
            id: true,
            recipe_id: true,
            version: true,
            // Projected even though the predicates above pin these three: the
            // shared mapper narrows each column rather than trusting a WHERE
            // clause it cannot see, which is what lets the same mapper serve
            // getPlanningRecipeVersionsByIds, where all three genuinely vary.
            status: true,
            nutrition_provenance: true,
            allergen_status: true,
            total_minutes: true,
            meal_slots: true,
            budget_tier: true,
            per_serving_calories: true,
            per_serving_protein_g: true,
            per_serving_carbs_g: true,
            per_serving_fat_g: true,
            recipes: { select: { slug: true } },
            recipe_ingredients: { select: PLANNING_INGREDIENT_SELECT, orderBy: INGREDIENT_ORDER },
        },
        orderBy: [{ recipes: { slug: 'asc' } }, { version: 'asc' }],
    });

    return versions.map(toPlanRecipeCandidate);
};

/**
 * Loads one corpus once, and records it under its stamp.
 *
 * The cache write happens on the promise's own `then`, so every caller that
 * joined an in-flight load sees the same array, and a REJECTED load writes
 * nothing — the next call re-reads the stamp and tries again.
 *
 * A LATE LOAD CANNOT POISON THE CACHE. Two loads for different stamps can be in
 * flight at once, and the one that finishes second wins the entry regardless of
 * which corpus is newer. That is harmless precisely because the entry is
 * content-addressed: whichever entry is resident is served only to a caller
 * whose own stamp equals it, so "the older corpus won" costs a later reload and
 * never a stale answer.
 */
const loadPlanningCandidatesForStamp = (
    db: Prisma.TransactionClient,
    stamp: string,
): Promise<readonly PlanRecipeCandidate[]> => {
    const inFlight = inFlightPlanningLoads.get(stamp);

    if (inFlight !== undefined) {
        return inFlight;
    }

    const load = loadPlanningCandidates(db)
        .then((candidates) => {
            planningCandidateCache = { stamp, candidates };

            return candidates;
        })
        .finally(() => {
            inFlightPlanningLoads.delete(stamp);
        });

    inFlightPlanningLoads.set(stamp, load);

    return load;
};

/**
 * Every plannable recipe version, as the candidate shape the planner and the
 * swap selector both consume.
 *
 * SERVED FROM A FRESHNESS-VALIDATED PROCESS-LOCAL CACHE.
 * {@link loadPlanningCandidates} above reads the whole plannable corpus — every
 * current source-backed recipe version, its ingredients and those ingredients'
 * catalog foods — and it ran on EVERY alternatives and preview request, which
 * made the dominant term of both reads
 * proportional to the catalog rather than to the request. It is now issued only
 * when the corpus has actually changed: each call spends ONE statement on
 * {@link readPlanningCorpusStamp} and reuses the candidates behind that stamp.
 * The three rejected alternatives, and why a per-read content hash is the only
 * correct invalidation for a corpus written by other processes, are recorded
 * with that statement.
 *
 * THE RESULT IS A SHALLOW COPY of the cached array, and the copy is the contract
 * the return type states: a mutable `PlanRecipeCandidate[]`, so a consumer may
 * sort or truncate what it is handed, and the cached order is unaffected. The
 * ELEMENTS are shared, so a caller must treat a candidate and its nested
 * `per_serving` and `ingredients` as read-only — nothing does otherwise today
 * (`swap.logic.ts::selectSwapCandidates` and
 * `mealPlan.logic.ts::buildPlanCandidates` both build fresh arrays and sort
 * those), and a consumer that needs to change a candidate must copy it.
 *
 * WHAT THAT READ'S WHERE CLAUSE FILTERS, and why it is not a second
 * eligibility rule. Three predicates define the plannable UNIVERSE, and all three are
 * properties of the recipe alone — no user, no preference, no request: the
 * version is `current`, its rolled-up nutrition is `source_backed`, and its
 * rolled-up allergen review is `known`. A row failing any of them is
 * unplannable for every user who will ever exist, so excluding it in the query
 * removes rows that could never be chosen rather than deciding anything. It is also
 * the direction a mistake has to fail in: the set handed to the search cannot
 * contain an estimate or an unreviewed dish even if a future caller forgot to
 * ask the rules.
 *
 * WHAT IT DELIBERATELY DOES NOT FILTER is everything that depends on the user
 * — diet, allergens, dislikes, the cooking-time limit and slot membership —
 * plus the per-ingredient half of provenance and review. Those stay with
 * `recipe.logic.ts::evaluatePlanningEligibility`, the SINGLE implementation the
 * generator, the swap selector and flag recomputation all call, because that is
 * the half where two copies would eventually disagree and one of them would
 * start serving an allergen (§5 "no business rules inline"). The rules
 * re-check the three columns themselves as well, so the query narrows the input
 * and the logic still owns every verdict.
 *
 * THE ORDER IS `slug, version`, AND IT IS LOAD-BEARING. The planner's candidate
 * pre-order is the portable identity `(slug, version, portion_multiplier)`
 * precisely because primary keys are `gen_random_uuid()` and differ between two
 * independently loaded databases; the seeded shuffle then walks that pre-order
 * once. Handing the search a set ordered by anything database-specific would
 * make the same inputs produce different plans on two machines holding the same
 * release — the determinism the second-database acceptance evidence checks. The
 * pair is unique (`recipes.slug` is unique and `(recipe_id, version)` is), so
 * the order is total.
 *
 * NO `userId` PARAMETER, by the §5.1 exception this file's header states:
 * recipes are shared reference data with no owner column, so there is nothing
 * to scope, and a parameter accepted only to be ignored would suggest otherwise.
 * The per-user half of planning is the PREFERENCES the caller passes to the
 * eligibility rules, which is where it belongs.
 *
 * Read whole rather than paged: forty-odd recipes with their ingredients is the
 * entire plannable universe, the in-memory search needs all of it before the
 * transaction opens (AAP §0.5.1), and a paged read would be a second source of
 * candidate ordering.
 */
export const getRecipeVersionsForPlanning = async (
    db: Prisma.TransactionClient = prisma,
): Promise<PlanRecipeCandidate[]> => {
    const stamp = await readPlanningCorpusStamp(db);

    // Freshness could not be established, so nothing may be served from the
    // cache and nothing may be written to it: this call reads the corpus, which
    // is what every call did before the cache existed.
    if (stamp === null) {
        return [...(await loadPlanningCandidates(db))];
    }

    const cached = planningCandidateCache;

    if (cached !== null && cached.stamp === stamp) {
        return [...cached.candidates];
    }

    return [...(await loadPlanningCandidatesForStamp(db, stamp))];
};
