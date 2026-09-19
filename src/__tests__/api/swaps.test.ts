// The HTTP proof for the three swap endpoints (Agent Action Plan §0.5.1 "Plan
// write-safety model", §0.5.2's three `…/meals/:mealId/alternatives*` and
// `…/swap` rows, §0.7.3's selection and grocery-diff rules, §0.9.2's
// `api/swaps.test.ts` rows):
//
//   GET  /api/meal-planning/plans/:planId/meals/:mealId/alternatives
//   GET  /api/meal-planning/plans/:planId/meals/:mealId/alternatives/:recipeVersionId/preview
//   POST /api/meal-planning/plans/:planId/meals/:mealId/swap
//
// THE CHARTER: THE THREE MUST AGREE. All three answer out of the same pair of
// pure functions — `swap.logic.ts::selectSwapCandidates` and
// `selectSwapPortion` — precisely so they cannot disagree about which recipes
// are on offer or at what portion. A unit test of those functions cannot show
// that the three ENDPOINTS still call them, and the failure this suite exists
// to catch is one of the three drifting: most plausibly a list that assumes a
// default portion of one while the preview and the commit compute one. So the
// headline case walks list → preview → commit over a single seeded world and
// asserts one recipe at one multiplier all the way through, and it is repeated
// for the candidate that is admissible ONLY at a non-default portion — the case
// a list assuming ×1 could not possibly pass.
//
// IT IS ALSO THE NAMED VERIFIER OF TWO MAPPERS. `mealPlan.mapper.ts` and
// `grocery.mapper.ts` have no `*.logic.test.ts` of their own, because Rule
// `backend-architecture` §11 places mappers under "unit-testable if
// non-trivial; otherwise covered by integration". This is that integration:
// `current` on the alternatives response is one of only two places the full
// `MealPlanMealResponse` is served, so its `flags`, `loggedEntries`,
// `previousRecipe`, `portionText` and display-rounded `planned` are asserted
// here, and the grocery DTO's `flag` is read back through
// `GET …/groceries` rather than inferred from the row.
//
// WHAT EVERY CASE ASSERTS AGAINST. The response AND the database. A status code
// that agrees with rows nobody wrote, or a row written behind a response that
// never said so, are both failures this suite is here to catch — so each case
// drives a real request through `request` (the shipped `app`, with its real
// mount order and its real middleware) and then re-reads `meal_plan_meals`,
// `meal_plan_days`, `meal_plans`, `grocery_items`, `meal_entries` and
// `meal_plan_actions`.
//
// THE CLOCK IS THE REAL ONE, AND THAT SHAPES THE FIXTURE. `commitSwap` takes
// `now` as an injectable last argument, but the controller passes none — a
// request is judged against `new Date()` — so a swap is only accepted while the
// plan's week contains the caller's today (§0.5.1's endedness rule, resolved in
// the user's stored zone). The fixture week is therefore DERIVED from the clock
// (`currentPlanStartDayKey()`, seven days) rather than pinned, which also means
// it spans every day key the user's zone could call today and cannot turn into
// a `409 plan_not_active` if a run crosses UTC midnight. The two consequences
// are deliberate: an ENDED plan is reached by seeding a week that has passed
// (`FIXTURE_ENDED_PLAN_START_DAY_KEY`) rather than by time travel, and
// `swapped_at` / `flagged_at` are BRACKETED between the instants either side of
// the request instead of compared to a fixed one.
//
// THE WEEK IS SEVEN DAYS AND ONLY ONE OF THEM IS PLANNED. That is what makes a
// grocery REMOVAL reachable: with every day planning the same lunch, no food a
// swapped meal drops ever leaves the list, because six other lunches still need
// it. One planned day also keeps the arithmetic small enough to state — each
// meal contributes `gram_weight ÷ yield_servings × portion_multiplier` = 100 g —
// while the six empty days give the repetition cases somewhere non-adjacent to
// plant a recipe. Days with no meals are an expressible plan state, which is
// why `makePlan` accepts `slots: []`.
//
// WHAT THIS SUITE DOES NOT OWN. `services/__tests__/swap.logic.test.ts` owns
// candidate selection, the portion minimisation, the ranking, the preview
// arithmetic, `isPreviewStillBinding` and the A→B→C derivation as pure
// functions — Rule §11's self-check applies to every case below: if it would
// pass with the database stubbed, it belongs there. `requestParserWiring`
// proves the parsers are reached with no I/O; the two cases here are the
// controller's half of that (the `400` BODY, and the nested preview path
// resolving rather than being swallowed by `/alternatives`). The exhaustive
// ownership matrix is `ownership.test.ts`'s and the local nested-id proof is
// here; raced writes are `concurrency.test.ts`'s; the post-commit abort seam is
// `fault.test.ts`'s; the deeper grocery banner matrix is `grocery.test.ts`'s.

import { Prisma, catalog_foods, recipe_versions } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import { loadPlannedMealsForGroceries, rebuildPlanGroceries } from '../../services/grocery.service';
// The module OBJECT, because `jest.spyOn` needs one to install the spy on: the
// case that counts a commit's preference reads wraps `loadPreferencesRow` in
// place, which a named import gives no handle to.
import * as preferencesService from '../../services/preferences.service';
// The same, for the canonical target read the commit resolves exactly once.
import * as targetsService from '../../services/targets.service';
import {
    GroceryItem,
    GroceryListResponse,
    InvalidRequestDetail,
    MealPlanDayEnvelopeResponse,
    MealPlanMealResponse,
    PreferencesSaveResponse,
    SwapAlternativesResponse,
    SwapMealResponse,
    SwapPreviewResponse,
} from '../../types/mealPlanning';
import { RECIPE_ICON_KEYS } from '../../types/recipe';
import { isMealPlanningEnabled, mealPlanningFault } from '../../utils/featureFlags';
import {
    FIXTURE_ENDED_PLAN_START_DAY_KEY,
    FIXTURE_TARGETS,
    FIXTURE_USER_TARGET_COLUMNS,
    FixtureRecipeVersion,
    addDaysToDayKey,
    currentPlanStartDayKey,
    makeCatalogFood,
    makePlan,
    makePreferences,
    makeRecipeVersion,
    makeUser,
} from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

// THE TWO SWITCHES ARE STUBBED AT THE MODULE BOUNDARY, because
// `utils/featureFlags.ts` resolves both from the environment ONCE at import
// (Rule `backend-architecture` §9: config is read at the module boundary, never
// branched on deep inside business code). Mutating `process.env` mid-suite
// therefore changes nothing, and `jest.resetModules()` would mean rebuilding
// the whole `app.ts` graph — including the Prisma singleton and this file's
// factories — just to flip a boolean. Stubbing the two ACCESSORS keeps one
// mounted app and one connection: the controller calls `isMealPlanningEnabled()`
// per request and `swap.service.ts` calls `mealPlanningFault()` inside
// `commitSwap`, so a stub takes effect for the very next request and is undone
// in `afterEach`.
//
// `requireActual` is spread rather than replaced wholesale so `postCommitAbort`
// and `POST_COMMIT_ABORT_HEADER` stay the real implementations: the abort seam
// belongs to `fault.test.ts`, and a stub of it here could make a case in that
// file — or in this one — pass for the wrong reason.
jest.mock('../../utils/featureFlags', () => ({
    ...(jest.requireActual('../../utils/featureFlags') as object),
    isMealPlanningEnabled: jest.fn(() => true),
    mealPlanningFault: jest.fn(() => 'off' as const),
}));

/* ---------------------------------------------------------------------------
 * The world's fixed values
 * ------------------------------------------------------------------------- */

const USER_ID = 'swap-suite-user';

/** A second account, for the ownership cases. Never the caller. */
const OTHER_USER_ID = 'swap-suite-other-user';

/** The plan's first day: one before today, so the week holds every zone's today. */
const PLAN_START_DAY_KEY = currentPlanStartDayKey();

const PLAN_DAY_COUNT = 7;

/**
 * Which day of the week carries the planned meals — the fourth, so both of its
 * neighbours are inside the week and the first and last days are NOT adjacent
 * to it. The repetition cases plant recipes on those two, where only the
 * "at most twice a week" clause can refuse them and the "never on consecutive
 * days" clause cannot.
 */
const PLANNED_DAY_INDEX = 3;

/** Non-adjacent to {@link PLANNED_DAY_INDEX}, so a plant there tests the count alone. */
const FIRST_DAY_INDEX = 0;
const LAST_DAY_INDEX = 6;

const PLANNED_DAY_KEY = addDaysToDayKey(PLAN_START_DAY_KEY, PLANNED_DAY_INDEX);

const LUNCH_SLOT = 'lunch';

const SWAP_KEY = '11111111-1111-4111-8111-111111111111';
const SECOND_SWAP_KEY = '22222222-2222-4222-8222-222222222222';
const FIRST_LOG_KEY = '44444444-4444-4444-8444-444444444444';
const SECOND_LOG_KEY = '55555555-5555-4555-8555-555555555555';

/** `meal_plans.revision` as `makePlan` writes it, and after one and two swaps. */
const PLAN_REVISION_BEFORE = 1;
const PLAN_REVISION_AFTER = 2;

/** `meal_plan_meals.revision` as a planted meal carries it, and after one swap. */
const MEAL_REVISION_BEFORE = 1;
const MEAL_REVISION_AFTER = 2;

/**
 * Per-100 g values for a recipe's two 200 g ingredients over a two-serving
 * yield: `Σ(gram_weight × per100g ÷ 100) ÷ yield` collapses to `2 × per100g`,
 * so each set below is half of the per-serving figures it produces.
 *
 * Every number is exactly representable in binary floating point, so the stored
 * `planned_*` columns and the day sums are exact rather than approximate —
 * which is what lets the assertions below use equality instead of a tolerance.
 */
const BASE_PER_100G = { calories: 350, protein_g: 26, carbs_g: 35, fat_g: 11.5, fiber_g: 0 };
const HEAVIER_PER_100G = { calories: 380, protein_g: 29, carbs_g: 38, fat_g: 12.5, fiber_g: 0 };
const HALF_PER_100G = { calories: 190, protein_g: 14.5, carbs_g: 19, fat_g: 6.25, fiber_g: 0 };

/** What each of the three planned slots carries: `2 × BASE_PER_100G`. */
const PLANNED_MEAL_NUTRITION = { calories: 700, protein: 52, carbs: 70, fat: 23 };

/** What the equal-portion candidate carries at ×1: `2 × HEAVIER_PER_100G`. */
const EQUAL_CANDIDATE_NUTRITION = { calories: 760, protein: 58, carbs: 76, fat: 25 };

/** The planned day as seeded: three meals of {@link PLANNED_MEAL_NUTRITION}. */
const DAY_TOTALS_BEFORE = { calories: 2100, protein: 156, carbs: 210, fat: 69 };

/** The day once the lunch becomes {@link EQUAL_CANDIDATE_NUTRITION} at ×1. */
const DAY_TOTALS_AFTER_EQUAL = { calories: 2160, protein: 162, carbs: 216, fat: 71 };

/**
 * The portion the half-sized candidate is offered at, and the case §0.7.3 names
 * for this suite.
 *
 * Its per-serving figure is 380 kcal and the day is 1,400 kcal without the
 * lunch, so of the admissible multipliers 1.75 (2,065 kcal) sits closest to the
 * 2,100 target — while ×1 (1,780 kcal) falls outside the day tolerance
 * altogether and is not admissible at all. A list that assumed a default
 * portion of one would therefore either omit this candidate or offer it at an
 * amount the commit refuses.
 */
const HALF_CANDIDATE_PORTION = 1.75;

/** The half candidate at {@link HALF_CANDIDATE_PORTION}: `2 × HALF_PER_100G × 1.75`. */
const HALF_CANDIDATE_NUTRITION = { calories: 665, protein: 50.75, carbs: 66.5, fat: 21.875 };

/** The day once the lunch becomes the half candidate at its own portion. */
const DAY_TOTALS_AFTER_HALF = { calories: 2065, protein: 154.75, carbs: 206.5, fat: 67.875 };

/** Grams of one food per planned meal: `gram_weight ÷ yield_servings × portion_multiplier`. */
const GRAMS_PER_MEAL = 100;

const INGREDIENT_GRAM_WEIGHT = 200;

/** 100 g of a 200 g-per-cup food rendered in its own volume family. */
const ARRIVING_VOLUME_DISPLAY_TEXT = '8 tbsp';

/** `MAX_SWAP_ALTERNATIVES`, restated so the assertion reads as the contract. */
const SWAP_ALTERNATIVE_LIMIT = 8;

/** How many extra eligible candidates the truncation case seeds: more than the limit. */
const OVER_LIMIT_CANDIDATE_COUNT = 10;

/* ---------------------------------------------------------------------------
 * Building the world
 * ------------------------------------------------------------------------- */

interface SuiteFixture {
    /** Only ever on the untouched breakfast and dinner: its line never moves. */
    unchangedFood: catalog_foods;
    /** On the breakfast and on the incoming candidate: its line goes up. */
    sharedFood: catalog_foods;
    /** On the outgoing lunch and on the dinner: its line comes down. */
    decreasingFood: catalog_foods;
    /** On the outgoing lunch alone: its line disappears. */
    removedFood: catalog_foods;
    /** On the incoming candidates alone: its line arrives. */
    newFood: catalog_foods;
    breakfastRecipe: FixtureRecipeVersion;
    lunchRecipe: FixtureRecipeVersion;
    dinnerRecipe: FixtureRecipeVersion;
    /** The candidate whose portion is ×1, and which most commit cases swap in. */
    equalPortionCandidate: FixtureRecipeVersion;
    /** The candidate admissible only at {@link HALF_CANDIDATE_PORTION}. */
    halfPortionCandidate: FixtureRecipeVersion;
    planId: string;
    /** Every day of the week, in date order, so a case can plant on a named one. */
    dayIds: readonly string[];
    plannedDayId: string;
    breakfastMealId: string;
    lunchMealId: string;
    dinnerMealId: string;
    otherUserPlanId: string;
    otherUserMealId: string;
}

let fixture: SuiteFixture;

/**
 * A food whose default portion is stated in GRAMS, which fixes its grocery line
 * in the `mass` family.
 *
 * A deliberate choice of family rather than a way round a refusal:
 * `makeCatalogFood`'s own default portion is "1 cup / 200 g" with no stored
 * density — the shape the whole catalog release ships — and it renders
 * perfectly well through the density that portion itself states. What a gram
 * portion buys is ARITHMETIC THIS FILE CAN STATE: every diff assertion below is
 * written in the grams the recipes plan. The volume family is exercised by
 * {@link makeVolumePortionFood}, on the one line that only has to appear.
 * `food_state: 'raw'` keeps the rendered name free of the state suffix §0.7.3
 * appends for every other state.
 */
const makeShoppableFood = async (displayName: string): Promise<catalog_foods> =>
    makeCatalogFood({
        display_name: displayName,
        food_state: 'raw',
        category: 'produce_vegetable',
        defaultPortion: { description: '1 portion', amount: 100, unit: 'g', gram_weight: 100 },
    });

/**
 * A food shaped the way the CATALOG RELEASE ships them: a volume-family default
 * portion ("1 cup", 200 g) with no `density_g_per_ml` at all.
 *
 * The arriving line of every swap below is this shape, so a commit can only
 * succeed if its own rebuild renders a volume row from the density the portion
 * states (200 g per cup ≈ 0.845 g/ml, §0.1.4's stored-portion conversion) —
 * which is why 100 g of it reads "8 tbsp".
 */
const makeVolumePortionFood = async (displayName: string): Promise<catalog_foods> =>
    makeCatalogFood({ display_name: displayName, food_state: 'raw', category: 'produce_vegetable' });

/**
 * A recipe version of exactly two ingredients, 200 g of each, at the per-100 g
 * values given — so its per-serving nutrition is `2 × per100g` and each of its
 * two foods contributes {@link GRAMS_PER_MEAL} to the shopping list per planned
 * meal at ×1.
 *
 * The nutrition is DERIVED by the factory from these ingredients rather than
 * stated, so a fixture whose stored per-serving figures disagreed with its own
 * ingredient rows is not expressible here.
 */
const makeTwoIngredientRecipe = async (
    slug: string,
    name: string,
    foods: readonly [catalog_foods, catalog_foods],
    per100g: typeof BASE_PER_100G,
    overrides: Partial<{ recipeId: string; version: number; status: string }> = {},
): Promise<FixtureRecipeVersion> =>
    makeRecipeVersion({
        slug,
        name,
        catalogFoodId: foods[0].id,
        ...overrides,
        ingredients: foods.map((food) => ({
            catalogFoodId: food.id,
            per100g,
            gram_weight: INGREDIENT_GRAM_WEIGHT,
            quantity: INGREDIENT_GRAM_WEIGHT,
            unit: 'g',
            display_text: `${INGREDIENT_GRAM_WEIGHT} g`,
        })),
    });

interface PlantedSlot {
    slot: string;
    slotTime: string;
    recipeVersionId: string;
    portionMultiplier?: number;
}

/**
 * Plants meals on one day of an otherwise empty week, and writes that day's
 * `planned_*` from the recipes it planted.
 *
 * The day totals are DERIVED from the recipe rows rather than passed in, so the
 * storage invariant `meal_plan_days.planned_* === Σ its meals` — the one
 * `mealPlan.mapper.ts` reports rather than re-sums, and the one a swap rewrites —
 * holds for a planted day exactly as it does for a generated one. A fixture that
 * left a day's totals at zero while giving it meals would put every later
 * assertion about a rewritten total on top of a contradiction.
 */
