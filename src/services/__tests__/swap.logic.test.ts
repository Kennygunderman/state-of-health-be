// Unit tests for the swap selection rules. No database, no network, no mocks
// and no clock: every rule in `swap.logic.ts` takes the rows it judges as
// arguments, so each test states a whole scenario from object literals and
// asserts a returned value.
//
// The scenarios that matter most are the ones a future change could plausibly
// "simplify" away, and each has its own describe block below:
//
//  - LIST = PREVIEW = COMMIT. One fixture proves `selectSwapCandidate` returns
//    the identical candidate the list carries — every row of a full eight-row
//    list included — that a recipe the list never offered is refused with
//    `RecipeIneligibleError`, and that the committed write holds exactly the
//    previewed numbers. Three separate implementations of "which meals fit",
//    and a preview reading a wider set than the sheet, are the failures this
//    pins.
//  - THE CURRENT MEAL REMOVED FROM REPETITION. A recipe whose only other use in
//    the week IS the meal being replaced stays admissible, and one more use
//    elsewhere makes it inadmissible again — so the removal subtracts exactly
//    one. The day-before and day-after cases are asserted separately, because
//    passing only one neighbour is the plausible mistake (the generator has
//    one).
//  - DETERMINISM WITHOUT A PRNG. The same candidates in a shuffled input order
//    yield an identical list, equal-proximity candidates order by slug then
//    version, and `Math.random` is asserted never to be consulted. The ranking
//    key is also proved TRANSITIVE — every permutation of a triple whose
//    proximities sit within one epsilon of each other sorts to one list —
//    because approximate equality is not an equivalence relation and a
//    comparator built on it makes the list depend on the input order.
//  - AN EMPTY LIST IS AN ANSWER. A slot whose only eligible recipe is the one
//    already planned returns `[]` (the client's 13d state) rather than offering
//    the user their own lunch, and an allergen is never relaxed to fill a short
//    list.
//  - THE PREVIEW BINDS THE PORTION. Including the §0.9.2 pair: a target change
//    that moves the recomputed multiplier ends in `PreviewStaleError`, and one
//    that leaves it equal does not.
//  - A COMMITTED SWAP CLEARS THE MEAL'S FLAGS. `swapMealWrite` returns empty
//    `flags` for every candidate, because a candidate that reached a commit
//    passed the eligibility rule a flag is raised by (§0.7.3).
//  - A -> B -> C LOGGED STATE, composed here from `swapMealWrite` and
//    `plannedMealLog.logic.ts::deriveLoggedStatus` rather than re-implemented in
//    `swap.logic.ts`: the audit column names B while the diary entries still
//    name A, and it is the entries the caption must come from.
//  - THE SWAP READS THE SAME FOOD GRAPH THE GENERATOR PLANS FROM. The last
//    describe drives the committed `recipes.fixture.json` versions — the rows
//    the recipe, planner, grocery and planned-log suites read — so the two
//    domains are proved to accept the same meals over real ingredient
//    snapshots, allergen tags and cooking times rather than over synthesised
//    ones. The synthetic recipes above pin the arithmetic; this pins the
//    agreement.
//  - THE SELECTION LEAVES ITS CALLER'S ARRAYS ALONE. The rows a list is built
//    from are very often the query result a later step reuses, and the sort
//    that ranks them is one `context.recipes.sort()` away from reordering it.
//  - THE REQUEST PARSERS ANSWER IN DATA, AND ANSWER ONCE. The three parsers
//    report every offending field of a request in ONE verdict, never throw, and
//    refuse a `portionMultiplier` that is not one of the offered portions — the
//    check that keeps a malformed portion a 400 instead of the `preview_stale`
//    `requireBoundPortion` would call it. The revision bound is pinned at
//    `MAX_REVISION` and one above it, because `Number.isInteger(1e30)` is true
//    and such a value becomes a 500 in the fingerprinter rather than a 400.
//
// Fixtures put every recipe on the TARGET'S OWN MACRO RATIO, so the day
// tolerance binds on calories alone and each scenario's arithmetic is readable
// (`proportional` below). Where a test needs the tolerance to bind on a macro
// instead, it states an explicit per-serving profile. Thresholds are never
// hand-copied: the multiplier sets and the list length come from the modules'
// own exported constants.

import { readFileSync } from 'fs';
import { join } from 'path';

import {
    MAX_SWAP_ALTERNATIVES,
    ParsedSwapAlternativesPath,
    ParsedSwapCommitRequest,
    ParsedSwapPreviewPath,
    SWAP_FIELD_CODES,
    SwapCandidate,
    SwapDayMeal,
    SwapSelectionContext,
    SwapWeekMeal,
    compareSwapCandidates,
    currentDayTotalsFor,
    parseSwapAlternativesPath,
    parseSwapCommitRequest,
    parseSwapPreviewPath,
    requireBoundPortion,
    selectSwapCandidate,
    selectSwapCandidates,
    selectSwapPortion,
    swapMealWhere,
    swapMealWrite,
} from '../swap.logic';
import {
    EXTENDED_PORTION_POLICY,
    MAIN_SLOT_PORTION_MULTIPLIERS,
    MealPlanInputError,
    PlanRecipeCandidate,
    SNACK_PORTION_MULTIPLIERS,
    TOLERANCE_EPSILON,
    computeDayTotals,
    isDayWithinTolerance,
    targetProximity,
} from '../mealPlan.logic';
import { PreviewStaleError, RecipeIneligibleError } from '../mealPlanning.errors';
import { LinkedDiaryEntryRow, deriveLoggedStatus } from '../plannedMealLog.logic';
import { MAX_REVISION } from '../preferences.logic';
import { PlanningPreferences } from '../recipe.logic';
import type { InvalidRequestDetail, MealPlanMacroTotals, SwapMealPayload } from '../../types/mealPlanning';
import type { MealSlot } from '../../types/recipe';

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

const TARGETS: MealPlanMacroTotals = { calories: 2000, protein: 150, carbs: 200, fat: 65 };

/** A nutrition profile on the target's own macro ratio, so only calories vary. */
const proportional = (calories: number): MealPlanMacroTotals => ({
    calories,
    protein: calories * (TARGETS.protein / TARGETS.calories),
    carbs: calories * (TARGETS.carbs / TARGETS.calories),
    fat: calories * (TARGETS.fat / TARGETS.calories),
});

/** A target set on the same ratio — what "the user moved their targets" looks like. */
const targetsAt = (calories: number): MealPlanMacroTotals => proportional(calories);

const PLAN_START = '2026-07-05';
/** Mid-week ON PURPOSE: this day has a day before AND a day after. */
const SWAP_DATE = '2026-07-08';
const DAY_BEFORE = '2026-07-07';
const DAY_AFTER = '2026-07-09';
const TWO_DAYS_LATER = '2026-07-10';
const PLAN_END = '2026-07-11';

const BREAKFAST_MEAL_ID = 'meal-breakfast';
const LUNCH_MEAL_ID = 'meal-lunch';
const DINNER_MEAL_ID = 'meal-dinner';

/** The recipe the day's breakfast holds — reused as the same-day repetition case. */
const SHARED_RECIPE_ID = 'shared-recipe';
/** The recipe the lunch being replaced holds, and its planned version. */
const WRAP_RECIPE_ID = 'wrap-recipe';
const WRAP_VERSION_1 = 'wrap-version-1';
const WRAP_VERSION_2 = 'wrap-version-2';

type Ingredient = PlanRecipeCandidate['ingredients'][number];

interface RecipeSpec {
    slug: string;
    /** Per-serving calories; the other three macros follow the target ratio. */
    perServingCalories?: number;
    /** An explicit profile, for fixtures that need the tolerance to bind on a macro. */
    nutrition?: MealPlanMacroTotals;
    recipeId?: string;
    versionId?: string;
    version?: number;
    slots?: MealSlot[];
    totalMinutes?: number;
    status?: 'current' | 'retired';
    provenance?: 'source_backed' | 'ingredient_derived' | 'ai_estimated';
    allergenTags?: string[];
    allergenStatus?: 'known' | 'unknown';
    dietTags?: string[];
    ingredientIds?: string[];
    foodGroups?: string[];
}

const makeRecipe = (spec: RecipeSpec): PlanRecipeCandidate => {
    const version = spec.version ?? 1;
    const ingredientIds = spec.ingredientIds ?? [`${spec.slug}-food`];
    const provenance = spec.provenance ?? 'source_backed';
    const allergenStatus = spec.allergenStatus ?? 'known';

    const ingredients: Ingredient[] = ingredientIds.map((catalogFoodId, index) => ({
        catalog_food_id: catalogFoodId,
        snapshot_name: catalogFoodId,
        snapshot_provenance: provenance,
        snapshot_allergen_tags: spec.allergenTags ?? [],
        snapshot_diet_tags: spec.dietTags ?? ['vegan'],
        is_optional: false,
        food_group: spec.foodGroups?.[index] ?? `${catalogFoodId}-group`,
        allergen_status: allergenStatus,
    }));

    return {
        recipe_version_id: spec.versionId ?? `${spec.slug}-version-${version}`,
        recipe_id: spec.recipeId ?? `${spec.slug}-recipe`,
        slug: spec.slug,
        version,
        status: spec.status ?? 'current',
        nutrition_provenance: provenance,
        allergen_status: allergenStatus,
        total_minutes: spec.totalMinutes ?? 20,
        meal_slots: spec.slots ?? ['lunch'],
        ingredients,
        budget_tier: 1,
        per_serving: spec.nutrition ?? proportional(spec.perServingCalories ?? 700),
    };
};

/**
 * The day being edited: breakfast 500 kcal, the lunch under replacement 700,
 * dinner 800 — a day that sits exactly on the 2,000 kcal target, so every
 * candidate's effect on it is the candidate's own arithmetic.
 */
const dayMeals = (lunchOverrides: Partial<SwapDayMeal> = {}): SwapDayMeal[] => [
    {
        id: BREAKFAST_MEAL_ID,
        slot: 'breakfast',
        recipeId: SHARED_RECIPE_ID,
        recipeVersionId: 'shared-version-1',
        portionMultiplier: 1,
        planned: proportional(500),
        revision: 1,
    },
    {
        id: LUNCH_MEAL_ID,
        slot: 'lunch',
        recipeId: WRAP_RECIPE_ID,
        recipeVersionId: WRAP_VERSION_1,
        portionMultiplier: 1,
        planned: proportional(700),
        revision: 1,
        ...lunchOverrides,
    },
    {
        id: DINNER_MEAL_ID,
        slot: 'dinner',
        recipeId: 'salmon-recipe',
        recipeVersionId: 'salmon-version-1',
        portionMultiplier: 1,
        planned: proportional(800),
        revision: 1,
    },
];

const currentLunch = (): SwapDayMeal => {
    const lunch = dayMeals().find((meal) => meal.id === LUNCH_MEAL_ID);

    if (lunch === undefined) {
        throw new Error('the lunch fixture must exist');
    }

    return lunch;
};

/**
 * The week the repetition rule reads: this day's three meals plus one meal on
 * the plan's first day, with whatever the scenario adds.
 */
const weekMeals = (extra: readonly SwapWeekMeal[] = []): SwapWeekMeal[] => [
    ...dayMeals().map((meal) => ({ id: meal.id, date: SWAP_DATE, recipeId: meal.recipeId })),
    { id: 'meal-first-day-lunch', date: PLAN_START, recipeId: 'first-day-recipe' },
    ...extra,
];

const makePreferences = (overrides: Partial<PlanningPreferences> = {}): PlanningPreferences => ({
    diet: null,
    allergens: [],
    disliked_food_ids: [],
    disliked_food_groups: [],
    cooking_time_limit_min: null,
    ...overrides,
});

const makeContext = (overrides: Partial<SwapSelectionContext> = {}): SwapSelectionContext => ({
    mealId: LUNCH_MEAL_ID,
    date: SWAP_DATE,
    slot: 'lunch',
    dayMeals: dayMeals(),
    weekMeals: weekMeals(),
    targets: TARGETS,
    preferences: makePreferences(),
    recipes: [],
    ...overrides,
});

/** The candidate the list would carry for one recipe, or a failure naming it. */
const requirePortion = (context: SwapSelectionContext, recipe: PlanRecipeCandidate): SwapCandidate => {
    const candidate = selectSwapPortion(context, recipe);

    if (candidate === null) {
        throw new Error(`expected ${recipe.slug} to have an admissible portion`);
    }

    return candidate;
};

/** The `field` a {@link MealPlanInputError} names — what the controller renders. */
const inputErrorField = (act: () => unknown): string => {
    try {
        act();
    } catch (error) {
        if (error instanceof MealPlanInputError) {
            return error.field;
        }

        throw error;
    }

    throw new Error('expected a MealPlanInputError');
};

const slugsOf = (candidates: readonly SwapCandidate[]): string[] =>
    candidates.map((candidate) => candidate.recipe.slug);

