// The pure recipe domain: what a recipe's nutrition IS, which badges it may
// honestly claim, which diets and allergens its ingredients imply, and whether
// it may enter a meal plan at all.
//
// Everything here is deterministic and synchronous — no Prisma, no network, no
// filesystem, no `process.env`, no clock. The rows this module reads are
// declared below as structural snake_case interfaces rather than imported
// Prisma types, so every rule is unit-testable from plain object literals.
// `recipe.service.ts` owns every await and `scripts/recipes-seed.ts` owns file
// reading and the publish transaction; both DERIVE through this module rather
// than reimplementing a rule, because each of the rules below is one a
// reimplementation could get subtly — and unsafely — wrong.
//
// Five conventions are worth stating once, because all five are load-bearing
// and every one of them is pinned by a test:
//
//  * THE SNAPSHOT IS THE SOURCE. Every derivation reads the frozen
//    `recipe_ingredients` snapshot columns (`snapshot_per_100g`,
//    `snapshot_name`, `snapshot_provenance`, `snapshot_allergen_tags`,
//    `snapshot_diet_tags`) and never a live `catalog_foods` row. That is what
//    guarantees a catalog refresh cannot change an existing `recipe_versions`
//    row: a plan built in July still reports July's numbers and a diary entry
//    logged months ago keeps its snapshot. Staleness is DETECTED instead —
//    see `isIngredientSnapshotStale`, which compares BOTH version counters —
//    and a stale snapshot publishes a NEW version rather than editing one.
//
//  * NOTHING IS ROUNDED HERE. Derived totals and per-serving values are carried
//    at full precision. The rounding contract rounds exactly once at each of
//    two named points — `roundNutritionForDisplay` for recipe detail and plan
//    cards, and the diary snapshot inside
//    `nutrition.service.ts::insertPlannedMealEntry`, whose stored per-serving
//    integers `nutrition.service.ts::asEaten` then multiplies by the servings
//    eaten. An extra round anywhere in this module shifts every number
//    downstream of it and is exactly why the mobile "This adds" card would stop
//    agreeing with the server to the integer.
//
//  * CLAIMS ARE DERIVED, NEVER ACCEPTED. Badges, diet tags, allergen tags, the
//    allergen status, the nutrition provenance, the total time and the budget
//    tier are all computed from the ingredient set. A recipe file's declared
//    values are only ever COMPARED with the derivation
//    (`validateRecipeDeclaration`), so a file cannot talk its way to a
//    "Gluten free" badge, and a mismatch names the ingredient that contradicts
//    it. The recipe-level `diet_tags`/`allergen_tags` columns are the
//    seed-validated summary of this derivation, never an independent claim.
//
//  * THE SAFE DEFAULT IS ABSENCE. Where metadata is unknown, a claim is
//    omitted and eligibility is refused — never the reverse. An ingredient
//    whose allergen review is `unknown` blocks "Dairy free" and blocks planning
//    for EVERY user, whatever they selected, because a food we cannot describe
//    cannot be certified safe for anyone. A null nutrient means unknown and is
//    never coerced to 0: a sum missing a term is not a smaller sum.
//
//  * VERDICTS ARE RETURNED, NOT THROWN. Eligibility answers with its reasons
//    and declaration validation answers with its mismatches, because the caller
//    has to report per-field problems (the seed fails a file naming the recipe
//    and the offending ingredient; the planner turns the four preference codes
//    into `meal_plan_meals.flags`). Throwing is reserved for input that could
//    only be a programming or data-integrity error: `RecipeDerivationError`
//    below, and the `UnitConversionError` that `millilitersToGrams` raises for
//    a missing density — which is deliberately NOT caught here, because
//    assuming millilitres equal grams is a ~9 % calorie error on oil and worse
//    on honey.
//
// Not this module's job: reading or writing anything, shaping a wire DTO
// (`recipe.mapper.ts` owns snake_case → camelCase), the read-visibility rule
// for a retired version (`recipe.service.ts::getRecipeVersionForUser`), plan
// search and scoring (`mealPlan.logic.ts`), swap candidate ranking
// (`swap.logic.ts`), grocery aggregation (`grocery.logic.ts`), and the
// catalog-side facts about a food's publication status
// (`catalog.logic.ts::isRecipeEligibleCatalogFood`).

import { normalizeCanonicalName, PER_100G_BASIS_AMOUNT } from './catalog.logic';
import { NutritionProvenance } from '../types/nutrition';
import {
    MEAL_SLOTS,
    MealSlot,
    RECIPE_BADGES,
    RECIPE_ICON_KEYS,
    RecipeBadge,
    RecipeIconKey,
    RecipeNutritionProvenance,
    RecipePerServingNutrition,
} from '../types/recipe';
import { formatQuarters, millilitersToGrams, unitFamily } from '../utils/units';

/* ---------------------------------------------------------------------------
 * Errors — the narrow case where a verdict cannot express the problem
 * ------------------------------------------------------------------------- */

/**
 * Thrown for input a recipe could not legitimately have: an empty ingredient
 * set, a non-positive yield or gram weight, a non-finite core nutrient, a
 * nutrition basis this module cannot convert, or a missing cost class.
 *
 * Deliberately louder than a verdict. Each of these makes the derived number
 * meaningless rather than merely disputed, and a `checks[]`-style entry nobody
 * reads would let a recipe publish per-serving values computed from a NaN. The
 * seed catches this and fails the file, naming the recipe and — from `field`
 * and `ingredient` — the offending ingredient.
 *
 * A MISSING DENSITY is not this error: it surfaces as `UnitConversionError`
 * from `utils/units.ts`, which owns the rule that millilitres never equal
 * grams. Callers that report either failure should handle both classes.
 */
export class RecipeDerivationError extends Error {
    constructor(
        message: string,
        public readonly field: string,
        public readonly ingredient: string | null = null,
    ) {
        super(message);
        this.name = 'RecipeDerivationError';
    }
}

/* ---------------------------------------------------------------------------
 * Closed value sets — this module is the runtime enforcement point
 * ------------------------------------------------------------------------- */

const iconKeySet: ReadonlySet<string> = new Set<string>(RECIPE_ICON_KEYS);
const mealSlotSet: ReadonlySet<string> = new Set<string>(MEAL_SLOTS);
const badgeSet: ReadonlySet<string> = new Set<string>(RECIPE_BADGES);

/**
 * Whether a value is one of the nine `RecipeIconKey` codes.
 *
 * A MEMBERSHIP decision only: the key → icon-component mapping lives on mobile
 * (`MealIconTile/index.util.ts::iconComponentFor`, which falls back to a bowl
 * glyph for an unrecognised key), so this module makes no rendering decision.
 * The backend is nonetheless the only place an unknown key can be caught —
 * `icon_key` is a plain TEXT column and the mobile codec decodes it leniently
 * as `io.string` — which is why the seed rejects an out-of-set key here.
 */
export const isRecipeIconKey = (value: unknown): value is RecipeIconKey =>
    typeof value === 'string' && iconKeySet.has(value);

/** Whether a value is one of the four `MealSlot` codes. */
export const isMealSlot = (value: unknown): value is MealSlot =>
    typeof value === 'string' && mealSlotSet.has(value);

/**
 * Whether a value is one of the five `RecipeBadge` codes.
 *
 * The mobile converters DROP an unknown badge rather than failing, so a badge
 * that is never validated server-side is a badge that silently disappears.
 * `deriveBadges` can only emit members by construction; this guard is for
 * validating a DECLARED list.
 */
export const isRecipeBadge = (value: unknown): value is RecipeBadge =>
    typeof value === 'string' && badgeSet.has(value);

/* ---------------------------------------------------------------------------
 * The rows and preferences these rules read
 * ------------------------------------------------------------------------- */

/** `recipe_versions.status` — exactly one version per recipe is `current`. */
export type RecipeVersionStatus = 'current' | 'retired';

/** Whether a food's allergen metadata has been reviewed. `unknown` is never plannable. */
export type RecipeAllergenStatus = 'known' | 'unknown';

/**
 * The basis a `snapshot_per_100g` record is stated on.
 *
 * Only these two: a recipe ingredient must convert to grams, and a
 * `per_serving`-only record cannot without a sourced serving weight — which is
 * why `catalog.logic.ts` quarantines one rather than publishing it. A basis
 * outside this pair reaching a recipe is a data-integrity error, so
 * `deriveRecipeNutrition` throws rather than guessing.
 */
export type RecipeNutritionBasis = 'per_100g' | 'per_100ml';

/**
 * A user's diet preference. Structurally identical to `Diet` in
 * `types/mealPlanning.ts`, restated here so this module's dependencies stay the
 * four files its rules actually need.
 */
export type RecipeDietPreference = 'none' | 'vegetarian' | 'vegan' | 'pescatarian';

/**
 * The nutrient set frozen in `recipe_ingredients.snapshot_per_100g`.
 *
 * The four core macros are REQUIRED at the type level, which is how the
 * impossible input is excluded before it can reach a sum: a published catalog
 * food always states all four (`catalog.logic.ts` quarantines one that does
 * not), so a null core macro here could only come from an unchecked cast.
 * `fiber_g` is genuinely optional — absent and null both mean unknown, and
 * unknown propagates.
 */
export interface RecipeIngredientNutrientSnapshot {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g?: number | null;
}