const plantMeals = async (dayId: string, slots: readonly PlantedSlot[]): Promise<string[]> => {
    const day = await prisma.meal_plan_days.findUniqueOrThrow({ where: { id: dayId } });
    const ids: string[] = [];
    let calories = 0;
    let protein = 0;
    let carbs = 0;
    let fat = 0;

    for (const [index, planted] of slots.entries()) {
        const version = await prisma.recipe_versions.findUniqueOrThrow({
            where: { id: planted.recipeVersionId },
        });
        const multiplier = planted.portionMultiplier ?? 1;
        const planned = {
            calories: version.per_serving_calories * multiplier,
            protein: version.per_serving_protein_g * multiplier,
            carbs: version.per_serving_carbs_g * multiplier,
            fat: version.per_serving_fat_g * multiplier,
        };

        const meal = await prisma.meal_plan_meals.create({
            data: {
                meal_plan_day_id: day.id,
                meal_plan_id: day.meal_plan_id,
                user_id: day.user_id,
                slot: planted.slot,
                slot_time: planted.slotTime,
                sort_order: index,
                recipe_version_id: planted.recipeVersionId,
                portion_multiplier: multiplier,
                planned_calories: planned.calories,
                planned_protein_g: planned.protein,
                planned_carbs_g: planned.carbs,
                planned_fat_g: planned.fat,
                revision: MEAL_REVISION_BEFORE,
                flags: [],
            },
        });

        ids.push(meal.id);
        calories += planned.calories;
        protein += planned.protein;
        carbs += planned.carbs;
        fat += planned.fat;
    }

    await prisma.meal_plan_days.update({
        where: { id: dayId },
        data: {
            planned_calories: calories,
            planned_protein_g: protein,
            planned_carbs_g: carbs,
            planned_fat_g: fat,
        },
    });

    return ids;
};

/**
 * The shopping list a freshly published plan has.
 *
 * Written through `rebuildPlanGroceries` — the production builder, whose own
 * docblock names the empty-stored-list case as the one a first publication
 * uses — rather than by inserting rows by hand, because what the swap cases
 * assert is the DIFF applied to a list the feature itself produced. A hand-built
 * list could disagree with the aggregation rules, and the diff would then be
 * measured against the wrong starting point.
 */
const writeInitialGroceryList = async (userId: string, planId: string): Promise<void> => {
    await prisma.$transaction(async (tx) => {
        const meals = await loadPlannedMealsForGroceries(tx, userId, planId);

        await rebuildPlanGroceries(tx, { userId, planId, meals, now: new Date() });
    });
};

const seedFixture = async (): Promise<SuiteFixture> => {
    await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(USER_ID);

    const unchangedFood = await makeShoppableFood('Unchanged Greens');
    const sharedFood = await makeShoppableFood('Shared Beans');
    const decreasingFood = await makeShoppableFood('Decreasing Lentils');
    const removedFood = await makeShoppableFood('Removed Squash');
    // The arriving line is the one food of the five whose portion is VOLUMETRIC,
    // so the swap's own rebuild has to render a volume row to commit at all.
    const newFood = await makeVolumePortionFood('Arriving Peppers');

    const breakfastRecipe = await makeTwoIngredientRecipe(
        'swap-suite-breakfast',
        'Breakfast Bowl',
        [unchangedFood, sharedFood],
        BASE_PER_100G,
    );
    const lunchRecipe = await makeTwoIngredientRecipe(
        'swap-suite-lunch',
        'Lunch Bowl',
        [removedFood, decreasingFood],
        BASE_PER_100G,
    );
    const dinnerRecipe = await makeTwoIngredientRecipe(
        'swap-suite-dinner',
        'Dinner Bowl',
        [decreasingFood, unchangedFood],
        BASE_PER_100G,
    );
    const equalPortionCandidate = await makeTwoIngredientRecipe(
        'swap-suite-candidate-equal',
        'Candidate At One Serving',
        [sharedFood, newFood],
        HEAVIER_PER_100G,
    );
    const halfPortionCandidate = await makeTwoIngredientRecipe(
        'swap-suite-candidate-half',
        'Candidate At Three Quarters Over',
        [sharedFood, newFood],
        HALF_PER_100G,
    );

    // `slots: []` publishes the week's days with no meals; `plantMeals` then
    // fills exactly one of them. See the module header for why only one day is
    // planned.
    const plan = await makePlan(USER_ID, {
        startDate: PLAN_START_DAY_KEY,
        dayCount: PLAN_DAY_COUNT,
        slots: [],
    });
    const dayIds = plan.meal_plan_days.map((day) => day.id);
    const plannedDayId = dayIds[PLANNED_DAY_INDEX];

    const [breakfastMealId, lunchMealId, dinnerMealId] = await plantMeals(plannedDayId, [
        { slot: 'breakfast', slotTime: '08:00', recipeVersionId: breakfastRecipe.id },
        { slot: LUNCH_SLOT, slotTime: '12:30', recipeVersionId: lunchRecipe.id },
        { slot: 'dinner', slotTime: '18:30', recipeVersionId: dinnerRecipe.id },
    ]);

    await writeInitialGroceryList(USER_ID, plan.id);

    // A second account with a week of its own, so the ownership cases have a
    // real foreign plan and a real foreign meal to aim at rather than an
    // invented id — which is the only way "another user's" and "no such thing"
    // can be shown to be the same answer.
    await makeUser({ id: OTHER_USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(OTHER_USER_ID);

    const otherUserPlan = await makePlan(OTHER_USER_ID, {
        startDate: PLAN_START_DAY_KEY,
        dayCount: PLAN_DAY_COUNT,
        slots: [],
    });
    const [otherUserMealId] = await plantMeals(otherUserPlan.meal_plan_days[PLANNED_DAY_INDEX].id, [
        { slot: LUNCH_SLOT, slotTime: '12:30', recipeVersionId: lunchRecipe.id },
    ]);

    await writeInitialGroceryList(OTHER_USER_ID, otherUserPlan.id);

    return {
        unchangedFood,
        sharedFood,
        decreasingFood,
        removedFood,
        newFood,
        breakfastRecipe,
        lunchRecipe,
        dinnerRecipe,
        equalPortionCandidate,
        halfPortionCandidate,
        planId: plan.id,
        dayIds,
        plannedDayId,
        breakfastMealId,
        lunchMealId,
        dinnerMealId,
        otherUserPlanId: otherUserPlan.id,
        otherUserMealId,
    };
};

/* ---------------------------------------------------------------------------
 * The requests — every case below travels through the mounted app
 * ------------------------------------------------------------------------- */

interface PathOverrides {
    planId?: string;
    mealId?: string;
}

const alternativesPath = ({ planId, mealId }: PathOverrides = {}): string =>
    `/api/meal-planning/plans/${planId ?? fixture.planId}/meals/${mealId ?? fixture.lunchMealId}/alternatives`;

const previewPath = (recipeVersionId: string, overrides: PathOverrides = {}): string =>
    `${alternativesPath(overrides)}/${recipeVersionId}/preview`;

const swapPath = ({ planId, mealId }: PathOverrides = {}): string =>
    `/api/meal-planning/plans/${planId ?? fixture.planId}/meals/${mealId ?? fixture.lunchMealId}/swap`;

const groceriesPath = (planId?: string): string =>
    `/api/meal-planning/plans/${planId ?? fixture.planId}/groceries`;

const dayPath = (dayKey: string = PLANNED_DAY_KEY, planId?: string): string =>
    `/api/meal-planning/plans/${planId ?? fixture.planId}/days/${dayKey}`;

const logPath = ({ planId, mealId }: PathOverrides = {}): string =>
    `/api/meal-planning/plans/${planId ?? fixture.planId}/meals/${mealId ?? fixture.lunchMealId}/log`;

/** The commit body for one candidate at one portion. */
const swapBody = (
    recipeVersionId: string,
    portionMultiplier: number,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
    recipeVersionId,
    portionMultiplier,
    expectedPlanRevision: PLAN_REVISION_BEFORE,
    idempotencyKey: SWAP_KEY,
    ...overrides,
});

const getAlternatives = (overrides: PathOverrides = {}, uid: string = USER_ID) =>
    asUser(request.get(alternativesPath(overrides)), { uid });

const getPreview = (recipeVersionId: string, overrides: PathOverrides = {}, uid: string = USER_ID) =>
    asUser(request.get(previewPath(recipeVersionId, overrides)), { uid });

const postSwap = (body: Record<string, unknown>, overrides: PathOverrides = {}, uid: string = USER_ID) =>
    asUser(request.post(swapPath(overrides)), { uid }).send(body);

const readAlternatives = async (uid: string = USER_ID): Promise<SwapAlternativesResponse> => {
    const response = await getAlternatives({}, uid).expect(200);

    return response.body as SwapAlternativesResponse;
};

const readPreview = async (recipeVersionId: string): Promise<SwapPreviewResponse> => {
    const response = await getPreview(recipeVersionId).expect(200);

    return response.body as SwapPreviewResponse;
};

/** A committed swap, with any refusal turned into a failure the reader can see. */
const commitSwapOrThrow = async (
    body: Record<string, unknown>,
    overrides: PathOverrides = {},
): Promise<SwapMealResponse> => {
    const response = await postSwap(body, overrides);

    if (response.status !== 200) {
        throw new Error(
            `the swap was refused with ${String(response.status)}: ${JSON.stringify(response.body)}`,
        );
    }

    return response.body as SwapMealResponse;
};

const readGroceryList = async (planId?: string, uid: string = USER_ID): Promise<GroceryListResponse> => {
    const response = await asUser(request.get(groceriesPath(planId)), { uid }).expect(200);

    return response.body as GroceryListResponse;
};

const readPlanDay = async (
    dayKey: string = PLANNED_DAY_KEY,
    uid: string = USER_ID,
): Promise<MealPlanDayEnvelopeResponse> => {
    const response = await asUser(request.get(dayPath(dayKey)), { uid }).expect(200);

    return response.body as MealPlanDayEnvelopeResponse;
};

/** The lunch slot as the day envelope reports it — the DTO a client reads. */
const readPlannedLunch = async (): Promise<MealPlanMealResponse> => {
    const envelope = await readPlanDay();
    const lunch = envelope.day.meals.find((meal) => meal.id === fixture.lunchMealId);

    if (lunch === undefined) {
        throw new Error('The planned day envelope no longer carries the lunch this suite swaps.');
    }

    return lunch;
};

/**
 * A diary bucket id for one day, through the route the client itself uses.
 *
 * `GET /api/macros/:date` self-heals the four buckets for any date, which is
 * exactly why §0.5.2 has the log body carry a `diaryMealId` the client obtained
 * rather than a bucket NAME the server would have to interpret.
 */
const diaryBucketId = async (dayKey: string, bucketName: string): Promise<string> => {
    const response = await asUser(request.get(`/api/macros/${dayKey}`), { uid: USER_ID }).expect(200);
    const bucket = (response.body as { meals: { id: string; name: string }[] }).meals.find(
        (meal) => meal.name === bucketName,
    );

    if (bucket === undefined) {
        throw new Error(`The diary for ${dayKey} has no ${bucketName} bucket to log into.`);
    }

    return bucket.id;
};

/** Logs the planned lunch as eaten, and returns the created diary entry's id. */
const logPlannedLunch = async (params: {
    idempotencyKey: string;
    expectedPlanRevision: number;
    servings?: number;
}): Promise<string> => {
    const response = await asUser(request.post(logPath()), { uid: USER_ID })
        .send({
            servings: params.servings ?? 1,
            date: PLANNED_DAY_KEY,
            diaryMealId: await diaryBucketId(PLANNED_DAY_KEY, 'Lunch'),
            expectedPlanRevision: params.expectedPlanRevision,
            idempotencyKey: params.idempotencyKey,
        })
        .expect(201);

    return (response.body as { entry: { id: string } }).entry.id;
};

/* ---------------------------------------------------------------------------
 * Stored-state readers — the other half of every assertion
 * ------------------------------------------------------------------------- */

const storedLunch = () => prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: fixture.lunchMealId } });

const storedMeal = (mealId: string) => prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: mealId } });

const storedDay = () => prisma.meal_plan_days.findUniqueOrThrow({ where: { id: fixture.plannedDayId } });

const storedPlan = (planId?: string) =>
    prisma.meal_plans.findUniqueOrThrow({ where: { id: planId ?? fixture.planId } });

const storedDays = (planId?: string) =>
    prisma.meal_plan_days.findMany({
        where: { meal_plan_id: planId ?? fixture.planId },
        orderBy: { day_index: 'asc' },
    });

const storedGroceryRows = (planId?: string, userId: string = USER_ID) =>
    prisma.grocery_items.findMany({
        where: { meal_plan_id: planId ?? fixture.planId, user_id: userId },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    });

type StoredGroceryRow = Prisma.grocery_itemsGetPayload<Record<string, never>>;

const groceryRowFor = async (food: catalog_foods): Promise<StoredGroceryRow | undefined> =>
    (await storedGroceryRows()).find((row) => row.catalog_food_id === food.id);

const requireGroceryRowFor = async (food: catalog_foods): Promise<StoredGroceryRow> => {
    const row = await groceryRowFor(food);

    if (row === undefined) {
        throw new Error(`The grocery list holds no line for ${food.display_name}.`);
    }

    return row;
};

/** A `NUMERIC(10,2)` column as a number, so amounts compare as amounts. */
const grams = (value: Prisma.Decimal | null): number | null => (value === null ? null : value.toNumber());

const ledgerRowsFor = (idempotencyKey: string, userId: string = USER_ID) =>
    prisma.meal_plan_actions.findMany({ where: { user_id: userId, idempotency_key: idempotencyKey } });

const storedEntries = (userId: string = USER_ID) =>
    prisma.meal_entries.findMany({
        where: { meals: { user_id: userId } },
        orderBy: [{ logged_at: 'asc' }, { id: 'asc' }],
    });

/** Checks one line through the real toggle, so its acknowledged baseline is real. */
const checkGroceryLine = async (food: catalog_foods): Promise<GroceryItem> => {
    const row = await requireGroceryRowFor(food);
    const response = await asUser(request.put(`${groceriesPath()}/${row.id}`), { uid: USER_ID })
        .send({ isChecked: true })
        .expect(200);

    return (response.body as { item: GroceryItem }).item;
};

/** The item as the list DTO carries it, checked section included. */
const listedItemFor = (list: GroceryListResponse, food: catalog_foods): GroceryItem | undefined =>
    [...list.sections.flatMap((section) => section.items), ...list.checkedItems].find(
        (item) => item.catalogFoodId === food.id,
    );

const requireListedItemFor = (list: GroceryListResponse, food: catalog_foods): GroceryItem => {
    const item = listedItemFor(list, food);

    if (item === undefined) {
        throw new Error(`The grocery response holds no item for ${food.display_name}.`);
    }

    return item;
};

/* ---------------------------------------------------------------------------
 * Response hygiene — asserted on every refusal, not just once
 * ------------------------------------------------------------------------- */

/**
 * A refusal body is EXACTLY its machine code plus the payload §0.5.2 declares
 * for that code — nothing else.
 *
 * Deep equality rather than a substring search, because equality is what
 * actually forecloses the leak Rule §4 names (`{ error: err }`): a stack, a
 * Prisma message, a driver code or an error class name cannot be present in a
 * body that equals `{error, …payload}` and no more. The serialised scan
 * afterwards is the belt to that braces — it catches a leak smuggled INSIDE one
 * of the declared members, where equality would accept it.
 */
const expectRefusal = (
    response: { status: number; body: unknown },
    status: number,
    error: string,
    payload: Record<string, unknown> = {},
): void => {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error, ...payload });

    const serialised = JSON.stringify(response.body);

    for (const leak of ['stack', 'prisma', 'Invalid `', 'at Object.', 'PrismaClient']) {
        expect(serialised).not.toContain(leak);
    }
};

/** An instant bracket, for the two columns a commit stamps with its own clock. */
const bracketed = (value: Date | null, from: Date, to: Date): void => {
    expect(value).not.toBeNull();
    expect((value as Date).getTime()).toBeGreaterThanOrEqual(from.getTime());
    expect((value as Date).getTime()).toBeLessThanOrEqual(to.getTime());
};

beforeEach(async () => {
    await truncateFeatureTables();
    jest.mocked(isMealPlanningEnabled).mockReturnValue(true);
    jest.mocked(mealPlanningFault).mockReturnValue('off');
    fixture = await seedFixture();
});

afterEach(() => {
    // Restored rather than left standing: the suite runs in band beside
    // `fault.test.ts`, which resolves the real switches from the environment,
    // and a stub left in place would be a mock leaking out of the file that set
    // it.
    jest.mocked(isMealPlanningEnabled).mockReturnValue(true);
    jest.mocked(mealPlanningFault).mockReturnValue('off');
});