/**
 * The day that would result from putting exactly `nutrition` in the lunch slot —
 * the counterfactual a test needs to show that a portion the rule REJECTED (or
 * passed over) really was admissible, or really was not.
 */
const dayIfLunchWere = (nutrition: MealPlanMacroTotals): MealPlanMacroTotals =>
    computeDayTotals(
        dayMeals().map((meal) => (meal.id === LUNCH_MEAL_ID ? { planned: nutrition } : meal)),
    );

const scaled = (nutrition: MealPlanMacroTotals, multiplier: number): MealPlanMacroTotals => ({
    calories: nutrition.calories * multiplier,
    protein: nutrition.protein * multiplier,
    carbs: nutrition.carbs * multiplier,
    fat: nutrition.fat * multiplier,
});

/* ---------------------------------------------------------------------------
 * The recipes the scenarios draw from
 *
 * With the day at 500 + 800 = 1,300 kcal around the lunch slot, a candidate
 * portion of C kcal lands the day at 1,300 + C against a 2,000 kcal target, and
 * the ±10 % calorie band admits C between 500 and 900.
 * ------------------------------------------------------------------------- */

/** 700 per serving: one serving lands the day exactly on target. */
const ALT_ALPHA = makeRecipe({ slug: 'alt-alpha', perServingCalories: 700 });

/** Identical numbers to alpha — the equal-proximity case the slug key orders. */
const ALT_BETA = makeRecipe({ slug: 'alt-beta', perServingCalories: 700 });

/** 1,400 per serving: admissible ONLY at half a portion (0.5 -> 700 kcal). */
const ALT_HALF = makeRecipe({ slug: 'alt-half', perServingCalories: 1400 });

/**
 * 1,120 per serving: 0.5 -> 560 (day 1,860) and 0.75 -> 840 (day 2,140) are
 * exactly equidistant from the target, so the tie must resolve to 0.5.
 */
const ALT_TIE = makeRecipe({ slug: 'alt-tie', perServingCalories: 1120 });

/**
 * 500 per serving: the FIRST admissible multiplier (1 -> day 1,800, on the band
 * edge) is 200 kcal out, while 1.5 -> day 2,050 is 50 out. The chosen portion
 * proves the rule minimises rather than taking the first portion that fits.
 */
const ALT_LARGER = makeRecipe({ slug: 'alt-larger', perServingCalories: 500 });

/** 200 per serving: even two portions leave the day below the band. */
const ALT_TINY = makeRecipe({ slug: 'alt-tiny', perServingCalories: 200 });

/**
 * 630 per serving: one portion lands the day at 1,930 kcal, 70 BELOW the day as
 * it stands — frame 13b's `−70 cal` delta pill, and the one sign the fixtures
 * above cannot produce (`alt-half` moves the day by nothing and `alt-larger`
 * moves it up).
 *
 * One portion is also the chosen one: three quarters leaves the day at 1,772.5
 * and outside the calorie band, and one and a quarter is 87.5 kcal out against
 * this portion's 70.
 */
const ALT_LIGHTER = makeRecipe({ slug: 'alt-lighter', perServingCalories: 630 });

/**
 * Lands the day's CALORIES exactly on target at one serving while leaving its
 * protein far below the band — the whole-day tolerance case.
 */
const ALT_PROTEIN_POOR = makeRecipe({
    slug: 'alt-protein-poor',
    nutrition: { calories: 700, protein: 0, carbs: 175, fat: 0 },
});

/**
 * 350 per serving, declared for lunch AND snack: the main-slot set reaches 2
 * (day exactly on target) where the snack set stops at 1.5, so the two slots
 * choose different portions for the same recipe.
 */
const ALT_SNACKABLE = makeRecipe({
    slug: 'alt-snackable',
    perServingCalories: 350,
    slots: ['lunch', 'snack'],
});

/** The republished version of the dish currently in the slot. */
const WRAP_V2 = makeRecipe({
    slug: 'wrap',
    version: 2,
    versionId: WRAP_VERSION_2,
    recipeId: WRAP_RECIPE_ID,
    perServingCalories: 700,
});

/** The version the slot already holds — never an alternative to itself. */
const WRAP_V1 = makeRecipe({
    slug: 'wrap',
    version: 1,
    versionId: WRAP_VERSION_1,
    recipeId: WRAP_RECIPE_ID,
    perServingCalories: 700,
});

/**
 * Twelve interchangeable alternatives, each 2 kcal lighter than the last, so
 * their resulting days are 2 kcal further from the target in `slug` order and
 * the ranking has one unambiguous answer.
 */
const rankedAlternatives = (): PlanRecipeCandidate[] =>
    Array.from({ length: 12 }, (unused, index) =>
        makeRecipe({
            slug: `rank-${String(index).padStart(2, '0')}`,
            perServingCalories: 700 - 2 * index,
        }),
    );

/* ---------------------------------------------------------------------------
 * currentDayTotalsFor
 * ------------------------------------------------------------------------- */

describe('currentDayTotalsFor', () => {
    it('sums the day as it stands, the meal being replaced included', () => {
        const context = makeContext();
        const totals = currentDayTotalsFor(context);

        expect(totals).toEqual(computeDayTotals(context.dayMeals));
        expect(totals.calories).toBe(2000);
    });

    it('refuses a day that does not contain the meal being replaced', () => {
        const context = makeContext({ mealId: 'meal-from-another-day' });

        expect(() => currentDayTotalsFor(context)).toThrow(MealPlanInputError);
        expect(inputErrorField(() => currentDayTotalsFor(context))).toBe('dayMeals');
    });

    it('refuses a date that does not exist, rather than planning against it', () => {
        const context = makeContext({ date: '2026-02-30' });

        expect(inputErrorField(() => currentDayTotalsFor(context))).toBe('date');
    });

    it('refuses a slot that disagrees with the stored meal', () => {
        const context = makeContext({ slot: 'dinner' });

        expect(inputErrorField(() => currentDayTotalsFor(context))).toBe('slot');
    });

    /**
     * The day-total guard in `mealPlan.logic.ts` is inherited here, and it
     * matters more on this path than on the generator's.
     *
     * A non-finite figure in a meal the swap KEEPS used to flow straight
     * through: the tolerance gate answered `true` for a NaN day (every band is
     * written in the positive form, and NaN fails every comparison), so
     * {@link selectSwapPortion} would compute a NaN calorie distance, a NaN
     * `calorieDelta` and a NaN `targetProximity` — and then offer that
     * candidate, ranked by a value no comparison can order. The user would be
     * shown alternatives in an arbitrary order with blank arithmetic behind
     * them. Now the fault surfaces named.
     */
    describe('a non-finite planned figure in the day', () => {
        const dayWithNaNBreakfast = (): SwapDayMeal[] =>
            dayMeals().map((meal) =>
                meal.id === BREAKFAST_MEAL_ID
                    ? { ...meal, planned: { ...meal.planned, calories: Number.NaN } }
                    : meal,
            );

        it('refuses to sum the day, naming the meal that carries it', () => {
            const context = makeContext({ dayMeals: dayWithNaNBreakfast() });

            expect(() => currentDayTotalsFor(context)).toThrow(MealPlanInputError);
            expect(inputErrorField(() => currentDayTotalsFor(context))).toBe('meals[0].planned.calories');
        });

        it('refuses to choose a portion against it, rather than ranking by NaN', () => {
            const context = makeContext({ dayMeals: dayWithNaNBreakfast() });

            expect(() => selectSwapPortion(context, makeRecipe({ slug: 'turkey-wrap' }))).toThrow(
                MealPlanInputError,
            );
        });

        it('refuses when the figure is on the meal being replaced', () => {
            const context = makeContext({
                dayMeals: dayMeals({ planned: { ...proportional(700), protein: undefined as unknown as number } }),
            });

            expect(inputErrorField(() => currentDayTotalsFor(context))).toBe('meals[1].planned.protein');
        });

        it('still sums a day whose meals are legitimately zero', () => {
            const context = makeContext({
                dayMeals: dayMeals().map((meal) => ({ ...meal, planned: proportional(0) })),
            });

            expect(currentDayTotalsFor(context).calories).toBe(0);
        });
    });
});

/* ---------------------------------------------------------------------------
 * selectSwapPortion — the portion, and only the portion
 * ------------------------------------------------------------------------- */

describe('selectSwapPortion', () => {
    it('minimises the resulting day\'s calorie gap rather than taking the first portion that fits', () => {
        const candidate = requirePortion(makeContext(), ALT_LARGER);

        expect(candidate.portionMultiplier).toBe(1.5);
        expect(candidate.dayTotalsIfSwapped.calories).toBe(2050);
        // One serving is tried FIRST and genuinely fits — the day lands on the
        // band edge at 1,800 — so a "first admissible" rule would have returned
        // it, 200 kcal out instead of 50.
        const onePortionDay = dayIfLunchWere(ALT_LARGER.per_serving);

        expect(MAIN_SLOT_PORTION_MULTIPLIERS).toContain(1);
        expect(isDayWithinTolerance(onePortionDay, TARGETS)).toBe(true);
        expect(Math.abs(onePortionDay.calories - TARGETS.calories)).toBeGreaterThan(
            Math.abs(candidate.dayTotalsIfSwapped.calories - TARGETS.calories),
        );
    });

    it('offers a recipe that is admissible only at a non-default portion at that portion', () => {
        const candidate = requirePortion(makeContext(), ALT_HALF);

        expect(candidate.portionMultiplier).toBe(0.5);
        expect(candidate.dayTotalsIfSwapped.calories).toBe(2000);
        // A full portion — the default, and the one a "portion 1 unless asked"
        // shortcut would offer — puts the day at 2,700 kcal, 500 above the band.
        expect(isDayWithinTolerance(dayIfLunchWere(ALT_HALF.per_serving), TARGETS)).toBe(false);
    });

    it('breaks a tie between two equidistant portions toward the smaller multiplier', () => {
        const candidate = requirePortion(makeContext(), ALT_TIE);

        expect(candidate.portionMultiplier).toBe(0.5);
        expect(candidate.dayTotalsIfSwapped.calories).toBe(1860);
        // The tie is real: three quarters of a portion is the same distance out.
        expect(Math.abs(2140 - TARGETS.calories)).toBe(
            Math.abs(candidate.dayTotalsIfSwapped.calories - TARGETS.calories),
        );
    });

    it('returns null when no portion keeps the day inside tolerance', () => {
        expect(selectSwapPortion(makeContext(), ALT_TINY)).toBeNull();
    });

    it('applies the whole-day tolerance, not the calorie band alone', () => {
        // One serving lands the day's calories exactly on target, so a
        // calories-only gate would admit it — the protein band is what refuses
        // it, at this and at every other portion.
        const onePortionDay = dayIfLunchWere(ALT_PROTEIN_POOR.per_serving);

        expect(onePortionDay.calories).toBe(TARGETS.calories);
        expect(onePortionDay.protein).toBeLessThan(TARGETS.protein);
        expect(isDayWithinTolerance(onePortionDay, TARGETS)).toBe(false);
        expect(selectSwapPortion(makeContext(), ALT_PROTEIN_POOR)).toBeNull();
    });

    it('uses the slot\'s own multiplier set, so a snack is never offered a main-slot portion', () => {
        const lunchCandidate = requirePortion(makeContext(), ALT_SNACKABLE);
        const snackContext = makeContext({
            slot: 'snack',
            dayMeals: dayMeals({ slot: 'snack' }),
        });
        const snackCandidate = requirePortion(snackContext, ALT_SNACKABLE);

        expect(lunchCandidate.portionMultiplier).toBe(2);
        expect(MAIN_SLOT_PORTION_MULTIPLIERS).toContain(2);
        expect(SNACK_PORTION_MULTIPLIERS).not.toContain(2);
        expect(snackCandidate.portionMultiplier).toBe(1.5);
    });

    it('carries the per-portion nutrition unrounded and the delta against the day as it stands', () => {
        const context = makeContext();
        const half = requirePortion(context, ALT_HALF);
        const larger = requirePortion(context, ALT_LARGER);

        expect(half.nutrition).toEqual(scaled(ALT_HALF.per_serving, 0.5));
        expect(larger.nutrition).toEqual(scaled(ALT_LARGER.per_serving, 1.5));
        // A like-for-like swap moves nothing; the heavier portion moves the day up.
        expect(half.calorieDelta).toBe(0);
        expect(larger.calorieDelta).toBe(50);
    });

    it('computes the whole resulting day, not only its calories, at full precision', () => {
        const context = makeContext();
        const half = requirePortion(context, ALT_HALF);
        const larger = requirePortion(context, ALT_LARGER);

        // All four values, against the day recomputed independently with the
        // candidate substituted in place: the preview card, the swap's stored
        // day totals and every macro band are read off this object, so a term
        // dropped from it would leave the calorie figure — the only one a
        // narrower assertion checks — perfectly right.
        expect(half.dayTotalsIfSwapped).toEqual(dayIfLunchWere(scaled(ALT_HALF.per_serving, 0.5)));
        expect(larger.dayTotalsIfSwapped).toEqual(dayIfLunchWere(scaled(ALT_LARGER.per_serving, 1.5)));
        // And unrounded: 37.5 g of protein at one and a half portions leaves the
        // day on a quarter gram, which the diary rounds once, later.
        expect(larger.dayTotalsIfSwapped.protein).toBe(153.75);
    });

    it('signs the calorie delta against the day as it stands: down, up and exactly level', () => {
        const context = makeContext();
        const currentCalories = currentDayTotalsFor(context).calories;

        // The sign is the delta pill's whole meaning, and inverting it is a
        // one-character change: 13b draws `−70 cal` for a day that gets lighter.
        expect(requirePortion(context, ALT_LIGHTER).calorieDelta).toBe(-70);
        expect(requirePortion(context, ALT_LARGER).calorieDelta).toBe(50);
        expect(requirePortion(context, ALT_HALF).calorieDelta).toBe(0);

        for (const recipe of [ALT_LIGHTER, ALT_LARGER, ALT_HALF]) {
            const candidate = requirePortion(context, recipe);

            expect(candidate.calorieDelta).toBe(candidate.dayTotalsIfSwapped.calories - currentCalories);
        }
    });

    it('carries every number an alternatives row needs, and none of its prose', () => {
        const candidate = requirePortion(makeContext(), ALT_LIGHTER);

        expect(Object.keys(candidate).sort()).toEqual([
            'calorieDelta',
            'dayTotalsIfSwapped',
            'nutrition',
            'portionMultiplier',
            'recipe',
            'targetProximity',
        ]);
        // §0.5.2's alternatives row reads `recipeVersionId`, `calories`,
        // `protein`, `totalMinutes` and `portionMultiplier` off exactly this
        // object, so each has to be here and has to be the candidate's own
        // portion rather than the recipe's serving.
        expect(candidate.recipe.recipe_version_id).toBe(ALT_LIGHTER.recipe_version_id);
        expect(candidate.recipe.total_minutes).toBe(ALT_LIGHTER.total_minutes);
        expect(candidate.portionMultiplier).toBe(1);
        expect(candidate.nutrition.calories).toBe(ALT_LIGHTER.per_serving.calories);
        expect(candidate.nutrition.protein).toBe(ALT_LIGHTER.per_serving.protein);
        // The row's `name` and `iconKey` are the mapper's to supply (Rule
        // backend-architecture §6), so this module invents no display string:
        // nothing it computes is text at all.
        expect(Object.values(candidate).some((value) => typeof value === 'string')).toBe(false);
    });

    it('ranks on the resulting whole day, never on a slot share', () => {
        const candidate = requirePortion(makeContext(), ALT_LARGER);

        expect(candidate.targetProximity).toBe(targetProximity(candidate.dayTotalsIfSwapped, TARGETS, 1));
    });
});