/**
 * The identity, safety and provenance facts every rule in this module reads
 * about an ingredient — the subset a planning check needs.
 *
 * `food_group` and `allergen_status` are optional because
 * `recipe_ingredients` does not snapshot them: the seed holds both from the
 * `catalog_foods` row it resolved, and the planner's service supplies
 * `food_group` (live identity metadata, matched against a live user
 * preference — never nutrition). Where either is absent the safe default
 * applies: no group match, and an allergen review that is not `known`.
 */
export interface RecipeIngredientIdentity {
    catalog_food_id: string;
    snapshot_name: string;
    snapshot_provenance: NutritionProvenance;
    snapshot_allergen_tags: readonly string[];
    snapshot_diet_tags: readonly string[];
    is_optional: boolean;
    food_group?: string | null;
    allergen_status?: RecipeAllergenStatus;
}

/** A `recipe_ingredients` row: the identity facts plus everything a quantity needs. */
export interface RecipeIngredientSnapshot extends RecipeIngredientIdentity {
    catalog_nutrition_version: number;
    catalog_metadata_version: number;
    snapshot_per_100g: RecipeIngredientNutrientSnapshot;
    quantity: number;
    unit: string;
    /** Grams of this ingredient in the WHOLE recipe, which yields `yield_servings` servings. */
    gram_weight: number;
    display_text: string;
    sort_order: number;
    /** Absent means `per_100g`; `per_100ml` additionally requires `density_g_per_ml`. */
    nutrition_basis?: RecipeNutritionBasis;
    density_g_per_ml?: number | null;
    /** The catalog food's 1–3 cost class; required only by the budget tier. */
    cost_class?: number | null;
}

/**
 * What the seed holds at publication: a `recipe_ingredients` row enriched with
 * the two facts the resolved `catalog_foods` row carries. Required rather than
 * optional here, because a derivation that silently omitted a badge for want of
 * a review status would be indistinguishable from an honest omission.
 */
export interface RecipePublicationIngredient extends RecipeIngredientSnapshot {
    allergen_status: RecipeAllergenStatus;
    cost_class: number;
}

/** The `recipe_versions` facts planning eligibility turns on, with its ingredients. */
export interface PlanningRecipeVersion {
    status: RecipeVersionStatus;
    /** The rolled-up provenance; planning admits `source_backed` and nothing else. */
    nutrition_provenance: NutritionProvenance;
    /** The rolled-up review status; planning admits `known` and nothing else. */
    allergen_status: RecipeAllergenStatus;
    /** `prep_minutes + cook_minutes`, per `deriveTotalMinutes`. */
    total_minutes: number;
    meal_slots: readonly string[];
    ingredients: readonly RecipeIngredientIdentity[];
}

/**
 * The `meal_plan_preferences` fields eligibility reads, snake_case as the row
 * stores them. Every one is nullable-tolerant: a user part-way through setup has
 * not answered them all, and a missing answer must never be read as a
 * permissive one — except for `cooking_time_limit_min`, where no answer can only
 * mean no limit.
 */
export interface PlanningPreferences {
    diet: RecipeDietPreference | null;
    allergens: readonly string[];
    disliked_food_ids: readonly string[];
    disliked_food_groups: readonly string[];
    cooking_time_limit_min: number | null;
}

// Row-shaped INPUTS above are snake_case, exactly as Prisma returns them, so a
// row can be handed to these rules unmapped. Everything DERIVED below is
// camelCase: the two naming worlds meet in `recipe.mapper.ts` (Rule
// backend-architecture §6), and a derived value that borrowed column casing
// would look like a column that exists.

/* ---------------------------------------------------------------------------
 * Deterministic ordering — shared by every rule that walks the ingredient set
 * ------------------------------------------------------------------------- */

/**
 * Ingredients in a deterministic order: `sort_order`, then `catalog_food_id`,
 * then their position in the input.
 *
 * Not cosmetic. Floating-point addition is not associative, so the same rows
 * arriving in a different sequence would otherwise produce totals differing in
 * the last bits — which a later republication would read as a content change
 * and publish a pointless new version for. Every list this module RETURNS is
 * ordered the same way, so a report or a DTO cannot reshuffle between runs.
 */
const orderIngredients = <T extends { catalog_food_id: string; sort_order: number }>(
    ingredients: readonly T[],
): T[] =>
    ingredients
        .map((ingredient, index) => ({ ingredient, index }))
        .sort((left, right) => {
            const bySortOrder = left.ingredient.sort_order - right.ingredient.sort_order;
            if (bySortOrder !== 0) {
                return bySortOrder;
            }
            if (left.ingredient.catalog_food_id !== right.ingredient.catalog_food_id) {
                return left.ingredient.catalog_food_id < right.ingredient.catalog_food_id ? -1 : 1;
            }
            return left.index - right.index;
        })
        .map((entry) => entry.ingredient);

/* ---------------------------------------------------------------------------
 * Time — one definition, used by four callers
 * ------------------------------------------------------------------------- */

/** The "Quick" badge's ceiling, in total minutes. */
export const QUICK_MAX_TOTAL_MINUTES = 15;

/**
 * `total_minutes = prep_minutes + cook_minutes`.
 *
 * The ONE definition. Badge derivation, planning eligibility, swap candidate
 * selection and incompatibility flagging all compare against this value, so a
 * second spelling of it — cook time alone, or a sum that forgot to include
 * prep — would let a recipe pass one gate and fail another for the same user.
 * The `recipe_versions.total_minutes` column stores the result rather than
 * being an independently authoritative field.
 */
export const deriveTotalMinutes = (prepMinutes: number, cookMinutes: number): number => {
    if (!Number.isFinite(prepMinutes) || prepMinutes < 0) {
        throw new RecipeDerivationError(
            `prep_minutes must be a finite, non-negative number, received ${String(prepMinutes)}`,
            'prep_minutes',
        );
    }
    if (!Number.isFinite(cookMinutes) || cookMinutes < 0) {
        throw new RecipeDerivationError(
            `cook_minutes must be a finite, non-negative number, received ${String(cookMinutes)}`,
            'cook_minutes',
        );
    }

    return prepMinutes + cookMinutes;
};

/* ---------------------------------------------------------------------------
 * Staleness — both version counters, because only one of them is about numbers
 * ------------------------------------------------------------------------- */

/** The two counters a `catalog_foods` row carries, as a snapshot or as the current row. */
export interface CatalogIngredientVersions {
    catalog_nutrition_version: number;
    catalog_metadata_version: number;
}

/** Which counter moved, or that the food is gone from the catalog altogether. */
export type IngredientSnapshotChange = 'nutrition' | 'metadata' | 'absent';

export interface StaleRecipeIngredient {
    catalogFoodId: string;
    name: string;
    changed: readonly IngredientSnapshotChange[];
    snapshotNutritionVersion: number;
    snapshotMetadataVersion: number;
    /** null when the catalog no longer carries the food at all. */
    currentNutritionVersion: number | null;
    currentMetadataVersion: number | null;
}

/**
 * Whether a frozen ingredient snapshot still describes the catalog food it was
 * taken from.
 *
 * BOTH counters are compared, and the metadata one is the half that is easy to
 * forget: `catalog_nutrition_version` moves when a nutrient changes, while
 * `catalog_metadata_version` moves when an allergen tag, diet tag, name or food
 * group changes. Checking only nutrition would let an ingredient quietly gain a
 * `milk` allergen tag while the published recipe went on claiming "Dairy free"
 * and went on being offered to a milk-allergic user — a safety bug, not a
 * cosmetic one.
 *
 * Inequality, not "greater than": a counter that moved BACKWARDS (a catalog
 * rollback, a reloaded release) still means the snapshot describes a different
 * row than the one on disk now.
 */
export const isIngredientSnapshotStale = (
    snapshot: CatalogIngredientVersions,
    current: CatalogIngredientVersions,
): boolean =>
    snapshot.catalog_nutrition_version !== current.catalog_nutrition_version ||
    snapshot.catalog_metadata_version !== current.catalog_metadata_version;

/**
 * Every ingredient whose snapshot no longer matches the catalog, with the
 * counters that moved — the verdict `recipes-seed.ts` needs to decide whether
 * to publish a new `recipe_versions` row and to say which ingredient forced it.
 *
 * A food missing from `currentVersions` is reported as `absent` rather than
 * treated as unchanged: it has been retired or was never loaded, and either way
 * the recipe can no longer be republished from it. Order follows the recipe's
 * own ingredient order so the report is stable.
 */