afterAll(async () => {
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * Extra recipes the alternatives cases add to the world
 * ------------------------------------------------------------------------- */

interface CandidateOptions {
    /** Replaces the first ingredient's food — how the dislike case is reached. */
    catalogFoodId?: string;
    /** Frozen on the first ingredient, which is where eligibility reads them. */
    allergenTags?: string[];
    dietTags?: string[];
    prepMinutes?: number;
    cookMinutes?: number;
    recipeId?: string;
    version?: number;
    status?: string;
    /** The slots the version declares. The factory's default is all three mains. */
    meal_slots?: string[];
}

/**
 * A candidate that is eligible and admissible in the seeded world: two 200 g
 * ingredients at {@link BASE_PER_100G}, so its per-serving figure is 700 kcal
 * and ×1 lands the day exactly on target.
 *
 * Every ineligibility case below starts from this recipe and changes exactly
 * ONE thing — an ingredient's frozen allergen or diet tags, its food, or the
 * cooking time — so a case that fails is failing about the constraint it names
 * and not about a recipe that was never admissible.
 *
 * The tags go on the INGREDIENT, because that is where
 * `recipe.logic.ts::evaluatePlanningEligibility` reads them: the recipe-level
 * columns are the seed-validated summary of the ingredient set, never an
 * independent claim, and the factory derives them from these snapshots.
 */
const makeCandidateRecipe = async (slug: string, options: CandidateOptions = {}): Promise<FixtureRecipeVersion> => {
    const { catalogFoodId, allergenTags, dietTags, prepMinutes, cookMinutes, ...versionOverrides } = options;
    const ingredient = (food: catalog_foods | { id: string }) => ({
        catalogFoodId: food.id,
        per100g: BASE_PER_100G,
        gram_weight: INGREDIENT_GRAM_WEIGHT,
        quantity: INGREDIENT_GRAM_WEIGHT,
        unit: 'g',
        display_text: `${INGREDIENT_GRAM_WEIGHT} g`,
    });

    return makeRecipeVersion({
        slug,
        name: slug,
        catalogFoodId: catalogFoodId ?? fixture.unchangedFood.id,
        prep_minutes: prepMinutes ?? 10,
        cook_minutes: cookMinutes ?? 15,
        ...versionOverrides,
        ingredients: [
            {
                ...ingredient({ id: catalogFoodId ?? fixture.unchangedFood.id }),
                ...(allergenTags === undefined ? {} : { snapshot_allergen_tags: allergenTags }),
                ...(dietTags === undefined ? {} : { snapshot_diet_tags: dietTags }),
            },
            ingredient(fixture.sharedFood),
        ],
    });
};

/**
 * A recipe every `422 recipe_ineligible` case names: plannable in every respect
 * — `current`, source-backed, allergen-known, inside the cooking-time limit —
 * but declaring `breakfast` ALONE, so the lunch slot never offers it.
 *
 * SLOT MEMBERSHIP is deliberately the disqualifying property. §0.7.3's
 * repetition rule is two clauses, and "some other meal of today holds this
 * dish" is not one of them, so the day's own breakfast and dinner recipes are
 * legitimate lunch alternatives and cannot stand in for an ineligible one. Slot
 * membership is `recipe.logic.ts::evaluatePlanningEligibility`'s rule, which the
 * generator and the swap share, so what is refused here is refused identically
 * by both.
 *
 * Built per case rather than seeded into {@link SuiteFixture}, so the `beforeEach`
 * that every one of this file's cases pays for stays the size it was.
 */
const makeLunchIneligibleRecipe = (): Promise<FixtureRecipeVersion> =>
    makeCandidateRecipe('swap-suite-breakfast-only', { meal_slots: ['breakfast'] });

const savePreference = (data: Prisma.meal_plan_preferencesUncheckedUpdateInput) =>
    prisma.meal_plan_preferences.update({ where: { user_id: USER_ID }, data });

const alternativeIdsOf = (response: SwapAlternativesResponse): string[] =>
    response.alternatives.map((alternative) => alternative.recipeVersionId);

/* ---------------------------------------------------------------------------
 * GET …/meals/:mealId/alternatives
 * ------------------------------------------------------------------------- */

describe('GET the swap alternatives', () => {
    describe('when the slot has nothing to offer', () => {
        it('answers 200 with an empty array rather than an error', async () => {
            // Every version this world offers for the lunch slot leaves the
            // PLANNABLE SET — `getRecipeVersionsForPlanning` admits `current`
            // rows only — except the one the slot already holds. The two
            // candidates and the day's other two meals are retired, so the
            // lunch's own version is the last eligible recipe standing and it
            // is refused because a meal is not an alternative to itself.
            //
            // Retirement rather than the rest of the day: §0.7.3 permits two
            // uses of a recipe on one day in two different slots, so the
            // breakfast's and the dinner's recipes ARE offered for this slot
            // while they stay current (the generator would plant them here).
            await prisma.recipe_versions.updateMany({
                where: {
                    id: {
                        in: [
                            fixture.equalPortionCandidate.id,
                            fixture.halfPortionCandidate.id,
                            fixture.breakfastRecipe.id,
                            fixture.dinnerRecipe.id,
                        ],
                    },
                },
                data: { status: 'retired' },
            });

            const response = await getAlternatives().expect(200);
            const body = response.body as SwapAlternativesResponse;

            // An empty array is the DECODED signal for the "no alternatives"
            // screen (§0.2.5), which the client distinguishes from a failure to
            // load them — so the response must be a success carrying no error
            // member of any kind.
            expect(body.alternatives).toEqual([]);
            expect(Object.keys(body).sort()).toEqual(['alternatives', 'current']);
            expect(body.current.id).toBe(fixture.lunchMealId);
        });
    });

    describe('the bound on how many it offers', () => {
        it(`returns exactly ${String(SWAP_ALTERNATIVE_LIMIT)} of the admissible candidates, the best by slug`, async () => {
            const slugs = Array.from({ length: OVER_LIMIT_CANDIDATE_COUNT }, (_, index) =>
                `swap-suite-limit-${String(index + 1).padStart(2, '0')}`,
            );

            for (const slug of slugs) {
                await makeCandidateRecipe(slug);
            }

            const listed = await readAlternatives();

            // Truncation happens AFTER the ranking, so these are the eight best
            // and not the first eight the catalog yielded. Twelve rows tie for
            // best here: the ten extras plus the day's OWN breakfast and dinner
            // recipes, which are admissible for this slot because §0.7.3's
            // repetition rule is two clauses and "another meal of today holds
            // it" is not one of them — the generator would plant either of them
            // in this slot, so the sheet offers them. All twelve land the day
            // exactly on its calorie target and are closer than either seeded
            // candidate on every macro, so they rank ahead of both and tie with
            // each other, which leaves the portable `(slug, version)` key to
            // order them: `swap-suite-breakfast` and `swap-suite-dinner` before
            // every `swap-suite-limit-NN`.
            const bestBySlug = [
                fixture.breakfastRecipe.name,
                fixture.dinnerRecipe.name,
                ...slugs.slice(0, SWAP_ALTERNATIVE_LIMIT - 2),
            ];

            expect(listed.alternatives).toHaveLength(SWAP_ALTERNATIVE_LIMIT);
            expect(listed.alternatives.map((alternative) => alternative.name)).toEqual(bestBySlug);
            // The rows the truncation dropped, stated so the case fails if the
            // cut were made before the sort instead of after it: the tail of the
            // tie and both seeded candidates, which are further from the target.
            expect(alternativeIdsOf(listed)).not.toContain(fixture.equalPortionCandidate.id);
            expect(alternativeIdsOf(listed)).not.toContain(fixture.halfPortionCandidate.id);
        });
    });

    describe('the eligibility it never relaxes', () => {
        it('withholds a recipe carrying an allergen the user selected', async () => {
            await savePreference({ allergens: ['milk'] });
            const offending = await makeCandidateRecipe('swap-suite-allergen', { allergenTags: ['milk'] });

            const listed = await readAlternatives();

            expect(alternativeIdsOf(listed)).not.toContain(offending.id);
            // The rest of the sheet is unaffected, so the exclusion is about the
            // allergen and not about an empty plannable set.
            expect(alternativeIdsOf(listed)).toContain(fixture.equalPortionCandidate.id);
        });

        it("withholds a recipe that does not meet the user's diet", async () => {
            await savePreference({ diet: 'vegan' });
            const offending = await makeCandidateRecipe('swap-suite-diet', { dietTags: [] });

            const listed = await readAlternatives();

            expect(alternativeIdsOf(listed)).not.toContain(offending.id);
            expect(alternativeIdsOf(listed)).toContain(fixture.equalPortionCandidate.id);
        });

        it('withholds a recipe built on a disliked food', async () => {
            const dislikedFood = await makeShoppableFood('Disliked Turnips');

            await savePreference({ disliked_food_ids: [dislikedFood.id] });
            const offending = await makeCandidateRecipe('swap-suite-dislike', {
                catalogFoodId: dislikedFood.id,
            });

            const listed = await readAlternatives();

            expect(alternativeIdsOf(listed)).not.toContain(offending.id);
            expect(alternativeIdsOf(listed)).toContain(fixture.equalPortionCandidate.id);
        });

        it('withholds a recipe that takes longer than the cooking-time limit', async () => {
            // 40 minutes of prep plus cook against a 30-minute limit. The limit
            // is applied to `total_minutes`, which the factory derives, so the
            // fixture cannot claim a time its own columns contradict.
            const offending = await makeCandidateRecipe('swap-suite-slow', {
                prepMinutes: 20,
                cookMinutes: 20,
            });

            expect(offending.total_minutes).toBe(40);

            const listed = await readAlternatives();

            expect(alternativeIdsOf(listed)).not.toContain(offending.id);
            expect(alternativeIdsOf(listed)).toContain(fixture.equalPortionCandidate.id);
        });

        it('withholds a recipe no allowed portion of which keeps the day inside tolerance', async () => {
            // 3,000 kcal a serving: even the smallest allowed multiplier puts
            // the day at 2,900 against a 2,100 target, well outside the ±10 %
            // band. Such a recipe is EXCLUDED rather than offered at an
            // out-of-tolerance portion, which is what stops the sheet proposing
            // a day the commit would then have to refuse.
            const oversized = await makeRecipeVersion({
                slug: 'swap-suite-oversized',
                name: 'swap-suite-oversized',
                perServing: { calories: 3000, protein: 40, carbs: 40, fat: 40 },
            });

            const listed = await readAlternatives();

            expect(alternativeIdsOf(listed)).not.toContain(oversized.id);
            expect(alternativeIdsOf(listed)).toContain(fixture.equalPortionCandidate.id);
        });
    });

    describe("the week's repetition rule, with the meal being replaced removed", () => {
        it('offers a candidate whose recipe is planned once elsewhere in the week', async () => {
            await plantMeals(fixture.dayIds[FIRST_DAY_INDEX], [
                {
                    slot: 'dinner',
                    slotTime: '18:30',
                    recipeVersionId: fixture.equalPortionCandidate.id,
                },
            ]);

            expect(alternativeIdsOf(await readAlternatives())).toContain(fixture.equalPortionCandidate.id);
        });

        it('withholds a candidate whose recipe is already planned twice elsewhere', async () => {
            for (const dayIndex of [FIRST_DAY_INDEX, LAST_DAY_INDEX]) {
                await plantMeals(fixture.dayIds[dayIndex], [
                    {
                        slot: 'dinner',
                        slotTime: '18:30',
                        recipeVersionId: fixture.equalPortionCandidate.id,
                    },
                ]);
            }

            const listed = await readAlternatives();

            // Both plants are a clear day away from the slot being swapped, so
            // the only clause that can refuse this recipe is "at most twice a
            // week" — and the other candidate proves the sheet still works.
            expect(alternativeIdsOf(listed)).not.toContain(fixture.equalPortionCandidate.id);
            expect(alternativeIdsOf(listed)).toContain(fixture.halfPortionCandidate.id);
        });

        it('does not count the meal being replaced against its own recipe', async () => {
            // A republished dish: the slot holds the RETIRED version while the
            // catalog offers a new current one of the same recipe, which is the
            // state a catalog refresh leaves behind. Its recipe is then used
            // twice in the week — once by this very meal, once a clear day away
            // — and two uses is what the rule refuses. It is nonetheless
            // offered, which can only be true if the meal was removed from the
            // count before anything was counted.
            const retiredLunch = await makeTwoIngredientRecipe(
                'swap-suite-republished',
                'Republished Lunch Bowl',
                [fixture.removedFood, fixture.decreasingFood],
                BASE_PER_100G,
                { status: 'retired' },
            );
            const republished = await makeTwoIngredientRecipe(
                'swap-suite-republished-current',
                'Republished Lunch Bowl v2',
                [fixture.removedFood, fixture.decreasingFood],
                BASE_PER_100G,
                { recipeId: retiredLunch.recipe_id, version: 2 },
            );

            // The retired version's ingredients are the outgoing lunch's own, so
            // the seeded grocery list stays exactly correct for the week.
            await prisma.meal_plan_meals.update({
                where: { id: fixture.lunchMealId },
                data: { recipe_version_id: retiredLunch.id },
            });
            await plantMeals(fixture.dayIds[FIRST_DAY_INDEX], [
                { slot: 'dinner', slotTime: '18:30', recipeVersionId: republished.id },
            ]);

            const listed = await readAlternatives();

            expect(alternativeIdsOf(listed)).toContain(republished.id);
            // And the version actually in the slot is never offered as an
            // alternative to itself, whatever its recipe's use count.
            expect(alternativeIdsOf(listed)).not.toContain(retiredLunch.id);
        });
    });

    describe('the rows it answers with', () => {
        it('carries the full planned-meal DTO as `current`', async () => {
            const listed = await readAlternatives();

            // One of only two places this DTO is served, so every derived member
            // is pinned here (Rule §11's mapper clause).
            expect(listed.current).toEqual({
                id: fixture.lunchMealId,
                revision: MEAL_REVISION_BEFORE,
                slot: LUNCH_SLOT,
                slotTime: '12:30',
                sortOrder: 1,
                recipe: {
                    versionId: fixture.lunchRecipe.id,
                    recipeId: fixture.lunchRecipe.recipe_id,
                    name: 'Lunch Bowl',
                    iconKey: 'bowl',
                    totalMinutes: 25,
                    badges: ['high_protein'],
                    nutritionProvenance: 'source_backed',
                },
                portionMultiplier: 1,
                // The recipe's OWN serving unit, not an anonymous "serving".
                portionText: '1 bowl',
                planned: PLANNED_MEAL_NUTRITION,
                flags: [],
                loggedEntries: [],
                previousRecipe: null,
            });
        });

        it("reports the meal's logged entry and previous recipe on `current` once it has them", async () => {
            await logPlannedLunch({ idempotencyKey: FIRST_LOG_KEY, expectedPlanRevision: PLAN_REVISION_BEFORE });
            // A log is a keyed write against the plan, so it advances
            // `meal_plans.revision` too — the swap that follows has to pin the
            // number the log left behind, not the one the plan was published
            // with.
            await commitSwapOrThrow(
                swapBody(fixture.equalPortionCandidate.id, 1, { expectedPlanRevision: PLAN_REVISION_AFTER }),
            );

            const listed = await readAlternatives();

            // The entry survives the swap and still names the recipe it was
            // eaten as, while `previousRecipe` names the version the slot held —
            // the audit value, which is a different fact from what was eaten.
            expect(listed.current.loggedEntries).toHaveLength(1);
            expect(listed.current.loggedEntries[0]).toMatchObject({
                recipeVersionId: fixture.lunchRecipe.id,
                recipeName: 'Lunch Bowl',
                mealName: 'Lunch',
                date: PLANNED_DAY_KEY,
                servings: 1,
            });
            expect(listed.current.previousRecipe).toEqual({
                versionId: fixture.lunchRecipe.id,
                name: 'Lunch Bowl',
            });
            expect(listed.current.recipe.versionId).toBe(fixture.equalPortionCandidate.id);
        });

        it('offers each candidate at the portion the server selected for it', async () => {
            const listed = await readAlternatives();

            // The half-sized candidate is admissible ONLY at ×1.75, so a row
            // carrying ×1 for it would mean the list never ran the portion
            // selection at all.
            //
            // The day's own breakfast and dinner recipes lead the list, at ×1
            // each: §0.7.3's repetition rule is two clauses, and a dish another
            // slot of today holds breaks neither, so both are admissible here
            // and both land the day exactly on target — which is why they rank
            // ahead of the two seeded candidates.
            expect(
                listed.alternatives.map((alternative) => [
                    alternative.recipeVersionId,
                    alternative.portionMultiplier,
                ]),
            ).toEqual([
                [fixture.breakfastRecipe.id, 1],
                [fixture.dinnerRecipe.id, 1],
                [fixture.halfPortionCandidate.id, HALF_CANDIDATE_PORTION],
                [fixture.equalPortionCandidate.id, 1],
            ]);
            // The whole DTO for one row, located by id rather than by position:
            // this is one of only two places the alternatives shape is served,
            // so every member of it is pinned here.
            expect(
                listed.alternatives.find(
                    (alternative) => alternative.recipeVersionId === fixture.halfPortionCandidate.id,
                ),
            ).toEqual({
                recipeVersionId: fixture.halfPortionCandidate.id,
                name: 'Candidate At Three Quarters Over',
                iconKey: 'bowl',
                calories: HALF_CANDIDATE_NUTRITION.calories,
                protein: Math.round(HALF_CANDIDATE_NUTRITION.protein),
                totalMinutes: 25,
                portionMultiplier: HALF_CANDIDATE_PORTION,
            });
        });

        it('answers two identical requests with the identical sequence', async () => {
            // The ranking is PRNG-free precisely so the sheet cannot reshuffle
            // under the user's thumb between two reads of one plan. A membership
            // check would let non-determinism through, so the whole array is
            // compared.
            expect((await readAlternatives()).alternatives).toEqual((await readAlternatives()).alternatives);
        });

        it('names icons and provenance with machine codes from the closed sets', async () => {
            const listed = await readAlternatives();

            for (const alternative of listed.alternatives) {
                expect(RECIPE_ICON_KEYS).toContain(alternative.iconKey);
            }

            expect(RECIPE_ICON_KEYS).toContain(listed.current.recipe.iconKey);
            expect(listed.current.recipe.nutritionProvenance).toBe('source_backed');
        });
    });
});

/* ---------------------------------------------------------------------------
 * GET …/alternatives/:recipeVersionId/preview
 * ------------------------------------------------------------------------- */

/**
 * The day with one meal substituted, derived here rather than read off the
 * response: `(day as planned − the outgoing lunch) + the candidate`.
 *
 * Written out so the expectation comes from the SEEDED figures. Comparing the
 * response against a total taken from the response would assert nothing, and a
 * stated constant would only move the copying one line further away.
 */
const dayTotalsWithLunchReplacedBy = (candidate: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
}) => ({
    calories: DAY_TOTALS_BEFORE.calories - PLANNED_MEAL_NUTRITION.calories + candidate.calories,
    protein: DAY_TOTALS_BEFORE.protein - PLANNED_MEAL_NUTRITION.protein + candidate.protein,
    carbs: DAY_TOTALS_BEFORE.carbs - PLANNED_MEAL_NUTRITION.carbs + candidate.carbs,
    fat: DAY_TOTALS_BEFORE.fat - PLANNED_MEAL_NUTRITION.fat + candidate.fat,
});

const rounded = (totals: { calories: number; protein: number; carbs: number; fat: number }) => ({
    calories: Math.round(totals.calories),
    protein: Math.round(totals.protein),
    carbs: Math.round(totals.carbs),
    fat: Math.round(totals.fat),
});

describe('GET one swap preview', () => {
    describe('what it refuses', () => {
        it('answers 422 recipe_ineligible for a recipe this slot never offered, and writes nothing', async () => {
            // A good row in every respect except the one that matters here: it
            // does not declare `lunch`, so this slot never offered it. The
            // precondition is asserted rather than assumed, because a recipe
            // the sheet DID offer would answer `200` and the case would pass
            // for the wrong reason.
            const ineligible = await makeLunchIneligibleRecipe();
            const listed = await readAlternatives();

            expect(alternativeIdsOf(listed)).not.toContain(ineligible.id);

            const mealBefore = await storedLunch();
            const response = await getPreview(ineligible.id);

            expectRefusal(response, 422, 'recipe_ineligible');
            expect(await storedLunch()).toEqual(mealBefore);
            expect((await storedPlan()).revision).toBe(PLAN_REVISION_BEFORE);
            expect(await prisma.meal_plan_actions.count()).toBe(0);
        });

        it("answers a foreign plan exactly as it answers one that does not exist", async () => {
            const foreign = await getPreview(fixture.equalPortionCandidate.id, {
                planId: fixture.otherUserPlanId,
                mealId: fixture.otherUserMealId,
            });
            const absent = await getPreview(fixture.equalPortionCandidate.id, {
                planId: '99999999-9999-4999-8999-999999999999',
                mealId: '88888888-8888-4888-8888-888888888888',
            });

            // Byte-identical bodies, so nothing in the answer tells a caller
            // whether the plan they named exists (§8, Rule §1.5). Never 403.
            expect(foreign.status).toBe(404);
            expect(absent.status).toBe(404);
            expect(foreign.body).toEqual(absent.body);
            expectRefusal(foreign, 404, 'Plan not found');
        });

        it("answers a foreign MEAL under the caller's own plan as not found", async () => {
            const response = await getPreview(fixture.equalPortionCandidate.id, {
                mealId: fixture.otherUserMealId,
            });

            expectRefusal(response, 404, 'Plan not found');
        });

        it('answers 400 invalid_request naming the path parameter that was malformed', async () => {
            const response = await getPreview('not-a-uuid');

            expect(response.status).toBe(400);
            expect(response.body).toEqual({
                error: 'invalid_request',
                details: [{ field: 'recipeVersionId', code: 'invalid_id' }],
            });
        });
    });

    describe('what it answers', () => {
        it('is reached through the nested path rather than captured by the alternatives route', async () => {
            // `/alternatives/:recipeVersionId/preview` sits UNDER
            // `/alternatives`, so declaration order decides which handler a
            // request lands in (Rule §3.1). Two facts establish the nested one
            // ran: the body is a preview envelope rather than an alternatives
            // list, and a malformed `recipeVersionId` is named in the refusal —
            // a field the alternatives parser does not know exists.
            const preview = await readPreview(fixture.equalPortionCandidate.id);

            expect(Object.keys(preview).sort()).toEqual([
                'alternative',
                'calorieDelta',
                'dayTotalsIfSwapped',
                'planRevision',
                'targets',
            ]);

            const malformed = await getPreview('not-a-uuid');

            expect((malformed.body as { details: { field: string }[] }).details[0].field).toBe(
                'recipeVersionId',
            );
        });

        it('describes the candidate, the day it would produce, and the binding revision', async () => {
            const preview = await readPreview(fixture.equalPortionCandidate.id);

            expect(preview.alternative.recipe.versionId).toBe(fixture.equalPortionCandidate.id);
            expect(preview.alternative.recipe.status).toBe('current');
            expect(preview.alternative.recipe.perServing).toEqual(EQUAL_CANDIDATE_NUTRITION);
            // Whole-recipe amounts, for `yieldServings` servings — the preview
            // carries the multiplier the client scales them by rather than a
            // second, pre-scaled collection.
            expect(preview.alternative.recipe.yieldServings).toBe(2);
            expect(preview.alternative.recipe.ingredients.map((row) => row.gramWeight)).toEqual([
                INGREDIENT_GRAM_WEIGHT,
                INGREDIENT_GRAM_WEIGHT,
            ]);

            expect(preview.alternative.portionMultiplier).toBe(1);
            expect(preview.alternative.portionText).toBe('1 bowl');
            expect(preview.alternative.nutrition).toEqual(EQUAL_CANDIDATE_NUTRITION);

            expect(preview.dayTotalsIfSwapped).toEqual(
                rounded(dayTotalsWithLunchReplacedBy(EQUAL_CANDIDATE_NUTRITION)),
            );
            // The user's own confirmed targets, which is what makes the card's
            // "of 2,100 kcal" the same number Account and the diary show.
            expect(preview.targets).toEqual({
                calories: FIXTURE_TARGETS.calories,
                protein: FIXTURE_TARGETS.protein,
                carbs: FIXTURE_TARGETS.carbs,
                fat: FIXTURE_TARGETS.fat,
            });
            // The revision the preview was computed against, and the value the
            // client sends back as `expectedPlanRevision` — so the binding
            // starts here.
            expect(preview.planRevision).toBe((await storedPlan()).revision);
        });

        it('signs the calorie delta positive when the swap raises the day', async () => {
            const preview = await readPreview(fixture.equalPortionCandidate.id);
            const expected = dayTotalsWithLunchReplacedBy(EQUAL_CANDIDATE_NUTRITION);

            expect(preview.calorieDelta).toBe(
                Math.round(expected.calories - DAY_TOTALS_BEFORE.calories),
            );
            expect(preview.calorieDelta).toBeGreaterThan(0);
        });

        it('signs the calorie delta negative when the swap lowers the day', async () => {
            const preview = await readPreview(fixture.halfPortionCandidate.id);
            const expected = dayTotalsWithLunchReplacedBy(HALF_CANDIDATE_NUTRITION);

            expect(preview.calorieDelta).toBe(
                Math.round(expected.calories - DAY_TOTALS_BEFORE.calories),
            );
            expect(preview.calorieDelta).toBeLessThan(0);
            expect(preview.dayTotalsIfSwapped).toEqual(rounded(expected));
            expect(preview.alternative.nutrition).toEqual(rounded(HALF_CANDIDATE_NUTRITION));
        });

        it('previews the same portion the alternatives row reported', async () => {
            const listed = await readAlternatives();

            for (const alternative of listed.alternatives) {
                const preview = await readPreview(alternative.recipeVersionId);

                // The first half of the three-way agreement: the list and the
                // preview run the SAME selection, so a row's portion and its
                // preview's portion cannot differ.
                expect(preview.alternative.portionMultiplier).toBe(alternative.portionMultiplier);
                expect(preview.alternative.recipe.versionId).toBe(alternative.recipeVersionId);
            }
        });
    });
});

/* ---------------------------------------------------------------------------
 * POST …/meals/:mealId/swap — what one commit writes
 * ------------------------------------------------------------------------- */

/** Every meal of the plan except the one being swapped, in a stable order. */
const otherStoredMeals = () =>
    prisma.meal_plan_meals.findMany({
        where: { meal_plan_id: fixture.planId, id: { not: fixture.lunchMealId } },
        orderBy: [{ meal_plan_day_id: 'asc' }, { sort_order: 'asc' }],
    });

/** Every day of the plan except the planned one, whose totals a swap rewrites. */
const otherStoredDays = () =>
    prisma.meal_plan_days.findMany({
        where: { meal_plan_id: fixture.planId, id: { not: fixture.plannedDayId } },
        orderBy: { day_index: 'asc' },
    });

/** Manual targets through the route a user would move them with. */
const saveManualTargets = async (calories: number): Promise<void> => {
    await asUser(request.put('/api/meal-planning/targets'), { uid: USER_ID })
        .send({
            source: 'manual',
            calories,
            protein: FIXTURE_TARGETS.protein,
            carbs: FIXTURE_TARGETS.carbs,
            fat: FIXTURE_TARGETS.fat,
            expectedTargetsRevision: 1,
        })
        .expect(200);
};

describe('POST one committed swap', () => {
    it('answers 200 with the meal, its day, the new revision and the grocery summary', async () => {
        const response = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1));

        expect(response.status).toBe(200);

        const body = response.body as SwapMealResponse;

        expect(Object.keys(body).sort()).toEqual(['day', 'groceryChangeSummary', 'meal', 'planRevision']);
        expect(body.meal.id).toBe(fixture.lunchMealId);
        expect(body.meal.recipe.versionId).toBe(fixture.equalPortionCandidate.id);
        expect(body.meal.revision).toBe(MEAL_REVISION_AFTER);
        expect(body.meal.planned).toEqual(EQUAL_CANDIDATE_NUTRITION);
        expect(body.meal.previousRecipe).toEqual({
            versionId: fixture.lunchRecipe.id,
            name: 'Lunch Bowl',
        });
        // The whole day, because a swap moves the day's planned totals.
        expect(body.day.id).toBe(fixture.plannedDayId);
        expect(body.day.date).toBe(PLANNED_DAY_KEY);
        expect(body.day.plannedTotals).toEqual(rounded(dayTotalsWithLunchReplacedBy(EQUAL_CANDIDATE_NUTRITION)));
        expect(body.planRevision).toBe(PLAN_REVISION_AFTER);
    });

    it('writes the meal, clears its flags, and records the version it replaced', async () => {
        // A flag is seeded first, because "a swap to a compatible recipe clears
        // that meal's flags" (§0.7.3) is only observable on a meal that had one:
        // a flag left standing would keep the affected-meals banner reporting a
        // meal the selection has just established as compatible.
        await prisma.meal_plan_meals.update({
            where: { id: fixture.lunchMealId },
            data: { flags: [{ code: 'allergen', detail: ['milk'] }] },
        });

        const before = new Date();
        const body = await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));
        const after = new Date();

        const lunch = await storedLunch();

        expect(lunch.recipe_version_id).toBe(fixture.equalPortionCandidate.id);
        expect(lunch.portion_multiplier).toBe(1);
        // Stored at FULL precision, while the DTO beside it is display-rounded.
        expect(lunch.planned_calories).toBe(EQUAL_CANDIDATE_NUTRITION.calories);
        expect(lunch.planned_protein_g).toBe(EQUAL_CANDIDATE_NUTRITION.protein);
        expect(lunch.planned_carbs_g).toBe(EQUAL_CANDIDATE_NUTRITION.carbs);
        expect(lunch.planned_fat_g).toBe(EQUAL_CANDIDATE_NUTRITION.fat);
        expect(lunch.revision).toBe(MEAL_REVISION_AFTER);
        expect(lunch.previous_recipe_version_id).toBe(fixture.lunchRecipe.id);
        bracketed(lunch.swapped_at, before, after);
        expect(lunch.flags).toEqual([]);
        expect(body.meal.flags).toEqual([]);
    });

    it("rewrites the day's stored totals and bumps the plan's revision", async () => {
        await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        const day = await storedDay();

        // The hand-computed constant rather than the helper the DTO cases use,
        // so the stored numbers are pinned independently of the test's own
        // arithmetic: 700 + 760 + 700 at full precision.
        expect(day.planned_calories).toBe(DAY_TOTALS_AFTER_EQUAL.calories);
        expect(day.planned_protein_g).toBe(DAY_TOTALS_AFTER_EQUAL.protein);
        expect(day.planned_carbs_g).toBe(DAY_TOTALS_AFTER_EQUAL.carbs);
        expect(day.planned_fat_g).toBe(DAY_TOTALS_AFTER_EQUAL.fat);
        // A fixture cross-check, not a claim about the server: the constant and
        // the helper the DTO cases compare against must describe the same day,
        // or a typo in either would make two expectations disagree silently.
        expect(DAY_TOTALS_AFTER_EQUAL).toEqual(dayTotalsWithLunchReplacedBy(EQUAL_CANDIDATE_NUTRITION));
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER);
    });

    it('leaves every other meal and every other day exactly as they stood', async () => {
        const mealsBefore = await otherStoredMeals();
        const daysBefore = await otherStoredDays();

        await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        // Swapping one meal touches one meal: the breakfast and the dinner of
        // this day, and every row of the six unplanned days, are unchanged down
        // to their revisions and timestamps.
        expect(await otherStoredMeals()).toEqual(mealsBefore);
        expect(await otherStoredDays()).toEqual(daysBefore);
    });

    it('leaves a linked diary entry and its snapshot untouched', async () => {
        await logPlannedLunch({ idempotencyKey: FIRST_LOG_KEY, expectedPlanRevision: PLAN_REVISION_BEFORE });

        const entriesBefore = await storedEntries();

        expect(entriesBefore).toHaveLength(1);

        await commitSwapOrThrow(
            swapBody(fixture.equalPortionCandidate.id, 1, { expectedPlanRevision: PLAN_REVISION_AFTER }),
        );

        // The numbers the user ate are never rewritten by a later swap: the row,
        // its plan link, its recipe link and its per-serving snapshot all stand.
        expect(await storedEntries()).toEqual(entriesBefore);
        expect(entriesBefore[0].meal_plan_meal_id).toBe(fixture.lunchMealId);
        expect(entriesBefore[0].recipe_version_id).toBe(fixture.lunchRecipe.id);
    });
});