/* ---------------------------------------------------------------------------
 * Eligibility — the generator's hard set, asserted one refusal at a time
 * ------------------------------------------------------------------------- */

describe('selectSwapCandidates eligibility', () => {
    const listWith = (
        recipes: readonly PlanRecipeCandidate[],
        preferences: PlanningPreferences = makePreferences(),
    ): SwapCandidate[] => selectSwapCandidates(makeContext({ recipes, preferences }));

    it('lists an eligible alternative', () => {
        expect(slugsOf(listWith([ALT_ALPHA]))).toEqual(['alt-alpha']);
    });

    it('excludes a retired version, which stays readable but is never planned again', () => {
        const retired = makeRecipe({ slug: 'alt-retired', status: 'retired' });

        expect(listWith([retired])).toEqual([]);
    });

    it('excludes a recipe whose nutrition is not source-backed, so a planned meal is never an estimate', () => {
        const derived = makeRecipe({ slug: 'alt-derived', provenance: 'ingredient_derived' });
        const estimated = makeRecipe({ slug: 'alt-estimated', provenance: 'ai_estimated' });

        expect(listWith([derived, estimated])).toEqual([]);
    });

    it('excludes a recipe whose allergen metadata is unreviewed, whatever the user selected', () => {
        const unreviewed = makeRecipe({ slug: 'alt-unreviewed', allergenStatus: 'unknown' });

        expect(listWith([unreviewed], makePreferences({ allergens: ['none'] }))).toEqual([]);
    });

    it('excludes a recipe carrying one of the user\'s allergens', () => {
        const milky = makeRecipe({ slug: 'alt-milky', allergenTags: ['milk'] });

        expect(slugsOf(listWith([milky, ALT_ALPHA], makePreferences({ allergens: ['Milk'] })))).toEqual([
            'alt-alpha',
        ]);
    });

    it('never relaxes an allergen to fill a short list', () => {
        const milky = makeRecipe({ slug: 'alt-milky', allergenTags: ['milk'] });

        // The only otherwise-eligible alternative carries the allergen, so the
        // honest answer is nothing at all.
        expect(listWith([milky], makePreferences({ allergens: ['milk'] }))).toEqual([]);
    });

    it('excludes a recipe incompatible with the user\'s diet', () => {
        const meaty = makeRecipe({ slug: 'alt-meaty', dietTags: [] });

        expect(slugsOf(listWith([meaty, ALT_ALPHA], makePreferences({ diet: 'vegetarian' })))).toEqual([
            'alt-alpha',
        ]);
    });

    it('excludes a recipe containing a disliked food, by id and by food group', () => {
        const mushroomy = makeRecipe({
            slug: 'alt-mushroomy',
            ingredientIds: ['mushroom-food'],
            foodGroups: ['mushroom'],
        });

        expect(listWith([mushroomy], makePreferences({ disliked_food_ids: ['mushroom-food'] }))).toEqual([]);
        expect(listWith([mushroomy], makePreferences({ disliked_food_groups: ['Mushroom'] }))).toEqual([]);
    });

    it('excludes a recipe that takes longer than the user\'s cooking-time limit', () => {
        const slow = makeRecipe({ slug: 'alt-slow', totalMinutes: 45 });

        expect(listWith([slow], makePreferences({ cooking_time_limit_min: 30 }))).toEqual([]);
        expect(slugsOf(listWith([slow], makePreferences({ cooking_time_limit_min: 45 })))).toEqual([
            'alt-slow',
        ]);
    });

    it('excludes a recipe that does not declare this slot', () => {
        const breakfastOnly = makeRecipe({ slug: 'alt-breakfast', slots: ['breakfast'] });

        expect(listWith([breakfastOnly])).toEqual([]);
    });

    it('excludes a recipe no portion of which fits the day', () => {
        expect(slugsOf(listWith([ALT_TINY, ALT_ALPHA]))).toEqual(['alt-alpha']);
    });

    it('lists a recipe admissible only at a non-default portion AT that portion', () => {
        // §0.7.3's explicit list assertion: the ROW carries the half portion,
        // not the default one, so the number the user taps is the number the
        // preview and the commit work from.
        const [listed] = listWith([ALT_HALF]);

        expect(listed.portionMultiplier).toBe(0.5);
        expect(listed.nutrition).toEqual(scaled(ALT_HALF.per_serving, 0.5));
        expect(listed.dayTotalsIfSwapped.calories).toBe(2000);
    });
});

/* ---------------------------------------------------------------------------
 * Repetition — evaluated with the meal being replaced removed
 * ------------------------------------------------------------------------- */

describe('selectSwapCandidates repetition', () => {
    it('keeps a recipe whose only other use in the week is the meal being replaced', () => {
        // `wrap` is planned twice: at this very lunch and on the last day. The
        // meal being replaced does not count against itself, so one use remains
        // and the republished version is admissible — and because the current
        // meal also leaves the SAME-DAY set, its own dish does not block it.
        const context = makeContext({
            recipes: [WRAP_V2],
            weekMeals: weekMeals([{ id: 'meal-last-day-lunch', date: PLAN_END, recipeId: WRAP_RECIPE_ID }]),
        });

        expect(slugsOf(selectSwapCandidates(context))).toEqual(['wrap']);
    });

    it('removes the meal being replaced exactly once, not the whole recipe', () => {
        // A third use — this lunch plus two other days — leaves two after the
        // removal, which is the weekly maximum.
        const context = makeContext({
            recipes: [WRAP_V2],
            weekMeals: weekMeals([
                { id: 'meal-last-day-lunch', date: PLAN_END, recipeId: WRAP_RECIPE_ID },
                { id: 'meal-first-day-dinner', date: PLAN_START, recipeId: WRAP_RECIPE_ID },
            ]),
        });

        expect(selectSwapCandidates(context)).toEqual([]);
    });

    it('excludes a recipe planned on the day before', () => {
        const neighbour = makeRecipe({ slug: 'alt-neighbour', recipeId: 'neighbour-recipe' });
        const context = makeContext({
            recipes: [neighbour, ALT_ALPHA],
            weekMeals: weekMeals([{ id: 'meal-before-dinner', date: DAY_BEFORE, recipeId: 'neighbour-recipe' }]),
        });

        expect(slugsOf(selectSwapCandidates(context))).toEqual(['alt-alpha']);
    });

    it('excludes a recipe planned on the day after, because the rule is symmetric', () => {
        const neighbour = makeRecipe({ slug: 'alt-neighbour', recipeId: 'neighbour-recipe' });
        const context = makeContext({
            recipes: [neighbour, ALT_ALPHA],
            weekMeals: weekMeals([{ id: 'meal-after-lunch', date: DAY_AFTER, recipeId: 'neighbour-recipe' }]),
        });

        expect(slugsOf(selectSwapCandidates(context))).toEqual(['alt-alpha']);
    });

    it('admits a recipe two days away, which is the clear day the rule asks for', () => {
        const neighbour = makeRecipe({ slug: 'alt-neighbour', recipeId: 'neighbour-recipe' });
        const context = makeContext({
            recipes: [neighbour],
            weekMeals: weekMeals([
                { id: 'meal-two-days-later', date: TWO_DAYS_LATER, recipeId: 'neighbour-recipe' },
            ]),
        });

        expect(slugsOf(selectSwapCandidates(context))).toEqual(['alt-neighbour']);
    });

    it('excludes a recipe already planned at another meal of the same day', () => {
        const sameDish = makeRecipe({
            slug: 'alt-same-dish',
            recipeId: SHARED_RECIPE_ID,
            versionId: 'shared-version-2',
        });
        const context = makeContext({ recipes: [sameDish, ALT_ALPHA] });

        expect(slugsOf(selectSwapCandidates(context))).toEqual(['alt-alpha']);
    });

    it('excludes a recipe already used twice elsewhere in the week', () => {
        const twice = makeRecipe({ slug: 'alt-twice', recipeId: 'twice-recipe' });
        const context = makeContext({
            recipes: [twice, ALT_ALPHA],
            weekMeals: weekMeals([
                { id: 'meal-first-day-dinner', date: PLAN_START, recipeId: 'twice-recipe' },
                { id: 'meal-last-day-lunch', date: PLAN_END, recipeId: 'twice-recipe' },
            ]),
        });

        expect(slugsOf(selectSwapCandidates(context))).toEqual(['alt-alpha']);
    });

    it('refuses a week that does not contain the meal being replaced', () => {
        const context = makeContext({
            recipes: [ALT_ALPHA],
            weekMeals: weekMeals().filter((meal) => meal.id !== LUNCH_MEAL_ID),
        });

        expect(() => selectSwapCandidates(context)).toThrow(MealPlanInputError);
        expect(inputErrorField(() => selectSwapCandidates(context))).toBe('weekMeals');
    });

    it('refuses a malformed week day key rather than silently never matching it', () => {
        const context = makeContext({
            recipes: [ALT_ALPHA],
            weekMeals: weekMeals([{ id: 'meal-broken', date: '2026-07-32', recipeId: 'broken-recipe' }]),
        });

        expect(inputErrorField(() => selectSwapCandidates(context))).toBe('weekMeals');
    });
});

/* ---------------------------------------------------------------------------
 * Ranking, determinism and truncation
 * ------------------------------------------------------------------------- */

