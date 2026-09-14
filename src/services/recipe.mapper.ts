// The row -> DTO boundary for recipe versions: the one place a `recipe_versions`
// row and its `recipe_ingredients` rows become the camelCase wire shapes
// `src/types/recipe.ts` and `src/types/mealPlanning.ts` declare and the mobile
// io-ts codecs decode (`convertRecipeVersion.ts`). One shape, one mapper — a
// second builder for any of these responses is drift, and drift here is a
// client that stops decoding.
//
// A file of its own rather than a private const in `recipe.service.ts` because
// THREE services need it (Rule backend-architecture §6):
//
//  * `recipe.service.ts` — the full body of GET /api/recipes/:recipeVersionId,
//    through `mapRecipeVersion`. That service owns the read-visibility rule for
//    a retired version; this file maps whichever version it is handed.
//  * `mealPlan.mapper.ts` — the compact `recipe` projection carried on every
//    planned meal, through `mapPlannedRecipeSummary`. That composite mapper
//    composes this one, which is why each function below is separately
//    callable: §6's "composite responses get their own mapper that composes the
//    smaller ones" only works if the smaller ones can be called alone.
//  * `swap.service.ts` — the alternative rows, through `mapSwapAlternative`,
//    and the preview's full recipe, through `mapRecipeVersion`.
//
// Pure and synchronous throughout — no Prisma client, no fetch, no clock, no
// `process.env`. Rows arrive as arguments because the service owns every query.
// The row types below are structural snake_case interfaces rather than Prisma's
// generated models, matching `catalog.mapper.ts`: a caller reading through
// `$queryRaw` has no model type to offer, and a mapper that demanded one would
// push its callers into casts.
//
// Six conventions this file holds the line on:
//
//  * A BROKEN PROMISE IS A FAULT, NOT A DEFAULT. Every field
//    `src/types/recipe.ts` declares non-optional is backed by a NOT NULL
//    column, so a row that cannot supply one is drift rather than a client
//    condition and this file throws `RecipeMappingError`. That applies with
//    most force to the two safety lists and to the instructions: an empty
//    `allergenTags` is the claim "contains none of the named allergens" and an
//    empty `instructions` is a recipe that cannot be cooked, so neither may be
//    manufactured from an absent value. `reps ?? 0` is a safe default;
//    `allergenTags ?? []` is a false safety claim. What DOES degrade is named
//    on `mapRecipeVersion`, and it is one thing only: an unrecognised member of
//    the two closed-set code lists.
//
//  * THE SNAPSHOT IS THE SOURCE. An ingredient's name and provenance come from
//    the frozen `recipe_ingredients` snapshot columns, never from a joined
//    `catalog_foods` row — see `mapRecipeIngredient`. This is the load-bearing
//    rule of the file.
//
//  * NOTHING IS RECOMPUTED. `perServing` reads the stored `per_serving_*`
//    columns and `totalMinutes` the stored `total_minutes`. Both were derived
//    at publication by `recipe.logic.ts` from the ingredient snapshots; a
//    second derivation here would disagree with the stored values the moment
//    the catalog moved on, which is the precise drift the snapshot design
//    exists to prevent. Portion scaling and display rounding are also
//    `recipe.logic.ts`'s (`scalePlannedNutrition`, `roundNutritionForDisplay`),
//    which is why `mapSwapAlternative` is HANDED its nutrition.
//
//  * NO PLANNED-MEAL CONTEXT. A recipe response carries no portion multiplier,
//    planned nutrition, slot, time, logged state or plan revision. Those come
//    from GET /meal-planning/plans/:planId/days/:date and belong to
//    `mealPlan.mapper.ts`; restating them here would give the same numbers two
//    sources of truth.
//
//  * CODES GO ON THE WIRE, NEVER PROSE. `iconKey`, `badges`, `dietTags`,
//    `allergenTags`, `allergenStatus`, `nutritionProvenance` and `status`
//    travel as the codes the database stores. The mobile app renders them
//    through `src/constants/strings.ts`, where the badge labels ("High
//    protein", "Gluten free", "Dairy free") live, and `MealIconTile` owns the
//    icon-key -> component table. Labelling here would hard-code English into
//    the API and duplicate a mapping the client already owns.
//
//  * NAMES ARE DATA. Recipe and ingredient names pass through untouched — no
//    title-casing, no trimming. They are curated before publication, and
//    re-casing them would corrupt deliberate spellings.
//
// Not this file's job: deciding anything. Every recipe RULE — nutrition
// derivation, badge and tag derivation, eligibility, staleness, ingredient
// ordering — lives in `recipe.logic.ts` under unit test. This file reshapes,
// which is also why it is `recipe.mapper.ts` and not a second `*.logic.ts`:
// `jest.config.ts` derives one coverage threshold per `src/services/*.logic.ts`
// on disk and `coverageInventory.test.ts` fails the run when that set drifts.
// §11 covers mappers by integration — `src/__tests__/api/recipes.test.ts`,
// `api/plans.test.ts` and `api/swaps.test.ts` assert these shapes end to end.