/* ---------------------------------------------------------------------------
 * POST …/meals/:mealId/swap — the plan-level flag aggregate it refreshes
 *
 * `meal_plan_meals.flags` is the source of truth and the swap has always
 * cleared it (the case above). `meal_plans.incompatibility_flags` is the
 * plan-level AUDIT RECORD §0.5.1 and §0.5.2 name alongside it, and the failure
 * these cases exist to catch is the two disagreeing: a swap that clears the
 * meal's flag while leaving the aggregate naming that same meal, which is
 * exactly what the aggregate read back as before this suite grew this section.
 * Nothing user-visible reads the column today — `hasIncompatibilities` and
 * `/affected-meals` both derive from the meals — so the assertions below are
 * against STORAGE, which is the only place the divergence is observable.
 * ------------------------------------------------------------------------- */

/** The zone `makePreferences` stores, restated on each save so it cannot move. */
const FIXTURE_TIME_ZONE = 'America/New_York';

/**
 * The column as stored, read as `unknown`.
 *
 * `unknown` rather than a decoded type because one of the values this column
 * legitimately holds is the bare `[]` a plan is PUBLISHED with — the "never
 * recomputed" value, which is neither the record's shape nor a claim about
 * flags. Asserting through a type would presume a shape the storage does not
 * guarantee, and the transition off that value is one of the cases below.
 */
const storedIncompatibilityFlags = async (planId?: string): Promise<unknown> =>
    (await storedPlan(planId)).incompatibility_flags;

/** The instant an audit record states it was derived at, as a `Date` to bracket. */
const recomputedAtOf = (aggregate: unknown): Date =>
    new Date((aggregate as { recomputedAt: string }).recomputedAt);

/**
 * Declares `milk` on one recipe version — on `allergen_tags`, which is what
 * eligibility reads, AND on the ingredient snapshot that union is derived from,
 * so the fixture states one thing twice rather than contradicting itself.
 *
 * AN ALLERGEN RATHER THAN A DISLIKE, and not a stylistic choice: every fixture
 * food shares the `fixture_food` food group, and §0.7.3 has a dislike exclude
 * the whole group a disliked food belongs to. Disliking one food would
 * therefore make every candidate ineligible as well, leaving no swap to
 * observe. An allergen is carried per recipe, so this flags exactly the meals
 * planning this recipe and leaves the candidates — whose `allergen_tags` are
 * empty — on offer.
 */
const declareMilkOn = async (version: FixtureRecipeVersion): Promise<void> => {
    await prisma.recipe_versions.update({
        where: { id: version.id },
        data: { allergen_tags: ['milk'] },
    });
    await prisma.recipe_ingredients.updateMany({
        where: { recipe_version_id: version.id, sort_order: 0 },
        data: { snapshot_allergen_tags: ['milk'] },
    });
};

/**
 * Saves a milk allergy through the route a plan-settings edit takes, and
 * returns how many meals it flagged.
 *
 * THE REAL PREFERENCE-SAVE PATH, never a hand-written column. That path is the
 * other writer of this aggregate, so the record a swap has to refresh must be
 * the one it actually produces — a fixture that wrote the column itself could
 * agree with the swap's writer while both disagreed with the save's.
 */
const declareMilkAllergy = async (): Promise<number> => {
    const response = await asUser(request.put('/api/meal-planning/preferences'), { uid: USER_ID }).send({
        allergens: ['milk'],
        timeZone: FIXTURE_TIME_ZONE,
        expectedRevision: 1,
    });

    if (response.status !== 200) {
        throw new Error(
            `declaring the allergy was refused with ${String(response.status)}: ` +
                JSON.stringify(response.body),
        );
    }

    return (response.body as PreferencesSaveResponse).affectedMealCount;
};