describe('selectSwapCandidates ranking', () => {
    it('ranks by the resulting day\'s proximity to the target', () => {
        const context = makeContext({ recipes: [ALT_LARGER, ALT_ALPHA, ALT_TIE] });
        const candidates = selectSwapCandidates(context);

        expect(slugsOf(candidates)).toEqual(['alt-alpha', 'alt-larger', 'alt-tie']);
        expect(candidates[0].targetProximity).toBeLessThan(candidates[1].targetProximity);
        expect(candidates[1].targetProximity).toBeLessThan(candidates[2].targetProximity);
    });

    it('orders equal-proximity candidates by slug, whichever order they arrive in', () => {
        const forwards = selectSwapCandidates(makeContext({ recipes: [ALT_ALPHA, ALT_BETA] }));
        const backwards = selectSwapCandidates(makeContext({ recipes: [ALT_BETA, ALT_ALPHA] }));

        expect(forwards[0].targetProximity).toBe(forwards[1].targetProximity);
        expect(slugsOf(forwards)).toEqual(['alt-alpha', 'alt-beta']);
        expect(backwards).toEqual(forwards);
    });

    it('is identical for the same candidates in a shuffled input order', () => {
        const recipes = [...rankedAlternatives(), ALT_HALF, ALT_TIE, ALT_LARGER];
        const shuffled = [...recipes.slice(7), ...recipes.slice(0, 7).reverse()];

        expect(selectSwapCandidates(makeContext({ recipes: shuffled }))).toEqual(
            selectSwapCandidates(makeContext({ recipes })),
        );
    });

    it('never consults a PRNG, so the list is stable across refetches', () => {
        const random = jest.spyOn(Math, 'random');

        try {
            const context = makeContext({ recipes: rankedAlternatives() });

            expect(selectSwapCandidates(context)).toEqual(selectSwapCandidates(context));
            expect(random).not.toHaveBeenCalled();
        } finally {
            random.mockRestore();
        }
    });

    it('offers eight rows at most, which is the product decision, not an arithmetic one', () => {
        // Every other assertion in this file reaches the length through the
        // exported constant, deliberately — this is the one place the NUMBER is
        // pinned, because §0.7.3 fixes it at eight and a change to it changes
        // the offer the preview and the commit are held to.
        expect(MAX_SWAP_ALTERNATIVES).toBe(8);
    });

    it('truncates to the policy maximum AFTER ranking, so the rows are the best ones', () => {
        const candidates = selectSwapCandidates(makeContext({ recipes: rankedAlternatives() }));

        expect(candidates).toHaveLength(MAX_SWAP_ALTERNATIVES);
        expect(slugsOf(candidates)).toEqual([
            'rank-00',
            'rank-01',
            'rank-02',
            'rank-03',
            'rank-04',
            'rank-05',
            'rank-06',
            'rank-07',
        ]);
    });

    it('lets a caller ask for fewer, and never for more than the policy maximum', () => {
        const recipes = rankedAlternatives();

        expect(slugsOf(selectSwapCandidates(makeContext({ recipes, limit: 3 })))).toEqual([
            'rank-00',
            'rank-01',
            'rank-02',
        ]);
        expect(selectSwapCandidates(makeContext({ recipes, limit: 50 }))).toHaveLength(
            MAX_SWAP_ALTERNATIVES,
        );
    });

    it('refuses a limit that is not a positive integer', () => {
        const recipes = [ALT_ALPHA];

        expect(inputErrorField(() => selectSwapCandidates(makeContext({ recipes, limit: 0 })))).toBe('limit');
        expect(inputErrorField(() => selectSwapCandidates(makeContext({ recipes, limit: 2.5 })))).toBe(
            'limit',
        );
    });

    it('leaves the caller\'s own rows untouched, because a later step reuses them', () => {
        const recipes = rankedAlternatives();
        const context = makeContext({ recipes, dayMeals: dayMeals(), weekMeals: weekMeals() });
        const before = JSON.stringify({
            recipes: context.recipes,
            dayMeals: context.dayMeals,
            weekMeals: context.weekMeals,
            targets: context.targets,
        });

        const listed = selectSwapCandidates(context);

        // The ranking sorts, and `candidates.sort(...)` on the caller's own
        // array instead of a copy is the plausible slip: `swap.service.ts`
        // hands in the query result it goes on to read the committed rows from,
        // and a reordered — or worse, truncated — input is a defect that would
        // only show up in the grocery diff two steps later.
        expect(
            JSON.stringify({
                recipes: context.recipes,
                dayMeals: context.dayMeals,
                weekMeals: context.weekMeals,
                targets: context.targets,
            }),
        ).toBe(before);
        expect(listed).not.toBe(context.recipes);
        expect(recipes.map((recipe) => recipe.slug)).toEqual(
            rankedAlternatives().map((recipe) => recipe.slug),
        );
    });
});

describe('compareSwapCandidates', () => {
    const context = makeContext();
    const alpha = requirePortion(context, ALT_ALPHA);
    const beta = requirePortion(context, ALT_BETA);
    const larger = requirePortion(context, ALT_LARGER);

    it('orders by the resulting day\'s proximity first', () => {
        expect(compareSwapCandidates(alpha, larger)).toBeLessThan(0);
        expect(compareSwapCandidates(larger, alpha)).toBeGreaterThan(0);
    });

    it('orders equal proximity by slug, in both directions', () => {
        expect(compareSwapCandidates(alpha, beta)).toBe(-1);
        expect(compareSwapCandidates(beta, alpha)).toBe(1);
    });

    it('orders one slug\'s versions by version number, so the key is total', () => {
        const first = requirePortion(context, WRAP_V1);
        const second = requirePortion(context, WRAP_V2);

        expect(first.recipe.slug).toBe(second.recipe.slug);
        expect(compareSwapCandidates(first, second)).toBeLessThan(0);
        expect(compareSwapCandidates(second, second)).toBe(0);
    });

    /**
     * The intransitivity counterexample, at the scale the epsilon lives at: with
     * an "equal within epsilon" primary key, A and B tie (so the slugs order
     * them A after B), B and C tie (B after C), yet A sorts before C on
     * proximity — an order no list can satisfy, which is why the six input
     * permutations produced three different outputs.
     */
    const NEAR_TIE_STEP = TOLERANCE_EPSILON * 0.75;

    const atProximity = (slug: string, targetProximity: number): SwapCandidate => ({
        ...alpha,
        recipe: { ...alpha.recipe, slug },
        targetProximity,
    });

    const permutationsOfThree = <T>([first, second, third]: readonly T[]): T[][] => [
        [first, second, third],
        [first, third, second],
        [second, first, third],
        [second, third, first],
        [third, first, second],
        [third, second, first],
    ];

    it('sorts every permutation of a near-tied triple into one identical list', () => {
        const near = [
            atProximity('z', 0),
            atProximity('m', NEAR_TIE_STEP),
            atProximity('a', 2 * NEAR_TIE_STEP),
        ];
        const expected = ['z', 'm', 'a'];

        // Each neighbouring pair differs by less than epsilon, so the old
        // approximate-equality key called each pair equal and deferred to the
        // slugs while ordering the outer pair by proximity.
        expect(near[2].targetProximity - near[0].targetProximity).toBeGreaterThan(TOLERANCE_EPSILON);
        expect(near[1].targetProximity - near[0].targetProximity).toBeLessThan(TOLERANCE_EPSILON);
        expect(near[2].targetProximity - near[1].targetProximity).toBeLessThan(TOLERANCE_EPSILON);

        for (const permutation of permutationsOfThree(near)) {
            expect(slugsOf([...permutation].sort(compareSwapCandidates))).toEqual(expected);
        }
    });

    it('is transitive across that triple, so no pair contradicts another', () => {
        const [first, second, third] = [
            atProximity('z', 0),
            atProximity('m', NEAR_TIE_STEP),
            atProximity('a', 2 * NEAR_TIE_STEP),
        ];

        expect(compareSwapCandidates(first, second)).toBeLessThan(0);
        expect(compareSwapCandidates(second, third)).toBeLessThan(0);
        expect(compareSwapCandidates(first, third)).toBeLessThan(0);
    });

    it('treats two proximities inside one epsilon bucket as genuinely equal', () => {
        // Both round to bucket 0, so the lexical keys decide — the intent the
        // epsilon carried, now expressed as a real equivalence class.
        const noisy = atProximity('z', TOLERANCE_EPSILON * 0.2);
        const exact = atProximity('a', 0);

        expect(compareSwapCandidates(noisy, exact)).toBe(1);
        expect(compareSwapCandidates(exact, noisy)).toBe(-1);
    });

    it('orders a pair straddling a bucket boundary by proximity, and does so both ways round', () => {
        // 0.4ε and 0.6ε are closer together than epsilon but round to 0 and 1:
        // the documented trade-off of a transitive key. Either answer is stable;
        // what matters is that it is the same answer whichever order they arrive
        // in, and that no third candidate can contradict it.
        const below = atProximity('z', TOLERANCE_EPSILON * 0.4);
        const above = atProximity('a', TOLERANCE_EPSILON * 0.6);

        expect(compareSwapCandidates(below, above)).toBe(-1);
        expect(compareSwapCandidates(above, below)).toBe(1);
        expect(slugsOf([below, above].sort(compareSwapCandidates))).toEqual(['z', 'a']);
        expect(slugsOf([above, below].sort(compareSwapCandidates))).toEqual(['z', 'a']);
    });
});

/* ---------------------------------------------------------------------------
 * One function, three callers — the list, the preview and the commit agree
 * ------------------------------------------------------------------------- */

describe('selectSwapCandidate', () => {
    it('returns the identical candidate the list carries', () => {
        const context = makeContext({ recipes: [ALT_ALPHA, ALT_HALF, ALT_LARGER] });
        const listed = selectSwapCandidates(context);

        expect(listed).toHaveLength(3);

        for (const candidate of listed) {
            expect(selectSwapCandidate(context, candidate.recipe.recipe_version_id)).toEqual(candidate);
        }
    });

    it('returns every one of a FULL list\'s rows identically, row for row', () => {
        // The eight-row case, so "identical to its row" is asserted at the
        // truncation boundary and not only on a short list.
        const context = makeContext({ recipes: rankedAlternatives() });
        const listed = selectSwapCandidates(context);

        expect(listed).toHaveLength(MAX_SWAP_ALTERNATIVES);
        expect(
            listed.map((candidate) => selectSwapCandidate(context, candidate.recipe.recipe_version_id)),
        ).toEqual(listed);
    });

    it('binds the commit to exactly the previewed numbers', () => {
        const context = makeContext({ recipes: [ALT_HALF] });
        const listed = selectSwapCandidates(context)[0];
        const previewed = selectSwapCandidate(context, listed.recipe.recipe_version_id);
        const committed = selectSwapCandidate(context, previewed.recipe.recipe_version_id);

        expect(() => requireBoundPortion(previewed.portionMultiplier, committed.portionMultiplier)).not.toThrow();

        const write = swapMealWrite(currentLunch(), committed, new Date('2026-07-08T12:30:00.000Z'));

        expect(write.portion_multiplier).toBe(previewed.portionMultiplier);
        expect(write.planned_calories).toBe(previewed.nutrition.calories);
        expect(write.planned_protein_g).toBe(previewed.nutrition.protein);
        expect(write.planned_carbs_g).toBe(previewed.nutrition.carbs);
        expect(write.planned_fat_g).toBe(previewed.nutrition.fat);
    });

    it('refuses a recipe outside the eight listed rows, however eligible it is on its own', () => {
        // `rank-08` is admissible and has a perfectly good portion — the list
        // simply never offered it, because ranking put it ninth. Committing a
        // row the sheet did not present is the disagreement the one-function
        // rule exists to prevent, so it is `recipe_ineligible` (§0.7.3).
        const recipes = rankedAlternatives();
        const context = makeContext({ recipes });
        const ninth = recipes[8];

        expect(selectSwapPortion(context, ninth)).not.toBeNull();
        expect(slugsOf(selectSwapCandidates(context))).not.toContain(ninth.slug);
        expect(() => selectSwapCandidate(context, ninth.recipe_version_id)).toThrow(RecipeIneligibleError);
    });

    it('refuses a row a narrowed list dropped, so the preview never widens the offer', () => {
        // A caller may ask for fewer rows than the policy maximum; the preview
        // and the commit are held to the rows that caller was given.
        const recipes = rankedAlternatives();
        const narrowed = makeContext({ recipes, limit: 2 });
        const third = recipes[2];

        expect(slugsOf(selectSwapCandidates(narrowed))).toEqual(['rank-00', 'rank-01']);
        expect(() => selectSwapCandidate(narrowed, third.recipe_version_id)).toThrow(RecipeIneligibleError);
        expect(selectSwapCandidate(makeContext({ recipes }), third.recipe_version_id).recipe.slug).toBe(
            third.slug,
        );
    });

    it('refuses a recipe that is not in the plannable set', () => {
        const context = makeContext({ recipes: [ALT_ALPHA] });

        expect(() => selectSwapCandidate(context, 'some-other-version')).toThrow(RecipeIneligibleError);
    });

    it('refuses a retired recipe, which is what a catalog refresh between list and commit looks like', () => {
        const retired = makeRecipe({ slug: 'alt-retired', status: 'retired' });
        const context = makeContext({ recipes: [retired] });

        expect(() => selectSwapCandidate(context, retired.recipe_version_id)).toThrow(RecipeIneligibleError);
    });

    it('refuses a recipe a preference change has since ruled out', () => {
        const milky = makeRecipe({ slug: 'alt-milky', allergenTags: ['milk'] });
        const listing = makeContext({ recipes: [milky] });
        const committing = makeContext({
            recipes: [milky],
            preferences: makePreferences({ allergens: ['milk'] }),
        });

        expect(slugsOf(selectSwapCandidates(listing))).toEqual(['alt-milky']);
        expect(() => selectSwapCandidate(committing, milky.recipe_version_id)).toThrow(RecipeIneligibleError);
    });

    it('refuses the version already in the slot, which would be a swap to itself', () => {
        const context = makeContext({ recipes: [WRAP_V1] });

        expect(() => selectSwapCandidate(context, WRAP_VERSION_1)).toThrow(RecipeIneligibleError);
    });

    it('refuses a recipe the week\'s repetition rule now excludes', () => {
        const neighbour = makeRecipe({ slug: 'alt-neighbour', recipeId: 'neighbour-recipe' });
        const context = makeContext({
            recipes: [neighbour],
            weekMeals: weekMeals([{ id: 'meal-after-lunch', date: DAY_AFTER, recipeId: 'neighbour-recipe' }]),
        });

        expect(() => selectSwapCandidate(context, neighbour.recipe_version_id)).toThrow(RecipeIneligibleError);
    });

    it('refuses a recipe no portion of which keeps the day inside tolerance', () => {
        const context = makeContext({ recipes: [ALT_TINY] });

        expect(() => selectSwapCandidate(context, ALT_TINY.recipe_version_id)).toThrow(RecipeIneligibleError);
    });
});