import { MealPlanMealRecipeSummary, SwapAlternative } from '../types/mealPlanning';
import { RecipeIngredientResponse, RecipePerServingNutrition, RecipeVersionResponse } from '../types/recipe';
import { mapIngredientSnapshot, RecipeIngredientSnapshotRow } from './catalog.mapper';
import { isMealSlot, isRecipeBadge, isRecipeIconKey } from './recipe.logic';

/* ---------------------------------------------------------------------------
 * The one failure this boundary can have
 * ------------------------------------------------------------------------- */

/**
 * A stored row contradicted a guarantee `src/types/recipe.ts` makes to the
 * client: a code column holding a value outside its closed set, a required
 * TEXT[] column that is absent or is not an array of strings, an instruction
 * list that is absent, not an array or empty, an instruction step that is not a
 * string, or a planned recipe whose nutrition is not source-backed.
 *
 * Loud on purpose, because every one of these is prevented upstream —
 * `recipe.logic.ts` owns the closed sets, `scripts/recipes-seed.ts` refuses a
 * file that violates one, and planning eligibility admits only source-backed
 * recipes — so reaching this error means a row was written around that
 * pipeline. The quiet alternatives are worse than a 500: emitting the stored
 * value breaks a field the mobile decoder declares as a closed union, failing
 * the whole response rather than the one bad field, and substituting a
 * plausible code states a fact about the recipe that nothing established.
 *
 * `reps ?? 0` is a safe default; `allergenStatus ?? 'known'` is a false safety
 * claim. That distinction is what this class encodes, and it is the same one
 * `CatalogMappingError` encodes one layer down.
 */
export class RecipeMappingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RecipeMappingError';
    }
}

/* ---------------------------------------------------------------------------
 * Row inputs — snake_case, exactly as stored
 * ------------------------------------------------------------------------- */

/**
 * One `recipe_ingredients` row: its frozen catalog identity plus the recipe's
 * own quantity facts.
 *
 * Extends the snapshot row `catalog.mapper.ts` declares rather than restating
 * those eight columns, so the two halves of an ingredient cannot drift apart.
 *
 * The code column arrives as `string` and the JSONB column as `unknown`
 * because that is what the database holds and what a `$queryRaw` projection
 * hands back; both are narrowed on the way out by `mapIngredientSnapshot`.
 */
export interface RecipeIngredientRow extends RecipeIngredientSnapshotRow {
    quantity: number;
    unit: string;
    /** Grams of this ingredient in the WHOLE recipe, which yields `yield_servings` servings. */
    gram_weight: number;
    display_text: string;
    is_optional: boolean;
}