export const findStaleIngredients = (
    ingredients: readonly RecipeIngredientSnapshot[],
    currentVersions: ReadonlyMap<string, CatalogIngredientVersions>,
): StaleRecipeIngredient[] => {
    const stale: StaleRecipeIngredient[] = [];

    for (const ingredient of orderIngredients(ingredients)) {
        const current = currentVersions.get(ingredient.catalog_food_id);

        if (current === undefined) {
            stale.push({
                catalogFoodId: ingredient.catalog_food_id,
                name: ingredient.snapshot_name,
                changed: ['absent'],
                snapshotNutritionVersion: ingredient.catalog_nutrition_version,
                snapshotMetadataVersion: ingredient.catalog_metadata_version,
                currentNutritionVersion: null,
                currentMetadataVersion: null,
            });
            continue;
        }

        if (!isIngredientSnapshotStale(ingredient, current)) {
            continue;
        }

        const changed: IngredientSnapshotChange[] = [];
        if (ingredient.catalog_nutrition_version !== current.catalog_nutrition_version) {
            changed.push('nutrition');
        }
        if (ingredient.catalog_metadata_version !== current.catalog_metadata_version) {
            changed.push('metadata');
        }

        stale.push({
            catalogFoodId: ingredient.catalog_food_id,
            name: ingredient.snapshot_name,
            changed,
            snapshotNutritionVersion: ingredient.catalog_nutrition_version,
            snapshotMetadataVersion: ingredient.catalog_metadata_version,
            currentNutritionVersion: current.catalog_nutrition_version,
            currentMetadataVersion: current.catalog_metadata_version,
        });
    }

    return stale;
};

/* ---------------------------------------------------------------------------
 * Nutrition — summed from gram weights, never rounded, fibre null-propagating
 * ------------------------------------------------------------------------- */

/** Atwater factors: the 4/4/9 estimate the sourced energy value is compared against. */
const KCAL_PER_GRAM_PROTEIN = 4;
const KCAL_PER_GRAM_CARBS = 4;
const KCAL_PER_GRAM_FAT = 9;

/**
 * The amount a snapshot's values describe — 100 g, or 100 ml on a `per_100ml`
 * basis. One number for both, taken from `catalog.logic.ts` so the recipe side
 * cannot drift from the basis the catalog stores on.
 */
const SNAPSHOT_BASIS_AMOUNT = PER_100G_BASIS_AMOUNT;

/** Above this relative gap, the divergence is disclosed rather than corrected. */
export const SOURCED_CALORIE_DIVERGENCE_THRESHOLD = 0.05;

const PERCENT_SCALE = 100;
const DIVERGENCE_PERCENT_DECIMALS = 1;

export interface RecipeNutritionTotals extends RecipePerServingNutrition {
    /**
     * null when ANY ingredient's fibre is unknown. A sum missing a term is not
     * a smaller sum, and 0 would claim the recipe contains no fibre — a claim
     * no source made.
     */
    fiber: number | null;
}

export interface RecipeNutritionDerivation {
    /** Whole-recipe totals, at full precision. */
    total: RecipeNutritionTotals;
    /** `total ÷ yield_servings`, at full precision. Never rounded here. */
    perServing: RecipePerServingNutrition;
    perServingFiber: number | null;
    /** Σ over the recipe of `4·protein + 4·carbs + 9·fat`. */
    macroEnergyKcal: number;
    /**
     * `|macroEnergyKcal − total.calories| ÷ total.calories`, or null when the
     * sourced energy is 0 and there is no denominator to divide by. Exposed
     * next to the note so the 5 % boundary can be asserted as a number rather
     * than parsed out of prose.
     */
    calorieDivergence: number | null;
    sourcedCaloriesNote: string | null;
}

const requireNutrient = (
    value: number | null | undefined,
    field: string,
    ingredientName: string,
): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new RecipeDerivationError(
            `${field} must be a finite, non-negative number, received ${String(value)}`,
            field,
            ingredientName,
        );
    }

    return value;
};

/**
 * How much of one snapshot basis this ingredient's gram weight represents.
 *
 * A `per_100ml` basis goes through the food's own stored density, and a missing
 * one FAILS: `millilitersToGrams` throws `UnitConversionError`, which is not
 * caught here. Assuming millilitres equal grams understates oil by about 9 %
 * and honey by considerably more, so a seed failure a human fixes in the data
 * is the correct outcome.
 */
const requireGramWeight = (ingredient: RecipeIngredientSnapshot): number => {
    const gramWeight = ingredient.gram_weight;
    if (!Number.isFinite(gramWeight) || gramWeight <= 0) {
        throw new RecipeDerivationError(
            `gram_weight must be a finite number greater than 0, received ${String(gramWeight)}`,
            'gram_weight',
            ingredient.snapshot_name,
        );
    }

    return gramWeight;
};

const ingredientScaleFactor = (ingredient: RecipeIngredientSnapshot): number => {
    const gramWeight = requireGramWeight(ingredient);
    const basis: RecipeNutritionBasis = ingredient.nutrition_basis ?? 'per_100g';

    if (basis === 'per_100g') {
        return gramWeight / SNAPSHOT_BASIS_AMOUNT;
    }
    if (basis === 'per_100ml') {
        return gramWeight / millilitersToGrams(SNAPSHOT_BASIS_AMOUNT, ingredient.density_g_per_ml);
    }

    throw new RecipeDerivationError(
        `nutrition_basis must be per_100g or per_100ml for a recipe ingredient, received ${String(basis)}`,
        'nutrition_basis',
        ingredient.snapshot_name,
    );
};

/**
 * The disclosure when a recipe's sourced energy and its 4/4/9 macro estimate
 * disagree by more than {@link SOURCED_CALORIE_DIVERGENCE_THRESHOLD}.
 *
 * A DISCLOSURE, not a correction: sourced energy values legitimately differ
 * from the Atwater approximation (fibre, sugar alcohols, incomplete digestion),
 * so the sourced value stands and the difference is recorded in
 * `recipe_versions.sourced_calories_note`. Adjusting either number to make them
 * agree would be fabricating nutrition.
 *
 * The integers and the one decimal place in the returned sentence are STRING
 * formatting, not a rounding of any stored value — the derivation's own numbers
 * stay at full precision.
 */
export const deriveSourcedCaloriesNote = (totals: RecipePerServingNutrition): string | null => {
    const sourced = requireNutrient(totals.calories, 'calories', 'recipe total');
    const macroEnergy =
        requireNutrient(totals.protein, 'protein', 'recipe total') * KCAL_PER_GRAM_PROTEIN +
        requireNutrient(totals.carbs, 'carbs', 'recipe total') * KCAL_PER_GRAM_CARBS +
        requireNutrient(totals.fat, 'fat', 'recipe total') * KCAL_PER_GRAM_FAT;

    if (sourced === 0) {
        // No denominator, so no percentage — but macros that imply energy where
        // the source states none is still a contradiction worth recording.
        return macroEnergy === 0
            ? null
            : `Sourced energy 0 kcal differs from the 4/4/9 macro estimate ${Math.round(macroEnergy)} kcal.`;
    }

    const divergence = Math.abs(macroEnergy - sourced) / sourced;
    if (divergence <= SOURCED_CALORIE_DIVERGENCE_THRESHOLD) {
        return null;
    }

    const percent = (divergence * PERCENT_SCALE).toFixed(DIVERGENCE_PERCENT_DECIMALS);
    return (
        `Sourced energy ${Math.round(sourced)} kcal differs from the 4/4/9 macro estimate ` +
        `${Math.round(macroEnergy)} kcal by ${percent}%.`
    );
};

/**
 * A recipe's nutrition, derived from stored ingredient gram weights and the
 * per-100 g values frozen with them — the prompt's nutrition-integrity
 * requirement expressed as arithmetic.
 *
 * Each ingredient contributes `gram_weight × value / 100` of every nutrient;
 * per-serving is the total divided by `yield_servings` and is deliberately left
 * as a float. The four core macros are summed from values validated as finite
 * and non-negative, and fibre is summed only when EVERY ingredient states it.
 *
 * Optional ingredients are INCLUDED: an optional ingredient is still in the
 * dish when it is used, and a total that omitted it would understate the meal
 * the user actually eats.
 */
export const deriveRecipeNutrition = (
    ingredients: readonly RecipeIngredientSnapshot[],
    yieldServings: number,
): RecipeNutritionDerivation => {
    if (ingredients.length === 0) {
        throw new RecipeDerivationError(
            'a recipe needs at least one ingredient to have nutrition',
            'ingredients',
        );
    }
    if (!Number.isFinite(yieldServings) || yieldServings <= 0) {
        throw new RecipeDerivationError(
            `yield_servings must be a finite number greater than 0, received ${String(yieldServings)}`,
            'yield_servings',
        );
    }

    const scaled = orderIngredients(ingredients).map((ingredient) => ({
        ingredient,
        factor: ingredientScaleFactor(ingredient),
    }));

    let calories = 0;
    let protein = 0;
    let carbs = 0;
    let fat = 0;

    for (const { ingredient, factor } of scaled) {
        const values = ingredient.snapshot_per_100g;
        const name = ingredient.snapshot_name;

        calories += requireNutrient(values.calories, 'calories', name) * factor;
        protein += requireNutrient(values.protein_g, 'protein_g', name) * factor;
        carbs += requireNutrient(values.carbs_g, 'carbs_g', name) * factor;
        fat += requireNutrient(values.fat_g, 'fat_g', name) * factor;
    }

    // Presence is settled across the whole set before any fibre is added, so
    // the answer cannot depend on where an unknown value sits in the list.
    const fiberKnown = scaled.every(
        ({ ingredient }) =>
            ingredient.snapshot_per_100g.fiber_g !== undefined && ingredient.snapshot_per_100g.fiber_g !== null,
    );
    const fiber = fiberKnown
        ? scaled.reduce(
              (sum, { ingredient, factor }) =>
                  sum + requireNutrient(ingredient.snapshot_per_100g.fiber_g, 'fiber_g', ingredient.snapshot_name) * factor,
              0,
          )
        : null;

    const total: RecipeNutritionTotals = { calories, protein, carbs, fat, fiber };
    const macroEnergyKcal =
        protein * KCAL_PER_GRAM_PROTEIN + carbs * KCAL_PER_GRAM_CARBS + fat * KCAL_PER_GRAM_FAT;

    return {
        total,
        perServing: {
            calories: calories / yieldServings,
            protein: protein / yieldServings,
            carbs: carbs / yieldServings,
            fat: fat / yieldServings,
        },
        perServingFiber: fiber === null ? null : fiber / yieldServings,
        macroEnergyKcal,
        calorieDivergence: calories === 0 ? null : Math.abs(macroEnergyKcal - calories) / calories,
        sourcedCaloriesNote: deriveSourcedCaloriesNote(total),
    };
};