/* ---------------------------------------------------------------------------
 * The empty answer — the client's 13d state
 * ------------------------------------------------------------------------- */

describe('an empty alternatives list', () => {
    it('is the answer when the slot\'s only eligible recipe is the one already planned', () => {
        expect(selectSwapCandidates(makeContext({ recipes: [WRAP_V1] }))).toEqual([]);
    });

    it('is the answer when nothing is plannable at all', () => {
        expect(selectSwapCandidates(makeContext({ recipes: [] }))).toEqual([]);
    });

    it('is RETURNED and not thrown, so 13d is distinguishable from a failure', () => {
        // The client renders "no alternatives fit" from an empty list and an
        // error banner from a throw, and they say different things to the user:
        // one is the truthful consequence of their own restrictions, the other
        // says the app is broken. A refusal dressed up as an exception — or an
        // exception swallowed into `[]` — swaps the two.
        const noneEligible = makeContext({ recipes: [WRAP_V1, ALT_TINY] });

        expect(() => selectSwapCandidates(noneEligible)).not.toThrow();
        expect(selectSwapCandidates(noneEligible)).toEqual([]);
    });
});

/* ---------------------------------------------------------------------------
 * The preview binding
 * ------------------------------------------------------------------------- */

describe('requireBoundPortion', () => {
    it('accepts the portion the preview showed', () => {
        expect(() => requireBoundPortion(1.25, 1.25)).not.toThrow();
    });

    it('accepts float noise within the two-decimal representation the contract stores', () => {
        expect(() => requireBoundPortion(0.75, 0.7500000000001)).not.toThrow();
    });

    it('refuses a portion that is not the recomputed one', () => {
        expect(() => requireBoundPortion(1.25, 1)).toThrow(PreviewStaleError);
        expect(() => requireBoundPortion(0.75, 0.76)).toThrow(PreviewStaleError);
    });

    it('fails closed on a value that is not a portion at all', () => {
        expect(() => requireBoundPortion(Number.NaN, 1)).toThrow(PreviewStaleError);
    });

    it('turns a target change that moves the chosen multiplier into a stale preview', () => {
        // Previewed at 2,000 kcal: half a portion (day 1,860) ties with three
        // quarters and wins. Re-targeted at 2,140, only three quarters is
        // admissible, so the previewed portion is no longer the one the server
        // would write.
        const previewed = selectSwapCandidate(makeContext({ recipes: [ALT_TIE] }), ALT_TIE.recipe_version_id);
        const recomputed = selectSwapCandidate(
            makeContext({ recipes: [ALT_TIE], targets: targetsAt(2140) }),
            ALT_TIE.recipe_version_id,
        );

        expect(previewed.portionMultiplier).toBe(0.5);
        expect(recomputed.portionMultiplier).toBe(0.75);
        expect(() => requireBoundPortion(previewed.portionMultiplier, recomputed.portionMultiplier)).toThrow(
            PreviewStaleError,
        );
    });

    it('lets a target change that leaves the multiplier equal commit, because the preview binds the portion', () => {
        const previewed = selectSwapCandidate(
            makeContext({ recipes: [ALT_ALPHA] }),
            ALT_ALPHA.recipe_version_id,
        );
        const recomputed = selectSwapCandidate(
            makeContext({ recipes: [ALT_ALPHA], targets: targetsAt(2010) }),
            ALT_ALPHA.recipe_version_id,
        );

        expect(previewed.portionMultiplier).toBe(1);
        expect(recomputed.portionMultiplier).toBe(1);
        expect(recomputed.targetProximity).not.toBe(previewed.targetProximity);
        expect(() =>
            requireBoundPortion(previewed.portionMultiplier, recomputed.portionMultiplier),
        ).not.toThrow();
    });
});

/* ---------------------------------------------------------------------------
 * The committed write
 * ------------------------------------------------------------------------- */

describe('swapMealWrite', () => {
    const now = new Date('2026-07-08T12:30:00.000Z');

    it('records the new version, its portion, the planned macros and the audit trail', () => {
        const context = makeContext({ recipes: [ALT_HALF] });
        const candidate = selectSwapCandidate(context, ALT_HALF.recipe_version_id);
        const write = swapMealWrite(currentLunch(), candidate, now);

        expect(write).toEqual({
            recipe_version_id: ALT_HALF.recipe_version_id,
            portion_multiplier: 0.5,
            planned_calories: candidate.nutrition.calories,
            planned_protein_g: candidate.nutrition.protein,
            planned_carbs_g: candidate.nutrition.carbs,
            planned_fat_g: candidate.nutrition.fat,
            previous_recipe_version_id: WRAP_VERSION_1,
            swapped_at: now,
            revision: 2,
            flags: [],
        });
    });

    it('clears the meal\'s incompatibility flags, because a listed candidate is compatible', () => {
        // §0.7.3: a swap to a compatible recipe clears that meal's flags. The
        // value is UNCONDITIONAL and the stored flags are not even an input —
        // the candidate came out of the list, so it passed the same eligibility
        // rule a flag is raised by. Two unrelated meals are asserted to make the
        // point that nothing about the incoming row can change the answer; that
        // the column really is rewritten on a meal that carried a flag is a
        // database fact, proved at the service level.
        const context = makeContext({ recipes: [ALT_ALPHA, ALT_HALF] });
        const alpha = selectSwapCandidate(context, ALT_ALPHA.recipe_version_id);
        const half = selectSwapCandidate(context, ALT_HALF.recipe_version_id);

        expect(swapMealWrite(currentLunch(), alpha, now).flags).toEqual([]);
        expect(swapMealWrite({ ...currentLunch(), revision: 4 }, half, now).flags).toEqual([]);
    });

    it('advances the meal\'s own revision, whatever it has reached', () => {
        const context = makeContext({ recipes: [ALT_ALPHA] });
        const candidate = selectSwapCandidate(context, ALT_ALPHA.recipe_version_id);

        expect(swapMealWrite({ ...currentLunch(), revision: 7 }, candidate, now).revision).toBe(8);
    });

    it('keeps the planned macros at full precision, so the diary rounds exactly once', () => {
        const context = makeContext({ recipes: [ALT_LARGER] });
        const candidate = selectSwapCandidate(context, ALT_LARGER.recipe_version_id);
        const write = swapMealWrite(currentLunch(), candidate, now);

        // 37.5 g of protein at one and a half portions is 56.25 g, and it is
        // stored as 56.25: a round here would shift the diary snapshot, the
        // consumed total and the client's "This adds" card with it.
        expect(write.planned_protein_g).toBe(ALT_LARGER.per_serving.protein * 1.5);
        expect(Number.isInteger(write.planned_protein_g)).toBe(false);
    });

    it('refuses an invalid timestamp rather than writing one nobody can reconstruct', () => {
        const context = makeContext({ recipes: [ALT_ALPHA] });
        const candidate = selectSwapCandidate(context, ALT_ALPHA.recipe_version_id);

        expect(inputErrorField(() => swapMealWrite(currentLunch(), candidate, new Date('not a date')))).toBe(
            'now',
        );
    });

    it('refuses a revision that could not have been stored', () => {
        const context = makeContext({ recipes: [ALT_ALPHA] });
        const candidate = selectSwapCandidate(context, ALT_ALPHA.recipe_version_id);

        expect(
            inputErrorField(() => swapMealWrite({ ...currentLunch(), revision: 0 }, candidate, now)),
        ).toBe('revision');
        expect(
            inputErrorField(() => swapMealWrite({ ...currentLunch(), revision: 1.5 }, candidate, now)),
        ).toBe('revision');
    });
});

/* ---------------------------------------------------------------------------
 * The predicate that write is addressed by
 *
 * Its own describe because it answers a different question from
 * `swapMealWrite`: not "what does a swap store" but "which row is allowed to
 * receive it". Rule backend-architecture §5.1 and §0.5.1 answer that with four
 * columns — the row, its owner, its parent plan and the revision the selection
 * read — and the fourth is the one a reader has to be able to see is there,
 * because a meal's revision moves independently of its plan's and the
 * plan-level compare-and-swap in `swap.service.ts::applySwap` cannot detect a
 * change confined to one meal.
 * ------------------------------------------------------------------------- */

describe('swapMealWhere', () => {
    const owner = { userId: 'user-swapping', planId: 'plan-under-edit' };
    /** The commit's own instant, for the cases that pair this with the write. */
    const now = new Date('2026-07-08T12:30:00.000Z');

    it('addresses the row by its id, its owner, its parent plan and its stored revision', () => {
        expect(swapMealWhere(currentLunch(), owner)).toEqual({
            id: LUNCH_MEAL_ID,
            user_id: 'user-swapping',
            meal_plan_id: 'plan-under-edit',
            revision: 1,
        });
    });

    it('pins the revision the write advances FROM, whatever the meal has reached', () => {
        // The pairing is the contract: `swapMealWrite` sets `revision + 1` and
        // this matches `revision`, so the statement lands only on the row
        // generation the whole selection was computed against. A predicate
        // carrying the ADVANCED value — the natural slip when the two shapes
        // are assembled separately — would match nothing and fail every swap,
        // and one carrying a constant would only ever match an untouched meal.
        const context = makeContext({ recipes: [ALT_ALPHA] });
        const candidate = selectSwapCandidate(context, ALT_ALPHA.recipe_version_id);

        for (const revision of [1, 7, 4096]) {
            const meal = { ...currentLunch(), revision };

            expect(swapMealWhere(meal, owner).revision).toBe(revision);
            expect(swapMealWrite(meal, candidate, now).revision).toBe(
                swapMealWhere(meal, owner).revision + 1,
            );
        }
    });

    it('describes the same row the write describes, so the two cannot drift apart', () => {
        // Both are built from ONE `SwapDayMeal`, which is what makes this
        // assertion possible: the outgoing version the write records as
        // `previous_recipe_version_id` belongs to the row the predicate names.
        const context = makeContext({ recipes: [ALT_HALF] });
        const candidate = selectSwapCandidate(context, ALT_HALF.recipe_version_id);
        const meal = currentLunch();

        expect(swapMealWhere(meal, owner).id).toBe(meal.id);
        expect(swapMealWrite(meal, candidate, now).previous_recipe_version_id).toBe(
            meal.recipeVersionId,
        );
    });

    it('refuses a revision the write itself would refuse', () => {
        // One rule for both, so a value that could never have been stored
        // cannot reach the predicate and turn an input fault into a row count
        // of zero — which reads as a lost race rather than as a bug.
        expect(inputErrorField(() => swapMealWhere({ ...currentLunch(), revision: 0 }, owner))).toBe(
            'revision',
        );
        expect(inputErrorField(() => swapMealWhere({ ...currentLunch(), revision: 1.5 }, owner))).toBe(
            'revision',
        );
        expect(
            inputErrorField(() => swapMealWhere({ ...currentLunch(), revision: Number.NaN }, owner)),
        ).toBe('revision');
    });

    it('refuses an owner, a parent or a row it could not address anything by', () => {
        // The §5.1 failure the type system cannot catch: an empty `user_id` is a
        // `string` and compiles, and the write it produces is scoped to nobody.
        expect(inputErrorField(() => swapMealWhere(currentLunch(), { ...owner, userId: '' }))).toBe(
            'userId',
        );
        expect(inputErrorField(() => swapMealWhere(currentLunch(), { ...owner, userId: '   ' }))).toBe(
            'userId',
        );
        expect(inputErrorField(() => swapMealWhere(currentLunch(), { ...owner, planId: '' }))).toBe(
            'planId',
        );
        expect(inputErrorField(() => swapMealWhere({ ...currentLunch(), id: '' }, owner))).toBe(
            'mealId',
        );
    });
});