/**
 * A `recipe_versions` row, narrowed to the columns the wire shapes need.
 *
 * Absent by design: `sourced_calories_note` (an internal record of a rounding
 * divergence, not a client contract), `published_at` and `retired_at` (no
 * response renders them), and every relation. A caller may pass a wider row —
 * a full Prisma model satisfies this type structurally.
 *
 * The code columns are `string` and `budget_tier` a plain `number` because the
 * columns are TEXT and SMALLINT with no Prisma enum and no CHECK constraint,
 * deliberately, so that `recipe.logic.ts` and the seed are the single
 * enforcement point for the closed sets. They are narrowed on the way out,
 * here, so no caller carries a cast.
 *
 * `instructions` is `unknown` because the column is JSONB: the generated client
 * types it as a JSON value and a raw projection as whatever it finds, so it is
 * read defensively rather than asserted.
 *
 * The four list columns are NOT NULL — `meal_slots` unconditionally and
 * `diet_tags`, `allergen_tags` and `badges` with `DEFAULT ARRAY[]::TEXT[]`
 * (`prisma/migrations/20260908000000_meal_planning/migration.sql`) — so they are
 * typed non-null here, which is what stops a caller from reaching for a default
 * that the schema says cannot be needed. They are still READ through
 * `requireStringArray` below, because this type is a claim about the projection
 * rather than a proof of it: `$queryRaw<RecipeVersionRow[]>` asserts the shape
 * of whatever the statement returns, so a column dropped from a projection, a
 * view, or a row written around the migration can still arrive as `null` or as
 * something that is not an array of strings.
 */
export interface RecipeVersionRow {
    id: string;
    recipe_id: string;
    version: number;
    name: string;
    description: string | null;
    icon_key: string;
    instructions: unknown;
    yield_servings: number;
    serving_description: string;
    prep_minutes: number;
    cook_minutes: number;
    /** `prep_minutes + cook_minutes` as `recipe.logic.ts::deriveTotalMinutes` computed it at publication. */
    total_minutes: number;
    meal_slots: string[];
    diet_tags: string[];
    allergen_tags: string[];
    allergen_status: string;
    budget_tier: number;
    badges: string[];
    nutrition_provenance: string;
    per_serving_calories: number;
    per_serving_protein_g: number;
    per_serving_carbs_g: number;
    per_serving_fat_g: number;
    status: string;
}

/* ---------------------------------------------------------------------------
 * The two shared projections — declared in `src/types`, not restated here
 * ------------------------------------------------------------------------- */

// The planned-meal recipe projection and the swap alternatives row are
// `MealPlanMealRecipeSummary` and `SwapAlternative`, imported above from
// `types/mealPlanning.ts` and returned by `mapPlannedRecipeSummary` and
// `mapSwapAlternative` below. They live there rather than here because the wire
// shape itself belongs to `src/types/<domain>.ts` (Rule backend-architecture
// §2), and because they are members of the plan-day and alternatives responses
// `mealPlan.mapper.ts` and `swap.service.ts` assemble — a structurally
// identical local copy would be a second declaration of one contract that
// nothing compares, free to drift the moment either side gains a field, which
// is the exact failure §6's "one shape, one mapper" exists to prevent.
//
// Both DTOs carry their own field-level rationale —
// `MealPlanMealRecipeSummary` documents why `nutritionProvenance` is the single
// `'source_backed'` literal rather than the provenance union, and
// `SwapAlternative` why a candidate with no admissible portion is not listed at
// all. This file documents only what the MAPPING decides, on the two functions.

/* ---------------------------------------------------------------------------
 * Reading a stored column into the type the contract promises
 * ------------------------------------------------------------------------- */

// The closed sets below are keyed off the response type itself
// (`Readonly<Record<RecipeVersionResponse['status'], true>>` and friends), so
// they are exhaustive by construction: widen one of those unions and this
// object literal stops compiling until the new code is handled here. That is
// what makes a runtime membership set safe to write at all — a hand-listed
// array of the same strings would silently fall behind the contract.
//
// These four columns get a local set because `recipe.logic.ts` exports no guard
// for them; the three that HAVE a guard there (`isRecipeIconKey`, `isMealSlot`,
// `isRecipeBadge`) use it, so the membership DECISION stays in the logic layer
// and this file only applies it at the boundary. Narrowing is not validation:
// the response type declares these fields as closed unions, so a mapper that
// passed a bare `string` through would not compile, and the strict membership
// check that REJECTS a bad code still belongs to the seed.

const VERSION_STATUSES: Readonly<Record<RecipeVersionResponse['status'], true>> = {
    current: true,
    retired: true,
};

const ALLERGEN_STATUSES: Readonly<Record<RecipeVersionResponse['allergenStatus'], true>> = {
    known: true,
    unknown: true,
};

const NUTRITION_PROVENANCES: Readonly<Record<RecipeVersionResponse['nutritionProvenance'], true>> = {
    source_backed: true,
    ingredient_derived: true,
    ai_estimated: true,
};