/* ---------------------------------------------------------------------------
 * Tags — the union for allergens, the intersection for diets
 * ------------------------------------------------------------------------- */

/**
 * The comparison key for a tag.
 *
 * `normalizeCanonicalName` is the repository's ONE normalisation and it is
 * idempotent, so `tree_nuts`, `Tree nuts` and `tree-nuts` all collapse to the
 * same key. Comparing raw strings instead is how a user's selected `tree_nuts`
 * would fail to match a catalog food's `Tree nuts` and an allergen would reach
 * a plate. Note the keys are space-separated, so `gluten_free` keys as
 * `gluten free` — which is why every comparison in this module goes through
 * this function rather than against a literal.
 */
const tagKey = (tag: string): string => normalizeCanonicalName(tag);

const VEGAN_DIET_TAG = 'vegan';
const VEGETARIAN_DIET_TAG = 'vegetarian';
const PESCATARIAN_DIET_TAG = 'pescatarian';
const GLUTEN_FREE_DIET_TAG = 'gluten_free';
const MILK_ALLERGEN_TAG = 'milk';

const VEGAN_TAG_KEY = tagKey(VEGAN_DIET_TAG);
const GLUTEN_FREE_TAG_KEY = tagKey(GLUTEN_FREE_DIET_TAG);
const MILK_TAG_KEY = tagKey(MILK_ALLERGEN_TAG);

/**
 * Diet containment: `vegan ⊂ vegetarian ⊂ pescatarian`, and every recipe is
 * admissible under `none`.
 *
 * Read as "a dish admissible for this diet is also admissible for these" — a
 * vegan dish suits a vegetarian and a pescatarian, and a vegetarian dish suits
 * a pescatarian, because the pescatarian set is the vegetarian set plus
 * fish and seafood. `none` is never EMITTED as a tag: it is the absence of a
 * restriction rather than a property of the food, and emitting it on every
 * recipe would make every recipe file declare it. `isDietCompatible` is where
 * `none` admits everything.
 */
const DIET_TAG_IMPLICATIONS: ReadonlyMap<string, readonly string[]> = new Map([
    [VEGAN_TAG_KEY, [VEGETARIAN_DIET_TAG, PESCATARIAN_DIET_TAG]],
    [tagKey(VEGETARIAN_DIET_TAG), [PESCATARIAN_DIET_TAG]],
]);

/**
 * Collects tags keyed by their normalised form, keeping the lexicographically
 * smallest original spelling for each key.
 *
 * Smallest rather than first-seen: the winner must not depend on the order the
 * ingredient rows arrived in, or two runs over the same recipe would store
 * `Milk` and `milk` alternately and read as a content change.
 */
const collectTags = (tagLists: readonly (readonly string[])[]): Map<string, string> => {
    const byKey = new Map<string, string>();

    for (const tags of tagLists) {
        for (const tag of tags) {
            const key = tagKey(tag);
            // A tag with no alphanumeric content normalises to '' and is not a
            // tag at all; admitting it would create an unmatchable key.
            if (key.length === 0) {
                continue;
            }

            const existing = byKey.get(key);
            if (existing === undefined || tag < existing) {
                byKey.set(key, tag);
            }
        }
    }

    return byKey;
};

/** Original spellings, ordered by normalised key so the stored array is stable. */
const renderTags = (byKey: ReadonlyMap<string, string>): string[] =>
    [...byKey.entries()]
        .sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0))
        .map(([, original]) => original);

/**
 * The recipe's allergen tags: the UNION of every ingredient's snapshot allergen
 * tags, optional ingredients INCLUDED.
 *
 * Optional is still in the dish. Excluding an optional ingredient would
 * understate the allergen set, and understating it is the one direction of
 * error that reaches a plate — which is why the union is taken over every
 * ingredient regardless of `is_optional`.
 */
export const deriveAllergenTags = (ingredients: readonly RecipeIngredientIdentity[]): string[] =>
    renderTags(collectTags(ingredients.map((ingredient) => ingredient.snapshot_allergen_tags)));

/**
 * Whether every ingredient's allergen metadata has been reviewed.
 *
 * `known` only when EVERY ingredient says so, and an ingredient with no
 * `allergen_status` at all is not one of them: `recipe_ingredients` does not
 * snapshot the status, so its absence means the caller did not supply a review
 * — which cannot be read as a clean one. An empty ingredient set is `unknown`
 * for the same reason: nothing has been reviewed.
 */
export const deriveAllergenStatus = (
    ingredients: readonly RecipeIngredientIdentity[],
): RecipeAllergenStatus =>
    ingredients.length > 0 && ingredients.every((ingredient) => ingredient.allergen_status === 'known')
        ? 'known'
        : 'unknown';

/**
 * The recipe's diet tags: the INTERSECTION of every ingredient's snapshot diet
 * tags, closed under {@link DIET_TAG_IMPLICATIONS}.
 *
 * Intersection, not union, and that is the whole rule: a restrictive claim
 * holds for a dish only when it holds for every part of it. One ingredient
 * without the `vegan` tag makes the dish not vegan, however vegan the rest of
 * it is. Optional ingredients count here too, for the same reason they count
 * for allergens.
 *
 * An empty ingredient set yields no tags rather than every tag — "every
 * ingredient carries it" is vacuously true of nothing, and a vacuous claim is
 * the worst kind.
 */
export const deriveDietTags = (ingredients: readonly RecipeIngredientIdentity[]): string[] => {
    if (ingredients.length === 0) {
        return [];
    }

    const [first, ...rest] = ingredients;
    const shared = collectTags([first.snapshot_diet_tags]);

    for (const ingredient of rest) {
        const present = new Set([...collectTags([ingredient.snapshot_diet_tags]).keys()]);

        for (const key of [...shared.keys()]) {
            if (!present.has(key)) {
                shared.delete(key);
            }
        }
    }

    for (const key of [...shared.keys()]) {
        for (const implied of DIET_TAG_IMPLICATIONS.get(key) ?? []) {
            const impliedKey = tagKey(implied);
            if (!shared.has(impliedKey)) {
                shared.set(impliedKey, implied);
            }
        }
    }

    return renderTags(shared);
};

/**
 * Whether a recipe's derived diet tags admit a user's diet.
 *
 * `none` and "not answered yet" both admit everything — a user with no dietary
 * restriction is restricted by nothing — while any named diet must appear in
 * the derived tags. Callers pass the tags from {@link deriveDietTags} over the
 * ingredient snapshots, never the `recipe_versions.diet_tags` summary column,
 * which is only ever a record of that derivation.
 */
export const isDietCompatible = (
    diet: RecipeDietPreference | null,
    dietTags: readonly string[],
): boolean => {
    if (diet === null || diet === 'none') {
        return true;
    }

    const target = tagKey(diet);
    return dietTags.some((tag) => tagKey(tag) === target);
};

/**
 * The recipe's rolled-up nutrition provenance: the WEAKEST of its ingredients'.
 *
 * One `ai_estimated` ingredient makes the whole recipe an AI estimate, and one
 * `ingredient_derived` ingredient makes it ingredient-derived, because a total
 * is only as sound as the least sound number in it. Only a recipe every one of
 * whose ingredients is source-backed is `source_backed` — and only such a
 * recipe is plannable, which is what makes a planned meal's nutrition
 * presentable as verified.
 *
 * A `user_entered` ingredient is a data-integrity error rather than a weaker
 * grade: the server owns every catalog number, so no catalog food can carry
 * client-supplied nutrition. It throws instead of being absorbed into an
 * estimate grade that would misdescribe where the number came from.
 */
export const deriveNutritionProvenance = (
    ingredients: readonly RecipeIngredientIdentity[],
): RecipeNutritionProvenance => {
    if (ingredients.length === 0) {
        throw new RecipeDerivationError(
            'a recipe needs at least one ingredient to have a nutrition provenance',
            'ingredients',
        );
    }

    const userEntered = ingredients.find((ingredient) => ingredient.snapshot_provenance === 'user_entered');
    if (userEntered) {
        throw new RecipeDerivationError(
            'snapshot_provenance cannot be user_entered: a catalog food never carries client-supplied nutrition',
            'snapshot_provenance',
            userEntered.snapshot_name,
        );
    }

    if (ingredients.some((ingredient) => ingredient.snapshot_provenance === 'ai_estimated')) {
        return 'ai_estimated';
    }
    if (ingredients.some((ingredient) => ingredient.snapshot_provenance === 'ingredient_derived')) {
        return 'ingredient_derived';
    }

    return 'source_backed';
};