describe('the plan-level flag aggregate a swap refreshes', () => {
    /** Where a preference save that moved flags leaves the plan's revision. */
    const PLAN_REVISION_AFTER_FLAGGING = PLAN_REVISION_BEFORE + 1;
    /** And where the swap of a flagged meal leaves it: one bump, not two. */
    const PLAN_REVISION_AFTER_FLAGGED_SWAP = PLAN_REVISION_AFTER_FLAGGING + 1;

    /** The one flag a milk allergy puts on a meal planning a milk-bearing recipe. */
    const MILK_FLAG = [{ code: 'allergen', detail: ['milk'] }];

    /** The swap of the flagged lunch, against the revision the save left behind. */
    const swapTheFlaggedLunch = () =>
        commitSwapOrThrow(
            swapBody(fixture.equalPortionCandidate.id, 1, {
                expectedPlanRevision: PLAN_REVISION_AFTER_FLAGGING,
            }),
        );

    it('clears the aggregate when the swap clears the last flagged meal', async () => {
        await declareMilkOn(fixture.lunchRecipe);

        expect(await declareMilkAllergy()).toBe(1);

        // The starting point: the SAVE's own record, naming the one meal it
        // flagged. Asserted rather than assumed, because every claim below is
        // about what the swap does to this exact value.
        expect(await storedIncompatibilityFlags()).toEqual({
            flaggedMealIds: [fixture.lunchMealId],
            codes: ['allergen'],
            recomputedAt: expect.any(String),
        });
        expect((await storedLunch()).flags).toEqual(MILK_FLAG);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER_FLAGGING);

        const before = new Date();
        const body = await swapTheFlaggedLunch();
        const after = new Date();

        // The meal row is the source of truth, and it now carries no flag...
        expect(body.meal.flags).toEqual([]);
        expect((await storedLunch()).flags).toEqual([]);

        // ...and the aggregate now says the same thing, instead of going on
        // naming the meal this commit has just made compatible.
        const aggregate = await storedIncompatibilityFlags();

        expect(aggregate).toEqual({
            flaggedMealIds: [],
            codes: [],
            recomputedAt: expect.any(String),
        });

        // RE-DERIVED BY THIS COMMIT rather than left at the save's instant. A
        // record that kept the older timestamp would be the same defect with an
        // empty payload rather than a full one — the column would be claiming a
        // currency it does not have — so the instant is bracketed to the request
        // and not merely asserted to be a string.
        bracketed(recomputedAtOf(aggregate), before, after);

        // ONE revision bump for the swap, on top of the save's. The aggregate
        // rides the statement that increments it rather than adding a second
        // write, so a swap still costs a client exactly one stale-plan boundary.
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER_FLAGGED_SWAP);
    });

    it('keeps naming the flagged meals the swap did not touch', async () => {
        await declareMilkOn(fixture.lunchRecipe);
        await declareMilkOn(fixture.dinnerRecipe);

        expect(await declareMilkAllergy()).toBe(2);

        await swapTheFlaggedLunch();

        // RECOMPUTED FROM THE ROWS, never blanked: the dinner is still flagged,
        // so the aggregate still names it and still carries its code. This is
        // the case that separates a real recomputation from a swap that simply
        // empties the column whenever it writes.
        expect(await storedIncompatibilityFlags()).toEqual({
            flaggedMealIds: [fixture.dinnerMealId],
            codes: ['allergen'],
            recomputedAt: expect.any(String),
        });
        expect((await storedMeal(fixture.dinnerMealId)).flags).toEqual(MILK_FLAG);
        expect((await storedLunch()).flags).toEqual([]);
    });

    it('records the aggregate even on a plan nothing ever flagged', async () => {
        // A plan is published with the bare `[]` this column defaults to. The
        // commit writes the record unconditionally, so there is no "nothing
        // changed" branch in which the aggregate could be left behind — and the
        // record it leaves is the honest one for a plan with no flagged meal.
        expect(await storedIncompatibilityFlags()).toEqual([]);

        await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        expect(await storedIncompatibilityFlags()).toEqual({
            flaggedMealIds: [],
            codes: [],
            recomputedAt: expect.any(String),
        });
    });

    it('leaves the aggregate exactly as it stood when the commit is refused', async () => {
        await declareMilkOn(fixture.lunchRecipe);
        await declareMilkAllergy();

        const recordBefore = await storedIncompatibilityFlags();

        // A stale revision, which the gates refuse before anything is written.
        // The aggregate must still describe the flag that is still standing: a
        // refusal that cleared it would be the mirror image of the defect.
        const response = await postSwap(
            swapBody(fixture.equalPortionCandidate.id, 1, {
                expectedPlanRevision: PLAN_REVISION_BEFORE,
            }),
        );

        expect(response.status).toBe(409);
        expect(await storedIncompatibilityFlags()).toEqual(recordBefore);
        expect((await storedLunch()).flags).toEqual(MILK_FLAG);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER_FLAGGING);
    });
});

/* ---------------------------------------------------------------------------
 * The gates a commit passes before it writes
 * ------------------------------------------------------------------------- */

describe('the gates a swap commit passes', () => {
    /**
     * A syntactically valid meal id that no plan holds — the parser accepts it,
     * so the refusal it draws is the one the gates below decide and not a `400`.
     */
    const ABSENT_MEAL_ID = '33333333-3333-4333-8333-333333333333';

    /** Nothing about the plan moved: the assertion every refusal below repeats. */
    const expectNothingWritten = async (mealBefore: { revision: number }): Promise<void> => {
        expect(await storedLunch()).toEqual(mealBefore);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_BEFORE);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
    };

    it('refuses a portion that is not the one the server recomputes', async () => {
        const mealBefore = await storedLunch();
        const rowsBefore = await storedGroceryRows();

        // A legal multiplier, and not this candidate's: committing it would swap
        // in an amount of food the user never approved.
        const response = await postSwap(swapBody(fixture.halfPortionCandidate.id, 1));

        expectRefusal(response, 409, 'preview_stale');
        await expectNothingWritten(mealBefore);
        expect(await storedGroceryRows()).toEqual(rowsBefore);
    });

    it('refuses the previewed portion once a target move has changed which portion fits', async () => {
        const preview = await readPreview(fixture.halfPortionCandidate.id);

        expect(preview.alternative.portionMultiplier).toBe(HALF_CANDIDATE_PORTION);

        // Moving the day's calorie target onto 2,160 makes ×2 the multiplier
        // that minimises the gap, so the portion the user was shown is no
        // longer the one the server would choose.
        await saveManualTargets(2160);

        const mealBefore = await storedLunch();
        const response = await postSwap(
            swapBody(fixture.halfPortionCandidate.id, preview.alternative.portionMultiplier),
        );

        expectRefusal(response, 409, 'preview_stale');
        await expectNothingWritten(mealBefore);
    });

    it('accepts the previewed portion when a target move leaves it unchanged', async () => {
        const preview = await readPreview(fixture.equalPortionCandidate.id);

        // THE PREVIEW BINDS THE PORTION, NOT THE TARGETS. This target move is
        // real — the targets the swap scores against are different numbers —
        // but ×1 still minimises the gap, so there is nothing stale about the
        // portion the user approved and the commit proceeds.
        await saveManualTargets(2150);

        const body = await commitSwapOrThrow(
            swapBody(fixture.equalPortionCandidate.id, preview.alternative.portionMultiplier),
        );

        expect(body.meal.portionMultiplier).toBe(preview.alternative.portionMultiplier);
        expect((await storedLunch()).recipe_version_id).toBe(fixture.equalPortionCandidate.id);
    });

    it('refuses a stale plan revision and reports the current one', async () => {
        const mealBefore = await storedLunch();
        const response = await postSwap(
            swapBody(fixture.equalPortionCandidate.id, 1, { expectedPlanRevision: 99 }),
        );

        expectRefusal(response, 409, 'stale_plan', { currentRevision: PLAN_REVISION_BEFORE });
        await expectNothingWritten(mealBefore);
    });

    it('refuses a superseded plan and names the plan that replaced it', async () => {
        await prisma.meal_plans.update({ where: { id: fixture.planId }, data: { status: 'superseded' } });
        const successor = await makePlan(USER_ID, {
            startDate: addDaysToDayKey(PLAN_START_DAY_KEY, PLAN_DAY_COUNT),
            dayCount: PLAN_DAY_COUNT,
            slots: [],
            replaced_plan_id: fixture.planId,
        });
        const mealBefore = await storedLunch();

        const response = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1));

        // Same code, a different payload: a stale screen is sent to the week
        // that replaced this one.
        expectRefusal(response, 409, 'plan_not_active', { replacementPlanId: successor.id });
        expect(await storedLunch()).toEqual(mealBefore);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
    });

    it('still answers a superseded plan 409, even when the meal id it names is in no plan at all', async () => {
        // THE ORDER OF THE FOUR CHECKS IS THE ANSWER, and this is the case that
        // pins it. Both refusals are true of this request — the plan has been
        // replaced AND the meal id names nothing — so whichever check runs
        // first decides what the client is told. §0.5.1 judges the plan's status
        // before the meal, because "your week has moved, here is the new one" is
        // the actionable half; answering `404` would send a stale screen looking
        // for a meal instead of for the current week. It is the check ORDER that
        // guarantees it, not the order the facts happen to be read in.
        await prisma.meal_plans.update({ where: { id: fixture.planId }, data: { status: 'superseded' } });

        const successor = await makePlan(USER_ID, {
            startDate: addDaysToDayKey(PLAN_START_DAY_KEY, PLAN_DAY_COUNT),
            dayCount: PLAN_DAY_COUNT,
            slots: [],
            replaced_plan_id: fixture.planId,
        });
        const mealBefore = await storedLunch();

        const response = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1), {
            mealId: ABSENT_MEAL_ID,
        });

        expectRefusal(response, 409, 'plan_not_active', { replacementPlanId: successor.id });
        expect(await storedLunch()).toEqual(mealBefore);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
    });

    it("answers a writable plan's unknown meal id 404, which is the other half of that order", async () => {
        // The same request against a plan that IS writable: with no status
        // refusal to report, the missing meal is what the client hears — so the
        // `409` above is the order at work rather than `plan_not_active`
        // swallowing every refusal on the route.
        const mealBefore = await storedLunch();
        const response = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1), {
            mealId: ABSENT_MEAL_ID,
        });

        expectRefusal(response, 404, 'Plan not found');
        await expectNothingWritten(mealBefore);
    });

    it('refuses a plan whose last day has passed, as ended', async () => {
        // A week that has genuinely gone by, rather than the current one judged
        // at a later instant: the controller passes no clock, so an ended plan
        // is reached by seeding one.
        const endedPlan = await makePlan(USER_ID, {
            startDate: FIXTURE_ENDED_PLAN_START_DAY_KEY,
            dayCount: PLAN_DAY_COUNT,
            slots: [],
        });
        const [endedLunchId] = await plantMeals(endedPlan.meal_plan_days[PLANNED_DAY_INDEX].id, [
            { slot: LUNCH_SLOT, slotTime: '12:30', recipeVersionId: fixture.lunchRecipe.id },
        ]);
        const mealBefore = await storedMeal(endedLunchId);

        const response = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1), {
            planId: endedPlan.id,
            mealId: endedLunchId,
        });

        // Stored `active`, because §0.5.1 keeps the column as it is and makes
        // endedness a rule every write path applies.
        expect(endedPlan.status).toBe('active');
        expectRefusal(response, 409, 'plan_not_active', { reason: 'ended' });
        expect(await storedMeal(endedLunchId)).toEqual(mealBefore);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
    });

    it('refuses a candidate this slot never offered', async () => {
        // A recipe that declares `breakfast` alone: the commit resolves its
        // candidate through the same `selectSwapCandidates` the sheet does, so
        // a version the sheet could not list is not committable either.
        const ineligible = await makeLunchIneligibleRecipe();
        const mealBefore = await storedLunch();
        const response = await postSwap(swapBody(ineligible.id, 1));

        expectRefusal(response, 422, 'recipe_ineligible');
        await expectNothingWritten(mealBefore);
    });

    it('refuses a body carrying a key the endpoint does not accept', async () => {
        const mealBefore = await storedLunch();
        // The caller's identity comes from the verified token and from nothing
        // else (Rule §4), so a `userId` in the body is not quietly ignored — it
        // is reported, because silently dropping a key lets a client believe a
        // value it sent was honoured.
        const response = await postSwap(
            swapBody(fixture.equalPortionCandidate.id, 1, { userId: OTHER_USER_ID }),
        );

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: 'invalid_request',
            details: [{ field: 'userId', code: 'unknown_field' }],
        });
        await expectNothingWritten(mealBefore);
        // And the named user's own plan is untouched by the attempt.
        expect((await storedPlan(fixture.otherUserPlanId)).revision).toBe(PLAN_REVISION_BEFORE);
    });

    describe('when the injected swap fault is armed', () => {
        it('answers 502 swap_failed and persists nothing at all', async () => {
            jest.mocked(mealPlanningFault).mockReturnValue('swap');

            const mealBefore = await storedLunch();
            const dayBefore = await storedDay();
            const rowsBefore = await storedGroceryRows();

            const response = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1));

            // This is the ONLY answer for which frame 13e's copy — "your lunch
            // is unchanged and your grocery list was not updated" — is
            // literally true, so the whole of it is asserted: the fault fires
            // before the transaction opens, so there is no lock, no
            // reservation, no meal write and no grocery diff to roll back.
            expectRefusal(response, 502, 'swap_failed');
            expect(await storedLunch()).toEqual(mealBefore);
            expect(await storedDay()).toEqual(dayBefore);
            expect((await storedPlan()).revision).toBe(PLAN_REVISION_BEFORE);
            expect(await storedGroceryRows()).toEqual(rowsBefore);
            expect(await prisma.meal_plan_actions.count()).toBe(0);
        });

        it('commits exactly once when the same key is retried with the fault gone', async () => {
            jest.mocked(mealPlanningFault).mockReturnValue('swap');
            await postSwap(swapBody(fixture.equalPortionCandidate.id, 1)).expect(502);

            jest.mocked(mealPlanningFault).mockReturnValue('off');
            const body = await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

            // The key was never reserved, so the retry is a first attempt rather
            // than a replay — and it commits once.
            expect(body.planRevision).toBe(PLAN_REVISION_AFTER);
            expect((await storedLunch()).recipe_version_id).toBe(fixture.equalPortionCandidate.id);

            const ledger = await ledgerRowsFor(SWAP_KEY);

            expect(ledger).toHaveLength(1);
            expect(ledger[0].response_status).toBe(200);
        });
    });
});

/* ---------------------------------------------------------------------------
 * What a commit resolves while it holds the lock
 *
 * A commit resolves its whole context ONCE, because every round trip inside its
 * transaction is time any other writer of this user's plan spends queued behind
 * the same per-user advisory lock. There are three resolutions and the cases
 * below count them:
 *
 *  * ONE plan read, carrying the lifecycle, the revision and the targets
 *    snapshot together.
 *  * ONE `preferences.service.ts::loadPreferencesRow`, for the zone that decides
 *    what "today" is (so an ended week is refused) AND the five eligibility
 *    columns candidate selection is judged by.
 *  * ONE `targets.service.ts::getTargets`, the canonical target read the plan
 *    card and Account read through as well.
 *
 * THE THIRD OF THOSE DOES TOUCH `meal_plan_preferences` AGAIN, and these cases
 * say so rather than pretending otherwise: `getTargets` is a single
 * `users ⋈ meal_plan_preferences` join, and that join must stay one statement
 * because the verdict it reaches compares the two rows — split in two, the
 * untouched legacy `PUT /api/user/targets`, which holds no meal-planning lock,
 * could commit between the halves and the pair would report `estimated` on
 * numbers that had already moved. What is pinned here is therefore the number of
 * RESOLUTIONS, which is the thing a future refactor can regress: one
 * `loadPreferencesRow` and one `getTargets` per commit, never a second of
 * either.
 * ------------------------------------------------------------------------- */

describe('what a swap commit resolves while it holds the lock', () => {
    /**
     * COUNTING SPIES, NOT STUBS: no `mockImplementation`, so both real reads run
     * and the commit each case drives is the same commit every other case in
     * this file drives.
     */
    const countContextReads = () => ({
        preferenceReads: jest.spyOn(preferencesService, 'loadPreferencesRow'),
        targetReads: jest.spyOn(targetsService, 'getTargets'),
    });

    it('resolves the preferences row and the current targets exactly once each', async () => {
        const { preferenceReads, targetReads } = countContextReads();

        try {
            const body = await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

            expect(body.planRevision).toBe(PLAN_REVISION_AFTER);

            // The callers are projected to their user ids before the
            // assertion: each recorded call also carries the transaction
            // client, and a failure that tried to print those would be a
            // serialisation of the whole Prisma client rather than a readable
            // diff.
            //
            // Two preference calls would mean "today" and the restrictions had
            // each fetched the row for themselves. Two target calls would mean
            // the commit context resolved them and something downstream —
            // `loadSwapSelection`, as it once did — resolved them again, a
            // second `users ⋈ meal_plan_preferences` join inside the lock.
            expect(preferenceReads.mock.calls.map(([userId]) => userId)).toEqual([USER_ID]);
            expect(targetReads.mock.calls.map(([userId]) => userId)).toEqual([USER_ID]);
        } finally {
            // Restored in a `finally` for the reason `afterEach` restores the
            // two flag stubs: this suite runs in band beside files that call the
            // real implementations.
            preferenceReads.mockRestore();
            targetReads.mockRestore();
        }
    });

    it('answers that one commit with the swapped meal, the rebuilt day and the bumped revision', async () => {
        // The behaviour half of the case above, driven with the same spies
        // installed: resolving the context once must not have changed what a
        // commit ANSWERS or what it writes. The targets the selection was scored
        // against are the ones the day is reported against, so the day's totals
        // are the proof that the single resolution reached the selection intact.
        const { preferenceReads, targetReads } = countContextReads();

        try {
            const body = await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

            expect(body.meal.id).toBe(fixture.lunchMealId);
            expect(body.meal.recipe.versionId).toBe(fixture.equalPortionCandidate.id);
            expect(body.meal.planned).toEqual(EQUAL_CANDIDATE_NUTRITION);
            expect(body.day.id).toBe(fixture.plannedDayId);
            expect(body.day.plannedTotals).toEqual(rounded(dayTotalsWithLunchReplacedBy(EQUAL_CANDIDATE_NUTRITION)));
            expect(body.planRevision).toBe(PLAN_REVISION_AFTER);

            // And the rows behind that answer, because a response agreeing with
            // nothing on disk is the failure this suite exists to catch.
            expect((await storedLunch()).recipe_version_id).toBe(fixture.equalPortionCandidate.id);
            expect((await storedDay()).planned_calories).toBe(DAY_TOTALS_AFTER_EQUAL.calories);
            expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER);

            expect(preferenceReads).toHaveBeenCalledTimes(1);
            expect(targetReads).toHaveBeenCalledTimes(1);
        } finally {
            preferenceReads.mockRestore();
            targetReads.mockRestore();
        }
    });
});