const BUDGET_TIERS: Readonly<Record<RecipeVersionResponse['budgetTier'], true>> = {
    1: true,
    2: true,
    3: true,
};

const isVersionStatus = (value: unknown): value is RecipeVersionResponse['status'] =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(VERSION_STATUSES, value);

const isAllergenStatus = (value: unknown): value is RecipeVersionResponse['allergenStatus'] =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(ALLERGEN_STATUSES, value);

const isNutritionProvenance = (value: unknown): value is RecipeVersionResponse['nutritionProvenance'] =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(NUTRITION_PROVENANCES, value);

const isBudgetTier = (value: unknown): value is RecipeVersionResponse['budgetTier'] =>
    typeof value === 'number' && Object.prototype.hasOwnProperty.call(BUDGET_TIERS, value);

/**
 * Narrows a stored column to the closed set the contract declares, throwing on
 * anything else.
 *
 * The guard does the deciding; this only applies it at the boundary and names
 * the column and the version in the failure, so an operator reading the log
 * knows which column of which row to repair.
 */
const narrowColumn = <T>(
    value: unknown,
    isMember: (candidate: unknown) => candidate is T,
    column: string,
    versionId: string,
): T => {
    if (!isMember(value)) {
        throw new RecipeMappingError(
            `recipe_versions.${column} holds unsupported value '${String(value)}' for version ${versionId}`,
        );
    }

    return value;
};

/**
 * A required TEXT[] column as the array the contract promises, throwing on
 * anything else.
 *
 * `meal_slots`, `diet_tags`, `allergen_tags` and `badges` are all NOT NULL, so
 * an absent value is drift or corruption rather than a state the schema admits
 * — and for the two SAFETY columns a default would be the worst possible
 * reading of it. `dietTags` and `allergenTags` are the derived union of every
 * ingredient's frozen tags (§0.7.3, `recipe.logic.ts::deriveAllergenTags`), and
 * planning eligibility compares the user's allergens against exactly that
 * union, so `[]` does not mean "unknown" on this contract: it means "contains
 * none of the nine named allergens" and "carries no dietary restriction". A
 * `?? []` here would publish that claim on behalf of a row that never made it,
 * which is the `allergenStatus ?? 'known'` side of the distinction
 * {@link RecipeMappingError} draws.
 *
 * It reads `unknown` rather than `string[]` deliberately, even though
 * {@link RecipeVersionRow} now types these columns non-null: that type is a
 * claim a `$queryRaw` projection makes about its own statement, not a proof, so
 * the check has to survive it. A non-string MEMBER throws for the same reason —
 * `filter(isMealSlot)` would quietly drop a number, understating the recipe's
 * slots or badges, and on a tag column there is no filter at all, so a
 * non-string would reach the client inside a field it declares `string[]`.
 */
const requireStringArray = (value: unknown, column: string, versionId: string): string[] => {
    if (!Array.isArray(value)) {
        throw new RecipeMappingError(
            `recipe_versions.${column} is ${value === null ? 'null' : typeof value}, not an array, for ` +
                `version ${versionId}; the column is NOT NULL, and an empty list here would state that the ` +
                'recipe carries none of these values rather than that they are unknown',
        );
    }

    return value.map((member, index) => {
        if (typeof member !== 'string') {
            throw new RecipeMappingError(
                `recipe_versions.${column}[${index}] is ${typeof member}, not a string, for version ` +
                    `${versionId}`,
            );
        }

        return member;
    });
};

/**
 * The `instructions` JSONB column as the ordered list of steps the client
 * renders.
 *
 * A root that is not an array THROWS, and so does an empty one. The column is
 * `JSONB NOT NULL` holding the steps `scripts/recipes-seed.ts` published, and a
 * published recipe has steps — frame 12 renders them as the numbered list a
 * user cooks from, and §0.5.2 declares `instructions: string[]` as part of what
 * a recipe IS. So neither absence nor emptiness is a state the write path can
 * produce, and reading either as "no instructions" would hand the user a recipe
 * that looks complete and cannot be followed: the screen renders a title,
 * badges, nutrition, an ingredient list and then nothing, with no way to tell
 * that the steps were lost rather than never written. A non-string INSIDE the
 * array throws for the adjacent reason: dropping it would silently renumber the
 * steps.
 */