/* ---------------------------------------------------------------------------
 * Badges — composition claims, derived and never accepted
 * ------------------------------------------------------------------------- */

/** "High protein": protein must supply at least this share of the energy. */
export const HIGH_PROTEIN_MIN_ENERGY_SHARE = 0.3;

/**
 * Tags that contradict a `gluten_free` claim.
 *
 * Kept as readable spellings and normalised once at load, so the list reads as
 * the policy it is. `wheat` is one of the nine tracked allergens; the rest are
 * taxonomy spellings a catalog food may carry. A food asserting `gluten_free`
 * while carrying one of these has contradictory metadata, and the badge is
 * withheld rather than resolved in the claim's favour.
 */
const GLUTEN_CONTRADICTING_TAG_KEYS: ReadonlySet<string> = new Set(
    ['wheat', 'barley', 'rye', 'malt', 'gluten', "brewer's yeast"].map(tagKey),
);

export interface RecipeBadgeContext {
    /**
     * The recipe's nutrition — whole-recipe totals or per-serving values, since
     * the protein share of energy is identical either way.
     */
    nutrition: RecipePerServingNutrition;
    /** From {@link deriveTotalMinutes}. */
    totalMinutes: number;
}

/**
 * The badges a recipe has EARNED, in `RECIPE_BADGES` declaration order.
 *
 * Derived from the ingredient set and the derived nutrition — never from a
 * recipe file's declared list, which `validateRecipeDeclaration` only ever
 * compares against this result. A badge is a claim a user with an allergy or a
 * diet acts on, so the derivation is the only thing allowed to make one.
 *
 * The rules, each with its safe default:
 *
 *  * `high_protein` — protein supplies ≥ 30 % of the energy. Omitted when the
 *    energy is 0: there is no share of nothing.
 *  * `gluten_free` — every ingredient reviewed (`allergen_status` known) AND
 *    the reviewed `gluten_free` tag present on every ingredient AND no
 *    gluten-bearing allergen tag anywhere. An UNCERTIFIED OAT is handled by
 *    the middle clause without a special case: the reviewer withholds the tag,
 *    so the intersection loses it and the badge drops. Oats that ARE certified
 *    carry the tag and keep the badge.
 *  * `dairy_free` — every ingredient reviewed AND no `milk` tag. An unreviewed
 *    ingredient omits the badge.
 *  * `vegan` — the `vegan` tag on every ingredient (the intersection again).
 *  * `quick` — `total_minutes ≤ 15`. A time fact rather than a composition
 *    claim, so it is the one badge an ingredient's metadata cannot block.
 *
 * The stable order matters beyond tidiness: `badges` is a `String[]` column, so
 * a reshuffled array is a spurious diff and, at seed time, a spurious new
 * recipe version.
 */
export const deriveBadges = (
    ingredients: readonly RecipeIngredientIdentity[],
    context: RecipeBadgeContext,
): RecipeBadge[] => {
    if (!Number.isFinite(context.totalMinutes) || context.totalMinutes < 0) {
        throw new RecipeDerivationError(
            `total_minutes must be a finite, non-negative number, received ${String(context.totalMinutes)}`,
            'total_minutes',
        );
    }

    const calories = requireNutrient(context.nutrition.calories, 'calories', 'recipe nutrition');
    const protein = requireNutrient(context.nutrition.protein, 'protein', 'recipe nutrition');

    const dietTagKeys = new Set(deriveDietTags(ingredients).map(tagKey));
    const allergenTagKeys = new Set(deriveAllergenTags(ingredients).map(tagKey));
    const reviewed = deriveAllergenStatus(ingredients) === 'known';

    const earned: Readonly<Record<RecipeBadge, boolean>> = {
        high_protein: calories > 0 && (protein * KCAL_PER_GRAM_PROTEIN) / calories >= HIGH_PROTEIN_MIN_ENERGY_SHARE,
        gluten_free:
            reviewed &&
            dietTagKeys.has(GLUTEN_FREE_TAG_KEY) &&
            ![...allergenTagKeys].some((key) => GLUTEN_CONTRADICTING_TAG_KEYS.has(key)),
        dairy_free: reviewed && !allergenTagKeys.has(MILK_TAG_KEY),
        vegan: dietTagKeys.has(VEGAN_TAG_KEY),
        quick: context.totalMinutes <= QUICK_MAX_TOTAL_MINUTES,
    };

    return RECIPE_BADGES.filter((badge) => earned[badge]);
};

/* ---------------------------------------------------------------------------
 * Budget — a relative preference, never a price
 * ------------------------------------------------------------------------- */

const MIN_COST_CLASS = 1;
const MAX_COST_CLASS = 3;

/** A cost score at or below this is tier 1; at or below the second, tier 2; else tier 3. */
export const BUDGET_TIER_1_MAX_COST_SCORE = 1.5;
export const BUDGET_TIER_2_MAX_COST_SCORE = 2.5;

/**
 * A recipe's cost score: `Σ(gram_weight × cost_class) ÷ Σ gram_weight`.
 *
 * Mass-weighted on purpose — a pinch of saffron should not make a lentil stew
 * expensive — and expressed in the catalog's 1–3 cost classes rather than in
 * money, because the planner offers a relative preference and shows no prices.
 * A missing or out-of-range `cost_class` throws rather than defaulting to the
 * middle class: a default would quietly make every unpriced recipe average, and
 * the seed holds the class for every ingredient it resolved.
 */
export const deriveCostScore = (ingredients: readonly RecipeIngredientSnapshot[]): number => {
    if (ingredients.length === 0) {
        throw new RecipeDerivationError('a recipe needs at least one ingredient to have a cost score', 'ingredients');
    }

    let weighted = 0;
    let totalGrams = 0;

    for (const ingredient of orderIngredients(ingredients)) {
        const gramWeight = requireGramWeight(ingredient);
        const costClass = ingredient.cost_class;

        if (
            typeof costClass !== 'number' ||
            !Number.isInteger(costClass) ||
            costClass < MIN_COST_CLASS ||
            costClass > MAX_COST_CLASS
        ) {
            throw new RecipeDerivationError(
                `cost_class must be an integer from ${MIN_COST_CLASS} to ${MAX_COST_CLASS}, received ${String(costClass)}`,
                'cost_class',
                ingredient.snapshot_name,
            );
        }

        weighted += gramWeight * costClass;
        totalGrams += gramWeight;
    }

    return weighted / totalGrams;
};

/**
 * The budget tier a cost score falls in: 1 at or below 1.5, 2 at or below 2.5,
 * otherwise 3.
 *
 * Inclusive upper bounds, which is the boundary worth pinning: a score of
 * exactly 1.5 is tier 1, and exactly 2.5 is tier 2. Recomputed by the seed from
 * the ingredient set rather than accepted from a recipe file, so a file cannot
 * declare itself cheap.
 */
export const deriveBudgetTier = (costScore: number): 1 | 2 | 3 => {
    if (!Number.isFinite(costScore)) {
        throw new RecipeDerivationError(
            `cost score must be a finite number, received ${String(costScore)}`,
            'cost_score',
        );
    }

    if (costScore <= BUDGET_TIER_1_MAX_COST_SCORE) {
        return 1;
    }
    if (costScore <= BUDGET_TIER_2_MAX_COST_SCORE) {
        return 2;
    }

    return 3;
};

/* ---------------------------------------------------------------------------
 * Scaling and the rounding contract
 * ------------------------------------------------------------------------- */

/**
 * What a caller wants quantities for: a portion multiplier, or the whole
 * recipe as written — frame 12's "Your portion / Full recipe" toggle.
 */
export type RecipePortionSelection = number | 'full';

/** One ingredient's quantities at the requested scale. Nothing is mutated. */
export interface ScaledRecipeIngredient {
    catalogFoodId: string;
    name: string;
    quantity: number;
    unit: string;
    gramWeight: number;
    displayText: string;
    sortOrder: number;
    isOptional: boolean;
}

const MASS_DISPLAY_DECIMALS = 1;
const TENTHS_PER_UNIT = 10;

/**
 * Count units that name nothing — the design shows "¼" for a quarter of an
 * avocado, not "¼ each".
 */
const GENERIC_COUNT_UNIT_KEYS: ReadonlySet<string> = new Set(
    ['each', 'whole', 'piece', 'pieces', 'count'].map(tagKey),
);

/**
 * An ingredient quantity as frame 12 renders it: fraction glyphs for volumes
 * and counts ("¾ cup", "¼"), a tenth of a unit for masses ("2.5 oz").
 *
 * The ingredient's OWN unit is kept. `utils/units.ts`'s `formatMass` and
 * `formatVolume` promote to the largest unit that stays ≥ 1, which is right for
 * a shopping list and wrong here: a recipe that says 5 oz of chicken must not
 * start saying 0.3 lb, and a "was/now" comparison in a recipe has no meaning to
 * keep a family stable for.
 *
 * The unit is also rendered exactly as the recipe authored it, with no
 * pluralisation. Pluralising an authored word is how "2 cups" becomes
 * "2 cupses"; `pluralizeCount` exists for the grocery list, whose count rows
 * are generated from a portion description rather than authored.
 */