/* ---------------------------------------------------------------------------
 * A rebuild that fails AFTER the meal has been written
 *
 * The other half of `swap_failed`, and the harder half: the fault above fires
 * before the transaction opens, while this one fires inside it, with the meal
 * row already updated and the plan's revision already bumped. Only the
 * transaction's rollback makes 13e's "your lunch is unchanged and your grocery
 * list was not updated" true here, so it is asserted on every row the commit
 * had touched by then.
 * ------------------------------------------------------------------------- */

describe('a swap whose grocery rebuild fails after the meal has been written', () => {
    /**
     * Breaks the rebuild the way only real data can: a stored row whose
     * `display_unit` no longer resolves to a unit family.
     *
     * The unit-family lock re-renders every surviving line through the family
     * the row was created in and refuses to guess when it cannot read one, so
     * this is the production fault — a row the aggregation must re-render and
     * cannot — rather than a stubbed throw.
     */
    const breakTheRebuild = async (): Promise<void> => {
        const row = await requireGroceryRowFor(fixture.unchangedFood);

        await prisma.grocery_items.update({ where: { id: row.id }, data: { display_unit: 'bottle' } });
    };

    it('answers 502 swap_failed and rolls the whole transaction back', async () => {
        await breakTheRebuild();

        const mealBefore = await storedLunch();
        const dayBefore = await storedDay();
        const rowsBefore = await storedGroceryRows();

        const response = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1));

        expectRefusal(response, 502, 'swap_failed');
        // The meal write and the revision bump happened inside the transaction
        // and are gone with it.
        expect(await storedLunch()).toEqual(mealBefore);
        expect((await storedLunch()).recipe_version_id).toBe(fixture.lunchRecipe.id);
        expect(await storedDay()).toEqual(dayBefore);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_BEFORE);
        expect(await storedGroceryRows()).toEqual(rowsBefore);
    });

    it('leaves no reservation behind, so the same key is still a first attempt', async () => {
        await breakTheRebuild();
        await postSwap(swapBody(fixture.equalPortionCandidate.id, 1)).expect(502);

        // The reservation shares the transaction, so a rolled-back commit
        // cannot strand a key that would later replay a swap that never
        // happened.
        expect(await prisma.meal_plan_actions.count()).toBe(0);

        // Repaired, the identical request goes through — and once, at the
        // revision it originally pinned.
        const row = await requireGroceryRowFor(fixture.unchangedFood);

        await prisma.grocery_items.update({ where: { id: row.id }, data: { display_unit: 'oz' } });

        const body = await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        expect(body.planRevision).toBe(PLAN_REVISION_AFTER);
        expect((await storedLunch()).recipe_version_id).toBe(fixture.equalPortionCandidate.id);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(1);
    });

    it('never answers a rendering fault as a 500', async () => {
        await breakTheRebuild();

        const response = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1));

        // The grocery domain's own error classes are outside the meal-planning
        // vocabulary, so an untranslated one would surface as an
        // unclassifiable 500 where §0.5.2 promises 502 as this endpoint's only
        // 5xx.
        expect(response.status).not.toBe(500);
        expect(response.status).toBe(502);
    });
});

/* ---------------------------------------------------------------------------
 * The idempotency ledger
 * ------------------------------------------------------------------------- */

describe('the idempotency ledger', () => {
    it('replays the stored 200 and body verbatim, writing nothing a second time', async () => {
        const first = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1));

        expect(first.status).toBe(200);

        const mealAfterFirst = await storedLunch();
        const dayAfterFirst = await storedDay();
        const rowsAfterFirst = await storedGroceryRows();

        const replay = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1));

        // 200, NOT 201: §0.5.1 fixes one replay policy per action and persists
        // the first response's status rather than inferring it, so the literal
        // code is what catches a status guessed from the action type.
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(first.body);

        expect(await storedLunch()).toEqual(mealAfterFirst);
        expect(await storedDay()).toEqual(dayAfterFirst);
        expect(await storedGroceryRows()).toEqual(rowsAfterFirst);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER);

        const ledger = await ledgerRowsFor(SWAP_KEY);

        expect(ledger).toHaveLength(1);
        expect(ledger[0].response_status).toBe(200);
        expect(ledger[0].plan_revision_after).toBe(PLAN_REVISION_AFTER);
    });

    it('replays even after the plan it pinned has moved on', async () => {
        const first = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1)).expect(200);

        // A second swap, of a different meal, advances the plan past the
        // revision the first request pinned.
        await postSwap(
            swapBody(fixture.halfPortionCandidate.id, HALF_CANDIDATE_PORTION, {
                expectedPlanRevision: PLAN_REVISION_AFTER,
                idempotencyKey: SECOND_SWAP_KEY,
            }),
            { mealId: fixture.dinnerMealId },
        ).expect(200);

        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER + 1);

        const replay = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1));

        // The replay is answered from the ledger BEFORE any revision or status
        // check, which is what lets a client whose response was lost recover
        // even though the plan has since changed under it.
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(first.body);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER + 1);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(1);
    });

    it('refuses the same key carrying a different request', async () => {
        await postSwap(swapBody(fixture.equalPortionCandidate.id, 1)).expect(200);

        const lunchAfterFirst = await storedLunch();
        const conflicting = await postSwap(
            swapBody(fixture.halfPortionCandidate.id, HALF_CANDIDATE_PORTION),
        );

        // A genuinely different write wearing a used key is never a retry, and
        // the fingerprint is compared before the revision is — so this is a
        // conflict rather than the `stale_plan` the pinned revision would also
        // have earned.
        expectRefusal(conflicting, 409, 'idempotency_conflict');
        expect(await storedLunch()).toEqual(lunchAfterFirst);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(1);
    });

    it('accepts a second, differently keyed swap of the same meal', async () => {
        await postSwap(swapBody(fixture.equalPortionCandidate.id, 1)).expect(200);

        const second = await postSwap(
            swapBody(fixture.halfPortionCandidate.id, HALF_CANDIDATE_PORTION, {
                expectedPlanRevision: PLAN_REVISION_AFTER,
                idempotencyKey: SECOND_SWAP_KEY,
            }),
        );

        expect(second.status).toBe(200);
        expect((await storedLunch()).recipe_version_id).toBe(fixture.halfPortionCandidate.id);
        expect((await storedLunch()).revision).toBe(MEAL_REVISION_AFTER + 1);
        // The audit column records the LAST version replaced, not a history.
        expect((await storedLunch()).previous_recipe_version_id).toBe(fixture.equalPortionCandidate.id);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER + 1);
    });
});

/* ---------------------------------------------------------------------------
 * The grocery consequences of one swap
 *
 * Every expectation below is computed from the seeded ingredient gram weights —
 * `gram_weight ÷ yield_servings × portion_multiplier` — rather than read out of
 * the response, so the aggregation is checked and not merely echoed. The five
 * foods were chosen so that ONE commit produces all five outcomes at once:
 * unchanged, increased, decreased, removed and added.
 * ------------------------------------------------------------------------- */

describe('the grocery consequences of a swap', () => {
    it('summarises the lines that arrived, went away and went up', async () => {
        const body = await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        // Added: the arriving food, on the incoming candidate alone. Removed:
        // the food on the outgoing lunch alone. Increased: the shared food,
        // 100 g on the breakfast plus 100 g newly on the lunch. The decrease is
        // deliberately absent from the summary — it is not one of its three
        // members, and the row itself is asserted below.
        expect(body.groceryChangeSummary).toEqual({ added: 1, removed: 1, increased: 1 });
    });

    it('re-aggregates every line to the grams the week now needs', async () => {
        await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        // Breakfast + dinner, untouched by the swap.
        expect(grams((await requireGroceryRowFor(fixture.unchangedFood)).quantity_grams)).toBe(
            GRAMS_PER_MEAL * 2,
        );
        // Breakfast + the incoming lunch.
        expect(grams((await requireGroceryRowFor(fixture.sharedFood)).quantity_grams)).toBe(
            GRAMS_PER_MEAL * 2,
        );
        // The dinner alone, now that the lunch no longer carries it.
        expect(grams((await requireGroceryRowFor(fixture.decreasingFood)).quantity_grams)).toBe(
            GRAMS_PER_MEAL,
        );
        // Nothing plans it any more, so the line is gone rather than zeroed.
        expect(await groceryRowFor(fixture.removedFood)).toBeUndefined();
        // The incoming lunch alone — and rendered in its own volume family,
        // which is what proves the rebuild re-derived the row rather than
        // copying a mass row's unit.
        const arriving = await requireGroceryRowFor(fixture.newFood);

        expect(grams(arriving.quantity_grams)).toBe(GRAMS_PER_MEAL);
        expect(arriving.display_text).toBe(ARRIVING_VOLUME_DISPLAY_TEXT);
        expect(arriving.is_checked).toBe(false);
        expect(arriving.flagged_at).toBeNull();
    });

    it('leaves a checked line whose amount did not move checked and unflagged', async () => {
        const checked = await checkGroceryLine(fixture.unchangedFood);

        await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        const row = await requireGroceryRowFor(fixture.unchangedFood);
        const listed = requireListedItemFor(await readGroceryList(), fixture.unchangedFood);

        // A rebuild is not a statement about what the shopper has bought.
        expect(row.is_checked).toBe(true);
        expect(row.flagged_at).toBeNull();
        expect(listed.isChecked).toBe(true);
        expect(listed.flag).toBeNull();
        expect(listed.displayText).toBe(checked.displayText);
    });

    it('keeps a checked line that went up checked, and flags it against what was acknowledged', async () => {
        const acknowledged = await checkGroceryLine(fixture.sharedFood);
        const acknowledgedGrams = grams((await requireGroceryRowFor(fixture.sharedFood)).quantity_grams);

        const before = new Date();
        const body = await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));
        const after = new Date();

        expect(body.groceryChangeSummary.increased).toBe(1);

        const row = await requireGroceryRowFor(fixture.sharedFood);

        // Nothing disappears from the list: the check stands and the row is
        // flagged instead, with the acknowledged amount — the quantity the user
        // was looking at when they checked it — recorded as the yardstick.
        expect(row.is_checked).toBe(true);
        expect(grams(row.quantity_grams)).toBe(GRAMS_PER_MEAL * 2);
        expect(grams(row.previous_quantity_grams)).toBe(acknowledgedGrams);
        bracketed(row.flagged_at, before, after);

        // Read back through the DTO, so storage and the wire shape agree.
        const list = await readGroceryList();
        const listed = requireListedItemFor(list, fixture.sharedFood);

        expect(list.checkedItems.map((item) => item.catalogFoodId)).toContain(fixture.sharedFood.id);
        expect(listed.isChecked).toBe(true);
        expect(listed.flag).not.toBeNull();
        // "was Y" is the ACKNOWLEDGED text, not merely the amount before this
        // change — which is the same thing here and, across repeated swaps, is
        // what stops it drifting to an intermediate amount.
        expect(listed.flag?.previousDisplayText).toBe(acknowledged.displayText);
        expect(listed.flag?.newDisplayText).toBe(listed.displayText);
        expect(listed.flag?.deltaDisplayText.startsWith('+')).toBe(true);
        expect(Date.parse(listed.flag?.flaggedAt ?? '')).toBe((row.flagged_at as Date).getTime());
    });

    it('leaves a checked line that went down checked, with nothing flagged', async () => {
        await checkGroceryLine(fixture.decreasingFood);

        await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        const row = await requireGroceryRowFor(fixture.decreasingFood);
        const listed = requireListedItemFor(await readGroceryList(), fixture.decreasingFood);

        // A decrease never re-opens the item and never warns about it: the text
        // follows the new amount and there is no flag for a pill to render.
        expect(row.is_checked).toBe(true);
        expect(grams(row.quantity_grams)).toBe(GRAMS_PER_MEAL);
        expect(row.flagged_at).toBeNull();
        expect(listed.isChecked).toBe(true);
        expect(listed.quantityGrams).toBe(GRAMS_PER_MEAL);
        expect(listed.flag).toBeNull();
    });

    it('counts a checked line that no meal plans any more as removed', async () => {
        await checkGroceryLine(fixture.removedFood);

        const body = await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        // Checked or not, a line nothing plans is deleted — and counted, so the
        // client can say the list changed.
        expect(body.groceryChangeSummary.removed).toBe(1);
        expect(await groceryRowFor(fixture.removedFood)).toBeUndefined();
        expect(listedItemFor(await readGroceryList(), fixture.removedFood)).toBeUndefined();
    });

    it('reports the swap on the banner, and the flag once one exists', async () => {
        const withoutFlags = await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        expect(withoutFlags.groceryChangeSummary.added).toBe(1);

        // Nothing was checked, so there is nothing to flag and the banner
        // reports the swap that changed the list, naming its slot.
        expect((await readGroceryList()).banner).toEqual({ code: 'updated_after_swap', mealSlot: LUNCH_SLOT });

        // A flag takes precedence, because an amount that went up on something
        // the shopper has already bought is the more urgent thing to say.
        await checkGroceryLine(fixture.sharedFood);
        await postSwap(
            swapBody(fixture.halfPortionCandidate.id, HALF_CANDIDATE_PORTION, {
                expectedPlanRevision: PLAN_REVISION_AFTER,
                idempotencyKey: SECOND_SWAP_KEY,
            }),
        ).expect(200);

        expect((await readGroceryList()).banner).toEqual({
            code: 'amount_increased',
            itemNames: [fixture.sharedFood.display_name],
        });
    });

    it('rebuilds the list without interleaving a check mark the user had already set', async () => {
        const beforeList = await readGroceryList();

        expect(beforeList.checkedCount).toBe(0);

        await checkGroceryLine(fixture.unchangedFood);
        await checkGroceryLine(fixture.decreasingFood);

        expect((await readGroceryList()).checkedCount).toBe(2);

        await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        const afterList = await readGroceryList();

        // The swap's rebuild and the toggles take the SAME per-user lock, so the
        // state afterwards is coherent rather than a mixture: both checks
        // survive, the arriving line is unchecked, and the counts agree with the
        // rows. (The raced ordering is `concurrency.test.ts`'s.)
        expect(afterList.checkedCount).toBe(2);
        expect(afterList.checkedItems).toHaveLength(2);
        expect(afterList.totalCount).toBe((await storedGroceryRows()).length);
        expect(afterList.sections.flatMap((section) => section.items)).toHaveLength(
            afterList.totalCount - afterList.checkedCount,
        );
        expect(requireListedItemFor(afterList, fixture.newFood).isChecked).toBe(false);
    });

    it("never touches another user's list when this user swaps", async () => {
        const foreignBefore = await storedGroceryRows(fixture.otherUserPlanId, OTHER_USER_ID);

        expect(foreignBefore.length).toBeGreaterThan(0);

        await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        expect(await storedGroceryRows(fixture.otherUserPlanId, OTHER_USER_ID)).toEqual(foreignBefore);
    });
});

/* ---------------------------------------------------------------------------
 * The one statement a grocery diff is applied through
 *
 * `rebuildPlanGroceries` runs inside the commit's interactive transaction while
 * its per-user advisory lock is held, so the number of statements it issues is
 * the number of round trips every other writer of this user's plan waits for. It
 * therefore applies the whole of a diff's `updates` in ONE
 * `UPDATE … FROM (VALUES …)` rather than one statement per changed row (AAP
 * §0.7.3's no-per-item-query requirement).
 *
 * Two cases, because one alone cannot show it. The first drives a real swap that
 * moves several lines at once and asserts the outcome — every changed row's
 * columns, every untouched row byte-identical, and the check marks and the flag
 * the set-based write must not disturb. The second asserts the property itself:
 * one statement for a diff of several updates, and none at all for a diff with
 * nothing to update.
 * ------------------------------------------------------------------------- */

/** 100 g in the mass family, which is where a gram-portion food's line lives. */
const ONE_MEAL_MASS_TEXT = '3.5 oz';
const ONE_MEAL_MASS_QUANTITY = 3.5;

/** 200 g in the same family — two meals of one food. */
const TWO_MEAL_MASS_TEXT = '7.1 oz';
const TWO_MEAL_MASS_QUANTITY = 7.1;

/** The aisle every food this suite shops for files under. */
const PRODUCE_CATEGORY = 'produce';

/**
 * The instant the direct-call case raises its flag at, injected through
 * `rebuildPlanGroceries`'s own `now` parameter.
 *
 * Fixed, and fixed with a non-zero millisecond field, because that is what makes
 * the `TIMESTAMP(3)` round trip provable: the set-based statement binds the
 * instant as an ISO-8601 wall time cast `::timestamp(3)`, and a cast that shifted
 * or truncated it would show up here as a `flagged_at` that is not this value to
 * the millisecond.
 */