const readInstructions = (value: unknown, versionId: string): string[] => {
    if (!Array.isArray(value)) {
        throw new RecipeMappingError(
            `recipe_versions.instructions is ${value === null ? 'null' : typeof value}, not an array, for ` +
                `version ${versionId}; a published recipe carries the steps it is cooked from`,
        );
    }

    if (value.length === 0) {
        throw new RecipeMappingError(
            `recipe_versions.instructions is empty for version ${versionId}; a published recipe carries at ` +
                'least one step, so an empty list is lost data rather than a recipe with nothing to do',
        );
    }

    return value.map((step, index) => {
        if (typeof step !== 'string') {
            throw new RecipeMappingError(
                `recipe_versions.instructions[${index}] is ${typeof step}, not a string, ` +
                    `for version ${versionId}`,
            );
        }

        return step;
    });
};

/* ---------------------------------------------------------------------------
 * One ingredient — the frozen snapshot plus the recipe's own quantity
 * ------------------------------------------------------------------------- */

/**
 * One `recipe_ingredients` row as the recipe detail and swap preview carry it.
 *
 * THE LOAD-BEARING RULE OF THIS FILE: `name` and `nutritionProvenance` come
 * from the frozen `snapshot_*` columns, through `catalog.mapper.ts`'s
 * `mapIngredientSnapshot`, and never from a joined `catalog_foods` row — not
 * even when the caller has already loaded one. `recipe_ingredients` freezes
 * identity, display, provenance and safety metadata at publication precisely
 * so that a historical plan, a recipe detail for a retired version and a diary
 * entry logged months ago keep reporting what the recipe was published with. A
 * catalog refresh renames foods, re-derives nutrition and bumps both version
 * counters; reading the live row here would silently rewrite the past
 * everywhere those three responses are built, and because allergen and diet
 * tags are part of the snapshot it could restate a SAFETY claim after the fact.
 * Staleness is detected instead — `recipe.logic.ts::findStaleIngredients`
 * compares both counters and the seed publishes a NEW version.
 *
 * `catalogFoodId` is still emitted: the client needs it for provenance display
 * and it is the grocery list's canonical identity. Only the DISPLAYED name and
 * provenance are the frozen ones.
 *
 * `isOptional` is emitted because it changes what the user reads: an optional
 * ingredient still counts toward the allergen union
 * (`recipe.logic.ts::deriveAllergenTags` includes it), so a client that could
 * not distinguish it would imply the recipe requires something it merely
 * allows.
 *
 * EVERY AMOUNT HERE IS A WHOLE-RECIPE AMOUNT — `quantity`, `gramWeight` and
 * the pre-formatted `displayText` alike — because that is what
 * `recipe_ingredients` stores: the recipe as published, which yields
 * `yieldServings` servings. Nothing on this projection is scaled, and nothing
 * on it could be: a recipe response carries no planned-meal context, so the
 * portion is not known here (see the NO PLANNED-MEAL CONTEXT convention). A
 * consumer showing one portion derives it — `quantity × portionMultiplier /
 * yieldServings` — from the multiplier its own response carries beside the
 * recipe: `MealPlanMealResponse.portionMultiplier` for a planned meal,
 * `SwapPreviewAlternative.portionMultiplier` for the swap preview. Both mobile
 * screens do exactly that through one shared helper —
 * `mobile/src/utility/ServingsUtility.ts`, where `plannedPortionFactor` turns
 * the multiplier and the yield into one factor and `scaleIngredientsForDisplay`
 * applies it to every ingredient row — which is what keeps the amounts on screen
 * consistent with the portion-scaled nutrition beside them.
 */
export const mapRecipeIngredient = (ingredient: RecipeIngredientRow): RecipeIngredientResponse => {
    const snapshot = mapIngredientSnapshot(ingredient);

    return {
        catalogFoodId: snapshot.catalogFoodId,
        name: snapshot.name,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
        gramWeight: ingredient.gram_weight,
        displayText: ingredient.display_text,
        nutritionProvenance: snapshot.nutritionProvenance,
        isOptional: ingredient.is_optional,
    };
};