export const formatIngredientQuantity = (quantity: number, unit: string): string => {
    if (!Number.isFinite(quantity)) {
        throw new RecipeDerivationError(
            `quantity must be a finite number, received ${String(quantity)}`,
            'quantity',
        );
    }

    const label = unit.trim();
    const family = unitFamily(label);

    if (family === 'mass') {
        const rounded = Math.round(quantity * TENTHS_PER_UNIT) / TENTHS_PER_UNIT;
        const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(MASS_DISPLAY_DECIMALS);
        return label.length === 0 ? text : `${text} ${label}`;
    }

    // Volumes, counts and unrecognised units all take the quarter glyphs: the
    // design's recipe quantities are fractions, and a unit this repository does
    // not know is safer rendered as an exact-looking fraction than as a decimal
    // that implies a precision the recipe never stated.
    const text = formatQuarters(quantity);

    if (label.length === 0) {
        return text;
    }
    if (family === 'count' && GENERIC_COUNT_UNIT_KEYS.has(tagKey(label))) {
        return text;
    }

    return `${text} ${label}`;
};

/**
 * Ingredient quantities at the requested scale, as new values.
 *
 * DISPLAY ONLY. The stored quantities, the planned portion and the grocery list
 * are untouched — which is trivially true because this function reads its
 * arguments and returns fresh objects, and is what makes frame 12's toggle safe
 * to flip.
 *
 * `gram_weight` and `quantity` describe the WHOLE recipe, which yields
 * `yield_servings` servings, so:
 *
 *  * `'full'` scales by 1 — the stored values already are the full recipe.
 *  * a portion multiplier `m` scales by `m / yield_servings`, so `m = 1` is one
 *    serving and `m = yield_servings` is the whole recipe again.
 *
 * At a factor of exactly 1 the AUTHORED `display_text` is returned unchanged:
 * at that scale it is correct by construction and it carries phrasing a
 * recomputation would lose. Every other factor is rendered by
 * {@link formatIngredientQuantity}.
 */
export const scaleIngredients = (
    ingredients: readonly RecipeIngredientSnapshot[],
    portion: RecipePortionSelection,
    yieldServings: number,
): ScaledRecipeIngredient[] => {
    if (!Number.isFinite(yieldServings) || yieldServings <= 0) {
        throw new RecipeDerivationError(
            `yield_servings must be a finite number greater than 0, received ${String(yieldServings)}`,
            'yield_servings',
        );
    }
    if (portion !== 'full' && (!Number.isFinite(portion) || portion <= 0)) {
        throw new RecipeDerivationError(
            `portion multiplier must be 'full' or a finite number greater than 0, received ${String(portion)}`,
            'portion_multiplier',
        );
    }

    const factor = portion === 'full' ? 1 : portion / yieldServings;

    return orderIngredients(ingredients).map((ingredient) => {
        const quantity = ingredient.quantity * factor;

        return {
            catalogFoodId: ingredient.catalog_food_id,
            name: ingredient.snapshot_name,
            quantity,
            unit: ingredient.unit,
            gramWeight: requireGramWeight(ingredient) * factor,
            displayText: factor === 1 ? ingredient.display_text : formatIngredientQuantity(quantity, ingredient.unit),
            sortOrder: ingredient.sort_order,
            isOptional: ingredient.is_optional,
        };
    });
};

/**
 * A planned meal's nutrition: per-serving values times the portion multiplier,
 * at FULL PRECISION.
 *
 * The first link in the rounding contract, and the one place an extra
 * `Math.round` would be invisible and wrong. The chain is:
 *
 *   1. here — per-serving × `portion_multiplier`, unrounded;
 *   2. {@link roundNutritionForDisplay} — what recipe detail and the plan cards
 *      show;
 *   3. `nutrition.service.ts::insertPlannedMealEntry` — the diary snapshot,
 *      rounded ONCE on insert, which is what makes the stored entry equal the
 *      planned portion;
 *   4. `nutrition.service.ts::asEaten` — `Math.round(snapshot × servings)` per
 *      value, the consumed total.
 *
 * Rounding at step 1 would shift steps 2 through 4 and is exactly why the
 * mobile "This adds" card would stop agreeing with the server to the integer.
 */
export const scalePlannedNutrition = (
    perServing: RecipePerServingNutrition,
    portionMultiplier: number,
): RecipePerServingNutrition => {
    if (!Number.isFinite(portionMultiplier) || portionMultiplier <= 0) {
        throw new RecipeDerivationError(
            `portion multiplier must be a finite number greater than 0, received ${String(portionMultiplier)}`,
            'portion_multiplier',
        );
    }

    return {
        calories: requireNutrient(perServing.calories, 'calories', 'planned portion') * portionMultiplier,
        protein: requireNutrient(perServing.protein, 'protein', 'planned portion') * portionMultiplier,
        carbs: requireNutrient(perServing.carbs, 'carbs', 'planned portion') * portionMultiplier,
        fat: requireNutrient(perServing.fat, 'fat', 'planned portion') * portionMultiplier,
    };
};

/**
 * The one display rounding: every value to the nearest whole unit.
 *
 * Step 2 of the rounding contract above — what recipe detail, the swap preview
 * and the plan cards render. The derived values themselves stay unrounded, so
 * this never feeds back into a stored number.
 */
export const roundNutritionForDisplay = (nutrition: RecipePerServingNutrition): RecipePerServingNutrition => ({
    calories: Math.round(requireNutrient(nutrition.calories, 'calories', 'displayed nutrition')),
    protein: Math.round(requireNutrient(nutrition.protein, 'protein', 'displayed nutrition')),
    carbs: Math.round(requireNutrient(nutrition.carbs, 'carbs', 'displayed nutrition')),
    fat: Math.round(requireNutrient(nutrition.fat, 'fat', 'displayed nutrition')),
});

/* ---------------------------------------------------------------------------
 * Planning eligibility — one function, three callers
 * ------------------------------------------------------------------------- */

/**
 * Why a recipe may not be planned.
 *
 * The last four are exactly the `meal_plan_meals.flags` codes, so a planned
 * meal that a later preference change made incompatible can be flagged from
 * this verdict without a second vocabulary. The first four are structural: they
 * describe a recipe that is not plannable for ANYONE and are never shown as a
 * preference conflict.
 */
export type PlanningEligibilityCode =
    | 'status'
    | 'nutrition_provenance'
    | 'allergen_status'
    | 'allergen'
    | 'diet'
    | 'dislike'
    | 'cooking_time'
    | 'slot';

/**
 * One refusal, with the values that caused it — never a sentence. Per code:
 *
 *  * `status` — the recipe version's status.
 *  * `nutrition_provenance` — the offending ingredients' names, or the recipe's
 *    rolled-up provenance when no ingredient can be named for it.
 *  * `allergen_status` — the unreviewed ingredients' names, or the recipe's
 *    rolled-up status.
 *  * `allergen` — the user's own selected allergen values that the recipe
 *    carries, in their spelling, because that is what the user recognises.
 *  * `diet` — the user's diet.
 *  * `dislike` — the offending ingredients' names.
 *  * `cooking_time` — the recipe's total minutes (the limit is the caller's own
 *    preference, which it already holds).
 *  * `slot` — the slot that was asked for.
 */
export interface PlanningEligibilityReason {
    code: PlanningEligibilityCode;
    detail: string[];
}

export interface PlanningEligibilityVerdict {
    eligible: boolean;
    /** Every refusal, in {@link PlanningEligibilityCode} declaration order. */
    reasons: PlanningEligibilityReason[];
}

/** The subset of codes that describe a PREFERENCE conflict rather than an unplannable recipe. */
export const PREFERENCE_FLAG_CODES: readonly PlanningEligibilityCode[] = [
    'diet',
    'allergen',
    'dislike',
    'cooking_time',
];

/**
 * "None" is the mutually exclusive answer meaning no allergies. It is not a tag
 * any food carries, and matching it against one would exclude every food with a
 * literal `none` tag for a user who declared no allergy at all.
 */
const NONE_ALLERGEN_TAG_KEY = tagKey('none');

const sortedDistinct = (values: readonly string[]): string[] => [...new Set(values)].sort();

const ingredientNames = (ingredients: readonly RecipeIngredientIdentity[]): string[] =>
    sortedDistinct(ingredients.map((ingredient) => ingredient.snapshot_name));