const FLAG_INSTANT = new Date('2026-03-04T05:06:07.789Z');

/** How many lines the doubled week moves, which is the diff the one statement carries. */
const DOUBLED_WEEK_UPDATE_COUNT = 4;

/**
 * A transaction client that records the raw statements issued through it and
 * passes every call on to the real one.
 *
 * A recording PROXY rather than a fabricated stub, and the reason is the
 * invariant under test: `rebuildPlanGroceries` compares the affected-row count
 * with the number of rows its diff decided and raises a fault when they differ,
 * so a stub returning an invented count would either have to reimplement the
 * diff or defeat the very check that makes the single statement safe. Forwarding
 * to a real interactive transaction keeps that check honest and additionally
 * proves the statement is valid SQL that PostgreSQL applies to the rows it
 * names — while `recorded` still answers the question a stub was wanted for: how
 * many statements were issued, carrying which parameters.
 */
const recordingTransaction = (tx: Prisma.TransactionClient, recorded: Prisma.Sql[]): Prisma.TransactionClient =>
    new Proxy(tx, {
        get: (target, property, receiver): unknown => {
            if (property !== '$executeRaw') {
                return Reflect.get(target, property, receiver);
            }

            const executeRaw = Reflect.get(target, property, receiver) as (
                statement: Prisma.Sql,
                ...values: unknown[]
            ) => Promise<number>;

            return (statement: Prisma.Sql, ...values: unknown[]): Promise<number> => {
                recorded.push(statement);

                return executeRaw.call(target, statement, ...values);
            };
        },
    });

describe('the one statement a grocery diff is applied through', () => {
    /** The lines a week planning one extra day carries, which no swap of the lunch moves. */
    interface AnchoredWorld {
        /** On a day the swap never touches, and sorting before every other line. */
        anchorFoods: readonly [catalog_foods, catalog_foods];
        /** The arriving food, named so it sorts LAST and leaves the anchors' order alone. */
        lateFood: catalog_foods;
        /** Eligible and admissible at ×1, exactly as `equalPortionCandidate` is. */
        candidate: FixtureRecipeVersion;
    }

    /**
     * Adds a breakfast on a day the swapped lunch has nothing to do with, and a
     * candidate whose arriving food sorts after every existing line.
     *
     * BOTH HALVES EXIST TO MAKE "UNTOUCHED" REACHABLE. List order is aisle then
     * name, so a line that arrives or leaves renumbers every row after it —
     * which is a real update, and would leave a diff of this shape with no
     * untouched row to compare. Anchoring two lines at the top of the alphabet
     * on a day the swap does not replan, and naming the arriving food so it
     * sorts last, leaves those two rows genuinely untouched by the commit: same
     * grams, same text, same `sort_order`.
     */
    const anchorTheWeek = async (): Promise<AnchoredWorld> => {
        const anchorFoods: [catalog_foods, catalog_foods] = [
            await makeShoppableFood('Anchor Beets'),
            await makeShoppableFood('Anchor Greens'),
        ];
        const anchorRecipe = await makeTwoIngredientRecipe(
            'swap-suite-anchor',
            'Anchor Bowl',
            anchorFoods,
            BASE_PER_100G,
        );

        await plantMeals(fixture.dayIds[FIRST_DAY_INDEX], [
            { slot: 'breakfast', slotTime: '08:00', recipeVersionId: anchorRecipe.id },
        ]);

        const lateFood = await makeShoppableFood('Zesty Peppers');
        const candidate = await makeTwoIngredientRecipe(
            'swap-suite-candidate-multi-row',
            'Candidate Moving Several Lines',
            [fixture.sharedFood, lateFood],
            HEAVIER_PER_100G,
        );

        // The anchored day's own lines have to be on the list before the swap
        // diffs it, so the list is rebuilt from the week as it now stands.
        await writeInitialGroceryList(USER_ID, fixture.planId);

        return { anchorFoods, lateFood, candidate };
    };

    it('applies a diff that moves several lines at once, and leaves every other line alone', async () => {
        const { anchorFoods, lateFood, candidate } = await anchorTheWeek();

        // Three check marks, each proving something different survives a write
        // that never mentions `is_checked`: the row that goes UP (and is
        // flagged), the row only the renumbering touches, and a row the diff
        // reports unchanged.
        const acknowledged = await checkGroceryLine(fixture.sharedFood);

        await checkGroceryLine(fixture.unchangedFood);
        await checkGroceryLine(anchorFoods[0]);

        const anchoredBefore = (await storedGroceryRows()).filter((row) =>
            anchorFoods.some((food) => food.id === row.catalog_food_id),
        );

        expect(anchoredBefore).toHaveLength(anchorFoods.length);

        const before = new Date();
        const body = await commitSwapOrThrow(swapBody(candidate.id, 1));
        const after = new Date();

        // One line arrives (the late-sorting food), one leaves (nothing plans it
        // now), one went up — and three rows were written by the single
        // statement: the shared line, the decreased line, and the unchanged line
        // whose `sort_order` the removal moved.
        expect(body.groceryChangeSummary).toEqual({ added: 1, removed: 1, increased: 1 });

        const shared = await requireGroceryRowFor(fixture.sharedFood);
        const decreased = await requireGroceryRowFor(fixture.decreasingFood);
        const renumbered = await requireGroceryRowFor(fixture.unchangedFood);
        const arrived = await requireGroceryRowFor(lateFood);

        // Anchor Beets 0, Anchor Greens 1, Decreasing Lentils 2, Shared Beans 3,
        // Unchanged Greens 4, Zesty Peppers 5 — aisle then name, with Removed
        // Squash gone from the middle of it.
        expect(grams(shared.quantity_grams)).toBe(GRAMS_PER_MEAL * 2);
        expect(shared.display_quantity).toBe(TWO_MEAL_MASS_QUANTITY);
        expect(shared.display_unit).toBe('oz');
        expect(shared.display_text).toBe(TWO_MEAL_MASS_TEXT);
        expect(shared.name).toBe(fixture.sharedFood.display_name);
        expect(shared.category).toBe(PRODUCE_CATEGORY);
        expect(shared.sort_order).toBe(3);
        expect(shared.is_checked).toBe(true);
        expect(grams(shared.previous_quantity_grams)).toBe(GRAMS_PER_MEAL);
        bracketed(shared.flagged_at, before, after);

        expect(grams(decreased.quantity_grams)).toBe(GRAMS_PER_MEAL);
        expect(decreased.display_quantity).toBe(ONE_MEAL_MASS_QUANTITY);
        expect(decreased.display_text).toBe(ONE_MEAL_MASS_TEXT);
        expect(decreased.name).toBe(fixture.decreasingFood.display_name);
        expect(decreased.category).toBe(PRODUCE_CATEGORY);
        expect(decreased.sort_order).toBe(2);
        expect(decreased.is_checked).toBe(false);
        expect(decreased.previous_quantity_grams).toBeNull();
        expect(decreased.flagged_at).toBeNull();

        // Only the renumbering moved this one, so its amount and its text are
        // the ones it already had — and its check mark is still set.
        expect(grams(renumbered.quantity_grams)).toBe(GRAMS_PER_MEAL * 2);
        expect(renumbered.display_text).toBe(TWO_MEAL_MASS_TEXT);
        expect(renumbered.sort_order).toBe(4);
        expect(renumbered.is_checked).toBe(true);
        expect(renumbered.flagged_at).toBeNull();

        expect(grams(arrived.quantity_grams)).toBe(GRAMS_PER_MEAL);
        expect(arrived.sort_order).toBe(5);
        expect(arrived.is_checked).toBe(false);
        expect(await groceryRowFor(fixture.removedFood)).toBeUndefined();

        // Byte-identical, every column included: the two anchored lines are not
        // in the diff's updates, so no part of the one statement may reach them.
        const anchoredAfter = (await storedGroceryRows()).filter((row) =>
            anchorFoods.some((food) => food.id === row.catalog_food_id),
        );

        expect(anchoredAfter).toEqual(anchoredBefore);

        // And the flag the statement wrote reads back through the DTO intact:
        // "was" is the amount the shopper acknowledged, "now" is the row's own
        // text, the delta is positive, and the instant is the stored one to the
        // millisecond.
        const listed = requireListedItemFor(await readGroceryList(), fixture.sharedFood);

        expect(listed.flag?.previousDisplayText).toBe(acknowledged.displayText);
        expect(listed.flag?.previousDisplayText).toBe(ONE_MEAL_MASS_TEXT);
        expect(listed.flag?.newDisplayText).toBe(TWO_MEAL_MASS_TEXT);
        expect(listed.flag?.deltaDisplayText).toBe('+3.6 oz');
        expect(listed.flag?.flaggedAt).toBe((shared.flagged_at as Date).toISOString());
    });

    it('issues one statement for a diff of several rows, and none for a diff with nothing to update', async () => {
        // Checked first, so the doubling below has a flag to raise: the instant
        // it is raised at is the value the `::timestamp(3)` round trip is
        // measured by.
        await checkGroceryLine(fixture.sharedFood);

        const before = await storedGroceryRows();
        const recorded: Prisma.Sql[] = [];

        await prisma.$transaction(async (tx) => {
            // The same week twice over: every line's amount doubles, so every
            // stored row is an update and nothing is inserted or removed — a
            // multi-row diff with no other kind of write in it.
            const meals = await loadPlannedMealsForGroceries(tx, USER_ID, fixture.planId);
            const doubled = [...meals, ...meals];
            const recording = recordingTransaction(tx, recorded);
            const rebuild = {
                userId: USER_ID,
                planId: fixture.planId,
                meals: doubled,
                now: FLAG_INSTANT,
            };

            expect(await rebuildPlanGroceries(recording, rebuild)).toEqual({
                added: 0,
                removed: 0,
                increased: DOUBLED_WEEK_UPDATE_COUNT,
            });

            // ONE statement for four changed rows, carrying every one of their
            // ids as a bound parameter.
            expect(recorded).toHaveLength(1);
            expect(recorded[0].text).toContain('UPDATE grocery_items');
            expect(recorded[0].text).toContain('FROM (VALUES');

            for (const row of before) {
                expect(recorded[0].values).toContain(row.id);
            }

            // Run again against the same week and the diff has nothing to
            // update, so no statement is issued at all — `Prisma.join` is never
            // handed an empty list and the lock is held for no extra round trip.
            expect(await rebuildPlanGroceries(recording, rebuild)).toEqual({
                added: 0,
                removed: 0,
                increased: 0,
            });
            expect(recorded).toHaveLength(1);
        });

        const after = await storedGroceryRows();

        expect(after).toHaveLength(before.length);

        for (const [index, row] of after.entries()) {
            // The write really landed, on every row, through that one statement.
            expect(grams(row.quantity_grams)).toBe((grams(before[index].quantity_grams) as number) * 2);
            expect(row.is_checked).toBe(before[index].is_checked);
            expect(row.checked_at).toEqual(before[index].checked_at);
        }

        // The flagged row's instant is the injected one to the millisecond,
        // which is the `TIMESTAMP(3)` round trip the statement's cast promises.
        const flagged = await requireGroceryRowFor(fixture.sharedFood);

        expect((flagged.flagged_at as Date).toISOString()).toBe(FLAG_INSTANT.toISOString());
        expect(grams(flagged.previous_quantity_grams)).toBe(GRAMS_PER_MEAL);
    });
});

/* ---------------------------------------------------------------------------
 * A logged, then twice-swapped slot — the A → B → C chain
 *
 * The one case that separates "logged-then-swapped" derived from the ENTRIES
 * from the same state guessed at from `previous_recipe_version_id`: after two
 * swaps the audit column names only B, while the diary holds an A entry and a B
 * entry that must both be reported, each under its own recipe's name.
 * ------------------------------------------------------------------------- */

describe('a slot that was logged and then swapped twice', () => {
    /** A = the planned lunch, B = the equal-portion candidate, C = the half one. */
    interface ChainOutcome {
        firstEntryId: string;
        secondEntryId: string;
        lunch: MealPlanMealResponse;
    }

    const runChain = async (): Promise<ChainOutcome> => {
        // Every keyed write advances the plan's revision — the logs included —
        // so each step pins the revision the step before it produced.
        const firstEntryId = await logPlannedLunch({
            idempotencyKey: FIRST_LOG_KEY,
            expectedPlanRevision: PLAN_REVISION_BEFORE,
        });

        await postSwap(
            swapBody(fixture.equalPortionCandidate.id, 1, { expectedPlanRevision: 2 }),
        ).expect(200);

        const secondEntryId = await logPlannedLunch({
            idempotencyKey: SECOND_LOG_KEY,
            expectedPlanRevision: 3,
            servings: 0.5,
        });

        await postSwap(
            swapBody(fixture.halfPortionCandidate.id, HALF_CANDIDATE_PORTION, {
                expectedPlanRevision: 4,
                idempotencyKey: SECOND_SWAP_KEY,
            }),
        ).expect(200);

        return { firstEntryId, secondEntryId, lunch: await readPlannedLunch() };
    };

    it('reports both entries in order, each under the recipe it actually was', async () => {
        const { firstEntryId, secondEntryId, lunch } = await runChain();

        expect(lunch.loggedEntries).toHaveLength(2);
        // Ordered by loggedAt, then by entryId — deterministic even for two
        // entries the clock cannot separate.
        expect(lunch.loggedEntries.map((entry) => entry.entryId)).toEqual([firstEntryId, secondEntryId]);
        expect(lunch.loggedEntries[0].recipeVersionId).toBe(fixture.lunchRecipe.id);
        expect(lunch.loggedEntries[0].recipeName).toBe('Lunch Bowl');
        expect(lunch.loggedEntries[1].recipeVersionId).toBe(fixture.equalPortionCandidate.id);
        expect(lunch.loggedEntries[1].recipeName).toBe('Candidate At One Serving');
        // Each entry names the recipe IT was, joined from `recipe_versions`, so
        // a caption after any number of swaps names what was eaten. An
        // implementation reading the audit column could name at most one of
        // these two, which is what this assertion forecloses.
        expect(lunch.loggedEntries[0].recipeName).not.toBe(lunch.loggedEntries[1].recipeName);
        expect(lunch.loggedEntries.map((entry) => entry.servings)).toEqual([1, 0.5]);
        expect(lunch.loggedEntries.map((entry) => entry.mealName)).toEqual(['Lunch', 'Lunch']);
        expect(lunch.loggedEntries.map((entry) => entry.date)).toEqual([PLANNED_DAY_KEY, PLANNED_DAY_KEY]);
    });

    it('holds the slot at C, logged against neither of its entries', async () => {
        const { lunch } = await runChain();

        expect(lunch.recipe.versionId).toBe(fixture.halfPortionCandidate.id);
        // NOT logged: no entry references the recipe the slot now holds, which
        // is the whole of the determination — the replacement is never marked
        // eaten on the strength of a meal the user ate before it arrived.
        expect(
            lunch.loggedEntries.some((entry) => entry.recipeVersionId === lunch.recipe.versionId),
        ).toBe(false);
        // And the card's logged-then-swapped state is reachable from the
        // entries alone: every one of them names a version other than the
        // current one.
        expect(
            lunch.loggedEntries.every((entry) => entry.recipeVersionId !== lunch.recipe.versionId),
        ).toBe(true);
        expect(lunch.planned).toEqual(rounded(HALF_CANDIDATE_NUTRITION));

        // The week now plans C, and the day's stored totals say so — the two
        // logs did not leave the slot's own numbers behind.
        const day = await storedDay();

        expect(day.planned_calories).toBe(DAY_TOTALS_AFTER_HALF.calories);
        expect(day.planned_protein_g).toBe(DAY_TOTALS_AFTER_HALF.protein);
        expect(day.planned_carbs_g).toBe(DAY_TOTALS_AFTER_HALF.carbs);
        expect(day.planned_fat_g).toBe(DAY_TOTALS_AFTER_HALF.fat);
    });

    it('names only the last version replaced on previousRecipe', async () => {
        const { lunch } = await runChain();

        // An audit value, not a history: after A → B → C it is B, and A
        // survives only on its own diary entry.
        expect(lunch.previousRecipe).toEqual({
            versionId: fixture.equalPortionCandidate.id,
            name: 'Candidate At One Serving',
        });
        expect((await storedLunch()).previous_recipe_version_id).toBe(fixture.equalPortionCandidate.id);
    });

    it('leaves both diary snapshots exactly as they were logged', async () => {
        const firstEntryId = await logPlannedLunch({
            idempotencyKey: FIRST_LOG_KEY,
            expectedPlanRevision: PLAN_REVISION_BEFORE,
        });
        const afterFirstLog = await storedEntries();

        await postSwap(
            swapBody(fixture.equalPortionCandidate.id, 1, { expectedPlanRevision: 2 }),
        ).expect(200);

        // The A entry is byte-identical after the swap that replaced A.
        expect(await storedEntries()).toEqual(afterFirstLog);

        await logPlannedLunch({
            idempotencyKey: SECOND_LOG_KEY,
            expectedPlanRevision: 3,
            servings: 0.5,
        });
        const afterSecondLog = await storedEntries();

        await postSwap(
            swapBody(fixture.halfPortionCandidate.id, HALF_CANDIDATE_PORTION, {
                expectedPlanRevision: 4,
                idempotencyKey: SECOND_SWAP_KEY,
            }),
        ).expect(200);

        // Both entries stand: the numbers a user ate are never rewritten by a
        // later swap, so each snapshot still describes the recipe it was logged
        // from and both keep their links to this planned meal.
        expect(await storedEntries()).toEqual(afterSecondLog);

        const [first, second] = afterSecondLog;

        expect(first.id).toBe(firstEntryId);
        expect(first.recipe_version_id).toBe(fixture.lunchRecipe.id);
        expect(first.calories).toBe(PLANNED_MEAL_NUTRITION.calories);
        expect(second.recipe_version_id).toBe(fixture.equalPortionCandidate.id);
        expect(second.calories).toBe(EQUAL_CANDIDATE_NUTRITION.calories);
        expect(
            afterSecondLog.every((entry) => entry.meal_plan_meal_id === fixture.lunchMealId),
        ).toBe(true);
        // Nothing was logged against C.
        expect(
            afterSecondLog.some((entry) => entry.recipe_version_id === fixture.halfPortionCandidate.id),
        ).toBe(false);
    });
});