/* ---------------------------------------------------------------------------
 * The full recipe version
 * ------------------------------------------------------------------------- */

/**
 * A `recipe_versions` row and its ingredients as GET
 * /api/recipes/:recipeVersionId and the swap preview carry it.
 *
 * `ingredients` is emitted in the order given. Ordering is the caller's: the
 * service reads them `ORDER BY sort_order`, and `recipe.logic.ts` owns the
 * canonical order every derivation walks. A second, disagreeing sort here
 * would renumber an ingredient list against the instructions that reference it.
 *
 * `perServing` reads the stored columns. `recipes-seed.ts` derived them through
 * `recipe.logic.ts::deriveRecipeNutrition` from the ingredient snapshots at
 * publication — which also means they are finite by construction, since that
 * derivation throws on a non-finite nutrient rather than storing one. Summing
 * the snapshots again here would produce the same numbers today and different
 * ones after any catalog change, so the stored value is the only honest source.
 *
 * `status` travels so the client can tell a `retired` version — reachable only
 * through a historical plan or a diary link — from the `current` one.
 *
 * `dietTags` and `allergenTags` pass through as stored, unnarrowed: the
 * contract leaves them open `string[]` because they are taxonomies drawn from
 * catalog food metadata, and a legitimate new tag must not become a failure
 * here.
 */
export const mapRecipeVersion = (
    version: RecipeVersionRow,
    ingredients: readonly RecipeIngredientRow[],
): RecipeVersionResponse => ({
    versionId: version.id,
    recipeId: version.recipe_id,
    version: version.version,
    status: narrowColumn(version.status, isVersionStatus, 'status', version.id),
    name: version.name,
    // The nullable column meets the non-null contract here: an empty description
    // asserts nothing and renders exactly what null rendered, which puts it on the
    // `reps ?? 0` side of the distinction `RecipeMappingError` draws rather than the
    // `allergenStatus ?? 'known'` side. Throwing instead would turn a legitimately
    // description-less recipe into a 500.
    description: version.description ?? '',
    iconKey: narrowColumn(version.icon_key, isRecipeIconKey, 'icon_key', version.id),
    instructions: readInstructions(version.instructions, version.id),
    yieldServings: version.yield_servings,
    servingDescription: version.serving_description,
    prepMinutes: version.prep_minutes,
    cookMinutes: version.cook_minutes,
    totalMinutes: version.total_minutes,
    // All four list columns are READ through `requireStringArray`, so an absent
    // or malformed one fails the response instead of becoming an empty list.
    // The two SAFETY columns are why: `allergenTags` and `dietTags` are the
    // derived union of every ingredient's frozen tags, so `[]` is the positive
    // claim "contains none of the named allergens, carries no dietary
    // restriction" — a claim `?? []` would make on behalf of a row that never
    // made it.
    //
    // What still degrades is an unrecognised MEMBER of the two code lists, and
    // only there: `filter` drops it rather than throwing, which is what the
    // mobile converter already does ("Unknown slot and badge codes are dropped,
    // never substituted"), so client and server agree on the same wire value.
    // Dropping a member states less, which is honest; failing the whole recipe
    // over one unrecognised code would take the screen down for exactly the
    // future value this contract is designed to survive. Neither list decides
    // anything here either — planning eligibility reads the meal_slots COLUMN
    // through `recipe.logic.ts`, never this DTO — and the loud rejection of an
    // out-of-set code belongs to `recipes-seed.ts`, where it can still be
    // fixed. The two TAG lists have no filter at all, because their vocabulary
    // is deliberately open (`src/types/recipe.ts`), which is the second reason
    // a non-string member throws rather than being dropped. The single-value
    // code columns cannot degrade either way: there is nothing to omit, and
    // substituting a plausible code would state a fact about the recipe that
    // nothing established.
    mealSlots: requireStringArray(version.meal_slots, 'meal_slots', version.id).filter(isMealSlot),
    badges: requireStringArray(version.badges, 'badges', version.id).filter(isRecipeBadge),
    dietTags: requireStringArray(version.diet_tags, 'diet_tags', version.id),
    allergenTags: requireStringArray(version.allergen_tags, 'allergen_tags', version.id),
    allergenStatus: narrowColumn(version.allergen_status, isAllergenStatus, 'allergen_status', version.id),
    budgetTier: narrowColumn(version.budget_tier, isBudgetTier, 'budget_tier', version.id),
    nutritionProvenance: narrowColumn(
        version.nutrition_provenance,
        isNutritionProvenance,
        'nutrition_provenance',
        version.id,
    ),
    perServing: {
        calories: version.per_serving_calories,
        protein: version.per_serving_protein_g,
        carbs: version.per_serving_carbs_g,
        fat: version.per_serving_fat_g,
    },
    ingredients: ingredients.map(mapRecipeIngredient),
});