/**
 * Whether a recipe may be planned for a user, and if not, why.
 *
 * THE single eligibility implementation. Plan generation, swap alternatives and
 * incompatibility flagging all come through here, because three copies of a
 * rule is how one of them starts serving an allergen. Every clause is a safety
 * or contract requirement rather than a preference:
 *
 *  * `status = 'current'` — a retired version stays READABLE for the plans and
 *    diary entries that reference it, but is never planned again.
 *  * `nutrition_provenance = 'source_backed'`, on the recipe AND on every
 *    ingredient. The two estimate grades `catalog.logic.ts::isEstimatedNutrition`
 *    names — `ingredient_derived` and `ai_estimated` — never enter planning, so
 *    a planned meal is never an estimate and its "From meal plan" caption never
 *    needs a qualifier. This is the prompt's nutrition-integrity requirement
 *    made structural.
 *  * `allergen_status = 'known'` for every ingredient, optional ones included,
 *    REGARDLESS of what the user selected. Not "eligible unless the user
 *    selected that allergen": a food we cannot describe cannot be certified
 *    safe for anyone.
 *  * No overlap between the user's allergens and the union of every
 *    ingredient's snapshot allergen tags.
 *  * Diet compatibility derived from the ingredient snapshots — never from the
 *    `recipe_versions.diet_tags` summary column, which is only a record of that
 *    derivation and could disagree with it after a catalog change.
 *  * No ingredient whose `catalog_food_id` OR `food_group` is disliked. The
 *    group half is what makes disliking "Mushrooms, white" exclude the whole
 *    `mushroom` group without touching an unrelated one.
 *  * `total_minutes ≤ cooking_time_limit_min`, with no limit answered meaning
 *    no limit.
 *  * The requested slot is one the recipe declares. Passing `null` asks the
 *    slot-independent question, which is what a catalog-coverage count over all
 *    slots needs.
 *
 * Every refusal is collected rather than short-circuited, so a caller can
 * report all of them — the planner's limiting-constraint analysis needs to know
 * that relaxing one constraint alone would not help.
 */
export const evaluatePlanningEligibility = (
    recipe: PlanningRecipeVersion,
    preferences: PlanningPreferences,
    slot: MealSlot | null = null,
): PlanningEligibilityVerdict => {
    const reasons: PlanningEligibilityReason[] = [];

    if (recipe.status !== 'current') {
        reasons.push({ code: 'status', detail: [recipe.status] });
    }

    const notSourceBacked = recipe.ingredients.filter(
        (ingredient) => ingredient.snapshot_provenance !== 'source_backed',
    );
    if (recipe.nutrition_provenance !== 'source_backed' || notSourceBacked.length > 0) {
        reasons.push({
            code: 'nutrition_provenance',
            detail: notSourceBacked.length > 0 ? ingredientNames(notSourceBacked) : [recipe.nutrition_provenance],
        });
    }

    // Only ingredients whose review status the caller actually supplied can be
    // judged individually; where it is absent the recipe-level rollup is the
    // check, which is why that clause stands on its own.
    const unreviewed = recipe.ingredients.filter(
        (ingredient) => ingredient.allergen_status !== undefined && ingredient.allergen_status !== 'known',
    );
    if (recipe.allergen_status !== 'known' || unreviewed.length > 0) {
        reasons.push({
            code: 'allergen_status',
            detail: unreviewed.length > 0 ? ingredientNames(unreviewed) : [recipe.allergen_status],
        });
    }

    const recipeAllergenKeys = new Set(deriveAllergenTags(recipe.ingredients).map(tagKey));
    const matchedAllergens = preferences.allergens.filter((allergen) => {
        const key = tagKey(allergen);
        return key.length > 0 && key !== NONE_ALLERGEN_TAG_KEY && recipeAllergenKeys.has(key);
    });
    if (matchedAllergens.length > 0) {
        reasons.push({ code: 'allergen', detail: sortedDistinct(matchedAllergens) });
    }

    if (preferences.diet !== null && !isDietCompatible(preferences.diet, deriveDietTags(recipe.ingredients))) {
        reasons.push({ code: 'diet', detail: [preferences.diet] });
    }

    const dislikedIds = new Set(preferences.disliked_food_ids);
    const dislikedGroupKeys = new Set(
        preferences.disliked_food_groups.map(tagKey).filter((key) => key.length > 0),
    );
    const dislikedIngredients = recipe.ingredients.filter(
        (ingredient) =>
            dislikedIds.has(ingredient.catalog_food_id) ||
            (ingredient.food_group != null && dislikedGroupKeys.has(tagKey(ingredient.food_group))),
    );
    if (dislikedIngredients.length > 0) {
        reasons.push({ code: 'dislike', detail: ingredientNames(dislikedIngredients) });
    }

    // Negated rather than `>`, so a non-finite total_minutes is a refusal: the
    // comparison would be false either way and the safe reading of "we do not
    // know how long this takes" is that it does not fit.
    const limit = preferences.cooking_time_limit_min;
    if (limit !== null && !(recipe.total_minutes <= limit)) {
        reasons.push({ code: 'cooking_time', detail: [String(recipe.total_minutes)] });
    }

    if (slot !== null) {
        const declaredSlotKeys = new Set(recipe.meal_slots.map(tagKey));
        if (!declaredSlotKeys.has(tagKey(slot))) {
            reasons.push({ code: 'slot', detail: [slot] });
        }
    }

    return { eligible: reasons.length === 0, reasons };
};

/**
 * Whether a recipe may be planned — {@link evaluatePlanningEligibility}'s
 * verdict reduced to the boolean the generator's candidate filter wants. One
 * implementation, two shapes; never a second set of rules.
 */
export const isEligibleForPlanning = (
    recipe: PlanningRecipeVersion,
    preferences: PlanningPreferences,
    slot: MealSlot | null = null,
): boolean => evaluatePlanningEligibility(recipe, preferences, slot).eligible;

/* ---------------------------------------------------------------------------
 * Declared versus derived — the seed's gate
 * ------------------------------------------------------------------------- */

/** Everything a `recipe_versions` row's derived columns are computed from. */
export interface DerivedRecipeVersionFields {
    totalMinutes: number;
    nutrition: RecipeNutritionDerivation;
    perServing: RecipePerServingNutrition;
    sourcedCaloriesNote: string | null;
    dietTags: string[];
    allergenTags: string[];
    allergenStatus: RecipeAllergenStatus;
    nutritionProvenance: RecipeNutritionProvenance;
    badges: RecipeBadge[];
    costScore: number;
    budgetTier: 1 | 2 | 3;
}

/**
 * The fields a recipe file DECLARES that this module can check.
 *
 * The four `unknown`-typed members are values read from JSON, so they are
 * checked rather than trusted; the optional members are compared only when the
 * file states them, because the derivation is authoritative either way.
 */
export interface RecipeDeclaration {
    icon_key: unknown;
    meal_slots: readonly unknown[];
    badges: readonly unknown[];
    diet_tags: readonly string[];
    allergen_tags: readonly string[];
    prep_minutes: number;
    cook_minutes: number;
    yield_servings: number;
    total_minutes?: number;
    allergen_status?: unknown;
    nutrition_provenance?: unknown;
    budget_tier?: unknown;
}

export type RecipeMismatchCode =
    /** Outside a closed set this module owns. */
    | 'unknown_value'
    /** A list that must not be empty is. */
    | 'empty_value'
    /** The derivation produces it and the file does not declare it. */
    | 'undeclared'
    /** The file declares it and the derivation does not support it. */
    | 'unsupported'
    /** A single value differs from the derived one. */
    | 'mismatch';

export interface RecipeDeclarationMismatch {
    /** The `recipe_versions` column at issue. */
    field: string;
    code: RecipeMismatchCode;
    declared: string;
    /** The derived value, or the permitted values when a closed set was violated. */
    derived: string;
    /** The ingredients that explain the mismatch, where any can be named. */
    ingredients: string[];
    /**
     * A ready-to-print explanation. The seed prefixes the recipe's slug and
     * file, so this names the field, the values and the offending ingredients
     * and nothing else.
     */
    message: string;
}

export interface RecipeDeclarationVerdict {
    valid: boolean;
    derived: DerivedRecipeVersionFields;
    mismatches: RecipeDeclarationMismatch[];
}

/**
 * Everything a new `recipe_versions` row's derived columns hold, computed from
 * the ingredient set.
 *
 * This is what the seed publishes FROM — `total_minutes`, `per_serving_*`,
 * `sourced_calories_note`, `diet_tags`, `allergen_tags`, `allergen_status`,
 * `nutrition_provenance`, `badges` and `budget_tier` are all derived here and
 * none of them is read from the file.
 */
export const deriveRecipeVersionFields = (
    ingredients: readonly RecipePublicationIngredient[],
    yieldServings: number,
    prepMinutes: number,
    cookMinutes: number,
): DerivedRecipeVersionFields => {
    const totalMinutes = deriveTotalMinutes(prepMinutes, cookMinutes);
    const nutrition = deriveRecipeNutrition(ingredients, yieldServings);
    const costScore = deriveCostScore(ingredients);

    return {
        totalMinutes,
        nutrition,
        perServing: nutrition.perServing,
        sourcedCaloriesNote: nutrition.sourcedCaloriesNote,
        dietTags: deriveDietTags(ingredients),
        allergenTags: deriveAllergenTags(ingredients),
        allergenStatus: deriveAllergenStatus(ingredients),
        nutritionProvenance: deriveNutritionProvenance(ingredients),
        badges: deriveBadges(ingredients, { nutrition: nutrition.total, totalMinutes }),
        costScore,
        budgetTier: deriveBudgetTier(costScore),
    };
};

const hasTag = (tags: readonly string[], value: string): boolean => {
    const key = tagKey(value);
    return tags.some((tag) => tagKey(tag) === key);
};

const carryingAllergen = (
    ingredients: readonly RecipeIngredientIdentity[],
    allergen: string,
): RecipeIngredientIdentity[] =>
    ingredients.filter((ingredient) => hasTag(ingredient.snapshot_allergen_tags, allergen));

const lackingDietTag = (
    ingredients: readonly RecipeIngredientIdentity[],
    tag: string,
): RecipeIngredientIdentity[] =>
    ingredients.filter((ingredient) => !hasTag(ingredient.snapshot_diet_tags, tag));