/* ---------------------------------------------------------------------------
 * A -> B -> C, with the meal logged before the first swap
 *
 * Composed from `swapMealWrite` and `plannedMealLog.logic.ts::deriveLoggedStatus`
 * rather than re-implemented here: the logged state is that module's rule, and
 * this suite's job is to prove the two agree after two swaps.
 * ------------------------------------------------------------------------- */

describe('a logged meal swapped twice', () => {
    /**
     * The two intentional entries — one meal eaten, then a second serving of it
     * — which with the two swaps below IS the scenario the card treatment is
     * derived from (§0.7.3): two logs of A, a swap to B, a swap to C.
     */
    const twoEntriesForA = (): LinkedDiaryEntryRow[] => [
        { id: 'entry-first-serving', recipe_version_id: WRAP_VERSION_1 },
        { id: 'entry-second-serving', recipe_version_id: WRAP_VERSION_1 },
    ];

    /** The week as it stands after the slot has been swapped to `recipeId`. */
    const weekAfterSwapTo = (recipeId: string): SwapWeekMeal[] =>
        weekMeals().map((meal) => (meal.id === LUNCH_MEAL_ID ? { ...meal, recipeId } : meal));

    const swapTwice = (): { toB: ReturnType<typeof swapMealWrite>; toC: ReturnType<typeof swapMealWrite> } => {
        const mealA = currentLunch();
        const contextA = makeContext({ recipes: [ALT_ALPHA, ALT_BETA] });
        const candidateB = selectSwapCandidate(contextA, ALT_ALPHA.recipe_version_id);
        const toB = swapMealWrite(mealA, candidateB, new Date('2026-07-06T09:00:00.000Z'));

        const mealB: SwapDayMeal = {
            ...mealA,
            recipeId: ALT_ALPHA.recipe_id,
            recipeVersionId: toB.recipe_version_id,
            portionMultiplier: toB.portion_multiplier,
            planned: candidateB.nutrition,
            revision: toB.revision,
        };
        const contextB = makeContext({
            recipes: [ALT_ALPHA, ALT_BETA],
            dayMeals: dayMeals(mealB),
            weekMeals: weekAfterSwapTo(ALT_ALPHA.recipe_id),
        });
        const candidateC = selectSwapCandidate(contextB, ALT_BETA.recipe_version_id);
        const toC = swapMealWrite(mealB, candidateC, new Date('2026-07-07T09:00:00.000Z'));

        return { toB, toC };
    };

    it('chains the versions and the revisions through both swaps', () => {
        const { toB, toC } = swapTwice();

        expect(toB.previous_recipe_version_id).toBe(WRAP_VERSION_1);
        expect(toB.recipe_version_id).toBe(ALT_ALPHA.recipe_version_id);
        expect(toC.previous_recipe_version_id).toBe(ALT_ALPHA.recipe_version_id);
        expect(toC.recipe_version_id).toBe(ALT_BETA.recipe_version_id);
        expect([toB.revision, toC.revision]).toEqual([2, 3]);
        expect(toC.swapped_at.getTime()).toBeGreaterThan(toB.swapped_at.getTime());
    });

    it('reports the slot as logged-then-swapped, naming the recipe actually eaten', () => {
        const { toB, toC } = swapTwice();
        const state = deriveLoggedStatus(twoEntriesForA(), toC.recipe_version_id);

        expect(state.status).toBe('logged_then_swapped');
        expect(state.isLogged).toBe(false);
        // The entries still say A, and both intentional servings collapse to one
        // caption. The audit column says B — which is exactly why the caption
        // must be derived from the entries and never from
        // `previous_recipe_version_id`.
        expect(state.previousRecipeVersionIds).toEqual([WRAP_VERSION_1]);
        expect(toC.previous_recipe_version_id).not.toBe(state.previousRecipeVersionIds[0]);
        expect(toB.recipe_version_id).toBe(toC.previous_recipe_version_id);
    });

    it('reports every earlier version when the user logged before each swap', () => {
        const { toB, toC } = swapTwice();
        const entries: LinkedDiaryEntryRow[] = [
            ...twoEntriesForA(),
            { id: 'entry-after-first-swap', recipe_version_id: toB.recipe_version_id },
        ];

        expect(deriveLoggedStatus(entries, toC.recipe_version_id)).toEqual({
            status: 'logged_then_swapped',
            isLogged: false,
            previousRecipeVersionIds: [WRAP_VERSION_1, toB.recipe_version_id],
        });
    });

    it('reports the slot as logged once the recipe now planned has itself been eaten', () => {
        const { toC } = swapTwice();
        const entries: LinkedDiaryEntryRow[] = [
            ...twoEntriesForA(),
            { id: 'entry-current', recipe_version_id: toC.recipe_version_id },
        ];
        const state = deriveLoggedStatus(entries, toC.recipe_version_id);

        expect(state.status).toBe('logged');
        expect(state.isLogged).toBe(true);
    });

    it('never marks the replacement eaten: no entry references the recipe now planned', () => {
        const { toB, toC } = swapTwice();
        const entries = twoEntriesForA();

        // The user ate A. Swapping the slot cannot make C — or the B it passed
        // through — food anybody consumed, and the write carries no entry link
        // to invent one with.
        expect(entries.map((entry) => entry.recipe_version_id)).not.toContain(toC.recipe_version_id);
        expect(entries.map((entry) => entry.recipe_version_id)).not.toContain(toB.recipe_version_id);
        expect(deriveLoggedStatus(entries, toC.recipe_version_id).isLogged).toBe(false);
        expect(Object.keys(toC)).not.toContain('meal_entry_id');
    });

    it('leaves the logged entries exactly as the diary stored them (deriveLoggedStatus itself is covered by plannedMealLog.logic.test.ts; this asserts the swap-side composition)', () => {
        const { toC } = swapTwice();
        const entries = twoEntriesForA();
        const stored = JSON.stringify(entries);

        deriveLoggedStatus(entries, toC.recipe_version_id);

        // The diary snapshot outlives every swap: §0.7.3 keeps what the user
        // ate, and the caption is derived from these rows rather than written
        // back onto them.
        expect(JSON.stringify(entries)).toBe(stored);
    });
});

/* ---------------------------------------------------------------------------
 * The committed recipe fixture — one food graph, two domains
 *
 * Everything above judges synthetic recipes whose macros sit on the target's
 * own ratio, which is what makes each rule's arithmetic readable. This block
 * judges the COMMITTED rows instead: `data/meal-planning/recipes.fixture.json`
 * is the referentially closed pair (§0.3.3) the recipe, planner, grocery and
 * planned-log suites all read, so driving a swap through it proves the two
 * domains accept the same meals over real ingredient snapshots, real allergen
 * metadata and real cooking times — the property §0.7.3 asks for when it says
 * the swap must not offer a dish the generator refused.
 *
 * Read off disk and re-parsed per accessor, the convention `mealPlan.logic.test.ts`
 * uses, so a case that mutates a row cannot leak into the next. Nothing is
 * transcribed: every number below is the fixture's, and the premises each test
 * opens with are what makes it fail loudly — rather than vacuously — if the
 * committed graph changes shape.
 * ------------------------------------------------------------------------- */

const FIXTURE_DIRECTORY = join(__dirname, '..', '..', '..', 'data', 'meal-planning', 'fixtures');

const RECIPES_FIXTURE_JSON = readFileSync(join(FIXTURE_DIRECTORY, 'recipes.fixture.json'), 'utf8');

/** The `recipe_versions` columns a swap candidate is built from. */
interface FixtureRecipeVersion {
    id: string;
    recipe_id: string;
    recipe_slug: string;
    version: number;
    total_minutes: number;
    meal_slots: MealSlot[];
    status: 'current' | 'retired';
    nutrition_provenance: PlanRecipeCandidate['nutrition_provenance'];
    allergen_status: 'known' | 'unknown';
    budget_tier: number;
    per_serving_calories: number;
    per_serving_protein_g: number;
    per_serving_carbs_g: number;
    per_serving_fat_g: number;
}

/**
 * A `recipe_ingredients` row. `resolved_catalog_facts` is the fixture's
 * documented non-column field — the `catalog_foods` facts the table does not
 * snapshot, which is where the dislike rule's `food_group` comes from.
 */
interface FixtureRecipeIngredient {
    recipe_version_id: string;
    snapshot_name: string;
    snapshot_provenance: Ingredient['snapshot_provenance'];
    snapshot_allergen_tags: string[];
    snapshot_diet_tags: string[];
    catalog_food_id: string;
    is_optional: boolean;
    resolved_catalog_facts: { allergen_status: 'known' | 'unknown'; food_group: string };
}

interface RecipeFixtureDocument {
    recipe_versions: FixtureRecipeVersion[];
    recipe_ingredients: FixtureRecipeIngredient[];
}

const readRecipeFixture = (): RecipeFixtureDocument => JSON.parse(RECIPES_FIXTURE_JSON) as RecipeFixtureDocument;

/** The `(slug, version)` row, or a failure naming the pair it could not find. */
const fixtureVersion = (slug: string, version: number): FixtureRecipeVersion => {
    const row = readRecipeFixture().recipe_versions.find(
        (candidate) => candidate.recipe_slug === slug && candidate.version === version,
    );

    if (row === undefined) {
        throw new Error(`recipes.fixture.json carries no ${slug} v${version}`);
    }

    return row;
};

const fixtureIngredients = (versionId: string): FixtureRecipeIngredient[] =>
    readRecipeFixture().recipe_ingredients.filter((row) => row.recipe_version_id === versionId);

/** One committed version as a swap candidate. Every field is the fixture's. */
const fixtureCandidate = (slug: string, version: number): PlanRecipeCandidate => {
    const row = fixtureVersion(slug, version);

    return {
        recipe_version_id: row.id,
        recipe_id: row.recipe_id,
        slug: row.recipe_slug,
        version: row.version,
        status: row.status,
        nutrition_provenance: row.nutrition_provenance,
        allergen_status: row.allergen_status,
        total_minutes: row.total_minutes,
        meal_slots: row.meal_slots,
        budget_tier: row.budget_tier,
        per_serving: {
            calories: row.per_serving_calories,
            protein: row.per_serving_protein_g,
            carbs: row.per_serving_carbs_g,
            fat: row.per_serving_fat_g,
        },
        ingredients: fixtureIngredients(row.id).map(
            (ingredient): Ingredient => ({
                catalog_food_id: ingredient.catalog_food_id,
                snapshot_name: ingredient.snapshot_name,
                snapshot_provenance: ingredient.snapshot_provenance,
                snapshot_allergen_tags: ingredient.snapshot_allergen_tags,
                snapshot_diet_tags: ingredient.snapshot_diet_tags,
                is_optional: ingredient.is_optional,
                food_group: ingredient.resolved_catalog_facts.food_group,
                allergen_status: ingredient.resolved_catalog_facts.allergen_status,
            }),
        ),
    };
};

/** Every committed version, the retired one included — the plannable set as loaded. */
const fixtureCatalog = (): PlanRecipeCandidate[] =>
    readRecipeFixture().recipe_versions.map((row) => fixtureCandidate(row.recipe_slug, row.version));