/* ---------------------------------------------------------------------------
 * The compact projection a planned meal carries
 * ------------------------------------------------------------------------- */

/** The provenance every planned recipe has, by eligibility rather than by coincidence. */
const PLANNED_RECIPE_PROVENANCE: MealPlanMealRecipeSummary['nutritionProvenance'] = 'source_backed';

/**
 * The recipe fields a plan card and a swap row render.
 *
 * Seven fields, not the full recipe: the plan day response embeds one of these
 * per meal, and GET /recipes/:recipeVersionId serves the rest when the user
 * opens a card. Nothing about the PLANNED meal appears here — the portion
 * multiplier, planned nutrition, slot, time and logged state belong to the
 * planned meal that carries this projection, not to the recipe.
 *
 * `nutritionProvenance` is asserted against the stored column rather than
 * assumed. Planning admits only recipes whose every ingredient is source-backed
 * (`recipe.logic.ts::evaluatePlanningEligibility`), so the literal is true by
 * construction — but emitting it for a row that says otherwise would present an
 * ingredient-derived or AI-estimated figure as verified nutrition, the one
 * claim this product never makes. If this throws, the eligibility rule was
 * broken upstream, and that is worth a 500 rather than a quiet mislabel.
 */
export const mapPlannedRecipeSummary = (version: RecipeVersionRow): MealPlanMealRecipeSummary => {
    if (version.nutrition_provenance !== PLANNED_RECIPE_PROVENANCE) {
        throw new RecipeMappingError(
            `planned recipe version ${version.id} has nutrition_provenance ` +
                `'${version.nutrition_provenance}'; planning admits '${PLANNED_RECIPE_PROVENANCE}' only, ` +
                'so a planned meal is never presented as an estimate',
        );
    }

    return {
        versionId: version.id,
        recipeId: version.recipe_id,
        name: version.name,
        iconKey: narrowColumn(version.icon_key, isRecipeIconKey, 'icon_key', version.id),
        totalMinutes: version.total_minutes,
        badges: requireStringArray(version.badges, 'badges', version.id).filter(isRecipeBadge),
        nutritionProvenance: PLANNED_RECIPE_PROVENANCE,
    };
};

/* ---------------------------------------------------------------------------
 * One swap alternative row
 * ------------------------------------------------------------------------- */

/**
 * One candidate as the alternatives list renders it: a name, a meta line
 * ("540 cal · 38g protein · 15 min") and the portion it would be planned at.
 *
 * `nutrition` is the candidate AT `portionMultiplier`, already scaled and
 * rounded by the caller through `recipe.logic.ts::scalePlannedNutrition` and
 * `roundNutritionForDisplay`. Scaling it here would put that rule in a second
 * place and let the row disagree with the preview and the committed meal, which
 * are computed the same way. Only calories and protein are projected — carbs
 * and fat are accepted so the caller can hand over the totals it already has,
 * and dropping them is what keeps this row the narrow shape the screen needs.
 *
 * There is no calorie delta on this row by design: the day's delta is shown on
 * the preview, against the day the candidate would actually produce.
 */
export const mapSwapAlternative = (
    version: RecipeVersionRow,
    portionMultiplier: number,
    nutrition: RecipePerServingNutrition,
): SwapAlternative => ({
    recipeVersionId: version.id,
    name: version.name,
    iconKey: narrowColumn(version.icon_key, isRecipeIconKey, 'icon_key', version.id),
    calories: nutrition.calories,
    protein: nutrition.protein,
    totalMinutes: version.total_minutes,
    portionMultiplier,
});