const unreviewedIngredients = (
    ingredients: readonly RecipeIngredientIdentity[],
): RecipeIngredientIdentity[] => ingredients.filter((ingredient) => ingredient.allergen_status !== 'known');

/**
 * The ingredients that stop a declared badge from being earned.
 *
 * `high_protein` and `quick` are facts about the nutrition and the clock rather
 * than about any ingredient, so they name none — the mismatch's `declared` and
 * `derived` values already say everything there is to say about them.
 */
const badgeBlockers = (
    badge: RecipeBadge,
    ingredients: readonly RecipeIngredientIdentity[],
): RecipeIngredientIdentity[] => {
    if (badge === 'vegan') {
        return lackingDietTag(ingredients, VEGAN_DIET_TAG);
    }
    if (badge === 'gluten_free') {
        return ingredients.filter(
            (ingredient) =>
                ingredient.allergen_status !== 'known' ||
                !hasTag(ingredient.snapshot_diet_tags, GLUTEN_FREE_DIET_TAG) ||
                ingredient.snapshot_allergen_tags.some((tag) => GLUTEN_CONTRADICTING_TAG_KEYS.has(tagKey(tag))),
        );
    }
    if (badge === 'dairy_free') {
        return ingredients.filter(
            (ingredient) =>
                ingredient.allergen_status !== 'known' || hasTag(ingredient.snapshot_allergen_tags, MILK_ALLERGEN_TAG),
        );
    }

    return [];
};

const describeList = (values: readonly string[]): string => (values.length === 0 ? 'none' : values.join(', '));

interface TagSetComparison {
    field: string;
    declared: readonly string[];
    derived: readonly string[];
    /** Why the derivation includes a value the file omitted. */
    sourcesOf: (value: string) => readonly RecipeIngredientIdentity[];
    /** Why the derivation rejects a value the file declared. */
    blockersOf: (value: string) => readonly RecipeIngredientIdentity[];
}

/**
 * Compares a declared tag or badge list with the derived one, by normalised
 * key so a spelling difference is not reported as a missing value.
 *
 * BOTH directions are mismatches. An undeclared value is the dangerous one — a
 * recipe file that omits the `milk` its ingredients carry would understate an
 * allergen — but an unsupported one is a false claim, and the AAP requires the
 * declared set to EQUAL the derived set so that the stored column can be
 * trusted as a record of the derivation. Values are reported in sorted order.
 */
const compareTagSets = (comparison: TagSetComparison): RecipeDeclarationMismatch[] => {
    const declaredKeys = new Set(comparison.declared.map(tagKey));
    const derivedKeys = new Set(comparison.derived.map(tagKey));

    const undeclared = comparison.derived.filter((value) => !declaredKeys.has(tagKey(value))).sort();
    const unsupported = comparison.declared.filter((value) => !derivedKeys.has(tagKey(value))).sort();

    const mismatches: RecipeDeclarationMismatch[] = [];

    for (const value of undeclared) {
        const names = ingredientNames(comparison.sourcesOf(value));
        mismatches.push({
            field: comparison.field,
            code: 'undeclared',
            declared: describeList([...comparison.declared].sort()),
            derived: value,
            ingredients: names,
            message:
                `${comparison.field} does not declare "${value}", which the ingredients produce` +
                (names.length === 0 ? '.' : `: ${describeList(names)}.`),
        });
    }

    for (const value of unsupported) {
        const names = ingredientNames(comparison.blockersOf(value));
        mismatches.push({
            field: comparison.field,
            code: 'unsupported',
            declared: value,
            derived: describeList([...comparison.derived].sort()),
            ingredients: names,
            message:
                `${comparison.field} declares "${value}", which the ingredients do not support` +
                (names.length === 0 ? '.' : `: ${describeList(names)}.`),
        });
    }

    return mismatches;
};

const compareValue = (
    field: string,
    declared: unknown,
    derived: string | number,
): RecipeDeclarationMismatch | null =>
    declared === undefined || declared === derived
        ? null
        : {
              field,
              code: 'mismatch',
              declared: String(declared),
              derived: String(derived),
              ingredients: [],
              message: `${field} declares ${String(declared)} but the derived value is ${String(derived)}.`,
          };

/**
 * Checks a recipe file's declared fields against the derivation and returns
 * both — the seed's single gate.
 *
 * Nothing here is corrected: the derived values are returned for publication
 * and every disagreement is reported so `recipes-seed.ts` can fail the file
 * loudly, naming the recipe (which it holds) and the offending ingredient
 * (which this verdict names). A file must not be able to talk its way into a
 * "Gluten free" badge or an understated allergen list, and a silent correction
 * would leave the file and the database disagreeing for ever.
 *
 * Closed-set membership is checked here too, because `icon_key`, `meal_slots`
 * and `badges` are plain TEXT columns and the mobile codecs decode them
 * leniently — the backend is the only place an unknown code can be caught.
 *
 * Throws rather than reporting when the ingredient data itself makes a
 * derivation impossible (`RecipeDerivationError`, or `UnitConversionError` for
 * a missing density): there is no derived value to compare against in that
 * case, and the seed reports the thrown error against the same recipe.
 */
export const validateRecipeDeclaration = (
    declaration: RecipeDeclaration,
    ingredients: readonly RecipePublicationIngredient[],
): RecipeDeclarationVerdict => {
    const derived = deriveRecipeVersionFields(
        ingredients,
        declaration.yield_servings,
        declaration.prep_minutes,
        declaration.cook_minutes,
    );

    const mismatches: RecipeDeclarationMismatch[] = [];

    if (!isRecipeIconKey(declaration.icon_key)) {
        mismatches.push({
            field: 'icon_key',
            code: 'unknown_value',
            declared: String(declaration.icon_key),
            derived: describeList(RECIPE_ICON_KEYS),
            ingredients: [],
            message: `icon_key "${String(declaration.icon_key)}" is not one of: ${describeList(RECIPE_ICON_KEYS)}.`,
        });
    }

    const unknownSlots = declaration.meal_slots.filter((slot) => !isMealSlot(slot)).map((slot) => String(slot));
    if (declaration.meal_slots.length === 0) {
        mismatches.push({
            field: 'meal_slots',
            code: 'empty_value',
            declared: 'none',
            derived: describeList(MEAL_SLOTS),
            ingredients: [],
            message: 'meal_slots must declare at least one slot: a version with no slot can never be planned.',
        });
    } else if (unknownSlots.length > 0) {
        mismatches.push({
            field: 'meal_slots',
            code: 'unknown_value',
            declared: describeList(unknownSlots.sort()),
            derived: describeList(MEAL_SLOTS),
            ingredients: [],
            message: `meal_slots declares ${describeList(unknownSlots.sort())}, which is not one of: ${describeList(MEAL_SLOTS)}.`,
        });
    }

    const unknownBadges = declaration.badges.filter((badge) => !isRecipeBadge(badge)).map((badge) => String(badge));
    if (unknownBadges.length > 0) {
        mismatches.push({
            field: 'badges',
            code: 'unknown_value',
            declared: describeList(unknownBadges.sort()),
            derived: describeList(RECIPE_BADGES),
            ingredients: [],
            message: `badges declares ${describeList(unknownBadges.sort())}, which is not one of: ${describeList(RECIPE_BADGES)}.`,
        });
    }

    mismatches.push(
        ...compareTagSets({
            field: 'badges',
            declared: declaration.badges.filter(isRecipeBadge),
            derived: derived.badges,
            // A derived badge the file omitted is not any ingredient's doing —
            // it is earned by the whole set — so only the rejected direction
            // names ingredients.
            sourcesOf: () => [],
            blockersOf: (value) => (isRecipeBadge(value) ? badgeBlockers(value, ingredients) : []),
        }),
    );

    mismatches.push(
        ...compareTagSets({
            field: 'allergen_tags',
            declared: declaration.allergen_tags,
            derived: derived.allergenTags,
            sourcesOf: (value) => carryingAllergen(ingredients, value),
            blockersOf: () => [],
        }),
    );

    mismatches.push(
        ...compareTagSets({
            field: 'diet_tags',
            declared: declaration.diet_tags,
            derived: derived.dietTags,
            // A derived diet tag holds because every ingredient carries it, so
            // there is no single source to name; a declared one fails because
            // some ingredient does not.
            sourcesOf: () => [],
            blockersOf: (value) => lackingDietTag(ingredients, value),
        }),
    );

    const allergenStatusMismatch = compareValue('allergen_status', declaration.allergen_status, derived.allergenStatus);
    if (allergenStatusMismatch) {
        mismatches.push({
            ...allergenStatusMismatch,
            ingredients: ingredientNames(unreviewedIngredients(ingredients)),
        });
    }

    const singleValueMismatches = [
        compareValue('nutrition_provenance', declaration.nutrition_provenance, derived.nutritionProvenance),
        compareValue('total_minutes', declaration.total_minutes, derived.totalMinutes),
        compareValue('budget_tier', declaration.budget_tier, derived.budgetTier),
    ];
    for (const mismatch of singleValueMismatches) {
        if (mismatch) {
            mismatches.push(mismatch);
        }
    }

    return { valid: mismatches.length === 0, derived, mismatches };
};