describe('a swap over the committed recipe fixture', () => {
    const FIXTURE_BREAKFAST_ID = 'fixture-meal-breakfast';
    const FIXTURE_LUNCH_ID = 'fixture-meal-lunch';
    const FIXTURE_DINNER_ID = 'fixture-meal-dinner';

    const BREAKFAST = fixtureCandidate('yogurt-egg-white-crispbread-plate', 1);
    /** The lunch under replacement: the dish's CURRENT version. */
    const PLANNED_LUNCH = fixtureCandidate('lemon-herb-chicken-and-rice', 2);
    const DINNER = fixtureCandidate('salmon-and-kale-plate', 1);
    const STEW = fixtureCandidate('lentil-and-kale-stew', 1);

    /** Targets this committed day sits inside, so the portion rule can bind. */
    const FIXTURE_TARGETS: MealPlanMacroTotals = { calories: 1230, protein: 90, carbs: 120, fat: 45 };

    const plannedMeal = (
        id: string,
        slot: MealSlot,
        recipe: PlanRecipeCandidate,
    ): SwapDayMeal => ({
        id,
        slot,
        recipeId: recipe.recipe_id,
        recipeVersionId: recipe.recipe_version_id,
        portionMultiplier: 1,
        planned: recipe.per_serving,
        revision: 1,
    });

    const fixtureDayMeals = (): SwapDayMeal[] => [
        plannedMeal(FIXTURE_BREAKFAST_ID, 'breakfast', BREAKFAST),
        plannedMeal(FIXTURE_LUNCH_ID, 'lunch', PLANNED_LUNCH),
        plannedMeal(FIXTURE_DINNER_ID, 'dinner', DINNER),
    ];

    const fixtureContext = (overrides: Partial<SwapSelectionContext> = {}): SwapSelectionContext => ({
        mealId: FIXTURE_LUNCH_ID,
        date: SWAP_DATE,
        slot: 'lunch',
        dayMeals: fixtureDayMeals(),
        weekMeals: fixtureDayMeals().map((meal) => ({
            id: meal.id,
            date: SWAP_DATE,
            recipeId: meal.recipeId,
        })),
        targets: FIXTURE_TARGETS,
        preferences: makePreferences(),
        recipes: fixtureCatalog(),
        ...overrides,
    });

    it('offers the one committed version a lunch swap may take, out of the whole graph', () => {
        // The premises: the fixture really does carry the four lunch-declaring
        // versions this refuses, each for a different reason, so the single-row
        // answer below is a decision and not an accident of a thin fixture.
        expect(fixtureVersion('lemon-herb-chicken-and-rice', 1).status).toBe('retired');
        expect(fixtureVersion('roasted-carrot-and-lentil-salad', 1).nutrition_provenance).toBe(
            'ai_estimated',
        );
        expect(fixtureVersion('lemon-dressed-spinach-salad', 1).nutrition_provenance).toBe(
            'ingredient_derived',
        );
        expect(fixtureVersion('cracker-and-yogurt-snack-plate', 1).allergen_status).toBe('unknown');
        expect(fixtureCatalog().length).toBeGreaterThan(MAX_SWAP_ALTERNATIVES);

        const candidates = selectSwapCandidates(fixtureContext());

        expect(slugsOf(candidates)).toEqual(['lentil-and-kale-stew']);
        expect(candidates[0].portionMultiplier).toBe(1);
    });

    it('prices that swap with the fixture\'s own per-serving numbers', () => {
        const candidate = selectSwapCandidate(fixtureContext(), STEW.recipe_version_id);
        const currentDay = currentDayTotalsFor(fixtureContext());

        expect(candidate.nutrition).toEqual(STEW.per_serving);
        expect(candidate.dayTotalsIfSwapped).toEqual(
            computeDayTotals([
                { planned: BREAKFAST.per_serving },
                { planned: STEW.per_serving },
                { planned: DINNER.per_serving },
            ]),
        );
        expect(candidate.calorieDelta).toBeCloseTo(
            STEW.per_serving.calories - PLANNED_LUNCH.per_serving.calories,
            9,
        );
        expect(isDayWithinTolerance(candidate.dayTotalsIfSwapped, FIXTURE_TARGETS)).toBe(true);
        expect(currentDay.calories).toBeCloseTo(
            BREAKFAST.per_serving.calories +
                PLANNED_LUNCH.per_serving.calories +
                DINNER.per_serving.calories,
            9,
        );
    });

    it('answers 13d when the user dislikes the food group its only alternative carries', () => {
        const mushroom = fixtureIngredients(STEW.recipe_version_id).find(
            (ingredient) => ingredient.resolved_catalog_facts.food_group === 'mushroom',
        );

        expect(mushroom?.snapshot_name).toBe('Cremini mushrooms');

        const disliked = fixtureContext({
            preferences: makePreferences({ disliked_food_groups: ['mushroom'] }),
        });

        expect(selectSwapCandidates(disliked)).toEqual([]);
        expect(() => selectSwapCandidate(disliked, STEW.recipe_version_id)).toThrow(RecipeIneligibleError);
    });
});

/* ---------------------------------------------------------------------------
 * Request parsing
 *
 * Object literals only: a parser takes the request's own values, so each test
 * states a whole request and asserts the returned verdict. Nothing is thrown
 * and nothing is mocked.
 *
 * The valid ids below are v4 UUIDs; each malformed variant breaks exactly ONE
 * property of the form, so a test that fails names the property that stopped
 * being checked. Thresholds are never hand-copied: the accepted portions come
 * from `mealPlan.logic.ts`'s own exported sets and the revision ceiling from
 * `preferences.logic.ts`'s `MAX_REVISION`.
 * ------------------------------------------------------------------------- */

const PARSE_PLAN_ID = '3f7c2b1e-9d4a-4b6c-8e1f-0a2b3c4d5e6f';
const PARSE_MEAL_ID = 'a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d';
const PARSE_RECIPE_VERSION_ID = '7d6c5b4a-3e2f-4d1c-b0a9-8f7e6d5c4b3a';
const PARSE_IDEMPOTENCY_KEY = '0c1d2e3f-4a5b-4c6d-8e9f-1a2b3c4d5e6f';

/** A v1 UUID: well formed, wrong version nibble. */
const WRONG_VERSION_UUID = '3f7c2b1e-9d4a-1b6c-8e1f-0a2b3c4d5e6f';
/** A v4 UUID whose variant nibble is not one of `8`, `9`, `a`, `b`. */
const WRONG_VARIANT_UUID = '3f7c2b1e-9d4a-4b6c-ce1f-0a2b3c4d5e6f';
/** One hex pair short. */
const WRONG_LENGTH_UUID = '3f7c2b1e-9d4a-4b6c-8e1f-0a2b3c4d5e';

/** Every portion the product offers, which is the union the parser accepts. */
const ADMISSIBLE_PORTIONS: number[] = [
    ...new Set([...MAIN_SLOT_PORTION_MULTIPLIERS, ...SNACK_PORTION_MULTIPLIERS]),
];

/** In the diagnostic-only extended policy and NOT in the offered set. */
const EXTENDED_ONLY_PORTIONS: number[] = EXTENDED_PORTION_POLICY.mainSlot.filter(
    (multiplier) => !ADMISSIBLE_PORTIONS.includes(multiplier),
);

const COMMIT_PATH = { planId: PARSE_PLAN_ID, mealId: PARSE_MEAL_ID };

const VALID_COMMIT_BODY: SwapMealPayload = {
    recipeVersionId: PARSE_RECIPE_VERSION_ID,
    portionMultiplier: 1.25,
    expectedPlanRevision: 3,
    idempotencyKey: PARSE_IDEMPOTENCY_KEY,
};

/** The commit body with one field replaced — the shape every field test uses. */
const commitBodyWith = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    ...VALID_COMMIT_BODY,
    ...overrides,
});

/** The details a verdict reports, or a failure when it accepted the request. */
const detailsOf = (
    parsed: ParsedSwapAlternativesPath | ParsedSwapPreviewPath | ParsedSwapCommitRequest,
): InvalidRequestDetail[] => {
    if (parsed.kind !== 'error') {
        throw new Error(`expected an invalid_request verdict, received ${JSON.stringify(parsed)}`);
    }

    return parsed.details;
};

/** The `field:code` pairs a verdict reports, in the order it reports them. */
const fieldCodesOf = (
    parsed: ParsedSwapAlternativesPath | ParsedSwapPreviewPath | ParsedSwapCommitRequest,
): string[] => detailsOf(parsed).map((detail) => `${detail.field}:${detail.code}`);

/** The code a commit verdict reports for one body field. */
const commitBodyCode = (overrides: Record<string, unknown>, field: string): string | undefined =>
    detailsOf(parseSwapCommitRequest(COMMIT_PATH, commitBodyWith(overrides))).find(
        (detail) => detail.field === field,
    )?.code;

describe('parseSwapAlternativesPath', () => {
    it('accepts two v4 UUIDs', () => {
        expect(parseSwapAlternativesPath({ planId: PARSE_PLAN_ID, mealId: PARSE_MEAL_ID })).toEqual({
            kind: 'ok',
            planId: PARSE_PLAN_ID,
            mealId: PARSE_MEAL_ID,
        });
    });

    it('returns a verdict rather than throwing, with no status code in it', () => {
        const parsed = parseSwapAlternativesPath({ planId: 'not-a-uuid', mealId: PARSE_MEAL_ID });

        expect(parsed).toEqual({
            kind: 'error',
            code: 'invalid_request',
            message: 'planId and mealId must be UUIDs',
            details: [{ field: 'planId', code: SWAP_FIELD_CODES.INVALID_ID }],
        });
    });

    it('reports only the offending id', () => {
        expect(fieldCodesOf(parseSwapAlternativesPath({ planId: PARSE_PLAN_ID, mealId: 'nope' }))).toEqual([
            `mealId:${SWAP_FIELD_CODES.INVALID_ID}`,
        ]);
    });

    it('reports both ids at once, so the caller is not sent back twice', () => {
        expect(fieldCodesOf(parseSwapAlternativesPath({ planId: 'nope', mealId: 42 }))).toEqual([
            `planId:${SWAP_FIELD_CODES.INVALID_ID}`,
            `mealId:${SWAP_FIELD_CODES.INVALID_ID}`,
        ]);
    });

    it('refuses a UUID that is not version 4, however well formed', () => {
        expect(parseSwapAlternativesPath({ planId: WRONG_VERSION_UUID, mealId: PARSE_MEAL_ID }).kind).toBe(
            'error',
        );
        expect(parseSwapAlternativesPath({ planId: WRONG_VARIANT_UUID, mealId: PARSE_MEAL_ID }).kind).toBe(
            'error',
        );
    });

    it('refuses a truncated id, a non-string, an absent one and an explicit null', () => {
        expect(parseSwapAlternativesPath({ planId: WRONG_LENGTH_UUID, mealId: PARSE_MEAL_ID }).kind).toBe(
            'error',
        );
        expect(parseSwapAlternativesPath({ planId: 42, mealId: PARSE_MEAL_ID }).kind).toBe('error');
        expect(fieldCodesOf(parseSwapAlternativesPath({}))).toEqual([
            `planId:${SWAP_FIELD_CODES.INVALID_ID}`,
            `mealId:${SWAP_FIELD_CODES.INVALID_ID}`,
        ]);
        expect(fieldCodesOf(parseSwapAlternativesPath({ planId: null, mealId: null }))).toEqual([
            `planId:${SWAP_FIELD_CODES.INVALID_ID}`,
            `mealId:${SWAP_FIELD_CODES.INVALID_ID}`,
        ]);
    });
});

describe('parseSwapPreviewPath', () => {
    const validPath = {
        planId: PARSE_PLAN_ID,
        mealId: PARSE_MEAL_ID,
        recipeVersionId: PARSE_RECIPE_VERSION_ID,
    };

    it('accepts three v4 UUIDs', () => {
        expect(parseSwapPreviewPath(validPath)).toEqual({ kind: 'ok', ...validPath });
    });

    it('judges the recipe version id, so a malformed one is a 400 and not recipe_ineligible', () => {
        expect(parseSwapPreviewPath({ ...validPath, recipeVersionId: 'undefined' })).toEqual({
            kind: 'error',
            code: 'invalid_request',
            message: 'planId, mealId and recipeVersionId must be UUIDs',
            details: [{ field: 'recipeVersionId', code: SWAP_FIELD_CODES.INVALID_ID }],
        });
    });

    it('reports each id on its own', () => {
        expect(fieldCodesOf(parseSwapPreviewPath({ ...validPath, planId: WRONG_VERSION_UUID }))).toEqual([
            `planId:${SWAP_FIELD_CODES.INVALID_ID}`,
        ]);
        expect(fieldCodesOf(parseSwapPreviewPath({ ...validPath, mealId: WRONG_LENGTH_UUID }))).toEqual([
            `mealId:${SWAP_FIELD_CODES.INVALID_ID}`,
        ]);
        expect(fieldCodesOf(parseSwapPreviewPath({ ...validPath, recipeVersionId: null }))).toEqual([
            `recipeVersionId:${SWAP_FIELD_CODES.INVALID_ID}`,
        ]);
    });

    it('reports all three ids at once', () => {
        expect(fieldCodesOf(parseSwapPreviewPath({ planId: 'nope', mealId: 42, recipeVersionId: {} }))).toEqual(
            [
                `planId:${SWAP_FIELD_CODES.INVALID_ID}`,
                `mealId:${SWAP_FIELD_CODES.INVALID_ID}`,
                `recipeVersionId:${SWAP_FIELD_CODES.INVALID_ID}`,
            ],
        );
        expect(fieldCodesOf(parseSwapPreviewPath({}))).toHaveLength(3);
    });
});