/* ---------------------------------------------------------------------------
 * Ownership, the capability gate, and what a refusal is allowed to say
 *
 * The exhaustive route × id-class matrix is `ownership.test.ts`'s; what is here
 * is the local proof for the NESTED shape these three endpoints have, where a
 * plan id and a meal id can be owned by different people.
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * A malformed id in the NESTED path
 *
 * All three endpoints carry `:planId` and `:mealId`, and the preview a third id
 * as well. Only `recipeVersionId` was covered malformed above, which leaves the
 * two PARENT ids — the ones every request to this family carries — untested on
 * every one of the three.
 *
 * WHY THIS IS NOT COSMETIC. A non-UUID reaching a `where: { id }` predicate on a
 * `uuid` column is a PostgreSQL cast error, so the alternative to a parsed
 * refusal is a `500` with a driver message where §0.5.2 promises a `400
 * invalid_request` naming the field — and on the commit it is a `500` on a WRITE
 * path, where the ledger reservation and `buildRequestFingerprint` are already
 * in motion. That is why each of `swap.logic.ts`'s three parsers runs as the
 * FIRST statement of its service entry point, before any I/O.
 *
 * WHAT EACH CASE PINS. The exact body, including the ORDER of `details`: the
 * parsers judge every id rather than short-circuiting on the first, and they
 * report them in PATH order (`planId`, then `mealId`, then `recipeVersionId`),
 * so one round trip fixes a request with two bad ids and the client renders its
 * inline errors in the order the request reads. The commit adds the body's own
 * fields AFTER the path's, in one verdict.
 *
 * AND THAT NOTHING MOVED. A refusal that had already reserved the key would be
 * indistinguishable from this one at the status line, and it would leave the key
 * unusable — so every case re-reads the meal, the day, the plan, the grocery
 * rows and the ledger. `requestParserWiring.test.ts` makes the same point about
 * the service entry points with no database at all; this is the HTTP half, with
 * one.
 * ------------------------------------------------------------------------- */

describe('a malformed id in the nested path', () => {
    /** Not a UUID in any version, and not an id the routes could ever mint. */
    const MALFORMED_ID = 'not-a-uuid';

    const PLAN_ID_DETAIL: InvalidRequestDetail = { field: 'planId', code: 'invalid_id' };
    const MEAL_ID_DETAIL: InvalidRequestDetail = { field: 'mealId', code: 'invalid_id' };
    const RECIPE_VERSION_ID_DETAIL: InvalidRequestDetail = { field: 'recipeVersionId', code: 'invalid_id' };

    /** What any of the three requests resolves to, so one table can hold all three. */
    type SwapResponse = Awaited<ReturnType<typeof getAlternatives>>;

    /** A case name, the request it sends, and the details it must be answered with. */
    type MalformedPathCase = [string, () => PromiseLike<SwapResponse>, InvalidRequestDetail[]];

    /**
     * Everything these requests must not have touched.
     *
     * Whole rows rather than revisions alone: a parse that had reached the
     * database could have written `swapped_at`, `flags` or the day's stored
     * totals without moving a revision at all.
     */
    const untouchedState = async () => ({
        lunch: await storedLunch(),
        day: await storedDay(),
        plan: await storedPlan(),
        groceries: await storedGroceryRows(),
    });

    const cases: MalformedPathCase[] = [
        [
            'the alternatives read with a malformed planId',
            () => getAlternatives({ planId: MALFORMED_ID }),
            [PLAN_ID_DETAIL],
        ],
        [
            'the alternatives read with a malformed mealId',
            () => getAlternatives({ mealId: MALFORMED_ID }),
            [MEAL_ID_DETAIL],
        ],
        [
            'the alternatives read with both path ids malformed',
            () => getAlternatives({ planId: MALFORMED_ID, mealId: MALFORMED_ID }),
            [PLAN_ID_DETAIL, MEAL_ID_DETAIL],
        ],
        [
            'the preview with a malformed planId',
            () => getPreview(fixture.equalPortionCandidate.id, { planId: MALFORMED_ID }),
            [PLAN_ID_DETAIL],
        ],
        [
            'the preview with a malformed mealId',
            () => getPreview(fixture.equalPortionCandidate.id, { mealId: MALFORMED_ID }),
            [MEAL_ID_DETAIL],
        ],
        [
            'the preview with both parent ids malformed',
            () => getPreview(fixture.equalPortionCandidate.id, { planId: MALFORMED_ID, mealId: MALFORMED_ID }),
            [PLAN_ID_DETAIL, MEAL_ID_DETAIL],
        ],
        [
            // All three of the preview's ids at once, which is the only case
            // that shows `recipeVersionId` is reported LAST rather than first —
            // the order the path is read in, not the order the parser happens to
            // check in.
            'the preview with all three ids malformed',
            () => getPreview(MALFORMED_ID, { planId: MALFORMED_ID, mealId: MALFORMED_ID }),
            [PLAN_ID_DETAIL, MEAL_ID_DETAIL, RECIPE_VERSION_ID_DETAIL],
        ],
        [
            'the commit with a malformed planId',
            () => postSwap(swapBody(fixture.equalPortionCandidate.id, 1), { planId: MALFORMED_ID }),
            [PLAN_ID_DETAIL],
        ],
        [
            'the commit with a malformed mealId',
            () => postSwap(swapBody(fixture.equalPortionCandidate.id, 1), { mealId: MALFORMED_ID }),
            [MEAL_ID_DETAIL],
        ],
        [
            'the commit with both path ids malformed',
            () =>
                postSwap(swapBody(fixture.equalPortionCandidate.id, 1), {
                    planId: MALFORMED_ID,
                    mealId: MALFORMED_ID,
                }),
            [PLAN_ID_DETAIL, MEAL_ID_DETAIL],
        ],
        [
            // The path AND the body wrong together, which is what makes the
            // commit's single-verdict parse observable: a portion outside the
            // offered set is reported BESIDE the two path ids and after them,
            // rather than the caller being sent back twice.
            'the commit with both path ids and the portion malformed',
            () =>
                postSwap(swapBody(fixture.equalPortionCandidate.id, 1.1), {
                    planId: MALFORMED_ID,
                    mealId: MALFORMED_ID,
                }),
            [PLAN_ID_DETAIL, MEAL_ID_DETAIL, { field: 'portionMultiplier', code: 'unknown_value' }],
        ],
    ];

    it.each(cases)('answers %s with 400 invalid_request naming every bad id', async (_case, send, details) => {
        const before = await untouchedState();

        const response = await send();

        // The whole body, in order: `expectRefusal` would accept `details` in
        // any arrangement, and the arrangement is part of the contract here.
        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'invalid_request', details });

        // Parsed before any I/O, so there is nothing to have half-written: the
        // meal, the day, the plan and the shopping list are the rows this suite
        // seeded, and the commit's key never reached the ledger.
        expect(await untouchedState()).toEqual(before);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
        expect(await prisma.meal_plan_actions.count()).toBe(0);
    });

    it('never answers a malformed parent id as a 404, a 422 or a 500', async () => {
        // The three answers a malformed id would produce if it were NOT parsed
        // and the reason each would be wrong: a `404` (the plan read missed)
        // tells a client its plan is gone when it merely built a bad URL, a
        // `422 recipe_ineligible` tells it the meal no longer fits, and a `500`
        // is the PostgreSQL cast error surfacing with no field named at all.
        const answers = await Promise.all([
            getAlternatives({ planId: MALFORMED_ID }),
            getAlternatives({ mealId: MALFORMED_ID }),
            getPreview(fixture.equalPortionCandidate.id, { planId: MALFORMED_ID }),
            getPreview(fixture.equalPortionCandidate.id, { mealId: MALFORMED_ID }),
            postSwap(swapBody(fixture.equalPortionCandidate.id, 1), { planId: MALFORMED_ID }),
            postSwap(swapBody(fixture.equalPortionCandidate.id, 1), { mealId: MALFORMED_ID }),
        ]);

        expect(answers.map((answer) => answer.status)).toEqual([400, 400, 400, 400, 400, 400]);

        for (const answer of answers) {
            // And the refusal says nothing about the schema or the driver that
            // produced it — the id is named, the table is not (Rule §4).
            const serialised = JSON.stringify(answer.body);

            expect(serialised).not.toMatch(/PrismaClient|Invalid `|uuid|meal_plan|at Object\./i);
        }
    });
});

describe('ownership and the capability gate', () => {
    it('answers every one of the three endpoints 503 while the feature is off', async () => {
        jest.mocked(isMealPlanningEnabled).mockReturnValue(false);

        const responses = [
            await getAlternatives(),
            await getPreview(fixture.equalPortionCandidate.id),
            await postSwap(swapBody(fixture.equalPortionCandidate.id, 1)),
        ];

        for (const response of responses) {
            expectRefusal(response, 503, 'feature_disabled');
        }
        // A capability answer, not a write: the gate runs before the service is
        // reached at all.
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_BEFORE);
        expect(await prisma.meal_plan_actions.count()).toBe(0);
    });

    it('answers a request carrying no identity 401', async () => {
        const response = await request.post(swapPath()).send(swapBody(fixture.equalPortionCandidate.id, 1));

        expect(response.status).toBe(401);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_BEFORE);
    });

    it("refuses a swap aimed at another user's meal under the caller's own plan", async () => {
        const foreignMealBefore = await storedMeal(fixture.otherUserMealId);
        const response = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1), {
            mealId: fixture.otherUserMealId,
        });

        // The plan is the caller's and the meal is not, so the nested pair
        // resolves to nothing the caller owns — 404, and never a 403 that would
        // confirm the meal exists.
        expectRefusal(response, 404, 'Plan not found');
        expect(await storedMeal(fixture.otherUserMealId)).toEqual(foreignMealBefore);
    });

    it("refuses a swap aimed at another user's meal under that user's plan", async () => {
        const foreignMealBefore = await storedMeal(fixture.otherUserMealId);
        const foreignPlanBefore = await storedPlan(fixture.otherUserPlanId);
        const response = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1), {
            planId: fixture.otherUserPlanId,
            mealId: fixture.otherUserMealId,
        });

        expectRefusal(response, 404, 'Plan not found');
        // Every write predicate carries the owner key, so the foreign rows are
        // not merely unrewritten — they were never reachable.
        expect(await storedMeal(fixture.otherUserMealId)).toEqual(foreignMealBefore);
        expect(await storedPlan(fixture.otherUserPlanId)).toEqual(foreignPlanBefore);
        expect(await ledgerRowsFor(SWAP_KEY, OTHER_USER_ID)).toHaveLength(0);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
    });

    it("leaves the other user's plan and week untouched by a swap of the caller's own", async () => {
        const foreignPlanBefore = await storedPlan(fixture.otherUserPlanId);
        const foreignDaysBefore = await storedDays(fixture.otherUserPlanId);
        const foreignMealBefore = await storedMeal(fixture.otherUserMealId);

        await commitSwapOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        expect(await storedPlan(fixture.otherUserPlanId)).toEqual(foreignPlanBefore);
        expect(await storedDays(fixture.otherUserPlanId)).toEqual(foreignDaysBefore);
        expect(await storedMeal(fixture.otherUserMealId)).toEqual(foreignMealBefore);
    });

    it('refuses a portion outside the offered set at the boundary, not in the database', async () => {
        // The multipliers are a closed set the schema stores as a plain number
        // with no constraint behind it, so the parser is what has to reject an
        // unoffered one — and it names the field and the reason.
        const response = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1.1));

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: 'invalid_request',
            details: [{ field: 'portionMultiplier', code: 'unknown_value' }],
        });
        expect((await storedLunch()).portion_multiplier).toBe(1);
    });

    it('never answers 403, and never leaks an error object in any refusal', async () => {
        const ineligible = await makeLunchIneligibleRecipe();

        jest.mocked(isMealPlanningEnabled).mockReturnValue(false);
        const gated = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1));

        jest.mocked(isMealPlanningEnabled).mockReturnValue(true);
        jest.mocked(mealPlanningFault).mockReturnValue('swap');
        const failed = await postSwap(swapBody(fixture.equalPortionCandidate.id, 1));

        jest.mocked(mealPlanningFault).mockReturnValue('off');

        // One sweep over every refusal this endpoint family can produce: an
        // absent identity, the capability gate, a foreign resource, a malformed
        // id, a stale revision, an ineligible candidate and a vendor-style
        // failure.
        const refusals = [
            { response: await request.get(alternativesPath()), status: 401 },
            { response: gated, status: 503 },
            { response: await getAlternatives({ planId: fixture.otherUserPlanId }), status: 404 },
            { response: await getPreview('not-a-uuid'), status: 400 },
            {
                response: await postSwap(
                    swapBody(fixture.equalPortionCandidate.id, 1, { expectedPlanRevision: 99 }),
                ),
                status: 409,
            },
            { response: await postSwap(swapBody(ineligible.id, 1)), status: 422 },
            { response: failed, status: 502 },
        ];

        for (const { response, status } of refusals) {
            expect(response.status).toBe(status);
            // An absent capability, an absent resource and an absent right are
            // all answered without 403: §1.5 keeps authorisation failures
            // indistinguishable from absence.
            expect(response.status).not.toBe(403);

            const serialised = JSON.stringify(response.body);

            for (const leak of ['stack', 'prisma', 'Invalid `', 'at Object.', 'PrismaClient', 'Error:']) {
                expect(serialised).not.toContain(leak);
            }
            // A machine code or a human string, and nothing structural beside
            // the payload §0.5.2 declares.
            expect(typeof (response.body as { error?: unknown }).error).toBe('string');
        }
    });
});

/* ---------------------------------------------------------------------------
 * The headline: the list, the preview and the commit agree
 *
 * The three endpoints run the SAME `selectSwapCandidates` / `selectSwapPortion`
 * pair by design, so the failure this suite exists to catch is one of them
 * drifting — most plausibly a list that assumes ×1 while the preview and the
 * commit compute a portion. Only a case that drives all three over one seeded
 * world can catch it, so it is a named test rather than an incidental
 * consequence of the cases above.
 * ------------------------------------------------------------------------- */

describe('the list, the preview and the commit', () => {
    /** Walks one candidate the whole way through, from whatever the list says. */
    const walkTheFlow = async (recipeVersionId: string): Promise<void> => {
        const listed = await readAlternatives();
        const row = listed.alternatives.find(
            (alternative) => alternative.recipeVersionId === recipeVersionId,
        );

        expect(row).toBeDefined();

        const preview = await readPreview(row?.recipeVersionId ?? '');

        // Same recipe, same portion — read from the list, never restated.
        expect(preview.alternative.recipe.versionId).toBe(row?.recipeVersionId);
        expect(preview.alternative.portionMultiplier).toBe(row?.portionMultiplier);

        const committed = await commitSwapOrThrow(
            swapBody(preview.alternative.recipe.versionId, preview.alternative.portionMultiplier, {
                expectedPlanRevision: preview.planRevision,
            }),
        );

        // And the commit accepted exactly what was previewed: reaching here
        // without a `409 preview_stale` IS the agreement.
        expect(committed.meal.recipe.versionId).toBe(row?.recipeVersionId);
        expect(committed.meal.portionMultiplier).toBe(row?.portionMultiplier);
        expect(committed.meal.planned).toEqual(preview.alternative.nutrition);
        expect(committed.day.plannedTotals).toEqual(preview.dayTotalsIfSwapped);

        const stored = await storedLunch();

        expect(stored.recipe_version_id).toBe(row?.recipeVersionId);
        expect(stored.portion_multiplier).toBe(row?.portionMultiplier);
    };

    it('agrees on a candidate whose portion is one serving', async () => {
        await walkTheFlow(fixture.equalPortionCandidate.id);

        expect((await storedLunch()).portion_multiplier).toBe(1);
    });

    it('agrees on a candidate that is admissible only above one serving', async () => {
        // The case that proves the LIST ran the portion selection rather than
        // assuming ×1: this recipe fits the day at no other multiplier, so a
        // list that defaulted would offer a portion the commit then refused.
        await walkTheFlow(fixture.halfPortionCandidate.id);

        expect((await storedLunch()).portion_multiplier).toBe(HALF_CANDIDATE_PORTION);
    });

    it('agrees on the NEW portion once a target move has changed which one fits', async () => {
        const offeredBefore = (await readAlternatives()).alternatives.find(
            (alternative) => alternative.recipeVersionId === fixture.halfPortionCandidate.id,
        );

        expect(offeredBefore?.portionMultiplier).toBe(HALF_CANDIDATE_PORTION);

        // Moving the day's calorie target makes a DIFFERENT multiplier the one
        // that minimises the gap for the same recipe.
        await saveManualTargets(2160);

        await walkTheFlow(fixture.halfPortionCandidate.id);

        // All three endpoints moved together, because all three recompute the
        // selection rather than reading a cached one — and the portion the user
        // ends up with is the one the current targets chose.
        expect((await storedLunch()).portion_multiplier).toBe(2);
        expect((await storedLunch()).portion_multiplier).not.toBe(HALF_CANDIDATE_PORTION);
    });
});