describe('parseSwapCommitRequest', () => {
    it('accepts the path ids and the body the contract declares', () => {
        expect(parseSwapCommitRequest(COMMIT_PATH, VALID_COMMIT_BODY)).toEqual({
            kind: 'ok',
            planId: PARSE_PLAN_ID,
            mealId: PARSE_MEAL_ID,
            payload: VALID_COMMIT_BODY,
        });
    });

    it('carries exactly the four payload fields the service takes', () => {
        const parsed = parseSwapCommitRequest(COMMIT_PATH, VALID_COMMIT_BODY);

        if (parsed.kind !== 'ok') {
            throw new Error('expected the valid request to be accepted');
        }

        expect(Object.keys(parsed.payload).sort()).toEqual([
            'expectedPlanRevision',
            'idempotencyKey',
            'portionMultiplier',
            'recipeVersionId',
        ]);
    });

    it('judges the path ids here too', () => {
        expect(
            fieldCodesOf(parseSwapCommitRequest({ planId: 'nope', mealId: 42 }, VALID_COMMIT_BODY)),
        ).toEqual([`planId:${SWAP_FIELD_CODES.INVALID_ID}`, `mealId:${SWAP_FIELD_CODES.INVALID_ID}`]);
    });

    describe('a body that is not a JSON object', () => {
        it('reports the four fields a body should have carried', () => {
            expect(parseSwapCommitRequest(COMMIT_PATH, null)).toEqual({
                kind: 'error',
                code: 'invalid_request',
                message: 'A request body is required',
                details: [
                    { field: 'recipeVersionId', code: SWAP_FIELD_CODES.REQUIRED },
                    { field: 'portionMultiplier', code: SWAP_FIELD_CODES.REQUIRED },
                    { field: 'expectedPlanRevision', code: SWAP_FIELD_CODES.REQUIRED },
                    { field: 'idempotencyKey', code: SWAP_FIELD_CODES.REQUIRED },
                ],
            });
        });

        it('treats a bare string, an array and a missing body the same way', () => {
            expect(fieldCodesOf(parseSwapCommitRequest(COMMIT_PATH, 'recipeVersionId'))).toHaveLength(4);
            expect(fieldCodesOf(parseSwapCommitRequest(COMMIT_PATH, [VALID_COMMIT_BODY]))).toHaveLength(4);
            expect(fieldCodesOf(parseSwapCommitRequest(COMMIT_PATH, undefined))).toHaveLength(4);
        });

        it('still judges the path ids, which are wrong or right independently of the body', () => {
            expect(fieldCodesOf(parseSwapCommitRequest({ planId: 'nope', mealId: 'nope' }, null))).toEqual([
                `planId:${SWAP_FIELD_CODES.INVALID_ID}`,
                `mealId:${SWAP_FIELD_CODES.INVALID_ID}`,
                `recipeVersionId:${SWAP_FIELD_CODES.REQUIRED}`,
                `portionMultiplier:${SWAP_FIELD_CODES.REQUIRED}`,
                `expectedPlanRevision:${SWAP_FIELD_CODES.REQUIRED}`,
                `idempotencyKey:${SWAP_FIELD_CODES.REQUIRED}`,
            ]);
        });
    });

    describe('recipeVersionId and idempotencyKey', () => {
        it('requires both, telling an absent field from a malformed one', () => {
            expect(commitBodyCode({ recipeVersionId: undefined }, 'recipeVersionId')).toBe(
                SWAP_FIELD_CODES.REQUIRED,
            );
            expect(commitBodyCode({ idempotencyKey: null }, 'idempotencyKey')).toBe(
                SWAP_FIELD_CODES.REQUIRED,
            );
            expect(commitBodyCode({ recipeVersionId: WRONG_VERSION_UUID }, 'recipeVersionId')).toBe(
                SWAP_FIELD_CODES.INVALID_ID,
            );
            expect(commitBodyCode({ idempotencyKey: WRONG_LENGTH_UUID }, 'idempotencyKey')).toBe(
                SWAP_FIELD_CODES.INVALID_ID,
            );
        });

        it('refuses a non-string id', () => {
            expect(commitBodyCode({ recipeVersionId: 7 }, 'recipeVersionId')).toBe(
                SWAP_FIELD_CODES.INVALID_ID,
            );
            expect(commitBodyCode({ idempotencyKey: { key: PARSE_IDEMPOTENCY_KEY } }, 'idempotencyKey')).toBe(
                SWAP_FIELD_CODES.INVALID_ID,
            );
        });
    });

    describe('portionMultiplier', () => {
        it('accepts every portion the product offers', () => {
            expect(
                ADMISSIBLE_PORTIONS.map(
                    (multiplier) =>
                        parseSwapCommitRequest(COMMIT_PATH, commitBodyWith({ portionMultiplier: multiplier }))
                            .kind,
                ),
            ).toEqual(ADMISSIBLE_PORTIONS.map(() => 'ok'));
        });

        it('accepts float noise within the two-decimal representation the contract stores', () => {
            expect(
                parseSwapCommitRequest(COMMIT_PATH, commitBodyWith({ portionMultiplier: 1.2500000000001 }))
                    .kind,
            ).toBe('ok');
        });

        it('refuses a value outside the offered set as unknown_value', () => {
            for (const multiplier of [0, -1, 1.1, 0.6, 3.5]) {
                expect(commitBodyCode({ portionMultiplier: multiplier }, 'portionMultiplier')).toBe(
                    SWAP_FIELD_CODES.UNKNOWN_VALUE,
                );
            }
        });

        it('never widens the set with the diagnostic-only extended policy', () => {
            expect(EXTENDED_ONLY_PORTIONS).toEqual([0.25, 2.5, 3]);

            for (const multiplier of EXTENDED_ONLY_PORTIONS) {
                expect(commitBodyCode({ portionMultiplier: multiplier }, 'portionMultiplier')).toBe(
                    SWAP_FIELD_CODES.UNKNOWN_VALUE,
                );
            }
        });

        it('refuses a numeric string rather than coercing it, because the value is fingerprinted', () => {
            expect(commitBodyCode({ portionMultiplier: '1' }, 'portionMultiplier')).toBe(
                SWAP_FIELD_CODES.INVALID_TYPE,
            );
            expect(commitBodyCode({ portionMultiplier: true }, 'portionMultiplier')).toBe(
                SWAP_FIELD_CODES.INVALID_TYPE,
            );
        });

        it('requires the field', () => {
            expect(commitBodyCode({ portionMultiplier: undefined }, 'portionMultiplier')).toBe(
                SWAP_FIELD_CODES.REQUIRED,
            );
            expect(commitBodyCode({ portionMultiplier: null }, 'portionMultiplier')).toBe(
                SWAP_FIELD_CODES.REQUIRED,
            );
        });

        it('answers 400 for a non-finite portion, which requireBoundPortion would call a stale preview', () => {
            for (const multiplier of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
                expect(commitBodyCode({ portionMultiplier: multiplier }, 'portionMultiplier')).toBe(
                    SWAP_FIELD_CODES.UNKNOWN_VALUE,
                );
            }

            // The harm this parser removes, stated in one assertion: the binding
            // check fails CLOSED for any value that is not the recomputed
            // portion, so without the parse above a malformed portion reaches
            // the user as "your preview went stale".
            expect(() => requireBoundPortion(Number.NaN, 1.25)).toThrow(PreviewStaleError);
        });
    });

    describe('expectedPlanRevision', () => {
        it('accepts the first revision a plan can have and the column maximum', () => {
            expect(
                parseSwapCommitRequest(COMMIT_PATH, commitBodyWith({ expectedPlanRevision: 1 })).kind,
            ).toBe('ok');
            expect(
                parseSwapCommitRequest(COMMIT_PATH, commitBodyWith({ expectedPlanRevision: MAX_REVISION }))
                    .kind,
            ).toBe('ok');
            expect(MAX_REVISION).toBe(2_147_483_647);
        });

        it('refuses a revision below the first one', () => {
            expect(commitBodyCode({ expectedPlanRevision: 0 }, 'expectedPlanRevision')).toBe(
                SWAP_FIELD_CODES.BELOW_MINIMUM,
            );
            expect(commitBodyCode({ expectedPlanRevision: -1 }, 'expectedPlanRevision')).toBe(
                SWAP_FIELD_CODES.BELOW_MINIMUM,
            );
        });

        it('refuses a magnitude that cannot denote a stored revision', () => {
            expect(commitBodyCode({ expectedPlanRevision: MAX_REVISION + 1 }, 'expectedPlanRevision')).toBe(
                SWAP_FIELD_CODES.ABOVE_MAXIMUM,
            );
            // `Number.isInteger(1e30)` is true, which is exactly why the integer
            // check alone is not enough: this value would reach the fingerprinter
            // as an unrepresentable magnitude and surface as a 500.
            expect(Number.isInteger(1e30)).toBe(true);
            expect(commitBodyCode({ expectedPlanRevision: 1e30 }, 'expectedPlanRevision')).toBe(
                SWAP_FIELD_CODES.ABOVE_MAXIMUM,
            );
            expect(
                commitBodyCode({ expectedPlanRevision: Number.MAX_SAFE_INTEGER + 2 }, 'expectedPlanRevision'),
            ).toBe(SWAP_FIELD_CODES.ABOVE_MAXIMUM);
        });

        it('refuses a fractional revision', () => {
            expect(commitBodyCode({ expectedPlanRevision: 1.5 }, 'expectedPlanRevision')).toBe(
                SWAP_FIELD_CODES.NOT_AN_INTEGER,
            );
        });

        it('refuses a numeric string and a non-finite number', () => {
            expect(commitBodyCode({ expectedPlanRevision: '3' }, 'expectedPlanRevision')).toBe(
                SWAP_FIELD_CODES.INVALID_TYPE,
            );
            expect(commitBodyCode({ expectedPlanRevision: Number.NaN }, 'expectedPlanRevision')).toBe(
                SWAP_FIELD_CODES.INVALID_TYPE,
            );
            expect(
                commitBodyCode({ expectedPlanRevision: Number.POSITIVE_INFINITY }, 'expectedPlanRevision'),
            ).toBe(SWAP_FIELD_CODES.INVALID_TYPE);
        });

        it('requires the field, because it is the stale-plan guard', () => {
            expect(commitBodyCode({ expectedPlanRevision: undefined }, 'expectedPlanRevision')).toBe(
                SWAP_FIELD_CODES.REQUIRED,
            );
            expect(commitBodyCode({ expectedPlanRevision: null }, 'expectedPlanRevision')).toBe(
                SWAP_FIELD_CODES.REQUIRED,
            );
        });
    });

    describe('unknown body keys', () => {
        it('reports a key this endpoint does not accept rather than dropping it', () => {
            expect(fieldCodesOf(parseSwapCommitRequest(COMMIT_PATH, commitBodyWith({ mealName: 'Lunch' })))).toEqual(
                [`mealName:${SWAP_FIELD_CODES.UNKNOWN_FIELD}`],
            );
        });

        it('reports a misspelt field twice over: the missing one and the unknown one', () => {
            const parsed = parseSwapCommitRequest(COMMIT_PATH, {
                recipeVersionId: PARSE_RECIPE_VERSION_ID,
                portionMultipler: 1.25,
                expectedPlanRevision: 3,
                idempotencyKey: PARSE_IDEMPOTENCY_KEY,
            });

            expect(fieldCodesOf(parsed)).toEqual([
                `portionMultiplier:${SWAP_FIELD_CODES.REQUIRED}`,
                `portionMultipler:${SWAP_FIELD_CODES.UNKNOWN_FIELD}`,
            ]);
        });

        it('refuses path ids smuggled into the body', () => {
            expect(
                fieldCodesOf(
                    parseSwapCommitRequest(
                        COMMIT_PATH,
                        commitBodyWith({ planId: PARSE_PLAN_ID, mealId: PARSE_MEAL_ID }),
                    ),
                ),
            ).toEqual([
                `planId:${SWAP_FIELD_CODES.UNKNOWN_FIELD}`,
                `mealId:${SWAP_FIELD_CODES.UNKNOWN_FIELD}`,
            ]);
        });
    });

    it('reports every field of a fully malformed request at once', () => {
        const parsed = parseSwapCommitRequest(
            { planId: WRONG_VERSION_UUID, mealId: undefined },
            {
                recipeVersionId: 'nope',
                portionMultiplier: '1',
                expectedPlanRevision: 0,
                surprise: true,
            },
        );

        expect(parsed).toEqual({
            kind: 'error',
            code: 'invalid_request',
            message: 'The swap request is not valid',
            details: [
                { field: 'planId', code: SWAP_FIELD_CODES.INVALID_ID },
                { field: 'mealId', code: SWAP_FIELD_CODES.INVALID_ID },
                { field: 'recipeVersionId', code: SWAP_FIELD_CODES.INVALID_ID },
                { field: 'portionMultiplier', code: SWAP_FIELD_CODES.INVALID_TYPE },
                { field: 'expectedPlanRevision', code: SWAP_FIELD_CODES.BELOW_MINIMUM },
                { field: 'idempotencyKey', code: SWAP_FIELD_CODES.REQUIRED },
                { field: 'surprise', code: SWAP_FIELD_CODES.UNKNOWN_FIELD },
            ],
        });
    });
});
