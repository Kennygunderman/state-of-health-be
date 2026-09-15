// The write-safety model under real contention (Agent Action Plan §0.5.1 "Plan
// write-safety model" and §0.9.2's `api/concurrency.test.ts` rows).
//
// WHICH LAYER THIS EXERCISES, AND WHY.
//
// The meal-planning HTTP boundary does not exist in this checkout — there is no
// `src/routes/mealPlanning.routes.ts`, no `src/controllers/mealPlanning.
// controller.ts`, and `src/app.ts` mounts neither; the plan records that
// boundary as later work. That is no loss here: the advisory lock, the
// idempotency reservation, the compare-and-swap revision bumps and the
// transaction that holds them together all live in the SERVICE layer, so this
// is the layer where the hazards actually exist and where they are provable
// today. Nothing here fakes or simulates a request layer. When the mount lands,
// the request-level cases — two concurrent HTTP requests, and the
// `postCommitAbort` socket seam §0.9.2 describes — are added to THIS file
// beside the service cases.
//
// WHY THIS SUITE NEEDS MORE THAN ONE CLIENT. A lock can only be observed from a
// session that is not the one holding it, so {@link contendingClient} is a
// second, independent `PrismaClient` — the same construction
// `targets.service.test.ts` uses for its legacy writer. Races between two
// service calls do not need it: `prisma.$transaction` draws a separate
// connection from the pool per call, so two concurrent `logPlannedMeal`s are
// two genuine PostgreSQL sessions contending for one advisory lock. The second
// client exists for the cases that must HOLD the lock and watch a service call
// wait for it.
//
// HOW EACH RACE IS MADE DETERMINISTIC. A test that asserts which side of a race
// won is a test that passes on the machine it was written on. Every race here
// asserts the OUTCOME SET the contract allows — "exactly one committed and the
// other was refused as stale, and the database holds exactly one of these two
// coherent states" — never an ordering. Where an ORDERING is the thing under
// test, it is additionally driven sequentially in each order and the two
// resulting states are compared. The only timing value anywhere is
// {@link BLOCK_OBSERVATION_MS}, and it is not a race: it is how long a blocked
// write is watched, paired with a counter-proof that the same write completes
// in a fraction of it when nothing holds the lock — so the pair of assertions
// carries the proof rather than the interval.
//
// WHAT IS ASSERTED IS WHAT THE DATABASE HOLDS. Every case re-reads
// `meal_entries`, `meal_plan_actions`, `meal_plan_meals`, `meal_plan_days`,
// `meal_plans`, `grocery_items` and `meal_plan_preferences` — and, for the
// generation rows, `recipe_versions`, `recipe_ingredients` and `catalog_foods`
// — and asserts ids, row counts, statuses, columns, orderings and revisions.
// Two things are deliberately not asserted: the rounding of nutrition on plan
// DTOs and the exact text of `portionText`. Both are open findings against
// `mealPlan.mapper.ts` (F04, F05) being changed in another work unit, so an
// assertion on either would pin a value that is about to move. A portion
// MULTIPLIER is asserted where a preview binds one — it is the stored number
// the binding is judged on, not the string either finding touches.
//
// Determinism of the fixture: the week is pinned to a named day and every call
// takes the same injected `now`, so nothing here depends on when the suite runs.
//
// THE SECOND WORLD, AND WHY IT IS NOT IN `beforeEach`. The week above is a
// PUBLISHED plan, which is all the swap, log and grocery cases need. The rows
// that race GENERATIONS need something else — a user with no plan of their own
// and a catalog deep enough for the search to close a seven-day week under the
// repetition rule — so those describes seed their own plannable world
// ({@link seedPlannableWorld}) for a SECOND user. It is seeded per case rather
// than beside the week because `recipe_versions` is shared reference data with
// no owner: adding that pool to every case would widen the alternatives list
// the week's swap cases assert against. The two users never collide — the
// advisory lock is per user, and the planning user dislikes the week's food
// group, so neither user's recipes are ever eligible for the other.

import { randomUUID } from 'node:crypto';

import { PrismaClient, catalog_foods } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import {
    getGroceryList,
    loadPlannedMealsForGroceries,
    rebuildPlanGroceries,
    toggleGroceryItem,
    uncheckAllGroceries,
} from '../../services/grocery.service';
import { PLAN_DAY_COUNT } from '../../services/mealPlan.logic';
import {
    generatePlan,
    getMealPlanDay,
    regeneratePlan,
} from '../../services/mealPlan.service';
import {
    IdempotencyConflictError,
    PlanNotActiveError,
    PlanOverlapError,
    PreviewStaleError,
    StalePlanError,
    StaleRevisionError,
    UpcomingExistsError,
} from '../../services/mealPlanning.errors';
import { withMealPlanningTransaction, withUserLock } from '../../services/mealPlanningAction.service';
import { logPlannedMeal } from '../../services/plannedMealLog.service';
import { savePreferences } from '../../services/preferences.service';
import { getRecipeVersionForUser } from '../../services/recipe.service';
import { SwapDataError, commitSwap, getSwapAlternatives, getSwapPreview } from '../../services/swap.service';
import { saveTargets } from '../../services/targets.service';
import {
    FIXTURE_TARGETS,
    FIXTURE_USER_TARGET_COLUMNS,
    FixtureIngredientOptions,
    FixtureMealPlan,
    FixtureRecipeVersion,
    addDaysToDayKey,
    makeCatalogFood,
    makePlan,
    makePreferences,
    makeRecipeVersion,
    makeUser,
} from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

/** The one user every case contends over: the advisory lock is per user. */
const USER_ID = 'concurrency-suite-user';

/** The day the fixture week is built around, and the day every injected `now` falls on. */
const TODAY = '2026-09-15';

const NOW = new Date(`${TODAY}T12:00:00.000Z`);

/** `makePlan`'s default week around {@link TODAY}. */
const PLAN_START_DAY_KEY = addDaysToDayKey(TODAY, -1);

/**
 * How long a blocked write is watched before the absence of a result is taken
 * as evidence that it is blocked.
 *
 * The write it watches is a short transaction that completes in a small
 * fraction of this when nothing holds its lock — which is exactly what the
 * counter-proof test asserts — so the pair of assertions is what carries the
 * proof, and this interval only has to be comfortably longer than the work.
 * It stays well inside Prisma's default five-second interactive-transaction
 * timeout, so a blocked call resumes rather than expiring.
 */
const BLOCK_OBSERVATION_MS = 500;

/**
 * The three slot sizes that put a fixture day exactly on the plan's target
 * snapshot (2,100 kcal / 158 P / 210 C / 70 F), so a same-sized swap candidate
 * is admissible under the day tolerance and a real swap is committable.
 */
const SLOT_SIZES = {
    breakfast: { calories: 525, protein: 40, carbs: 52, fat: 18 },
    lunch: { calories: 735, protein: 55, carbs: 74, fat: 24 },
    dinner: { calories: 840, protein: 63, carbs: 84, fat: 28 },
} as const;

/**
 * A second session, so the per-user advisory lock can be held from OUTSIDE the
 * transaction under test. Query logging is not needed, so this client is
 * otherwise identical to the singleton.
 */
const contendingClient = new PrismaClient();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise plus its resolver, for sequencing two sessions without a sleep. */
const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
        release = () => resolve();
    });

    return { promise, release };
};

/** Tracks whether a promise has settled, without awaiting it. */
const watch = <T>(promise: Promise<T>): { settled: () => boolean; done: Promise<T> } => {
    let finished = false;
    const done = promise.finally(() => {
        finished = true;
    });

    return { settled: () => finished, done };
};

/* ---------------------------------------------------------------------------
 * The fixture
 * ------------------------------------------------------------------------- */

type Week = Awaited<ReturnType<typeof seedWeek>>;

/**
 * The plan every case contends over: one on-target week whose breakfast slot
 * has two admissible alternatives, its grocery list built by the real rebuild,
 * and the diary bucket a log body names.
 *
 * EVERY RECIPE HAS ITS OWN CATALOG FOOD, which is what makes a swap's grocery
 * reconciliation observable: swapping one day's breakfast REDUCES the outgoing
 * food's row (the other six days still plan it) and ADDS a row for the incoming
 * food, while the two untouched slots keep their amounts exactly — so a check
 * mark on one of those rows is a check mark the rebuild has to preserve. Each
 * food carries a MASS default portion, since a volume portion against a null
 * density cannot be converted into a grocery quantity.
 */
const seedWeek = async () => {
    await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(USER_ID, { time_zone: 'UTC' });

    const foodFor = async (sequence: number) =>
        makeCatalogFood({
            sequence,
            defaultPortion: { description: '100 g', amount: 100, unit: 'g', gram_weight: 100 },
        });

    const breakfastFood = await foodFor(1);
    const alternativeFood = await foodFor(2);
    const secondAlternativeFood = await foodFor(3);
    const lunchFood = await foodFor(4);
    const dinnerFood = await foodFor(5);

    const breakfast = await makeRecipeVersion({
        slug: 'concurrency-breakfast',
        catalogFoodId: breakfastFood.id,
        meal_slots: ['breakfast'],
        perServing: { ...SLOT_SIZES.breakfast },
    });
    const alternative = await makeRecipeVersion({
        slug: 'concurrency-breakfast-alt',
        catalogFoodId: alternativeFood.id,
        meal_slots: ['breakfast'],
        perServing: { ...SLOT_SIZES.breakfast },
    });
    // A SECOND alternative, because a swap cannot go back to the recipe it
    // replaced: the week's other six days still plan it, and the repetition
    // rule admits a recipe at most twice. So a case that needs two successive
    // swaps needs two unused candidates.
    const secondAlternative = await makeRecipeVersion({
        slug: 'concurrency-breakfast-alt-two',
        catalogFoodId: secondAlternativeFood.id,
        meal_slots: ['breakfast'],
        perServing: { ...SLOT_SIZES.breakfast },
    });
    const lunch = await makeRecipeVersion({
        slug: 'concurrency-lunch',
        catalogFoodId: lunchFood.id,
        meal_slots: ['lunch'],
        perServing: { ...SLOT_SIZES.lunch },
    });
    const dinner = await makeRecipeVersion({
        slug: 'concurrency-dinner',
        catalogFoodId: dinnerFood.id,
        meal_slots: ['dinner'],
        perServing: { ...SLOT_SIZES.dinner },
    });

    const plan = await makePlan(USER_ID, {
        today: TODAY,
        slots: [
            { slot: 'breakfast', slot_time: '08:00', recipeVersionId: breakfast.id },
            { slot: 'lunch', slot_time: '12:30', recipeVersionId: lunch.id },
            { slot: 'dinner', slot_time: '18:30', recipeVersionId: dinner.id },
        ],
    });

    const day = plan.meal_plan_days.find((candidate) => candidate.day_index === 1);

    if (day === undefined) {
        throw new Error('the fixture plan has no second day');
    }

    const breakfastMeal = day.meal_plan_meals.find((meal) => meal.slot === 'breakfast');

    if (breakfastMeal === undefined) {
        throw new Error('the fixture plan day has no breakfast slot');
    }

    await buildGroceries(plan.id);

    const lunchGroceryItem = await prisma.grocery_items.findFirstOrThrow({
        where: { meal_plan_id: plan.id, user_id: USER_ID, catalog_food_id: lunchFood.id },
    });

    const response = await asUser(request.get(`/api/macros/${TODAY}`), { uid: USER_ID }).expect(200);
    const bucket = (response.body as { meals: { id: string; name: string }[] }).meals.find(
        (meal) => meal.name === 'Breakfast',
    );

    if (bucket === undefined) {
        throw new Error(`GET /api/macros/${TODAY} returned no Breakfast bucket`);
    }

    return {
        plan,
        breakfastMeal,
        breakfast,
        alternative,
        secondAlternative,
        breakfastFood,
        alternativeFood,
        lunchFood,
        dinnerFood,
        lunchGroceryItem,
        diaryMealId: bucket.id,
    };
};

/**
 * The plan's grocery rows, written by the real service under the real lock —
 * there is no grocery factory, and building the rows by hand would test a
 * fixture rather than the aggregation a swap has to reconcile against.
 */
const buildGroceries = async (planId: string): Promise<void> => {
    await withMealPlanningTransaction((tx) =>
        withUserLock(tx, USER_ID, async (locked) =>
            rebuildPlanGroceries(locked, {
                userId: USER_ID,
                planId,
                meals: await loadPlannedMealsForGroceries(locked, USER_ID, planId),
                now: NOW,
            }),
        ),
    );
};

const logBody = (diaryMealId: string, expectedPlanRevision: number): Record<string, unknown> => ({
    servings: 1,
    date: TODAY,
    diaryMealId,
    expectedPlanRevision,
    idempotencyKey: randomUUID(),
});

/**
 * `portionMultiplier` defaults to the ×1 every fixture recipe is planned at and
 * is stated by a caller that committed a PREVIEWED portion: the commit binds
 * the portion the preview showed (`swap.logic.ts::requireBoundPortion`), so a
 * case that moves the targets under a preview has to send the previewed value
 * rather than this default.
 */
const swapBody = (
    recipeVersionId: string,
    expectedPlanRevision: number,
    portionMultiplier = 1,
): Record<string, unknown> => ({
    recipeVersionId,
    portionMultiplier,
    expectedPlanRevision,
    idempotencyKey: randomUUID(),
});

const regenerateBody = (expectedPlanRevision: number): Record<string, unknown> => ({
    idempotencyKey: randomUUID(),
    expectedPlanRevision,
    expectedPreferencesRevision: 1,
    expectedTargetsRevision: 1,
});

/**
 * `POST /meal-planning/plans` for one week, with the revisions the fixture
 * preferences row carries.
 *
 * The key is minted per call, so two generations raced against each other are
 * two intents rather than one retried one — which is the whole point of the
 * overlap rows: a shared key would be answered by the ledger's replay and no
 * conflict would ever be reached.
 */
const generateBody = (startDate: string): Record<string, unknown> => ({
    startDate,
    idempotencyKey: randomUUID(),
    expectedPreferencesRevision: 1,
    expectedTargetsRevision: 1,
});

const storedEntries = () =>
    prisma.meal_entries.findMany({
        where: { user_id: USER_ID },
        orderBy: [{ logged_at: 'asc' }, { id: 'asc' }],
    });

/**
 * Every ledger row of the user, completed or not. A row left PENDING would be a
 * defect, so the cases assert the row's `response_status` rather than filtering
 * on it — a filter would hide exactly the state worth catching.
 */
const ledgerRows = (userId: string = USER_ID) =>
    prisma.meal_plan_actions.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'asc' },
    });

const planRevision = async (planId: string): Promise<number> =>
    (await prisma.meal_plans.findUniqueOrThrow({ where: { id: planId }, select: { revision: true } })).revision;

const mealRow = (mealId: string) => prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: mealId } });

/** The day envelope for the fixture week's contended day, as the client reads it. */
const readDay = async () => {
    const result = await getMealPlanDay(USER_ID, week.plan.id, TODAY);

    if (result.kind !== 'ok') {
        throw new Error(`the day read was refused: ${JSON.stringify(result)}`);
    }

    return result.envelope;
};

/**
 * The grocery list as a comparable value: one entry per row, in a stable
 * order, carrying only what the contract decides — which food in which state,
 * how much of it, whether it is checked, whether it is flagged, and what
 * amount the user last acknowledged. Timestamps are excluded because they are
 * not part of any assertion here.
 */
const groceryStateOf = async (planId: string) => {
    const rows = await prisma.grocery_items.findMany({
        where: { meal_plan_id: planId, user_id: USER_ID },
        orderBy: [{ catalog_food_id: 'asc' }, { food_state: 'asc' }],
    });

    return rows.map((row) => ({
        catalogFoodId: row.catalog_food_id,
        foodState: row.food_state,
        quantityGrams: Number(row.quantity_grams),
        isChecked: row.is_checked,
        isFlagged: row.flagged_at !== null,
        acknowledgedGrams:
            row.previous_quantity_grams === null ? null : Number(row.previous_quantity_grams),
    }));
};

/**
 * A raced pair split into what fulfilled and what did not, so a case can assert
 * the OUTCOME SET — "exactly one of each" — without naming which side won.
 *
 * Call it as `splitRace<unknown>(…)` when the two racers return different
 * shapes; the inferred form keeps the value type for a homogeneous pair.
 */
const splitRace = <T>(
    results: readonly PromiseSettledResult<T>[],
): { fulfilled: PromiseFulfilledResult<T>[]; rejected: PromiseRejectedResult[] } => ({
    fulfilled: results.filter(
        (result): result is PromiseFulfilledResult<T> => result.status === 'fulfilled',
    ),
    rejected: results.filter((result): result is PromiseRejectedResult => result.status === 'rejected'),
});

/* ---------------------------------------------------------------------------
 * The plannable world — what a GENERATION contends over
 * ------------------------------------------------------------------------- */

/** The user the generation rows publish weeks for; see the module header. */
const PLANNING_USER_ID = 'concurrency-suite-planning-user';

/**
 * The food group the week fixture's foods carry, which the planning user
 * DISLIKES.
 *
 * `recipe_versions` has no owner, so the week's five recipes are in the
 * plannable universe of every user — including the one whose generations are
 * raced below, whose published weeks would then be a mixture of two fixtures'
 * recipes and whose swap alternatives would depend on which. One disliked group
 * separates the two worlds through the product's own eligibility rule
 * (`recipe.logic.ts::evaluatePlanningEligibility` refuses a recipe with a
 * disliked ingredient group), so every assertion below is about the pool this
 * suite seeded for it.
 */
const WEEK_FOOD_GROUP = 'fixture_food';

/** The group the pool's own foods carry, which nobody dislikes. */
const POOL_FOOD_GROUP = 'concurrency_pool';

/**
 * Thirteen recipes, each admissible in all three main slots.
 *
 * A week is {@link PLAN_DAY_COUNT} × 3 planned meals and the repetition rule
 * admits a recipe twice, so eleven is the arithmetic floor. Thirteen leaves the
 * search room to close the last day without backtracking into a corner — twelve
 * is the count `api/fault.test.ts` already publishes a week from — and the
 * thirteenth is the one a publication promotes mid-generation.
 */
const POOL_RECIPE_COUNT = 13;

/**
 * A pool recipe's two ingredients: its OWN food, which nothing else shops for,
 * and the staple every pool recipe carries.
 *
 * The per-100 g values and gram weights give each recipe 700 kcal / 52 P /
 * 70 C / 23 F per serving over the factory's two-serving yield
 * (`gram_weight × per100g ÷ 100 ÷ yield`), so three of them at ×1 land a day on
 * 2,100 / 156 / 210 / 69 — inside the day tolerance around
 * {@link FIXTURE_TARGETS} whichever three the search picks, which is what makes
 * a published week a property of the pool rather than of the search's order.
 *
 * THE STAPLE IS IN EVERY RECIPE ON PURPOSE: it is the food a catalog load
 * retires mid-generation below, and a food every planned meal shops for is one
 * the list has to carry however the week came out.
 */
const POOL_MAIN_PER_100G = { calories: 325, protein_g: 24, carbs_g: 32.5, fat_g: 10, fiber_g: 0 };
const POOL_STAPLE_PER_100G = { calories: 100, protein_g: 8, carbs_g: 10, fat_g: 6, fiber_g: 0 };
const POOL_MAIN_GRAMS = 400;
const POOL_STAPLE_GRAMS = 100;

/** `status` values of `recipe_versions`, in database spelling. */
const CURRENT_VERSION = 'current';
const RETIRED_VERSION = 'retired';

/** `publication_status` values of `catalog_foods` this suite writes or asserts. */
const RETIRED_FOOD = 'retired';

/** `meal_plans.status` values, in database spelling. */
const ACTIVE_PLAN = 'active';
const SUPERSEDED_PLAN = 'superseded';

/** One pool recipe: the version, and the food only it shops for. */
interface PoolRecipe {
    readonly version: FixtureRecipeVersion;
    readonly food: catalog_foods;
}

type PlannableWorld = Awaited<ReturnType<typeof seedPlannableWorld>>;

/**
 * A food whose default portion is stated in GRAMS, so its grocery line sits in
 * the `mass` family — a volume portion against a null density cannot be
 * converted into a quantity at all, which is the same reason the week's foods
 * are built this way.
 */
const poolFood = async (displayName: string): Promise<catalog_foods> =>
    makeCatalogFood({
        display_name: displayName,
        food_group: POOL_FOOD_GROUP,
        defaultPortion: { description: '100 g', amount: 100, unit: 'g', gram_weight: 100 },
    });

/** The two ingredients of every pool recipe, at the weights above. */
const poolIngredients = (
    main: catalog_foods,
    staple: catalog_foods,
): readonly FixtureIngredientOptions[] => [
    {
        catalogFoodId: main.id,
        per100g: POOL_MAIN_PER_100G,
        gram_weight: POOL_MAIN_GRAMS,
        quantity: POOL_MAIN_GRAMS,
        unit: 'g',
        display_text: `${POOL_MAIN_GRAMS} g`,
    },
    {
        catalogFoodId: staple.id,
        per100g: POOL_STAPLE_PER_100G,
        gram_weight: POOL_STAPLE_GRAMS,
        quantity: POOL_STAPLE_GRAMS,
        unit: 'g',
        display_text: `${POOL_STAPLE_GRAMS} g`,
    },
];

/**
 * The planning user, their preferences, and a catalog a week can be built from.
 *
 * The recipes are numbered in their slugs because `(slug, version)` is the
 * portable identity `swap.logic.ts` ranks ties by; the numbering makes the
 * ranked alternatives list readable in a failure message rather than deciding
 * anything this suite asserts.
 */
const seedPlannableWorld = async () => {
    await makeUser({ id: PLANNING_USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(PLANNING_USER_ID, {
        time_zone: 'UTC',
        disliked_food_groups: [WEEK_FOOD_GROUP],
    });

    const staple = await poolFood('Concurrency Pool Staple');
    const pool: PoolRecipe[] = [];

    for (let index = 0; index < POOL_RECIPE_COUNT; index += 1) {
        const food = await poolFood(`Concurrency Pool Food ${index}`);

        pool.push({
            food,
            version: await makeRecipeVersion({
                slug: `concurrency-pool-${String(index).padStart(2, '0')}`,
                catalogFoodId: food.id,
                ingredients: poolIngredients(food, staple),
            }),
        });
    }

    return { staple, pool };
};

/** The alternatives the sheet would offer for one meal, or the refusal verbatim. */
const listedAlternatives = async (userId: string, planId: string, mealId: string) => {
    const listed = await getSwapAlternatives(userId, planId, mealId);

    if (listed.kind !== 'ok') {
        throw new Error(`the alternatives read was refused: ${JSON.stringify(listed)}`);
    }

    return listed.response.alternatives;
};

/**
 * A published week for the planning user, built from the pool's first three
 * recipes, plus the meal and the candidate the swap rows contend over.
 *
 * The candidate is READ THROUGH THE SERVICE rather than named: every pool
 * recipe is nutritionally identical, so which one heads the ranked list is
 * `swap.logic.ts`'s to decide and not a fixture's to assume, and its portion
 * comes back on the same row — which is what the commit has to send to satisfy
 * the preview binding.
 */
const seedPlanningWeek = async (world: PlannableWorld) => {
    const plan = await makePlan(PLANNING_USER_ID, {
        startDate: TODAY,
        slots: [
            { slot: 'breakfast', slot_time: '08:00', recipeVersionId: world.pool[0].version.id },
            { slot: 'lunch', slot_time: '12:30', recipeVersionId: world.pool[1].version.id },
            { slot: 'dinner', slot_time: '18:30', recipeVersionId: world.pool[2].version.id },
        ],
    });
    const meal = plan.meal_plan_days[0].meal_plan_meals.find(
        (candidate) => candidate.slot === 'breakfast',
    );

    if (meal === undefined) {
        throw new Error('the planning week was built without the breakfast its swap rows replace');
    }

    const alternatives = await listedAlternatives(PLANNING_USER_ID, plan.id, meal.id);
    const [candidate] = alternatives;

    if (candidate === undefined) {
        throw new Error(`breakfast ${meal.id} of plan ${plan.id} has no alternative to swap to`);
    }

    return { plan, meal, candidate };
};

/* ---------------------------------------------------------------------------
 * Stored-plan readers shared by the generation rows
 * ------------------------------------------------------------------------- */

/** Characters of an ISO timestamp that make up its `yyyy-MM-dd` day key. */
const DAY_KEY_LENGTH = 10;

/** A `@db.Date` column as the day key the contract speaks in. */
const dayKeyOf = (date: Date): string => date.toISOString().slice(0, DAY_KEY_LENGTH);

const PLAN_WITH_MEALS = {
    meal_plan_days: {
        orderBy: { day_index: 'asc' },
        include: { meal_plan_meals: { orderBy: { sort_order: 'asc' } } },
    },
} as const;

type PlanWithMeals = Awaited<ReturnType<typeof plansOf>>[number];

/** Every plan of a user, in a stable order, with its days and their meals. */
const plansOf = (userId: string) =>
    prisma.meal_plans.findMany({
        where: { user_id: userId },
        include: PLAN_WITH_MEALS,
        orderBy: [{ start_date: 'asc' }, { id: 'asc' }],
    });

/**
 * The one plan a user holds, asserted to be the only one.
 *
 * The count is taken over the plans' START DATES rather than the rows, so a
 * failure reports which weeks were published instead of a bare length — the
 * difference between "two generations both committed" and "one published the
 * wrong week" is the first thing a reader needs.
 */
const theOnlyPlanOf = async (userId: string): Promise<PlanWithMeals> => {
    const plans = await plansOf(userId);

    expect(plans.map((plan) => dayKeyOf(plan.start_date))).toHaveLength(1);

    return plans[0];
};

/**
 * A published week is WHOLE: seven days in index order, each with the three
 * slots the schedule declares, every meal pointing at a recipe version.
 *
 * The row this serves is "no partial plan", so it is asserted structurally
 * rather than by counting rows: a missing day and a day missing its dinner are
 * different failures and both are visible here.
 */
const expectWholeWeek = (plan: PlanWithMeals): void => {
    expect(plan.meal_plan_days).toHaveLength(PLAN_DAY_COUNT);
    expect(plan.meal_plan_days.map((day) => day.day_index)).toEqual(
        Array.from({ length: PLAN_DAY_COUNT }, (_unused, index) => index),
    );

    for (const day of plan.meal_plan_days) {
        expect(day.meal_plan_meals.map((meal) => meal.slot)).toEqual(['breakfast', 'lunch', 'dinner']);
        // Every meal resolved a recipe version: the column is a RESTRICT
        // foreign key, so a half-published week would have failed at the
        // database rather than landing rows with nothing behind them.
        expect(day.meal_plan_meals.filter((meal) => meal.recipe_version_id.length === 0)).toEqual([]);
    }
};

/** Every planned meal of a week, in day and slot order. */
const mealsOf = (plan: PlanWithMeals) => plan.meal_plan_days.flatMap((day) => day.meal_plan_meals);

/**
 * At most one ACTIVE plan may start on a given date.
 *
 * The partial unique index `unique_active_meal_plan_start_date` is the backstop
 * rather than the proof: it would reject a second row, so asserting the
 * condition here is asserting that the SERVICE never tried — a generation that
 * published a colliding week would have failed at the database instead of
 * answering `plan_overlap`, and the two are different outcomes.
 */
const expectOneActivePlanPerStartDate = async (userId: string): Promise<void> => {
    const startDates = (await plansOf(userId))
        .filter((plan) => plan.status === ACTIVE_PLAN)
        .map((plan) => dayKeyOf(plan.start_date));

    expect(startDates).toEqual([...new Set(startDates)]);
};

/**
 * Every `replaced_plan_id` points at a plan that exists, is superseded, covers
 * the same week, and has exactly one successor — and every superseded plan is
 * pointed at by one.
 *
 * That pair of directions is what "the chains are intact" means: a successor
 * with a dangling link and a superseded week nothing replaced are both
 * states a stale screen cannot recover from, and neither is visible from one
 * side alone.
 */
const expectIntactReplacementChains = async (userId: string): Promise<void> => {
    const plans = await plansOf(userId);
    const byId = new Map(plans.map((plan) => [plan.id, plan]));

    for (const plan of plans) {
        if (plan.replaced_plan_id === null) {
            continue;
        }

        const replaced = byId.get(plan.replaced_plan_id);

        expect(replaced?.status).toBe(SUPERSEDED_PLAN);
        expect(replaced === undefined ? null : dayKeyOf(replaced.start_date)).toBe(
            dayKeyOf(plan.start_date),
        );
    }

    for (const superseded of plans.filter((plan) => plan.status === SUPERSEDED_PLAN)) {
        expect(plans.filter((plan) => plan.replaced_plan_id === superseded.id)).toHaveLength(1);
    }
};

/** The refusal a call produced, or the value it produced if it did not refuse. */
const outcomeOf = async <T>(attempt: () => Promise<T>): Promise<T | unknown> =>
    attempt().catch((error: unknown) => error);

let week: Week;

beforeEach(async () => {
    await truncateFeatureTables();
    week = await seedWeek();
});

afterAll(async () => {
    await truncateFeatureTables();
    await contendingClient.$disconnect();
});

/* ---------------------------------------------------------------------------
 * One key, two requests in flight
 * ------------------------------------------------------------------------- */

describe('two parallel requests carrying the same idempotency key', () => {
    it('commit one planned log between them and answer both with the same stored 201', async () => {
        const body = logBody(week.diaryMealId, 1);

        const [first, second] = await Promise.all([
            logPlannedMeal(USER_ID, week.plan.id, week.breakfastMeal.id, body, NOW),
            logPlannedMeal(USER_ID, week.plan.id, week.breakfastMeal.id, body, NOW),
        ]);

        if (first.kind !== 'ok' || second.kind !== 'ok') {
            throw new Error(`a same-key pair was refused: ${JSON.stringify({ first, second })}`);
        }

        // Indistinguishable by value, which is the guarantee: one of these two
        // came out of the `jsonb` snapshot column, so they are compared as
        // parsed values rather than as JSON text.
        expect(second.result.status).toBe(first.result.status);
        expect(second.result.planRevisionAfter).toBe(first.result.planRevisionAfter);
        expect(second.result.body).toEqual(first.result.body);
        expect(first.result.status).toBe(201);

        // One write happened. The advisory lock serialised the pair and the
        // `ON CONFLICT DO NOTHING` reservation is what the loser found.
        expect(await storedEntries()).toHaveLength(1);
        expect(await planRevision(week.plan.id)).toBe(2);

        const actions = await ledgerRows();

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({ action_type: 'log', response_status: 201, plan_revision_after: 2 });
    });

    it('commit one swap between them and answer both with the same stored 200', async () => {
        const body = swapBody(week.alternative.id, 1);

        const [first, second] = await Promise.all([
            commitSwap(USER_ID, week.plan.id, week.breakfastMeal.id, body, NOW),
            commitSwap(USER_ID, week.plan.id, week.breakfastMeal.id, body, NOW),
        ]);

        if (first.kind !== 'ok' || second.kind !== 'ok') {
            throw new Error(`a same-key swap pair was refused: ${JSON.stringify({ first, second })}`);
        }

        expect(first.result.status).toBe(200);
        expect(second.result.status).toBe(200);
        expect(second.result.planRevisionAfter).toBe(first.result.planRevisionAfter);
        expect(second.result.body).toEqual(first.result.body);

        // The meal moved once: one revision bump on the meal, one on the plan.
        const meal = await mealRow(week.breakfastMeal.id);

        expect(meal.recipe_version_id).toBe(week.alternative.id);
        expect(meal.revision).toBe(2);
        expect(await planRevision(week.plan.id)).toBe(2);

        const actions = await ledgerRows();

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({ action_type: 'swap', response_status: 200, plan_revision_after: 2 });
    });
});

/* ---------------------------------------------------------------------------
 * The lock itself, observed from a session that is not holding it
 * ------------------------------------------------------------------------- */

describe('the per-user advisory lock', () => {
    /** Holds the lock in a second session until the returned release is called. */
    const holdUserLock = async (): Promise<{ release: () => void; held: Promise<unknown> }> => {
        const taken = deferred();
        const releaseSignal = deferred();

        const held = contendingClient.$transaction(
            async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('meal-planning:' || ${USER_ID}))`;
                taken.release();
                await releaseSignal.promise;
            },
            { timeout: 20_000 },
        );

        await taken.promise;

        return { release: releaseSignal.release, held };
    };

    it('makes a planned log wait for a lock another session holds, then lets it commit', async () => {
        const lock = await holdUserLock();

        const logging = watch(
            logPlannedMeal(USER_ID, week.plan.id, week.breakfastMeal.id, logBody(week.diaryMealId, 1), NOW),
        );

        await sleep(BLOCK_OBSERVATION_MS);

        // Not merely unfinished: nothing of it is visible, because its
        // transaction has not reached its first write.
        expect(logging.settled()).toBe(false);
        expect(await storedEntries()).toHaveLength(0);
        expect(await ledgerRows()).toHaveLength(0);

        lock.release();
        await lock.held;

        const result = await logging.done;

        expect(result.kind).toBe('ok');
        expect(await storedEntries()).toHaveLength(1);
        expect(await planRevision(week.plan.id)).toBe(2);
    });

    it('does not make it wait when nothing holds the lock', async () => {
        // The counter-proof. Without it the test above could pass because of
        // something incidental to the transaction rather than because of the
        // lock, and a build that had lost `withUserLock` would look exactly as
        // correct.
        const logging = watch(
            logPlannedMeal(USER_ID, week.plan.id, week.breakfastMeal.id, logBody(week.diaryMealId, 1), NOW),
        );

        await sleep(BLOCK_OBSERVATION_MS);

        expect(logging.settled()).toBe(true);
        expect((await logging.done).kind).toBe('ok');
    });

    it('makes a grocery toggle wait for it too, because a toggle must not interleave with a rebuild', async () => {
        const lock = await holdUserLock();

        const toggling = watch(
            toggleGroceryItem(USER_ID, week.plan.id, week.lunchGroceryItem.id, { isChecked: true }, NOW),
        );

        await sleep(BLOCK_OBSERVATION_MS);

        expect(toggling.settled()).toBe(false);
        expect(
            await prisma.grocery_items.count({ where: { meal_plan_id: week.plan.id, is_checked: true } }),
        ).toBe(0);

        lock.release();
        await lock.held;

        expect((await toggling.done).item.isChecked).toBe(true);
        // A check mark is not a plan change, so the plan's revision did not move.
        expect(await planRevision(week.plan.id)).toBe(1);
    });
});

/* ---------------------------------------------------------------------------
 * Two action kinds on one meal
 * ------------------------------------------------------------------------- */

describe('a swap and a log on the same meal', () => {
    /**
     * The two states §0.5.1 allows after this pair, whichever order they ran
     * in: the swap won and no entry exists, or the log won and the meal still
     * holds its original recipe. Both are asserted in full, so "one coherent
     * state" is measured rather than assumed.
     */
    const expectOneCoherentState = async (): Promise<'swap' | 'log'> => {
        const meal = await mealRow(week.breakfastMeal.id);
        const entries = await storedEntries();
        const actions = await ledgerRows();

        expect(actions).toHaveLength(1);
        expect(await planRevision(week.plan.id)).toBe(2);

        if (meal.recipe_version_id === week.alternative.id) {
            expect(entries).toHaveLength(0);
            expect(meal.revision).toBe(2);
            expect(meal.previous_recipe_version_id).toBe(week.breakfast.id);
            expect(actions[0]).toMatchObject({ action_type: 'swap', response_status: 200 });

            return 'swap';
        }

        expect(meal.recipe_version_id).toBe(week.breakfast.id);
        // The log writes no column of the meal row, so its revision is untouched.
        expect(meal.revision).toBe(1);
        expect(entries).toHaveLength(1);
        expect(entries[0].meal_plan_meal_id).toBe(week.breakfastMeal.id);
        expect(actions[0]).toMatchObject({ action_type: 'log', response_status: 201 });

        return 'log';
    };

    it('lets exactly one of them commit when raced, and refuses the other as stale', async () => {
        const results = await Promise.allSettled([
            commitSwap(USER_ID, week.plan.id, week.breakfastMeal.id, swapBody(week.alternative.id, 1), NOW),
            logPlannedMeal(USER_ID, week.plan.id, week.breakfastMeal.id, logBody(week.diaryMealId, 1), NOW),
        ]);

        const { fulfilled, rejected } = splitRace(results);

        // Both pinned revision 1, and the revision is a compare-and-swap under
        // the lock, so the second one through is necessarily stale. WHICH one
        // wins is timing and is deliberately not asserted.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(StalePlanError);
        expect((rejected[0].reason as StalePlanError).currentRevision).toBe(2);

        await expectOneCoherentState();
    });

    it('logs the recipe the slot holds when the swap ran first', async () => {
        const swapped = await commitSwap(
            USER_ID,
            week.plan.id,
            week.breakfastMeal.id,
            swapBody(week.alternative.id, 1),
            NOW,
        );

        expect(swapped.kind).toBe('ok');

        const logged = await logPlannedMeal(
            USER_ID,
            week.plan.id,
            week.breakfastMeal.id,
            logBody(week.diaryMealId, 2),
            NOW,
        );

        expect(logged.kind).toBe('ok');

        const entries = await storedEntries();

        expect(entries).toHaveLength(1);
        // The snapshot is of the recipe the slot held at log time, which is the
        // replacement — the user ate what the card offered.
        expect(entries[0].recipe_version_id).toBe(week.alternative.id);
        expect(await planRevision(week.plan.id)).toBe(3);
        expect(await ledgerRows()).toHaveLength(2);

        const envelope = await readDay();
        const meal = envelope.day.meals.find((candidate) => candidate.id === week.breakfastMeal.id);

        expect(meal?.recipe.versionId).toBe(week.alternative.id);
        expect(meal?.loggedEntries.map((entry) => entry.recipeVersionId)).toEqual([week.alternative.id]);
    });

    it('keeps the eaten meal in the diary when the log ran first and the slot was swapped after', async () => {
        const logged = await logPlannedMeal(
            USER_ID,
            week.plan.id,
            week.breakfastMeal.id,
            logBody(week.diaryMealId, 1),
            NOW,
        );

        expect(logged.kind).toBe('ok');

        const swapped = await commitSwap(
            USER_ID,
            week.plan.id,
            week.breakfastMeal.id,
            swapBody(week.alternative.id, 2),
            NOW,
        );

        expect(swapped.kind).toBe('ok');

        const entries = await storedEntries();
        const meal = await mealRow(week.breakfastMeal.id);

        // Neither lost nor duplicated: the diary keeps what was actually eaten
        // while the slot holds the replacement.
        expect(entries).toHaveLength(1);
        expect(entries[0].recipe_version_id).toBe(week.breakfast.id);
        expect(entries[0].meal_plan_meal_id).toBe(week.breakfastMeal.id);
        expect(meal.recipe_version_id).toBe(week.alternative.id);
        expect(meal.previous_recipe_version_id).toBe(week.breakfast.id);
        expect(await planRevision(week.plan.id)).toBe(3);
        expect(await ledgerRows()).toHaveLength(2);

        const envelope = await readDay();
        const dto = envelope.day.meals.find((candidate) => candidate.id === week.breakfastMeal.id);

        // The logged-then-swapped state the card derives: an entry that
        // references a recipe the slot no longer holds.
        expect(dto?.recipe.versionId).toBe(week.alternative.id);
        expect(dto?.loggedEntries.map((entry) => entry.recipeVersionId)).toEqual([week.breakfast.id]);
    });
});

/* ---------------------------------------------------------------------------
 * A grocery toggle against a swap's grocery rebuild
 * ------------------------------------------------------------------------- */

describe('a grocery toggle and a swap that rebuilds the list', () => {
    /**
     * What one day's swap does to a seven-day list, and what the toggle beside
     * it must survive.
     *
     * Each recipe contributes 100 g of its own food per planned day, so a
     * seven-day week holds 700 g of each. Swapping ONE day's breakfast leaves
     * the outgoing food on the other six days (600 g, a DECREASE, which is
     * never flagged) and introduces the incoming food for one (100 g, a NEW row,
     * which is unchecked). The two untouched slots keep their 700 g exactly —
     * and the check mark the user put on one of them is the thing the rebuild
     * has to preserve.
     *
     * Asserted as one whole value, so a lost row, a duplicated row, a lost
     * check or a spurious flag all fail here.
     */
    const expectReconciledList = async (): Promise<void> => {
        const rows = await groceryStateOf(week.plan.id);
        const byFood = new Map(rows.map((row) => [row.catalogFoodId, row]));

        // The aggregation is keyed by (food, state), so the rebuild reconciles
        // rather than appends: four foods, four rows, no duplicate key.
        expect(rows).toHaveLength(4);
        expect(new Set(rows.map((row) => `${row.catalogFoodId}:${row.foodState}`)).size).toBe(4);

        expect(byFood.get(week.breakfastFood.id)).toEqual({
            catalogFoodId: week.breakfastFood.id,
            foodState: 'cooked',
            quantityGrams: 600,
            isChecked: false,
            isFlagged: false,
            acknowledgedGrams: null,
        });
        expect(byFood.get(week.alternativeFood.id)).toEqual({
            catalogFoodId: week.alternativeFood.id,
            foodState: 'cooked',
            quantityGrams: 100,
            isChecked: false,
            isFlagged: false,
            acknowledgedGrams: null,
        });
        expect(byFood.get(week.lunchFood.id)).toEqual({
            catalogFoodId: week.lunchFood.id,
            foodState: 'cooked',
            quantityGrams: 700,
            // The check survived the rebuild, and its amount did not move, so
            // nothing was flagged and the acknowledged baseline is what the user
            // saw when they checked it.
            isChecked: true,
            isFlagged: false,
            acknowledgedGrams: 700,
        });
        expect(byFood.get(week.dinnerFood.id)).toEqual({
            catalogFoodId: week.dinnerFood.id,
            foodState: 'cooked',
            quantityGrams: 700,
            isChecked: false,
            isFlagged: false,
            acknowledgedGrams: null,
        });

        expect(await planRevision(week.plan.id)).toBe(2);
        expect(await ledgerRows()).toHaveLength(1);
    };

    it('leaves one reconciled list when raced', async () => {
        const results = await Promise.allSettled([
            toggleGroceryItem(USER_ID, week.plan.id, week.lunchGroceryItem.id, { isChecked: true }, NOW),
            commitSwap(USER_ID, week.plan.id, week.breakfastMeal.id, swapBody(week.alternative.id, 1), NOW),
        ]);

        const { fulfilled, rejected } = splitRace<unknown>(results);

        // Both succeed in either order — a check mark carries no revision, so it
        // cannot make the swap stale, and the lock stops them interleaving.
        expect(rejected).toEqual([]);
        expect(fulfilled).toHaveLength(2);

        await expectReconciledList();
    });

    /**
     * The list keyed by each row's ROLE in the scenario rather than by its food
     * id, so two runs over two independently seeded fixtures are comparable —
     * the ids differ by construction, and the roles are what the contract
     * speaks about.
     */
    const groceryStateByRole = async () => {
        const roleOf = new Map([
            [week.breakfastFood.id, 'outgoing recipe'],
            [week.alternativeFood.id, 'incoming recipe'],
            [week.lunchFood.id, 'checked untouched slot'],
            [week.dinnerFood.id, 'untouched slot'],
        ]);

        return (await groceryStateOf(week.plan.id))
            .map(({ catalogFoodId, ...rest }) => ({
                role: roleOf.get(catalogFoodId) ?? `unexpected food ${catalogFoodId}`,
                ...rest,
            }))
            .sort((left, right) => left.role.localeCompare(right.role));
    };

    it('leaves that same list whichever order the two are driven in', async () => {
        // The ordering IS the thing under test here, so it is driven
        // sequentially each way and the two resulting states are compared.
        await toggleGroceryItem(USER_ID, week.plan.id, week.lunchGroceryItem.id, { isChecked: true }, NOW);
        await commitSwap(USER_ID, week.plan.id, week.breakfastMeal.id, swapBody(week.alternative.id, 1), NOW);

        await expectReconciledList();

        const toggleFirst = await groceryStateByRole();

        await truncateFeatureTables();
        week = await seedWeek();

        await commitSwap(USER_ID, week.plan.id, week.breakfastMeal.id, swapBody(week.alternative.id, 1), NOW);
        await toggleGroceryItem(USER_ID, week.plan.id, week.lunchGroceryItem.id, { isChecked: true }, NOW);

        await expectReconciledList();

        expect(await groceryStateByRole()).toEqual(toggleFirst);
    });

    it('reports the reconciled list through the read the client uses', async () => {
        await toggleGroceryItem(USER_ID, week.plan.id, week.lunchGroceryItem.id, { isChecked: true }, NOW);
        await commitSwap(USER_ID, week.plan.id, week.breakfastMeal.id, swapBody(week.alternative.id, 1), NOW);

        // Read with no reference instant, which is what a client does — the
        // parameter defaults to `new Date()`. It matters here because this is
        // the one assertion in the file that depends on the swap's ledger row
        // being VISIBLE to the read: `loadLastSwapContext` bounds that lookup
        // with `created_at <= now`, and `meal_plan_actions.created_at` is
        // stamped by the database clock rather than by the `now` the write was
        // driven with. Passing the suite's fixed NOW (12:00Z) therefore hid the
        // row from the banner on any run that happened after midday UTC.
        const list = await getGroceryList(USER_ID, week.plan.id);

        expect(list.totalCount).toBe(4);
        expect(list.checkedCount).toBe(1);
        expect(list.checkedItems.map((item) => item.catalogFoodId)).toEqual([week.lunchFood.id]);
        // The list changed under the user because of a swap, which is what the
        // banner exists to say.
        expect(list.banner?.code).toBe('updated_after_swap');
    });
});

/* ---------------------------------------------------------------------------
 * Every write path against a plan that has been replaced
 * ------------------------------------------------------------------------- */

describe('a superseded plan addressed by its old id and old revision', () => {
    /** The replaced week, its successor, and the ids each write path needs. */
    const seedSupersededWeek = async () => {
        const superseded = await makePlan(USER_ID, {
            today: TODAY,
            status: 'superseded',
            slots: [{ slot: 'breakfast', slot_time: '08:00', recipeVersionId: week.breakfast.id }],
            dayCount: 2,
        });
        const replacement = await makePlan(USER_ID, {
            startDate: addDaysToDayKey(PLAN_START_DAY_KEY, 14),
            replaced_plan_id: superseded.id,
            slots: [{ slot: 'breakfast', slot_time: '08:00', recipeVersionId: week.breakfast.id }],
            dayCount: 2,
        });

        await buildGroceries(superseded.id);

        const groceryItem = await prisma.grocery_items.findFirstOrThrow({
            where: { meal_plan_id: superseded.id, user_id: USER_ID },
        });

        return {
            superseded,
            replacement,
            meal: superseded.meal_plan_days[0].meal_plan_meals[0],
            dayKey: superseded.meal_plan_days[0].date.toISOString().slice(0, 10),
            groceryItem,
        };
    };

    it('refuses the log, the swap, the regeneration, the toggle and uncheck-all alike, and writes nothing', async () => {
        const replaced = await seedSupersededWeek();
        const entriesBefore = await prisma.meal_entries.count({ where: { user_id: USER_ID } });
        const actionsBefore = await prisma.meal_plan_actions.count({ where: { user_id: USER_ID } });

        const writes: { name: string; attempt: () => Promise<unknown> }[] = [
            {
                name: 'log',
                attempt: () =>
                    logPlannedMeal(
                        USER_ID,
                        replaced.superseded.id,
                        replaced.meal.id,
                        { ...logBody(week.diaryMealId, 1), date: replaced.dayKey },
                        NOW,
                    ),
            },
            {
                name: 'swap',
                attempt: () =>
                    commitSwap(
                        USER_ID,
                        replaced.superseded.id,
                        replaced.meal.id,
                        swapBody(week.alternative.id, 1),
                        NOW,
                    ),
            },
            {
                name: 'regenerate',
                attempt: () => regeneratePlan(USER_ID, replaced.superseded.id, regenerateBody(1), NOW),
            },
            {
                name: 'grocery toggle',
                attempt: () =>
                    toggleGroceryItem(
                        USER_ID,
                        replaced.superseded.id,
                        replaced.groceryItem.id,
                        { isChecked: true },
                        NOW,
                    ),
            },
            {
                name: 'uncheck-all',
                attempt: () => uncheckAllGroceries(USER_ID, replaced.superseded.id, NOW),
            },
        ];

        for (const write of writes) {
            const refusal = await write.attempt().catch((error: unknown) => error);

            expect(refusal).toBeInstanceOf(PlanNotActiveError);
            // Every one of them points at the week that replaced this one, so a
            // stale screen can follow the replacement instead of retrying.
            expect((refusal as PlanNotActiveError).data).toEqual({
                replacementPlanId: replaced.replacement.id,
            });
        }

        // Nothing any of the five attempted survived.
        expect(await prisma.meal_entries.count({ where: { user_id: USER_ID } })).toBe(entriesBefore);
        expect(await prisma.meal_plan_actions.count({ where: { user_id: USER_ID } })).toBe(actionsBefore);
        expect(await planRevision(replaced.superseded.id)).toBe(1);
        expect((await mealRow(replaced.meal.id)).recipe_version_id).toBe(week.breakfast.id);
        expect(
            await prisma.grocery_items.count({
                where: { meal_plan_id: replaced.superseded.id, is_checked: true },
            }),
        ).toBe(0);
        // And the successor was not touched either.
        expect(await planRevision(replaced.replacement.id)).toBe(1);
    });

    it('still accepts the same writes against the week that replaced it', async () => {
        // The counter-proof: the refusals above are about the plan's state, not
        // about the writes being broken.
        const replaced = await seedSupersededWeek();
        const replacementMeal = replaced.replacement.meal_plan_days[0].meal_plan_meals[0];
        const replacementDayKey = replaced.replacement.meal_plan_days[0].date.toISOString().slice(0, 10);

        // The replacement week starts two weeks after the fixture week, so its
        // own days are in the future; a plan is writable until its last day has
        // passed, which is what this `now` reflects.
        const withinReplacement = new Date(`${replacementDayKey}T12:00:00.000Z`);
        const bucket = await asUser(request.get(`/api/macros/${replacementDayKey}`), { uid: USER_ID })
            .expect(200)
            .then(
                (response) =>
                    (response.body as { meals: { id: string; name: string }[] }).meals.find(
                        (meal) => meal.name === 'Breakfast',
                    )?.id,
            );

        if (bucket === undefined) {
            throw new Error('the replacement week has no Breakfast bucket');
        }

        const logged = await logPlannedMeal(
            USER_ID,
            replaced.replacement.id,
            replacementMeal.id,
            { ...logBody(bucket, 1), date: replacementDayKey },
            withinReplacement,
        );

        expect(logged.kind).toBe('ok');
        expect(await planRevision(replaced.replacement.id)).toBe(2);
        expect(await planRevision(replaced.superseded.id)).toBe(1);
    });
});

/* ---------------------------------------------------------------------------
 * Two clients saving the revisioned state
 * ------------------------------------------------------------------------- */

describe('two clients saving the same revisioned state', () => {
    it('lets exactly one preference save win and refuses the other as stale', async () => {
        const results = await Promise.allSettled([
            savePreferences(USER_ID, { cookingTimeLimitMin: 15, timeZone: 'UTC', expectedRevision: 1 }, NOW),
            savePreferences(USER_ID, { cookingTimeLimitMin: 45, timeZone: 'UTC', expectedRevision: 1 }, NOW),
        ]);

        const { fulfilled, rejected } = splitRace(results);

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0].reason as Error).name).toBe('StaleRevisionError');
        expect((rejected[0].reason as { data: unknown }).data).toEqual({ currentRevision: 2 });

        if (fulfilled[0].value.kind !== 'ok') {
            throw new Error(`the winning save was refused: ${JSON.stringify(fulfilled[0].value)}`);
        }

        const stored = await prisma.meal_plan_preferences.findUniqueOrThrow({
            where: { user_id: USER_ID },
            select: { revision: true, cooking_time_limit_min: true },
        });

        // Exactly one update landed: the revision moved once, and the stored
        // value is the winner's rather than a blend of the two.
        expect(stored.revision).toBe(2);
        expect([15, 45]).toContain(stored.cooking_time_limit_min);
        expect(fulfilled[0].value.response.preferences.cookingTimeLimitMin).toBe(
            stored.cooking_time_limit_min,
        );
    });

    it('lets exactly one target save win and refuses the other as stale', async () => {
        const manual = (calories: number): Record<string, unknown> => ({
            source: 'manual',
            calories,
            protein: FIXTURE_TARGETS.protein,
            carbs: FIXTURE_TARGETS.carbs,
            fat: FIXTURE_TARGETS.fat,
            expectedTargetsRevision: 1,
        });

        const results = await Promise.allSettled([
            saveTargets(USER_ID, manual(1900), NOW),
            saveTargets(USER_ID, manual(2300), NOW),
        ]);

        const { fulfilled, rejected } = splitRace(results);

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0].reason as Error).name).toBe('StaleTargetsError');
        expect((rejected[0].reason as { currentRevision: number }).currentRevision).toBe(2);

        const preferences = await prisma.meal_plan_preferences.findUniqueOrThrow({
            where: { user_id: USER_ID },
            select: { targets_revision: true, confirmed_targets: true, target_source: true },
        });
        const user = await prisma.users.findUniqueOrThrow({
            where: { id: USER_ID },
            select: { target_calories: true },
        });

        expect(preferences.targets_revision).toBe(2);
        expect(preferences.target_source).toBe('manual');
        expect([1900, 2300]).toContain(user.target_calories);
        // The two halves of the write agree, so no client can be shown a
        // confirmed target the users row does not hold.
        expect((preferences.confirmed_targets as { calories: number }).calories).toBe(user.target_calories);
    });
});

/* ---------------------------------------------------------------------------
 * A lost response beside another client's write
 * ------------------------------------------------------------------------- */

describe('a response lost after the write committed', () => {
    it('replays the first client’s stored body although a second client has since logged the same meal', async () => {
        // The transport-loss seam §0.9.2 describes (`postCommitAbort` +
        // `res.socket.destroy()`) lives in the handler, which does not exist at
        // this checkpoint; `api/fault.test.ts` owns it. What a lost response
        // leaves BEHIND is service state, and that is what this asserts: the
        // action committed, the client never saw the answer, and its retry
        // carries the same key and the same body — including the revision it
        // pinned before any of this.
        const firstClientBody = logBody(week.diaryMealId, 1);
        const committed = await logPlannedMeal(
            USER_ID,
            week.plan.id,
            week.breakfastMeal.id,
            firstClientBody,
            NOW,
        );

        if (committed.kind !== 'ok') {
            throw new Error(`the first log was refused: ${JSON.stringify(committed)}`);
        }

        // A second client of the same user logs the same meal with ITS OWN key.
        // Two keys are two intents by design, so this is a second entry rather
        // than a duplicate.
        const secondClient = await logPlannedMeal(
            USER_ID,
            week.plan.id,
            week.breakfastMeal.id,
            logBody(week.diaryMealId, 2),
            NOW,
        );

        expect(secondClient.kind).toBe('ok');
        expect(await planRevision(week.plan.id)).toBe(3);

        // The first client's retry. Its pinned revision is two behind, which is
        // exactly the case the replay-before-revision-check ordering exists for.
        const replay = await logPlannedMeal(
            USER_ID,
            week.plan.id,
            week.breakfastMeal.id,
            firstClientBody,
            NOW,
        );

        if (replay.kind !== 'ok') {
            throw new Error(`the replay was refused: ${JSON.stringify(replay)}`);
        }

        expect(replay.result.status).toBe(committed.result.status);
        expect(replay.result.planRevisionAfter).toBe(committed.result.planRevisionAfter);
        expect(replay.result.body).toEqual(committed.result.body);
        // The stored body still reports the revision the FIRST write produced,
        // not the one the plan has now.
        expect(replay.result.planRevisionAfter).toBe(2);

        // Two writes, two ledger rows, and the replay was neither.
        const entries = await storedEntries();

        expect(entries).toHaveLength(2);
        expect(await ledgerRows()).toHaveLength(2);
        expect(await planRevision(week.plan.id)).toBe(3);

        // The day the client refetches shows both entries, in the order the
        // read declares — `logged_at` ascending then `id` — computed here from
        // the stored rows, so this holds whether or not the two transactions
        // share a timestamp.
        const envelope = await readDay();
        const meal = envelope.day.meals.find((candidate) => candidate.id === week.breakfastMeal.id);
        const expectedOrder = [...entries]
            .sort((left, right) =>
                left.logged_at.getTime() === right.logged_at.getTime()
                    ? left.id.localeCompare(right.id)
                    : left.logged_at.getTime() - right.logged_at.getTime(),
            )
            .map((entry) => entry.id);

        expect(meal?.loggedEntries.map((entry) => entry.entryId)).toEqual(expectedOrder);
    });

    it('replays a swap’s stored body although a second client has since swapped the meal again', async () => {
        const firstClientBody = swapBody(week.alternative.id, 1);
        const committed = await commitSwap(
            USER_ID,
            week.plan.id,
            week.breakfastMeal.id,
            firstClientBody,
            NOW,
        );

        if (committed.kind !== 'ok') {
            throw new Error(`the first swap was refused: ${JSON.stringify(committed)}`);
        }

        // The second client moves the same slot on to the other candidate,
        // which is a swap in its own right and moves the plan on again.
        const secondClient = await commitSwap(
            USER_ID,
            week.plan.id,
            week.breakfastMeal.id,
            swapBody(week.secondAlternative.id, 2),
            NOW,
        );

        expect(secondClient.kind).toBe('ok');
        expect((await mealRow(week.breakfastMeal.id)).recipe_version_id).toBe(
            week.secondAlternative.id,
        );

        const replay = await commitSwap(
            USER_ID,
            week.plan.id,
            week.breakfastMeal.id,
            firstClientBody,
            NOW,
        );

        if (replay.kind !== 'ok') {
            throw new Error(`the swap replay was refused: ${JSON.stringify(replay)}`);
        }

        // The stored answer, unchanged — and it did NOT re-apply the swap, so
        // the second client's state stands.
        expect(replay.result.status).toBe(200);
        expect(replay.result.planRevisionAfter).toBe(committed.result.planRevisionAfter);
        expect(replay.result.body).toEqual(committed.result.body);
        expect((await mealRow(week.breakfastMeal.id)).recipe_version_id).toBe(
            week.secondAlternative.id,
        );
        expect(await planRevision(week.plan.id)).toBe(3);
        expect(await ledgerRows()).toHaveLength(2);
    });
});

/* ---------------------------------------------------------------------------
 * A generation retried after the user's local midnight
 * ------------------------------------------------------------------------- */

describe('a generation retried after the user’s local midnight', () => {
    /**
     * The same wall-clock time, one day on. The planning user's stored zone is
     * UTC, so this moves `today` from {@link TODAY} to the next day and the
     * start-date window's LOWER bound with it — leaving the start date the
     * committed request carries behind `window.earliest`.
     */
    const NEXT_DAY_NOW = new Date(`${addDaysToDayKey(TODAY, 1)}T12:00:00.000Z`);

    /** What a refusal looks like when it comes back, so the branch is readable. */
    const refusalOf = (result: Awaited<ReturnType<typeof generatePlan>>) =>
        result.kind === 'error' ? result : null;

    it('replays its stored 201 rather than refusing the start date the clock moved under it', async () => {
        await seedPlannableWorld();

        // The client's one intent: one key, one body, held so the retry is
        // byte-identical to the request that committed.
        const intent = generateBody(TODAY);
        const committed = await generatePlan(PLANNING_USER_ID, intent, NOW);

        if (committed.kind !== 'ok') {
            throw new Error(`the generation was refused: ${JSON.stringify(committed)}`);
        }

        expect(committed.result.status).toBe(201);

        const published = await theOnlyPlanOf(PLANNING_USER_ID);

        expectWholeWeek(published);

        // THE COUNTER-PROOF, and the reason this case exists. The very same body
        // sent with a NEW key after midnight is refused `invalid_request`,
        // because its start date is now behind the window's lower bound. That is
        // the refusal the committed key must NOT receive.
        const newKey = await generatePlan(
            PLANNING_USER_ID,
            { ...intent, idempotencyKey: randomUUID() },
            NEXT_DAY_NOW,
        );

        expect(refusalOf(newKey)).toMatchObject({
            kind: 'error',
            code: 'invalid_request',
            details: [{ field: 'startDate', code: 'out_of_range' }],
        });

        // And it reserved nothing: the preflight's transaction rolled back, so
        // the only ledger row is still the publication's.
        expect(await ledgerRows(PLANNING_USER_ID)).toHaveLength(1);

        // The retry the client actually sends — same key, same body, the clock
        // a day on — is answered by the ledger, before the window, the setup
        // status the publication itself set to `completed`, the pinned revisions
        // or a fresh search can refuse it (§0.5.1).
        const replay = await generatePlan(PLANNING_USER_ID, intent, NEXT_DAY_NOW);

        if (replay.kind !== 'ok') {
            throw new Error(`the same-key retry was refused: ${JSON.stringify(replay)}`);
        }

        expect(replay.result.status).toBe(committed.result.status);
        expect(replay.result.planRevisionAfter).toBe(committed.result.planRevisionAfter);
        expect(replay.result.body).toEqual(committed.result.body);
        // §0.9.2's "byte-for-byte": the replayed body comes back out of the
        // `jsonb` column while the first came from memory, and the two texts
        // agree because both serialise a canonically ordered value
        // (`mealPlanningAction.logic.ts::canonicalizeResponseBody`).
        expect(JSON.stringify(replay.result.body)).toBe(JSON.stringify(committed.result.body));

        // Nothing was written twice: one plan, one whole week, one ledger row.
        const afterReplay = await theOnlyPlanOf(PLANNING_USER_ID);

        expect(afterReplay.id).toBe(published.id);
        expect(afterReplay.revision).toBe(1);
        expect(afterReplay.status).toBe(ACTIVE_PLAN);
        expectWholeWeek(afterReplay);
        expect(mealsOf(afterReplay)).toHaveLength(PLAN_DAY_COUNT * 3);

        const actions = await ledgerRows(PLANNING_USER_ID);

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            action_type: 'generate',
            idempotency_key: intent.idempotencyKey,
            response_status: 201,
            plan_revision_after: 1,
            meal_plan_id: published.id,
        });
        await expectOneActivePlanPerStartDate(PLANNING_USER_ID);
    });

    it('still refuses the used key carrying a different body, before any stateful check', async () => {
        await seedPlannableWorld();

        const intent = generateBody(TODAY);

        expect((await generatePlan(PLANNING_USER_ID, intent, NOW)).kind).toBe('ok');

        // Same key, different start date: a different request wearing a used
        // key, which is `409 idempotency_conflict` and not a replay — and it is
        // decided by the fingerprint rather than by the window, so it holds on
        // the far side of midnight too.
        const conflict = await outcomeOf(() =>
            generatePlan(
                PLANNING_USER_ID,
                { ...intent, startDate: addDaysToDayKey(TODAY, 7) },
                NEXT_DAY_NOW,
            ),
        );

        expect(conflict).toBeInstanceOf(IdempotencyConflictError);

        // One plan, one ledger row: the conflict wrote nothing.
        const published = await theOnlyPlanOf(PLANNING_USER_ID);

        expect(dayKeyOf(published.start_date)).toBe(TODAY);
        expect(await ledgerRows(PLANNING_USER_ID)).toHaveLength(1);
    });

    it('refuses a malformed body with no idempotency key before it reaches the ledger', async () => {
        await seedPlannableWorld();

        // The syntax half of the parse runs first precisely so a body with no
        // key never reserves one. There is nothing to fingerprint, so there is
        // nothing to reserve, and the ledger stays empty.
        const refused = await generatePlan(
            PLANNING_USER_ID,
            { startDate: TODAY, expectedPreferencesRevision: 1, expectedTargetsRevision: 1 },
            NOW,
        );

        expect(refusalOf(refused)).toMatchObject({
            kind: 'error',
            code: 'invalid_request',
            details: [{ field: 'idempotencyKey', code: 'required' }],
        });
        expect(await ledgerRows(PLANNING_USER_ID)).toHaveLength(0);
        expect(await plansOf(PLANNING_USER_ID)).toHaveLength(0);
    });
});

/* ---------------------------------------------------------------------------
 * Two generations for weeks that overlap
 * ------------------------------------------------------------------------- */

describe('two generations for weeks that overlap', () => {
    /** Starts today, so the week it publishes is the CURRENT one. */
    const FIRST_WEEK = TODAY;

    /** Starts tomorrow, so it overlaps the first week by six of its seven days. */
    const SECOND_WEEK = addDaysToDayKey(TODAY, 1);

    /**
     * One published week, whole, and a refusal that NAMES it.
     *
     * Which of the two start dates survives is timing and is deliberately not
     * asserted; that exactly one did, that it is a complete week, and that the
     * other request was told which plan it collided with are the contract
     * (§0.5.2's `409 plan_overlap {conflictingPlanId}`).
     */
    const expectOnePublishedWeek = async (refusal: unknown): Promise<PlanWithMeals> => {
        const published = await theOnlyPlanOf(PLANNING_USER_ID);

        expect([FIRST_WEEK, SECOND_WEEK]).toContain(dayKeyOf(published.start_date));
        expect(published.status).toBe(ACTIVE_PLAN);
        expect(published.revision).toBe(1);
        expect(published.replaced_plan_id).toBeNull();
        expectWholeWeek(published);

        expect(refusal).toBeInstanceOf(PlanOverlapError);
        expect((refusal as PlanOverlapError).conflictingPlanId).toBe(published.id);

        // The refused generation reserved a ledger row inside the transaction
        // that then rolled back, so the week that published is the only action
        // on record.
        const actions = await ledgerRows(PLANNING_USER_ID);

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            action_type: 'generate',
            response_status: 201,
            plan_revision_after: 1,
            meal_plan_id: published.id,
        });

        await expectOneActivePlanPerStartDate(PLANNING_USER_ID);

        return published;
    };

    it('publishes exactly one of them when raced, and names it in the other’s refusal', async () => {
        await seedPlannableWorld();

        const results = await Promise.allSettled([
            generatePlan(PLANNING_USER_ID, generateBody(FIRST_WEEK), NOW),
            generatePlan(PLANNING_USER_ID, generateBody(SECOND_WEEK), NOW),
        ]);

        const { fulfilled, rejected } = splitRace(results);

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(fulfilled[0].value.kind).toBe('ok');

        await expectOnePublishedWeek(rejected[0].reason);
    });

    it('refuses the second of them in either sequential order', async () => {
        // The ordering is the thing under test here, so it is driven
        // sequentially each way: whichever week is asked for first is the one
        // that survives, and the second is refused against it.
        const world = await seedPlannableWorld();

        expect((await generatePlan(PLANNING_USER_ID, generateBody(FIRST_WEEK), NOW)).kind).toBe('ok');

        const secondRefusal = await outcomeOf(() =>
            generatePlan(PLANNING_USER_ID, generateBody(SECOND_WEEK), NOW),
        );
        const publishedFirst = await expectOnePublishedWeek(secondRefusal);

        expect(dayKeyOf(publishedFirst.start_date)).toBe(FIRST_WEEK);

        await truncateFeatureTables();
        week = await seedWeek();
        await seedPlannableWorld();

        expect((await generatePlan(PLANNING_USER_ID, generateBody(SECOND_WEEK), NOW)).kind).toBe('ok');

        const firstRefusal = await outcomeOf(() =>
            generatePlan(PLANNING_USER_ID, generateBody(FIRST_WEEK), NOW),
        );
        const publishedSecond = await expectOnePublishedWeek(firstRefusal);

        expect(dayKeyOf(publishedSecond.start_date)).toBe(SECOND_WEEK);
        // Same pool both times, so the two runs differ only in the order the
        // two requests were made.
        expect(world.pool).toHaveLength(POOL_RECIPE_COUNT);
    });
});

/* ---------------------------------------------------------------------------
 * A generation while an upcoming week already stands
 * ------------------------------------------------------------------------- */

describe('a generation while an upcoming week already stands', () => {
    /** The week after the current one: the first week that is UPCOMING. */
    const FIRST_UPCOMING = addDaysToDayKey(TODAY, 7);

    /** A free week beyond it, overlapping nothing — refused only for being a SECOND upcoming plan. */
    const SECOND_UPCOMING = addDaysToDayKey(TODAY, 14);

    /** A current week for the planning user, so `FIRST_UPCOMING` is upcoming rather than current. */
    const seedCurrentWeek = async (world: PlannableWorld): Promise<FixtureMealPlan> =>
        makePlan(PLANNING_USER_ID, {
            startDate: TODAY,
            recipeVersionId: world.pool[0].version.id,
        });

    it('refuses a second upcoming week as upcoming_exists and leaves the first one intact', async () => {
        const world = await seedPlannableWorld();
        const current = await seedCurrentWeek(world);

        expect((await generatePlan(PLANNING_USER_ID, generateBody(FIRST_UPCOMING), NOW)).kind).toBe('ok');

        const upcoming = (await plansOf(PLANNING_USER_ID)).find(
            (plan) => dayKeyOf(plan.start_date) === FIRST_UPCOMING,
        );

        if (upcoming === undefined) {
            throw new Error('the first upcoming week was not published');
        }

        const refusal = await outcomeOf(() =>
            generatePlan(PLANNING_USER_ID, generateBody(SECOND_UPCOMING), NOW),
        );

        // No id travels with this one: §0.5.2 has the client reach the standing
        // upcoming plan through the current-plan response instead.
        expect(refusal).toBeInstanceOf(UpcomingExistsError);

        const plans = await plansOf(PLANNING_USER_ID);

        expect(plans.map((plan) => dayKeyOf(plan.start_date))).toEqual([TODAY, FIRST_UPCOMING]);
        expect(plans.map((plan) => plan.id)).toEqual([current.id, upcoming.id]);
        // The first upcoming week is exactly as it was published: same id, same
        // revision, still active, still whole.
        expect(upcoming.revision).toBe(1);
        expect(upcoming.status).toBe(ACTIVE_PLAN);
        expectWholeWeek(upcoming);
        expect(await ledgerRows(PLANNING_USER_ID)).toHaveLength(1);
        await expectOneActivePlanPerStartDate(PLANNING_USER_ID);
    });

    it('publishes exactly one of two upcoming weeks when they are raced', async () => {
        const world = await seedPlannableWorld();
        const current = await seedCurrentWeek(world);

        const results = await Promise.allSettled([
            generatePlan(PLANNING_USER_ID, generateBody(FIRST_UPCOMING), NOW),
            generatePlan(PLANNING_USER_ID, generateBody(SECOND_UPCOMING), NOW),
        ]);

        const { fulfilled, rejected } = splitRace(results);

        // The two weeks do not overlap, so the only rule that can refuse either
        // is the at-most-one-upcoming rule — and it refuses exactly one of them
        // whichever reached the lock first.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(fulfilled[0].value.kind).toBe('ok');
        expect(rejected[0].reason).toBeInstanceOf(UpcomingExistsError);

        const plans = await plansOf(PLANNING_USER_ID);
        const published = plans.filter((plan) => plan.id !== current.id);

        expect(published).toHaveLength(1);
        expect([FIRST_UPCOMING, SECOND_UPCOMING]).toContain(dayKeyOf(published[0].start_date));
        expectWholeWeek(published[0]);
        expect(await ledgerRows(PLANNING_USER_ID)).toHaveLength(1);
        await expectOneActivePlanPerStartDate(PLANNING_USER_ID);
    });
});

/* ---------------------------------------------------------------------------
 * A preference save racing a generation
 * ------------------------------------------------------------------------- */

describe('a preference save racing a generation', () => {
    /**
     * The saved limit, chosen to be one no pool recipe can satisfy: every pool
     * recipe totals the factory's 25 minutes, so a week built under the saved
     * limit could not contain any of them.
     *
     * That is what makes "published against the revision it snapshotted"
     * MEASURABLE rather than asserted: a plan whose meals take 25 minutes is a
     * plan built while the limit was still the fixture's 30, and no ordering of
     * this race could have produced it from the saved preferences.
     */
    const SAVED_COOKING_LIMIT = 15;

    // `timeZone` is a required member of the full-save envelope — the server derives the request's "today"
    // from the zone the request carried, never from the stored one — and it restates this user's stored
    // 'UTC', so the day key either ordering resolves is the same one the fixture was built with.
    const savedPreferences = () => ({ cookingTimeLimitMin: SAVED_COOKING_LIMIT, timeZone: 'UTC', expectedRevision: 1 });

    /** The stored preference row, which either ordering leaves at the saved value. */
    const expectSavedPreferences = async (): Promise<void> => {
        const stored = await prisma.meal_plan_preferences.findUniqueOrThrow({
            where: { user_id: PLANNING_USER_ID },
            select: { revision: true, cooking_time_limit_min: true },
        });

        // The save cannot lose this race: it pins revision 1 and a generation
        // never moves the preferences revision, so it commits in every ordering
        // and the only question is whether the generation survives it.
        expect(stored).toEqual({ revision: 2, cooking_time_limit_min: SAVED_COOKING_LIMIT });
    };

    /**
     * Either of the two states §0.5.1 allows after this pair, asserted in full
     * and from the database: a week published against the revision the search
     * snapshotted, or no week at all and a `stale_revision` refusal carrying
     * the revisions that moved.
     */
    const expectOneCoherentOutcome = async (generation: unknown): Promise<'published' | 'refused'> => {
        const plans = await plansOf(PLANNING_USER_ID);

        await expectSavedPreferences();

        if (plans.length === 0) {
            expect(generation).toBeInstanceOf(StaleRevisionError);
            expect((generation as StaleRevisionError).data).toEqual({
                preferencesRevision: 2,
                targetsRevision: 1,
            });
            expect(await ledgerRows(PLANNING_USER_ID)).toHaveLength(0);

            return 'refused';
        }

        expect(plans).toHaveLength(1);

        const published = plans[0];

        expect((generation as { kind?: string }).kind).toBe('ok');
        // The two inputs the plan row records are the two the request pinned
        // and the search read, so the week is attributable to them.
        expect(published.preferences_revision).toBe(1);
        expect(published.targets_revision).toBe(1);
        expectWholeWeek(published);

        const planned = await prisma.recipe_versions.findMany({
            where: { id: { in: [...new Set(mealsOf(published).map((meal) => meal.recipe_version_id))] } },
            select: { id: true, total_minutes: true },
        });

        expect(planned.length).toBeGreaterThan(0);

        for (const version of planned) {
            expect(version.total_minutes).toBeGreaterThan(SAVED_COOKING_LIMIT);
        }

        expect(await ledgerRows(PLANNING_USER_ID)).toHaveLength(1);

        return 'published';
    };

    it('either publishes against the revision it snapshotted or is refused as stale, when raced', async () => {
        await seedPlannableWorld();

        const results = await Promise.allSettled([
            savePreferences(PLANNING_USER_ID, savedPreferences(), NOW),
            generatePlan(PLANNING_USER_ID, generateBody(TODAY), NOW),
        ]);

        const [save, generation] = results;

        if (save.status !== 'fulfilled') {
            throw new Error(`the preference save was refused: ${JSON.stringify(save.reason)}`);
        }

        expect(save.value.kind).toBe('ok');

        const outcome = await expectOneCoherentOutcome(
            generation.status === 'fulfilled' ? generation.value : generation.reason,
        );

        expect(['published', 'refused']).toContain(outcome);
    });

    it('refuses the generation when the save is driven first, and publishes when it is driven second', async () => {
        await seedPlannableWorld();

        expect((await savePreferences(PLANNING_USER_ID, savedPreferences(), NOW)).kind).toBe('ok');

        expect(
            await expectOneCoherentOutcome(
                await outcomeOf(() => generatePlan(PLANNING_USER_ID, generateBody(TODAY), NOW)),
            ),
        ).toBe('refused');

        await truncateFeatureTables();
        week = await seedWeek();
        await seedPlannableWorld();

        const generation = await outcomeOf(() =>
            generatePlan(PLANNING_USER_ID, generateBody(TODAY), NOW),
        );

        expect((await savePreferences(PLANNING_USER_ID, savedPreferences(), NOW)).kind).toBe('ok');
        expect(await expectOneCoherentOutcome(generation)).toBe('published');
    });
});

/* ---------------------------------------------------------------------------
 * A regeneration and a swap on one plan
 * ------------------------------------------------------------------------- */

describe('a regeneration and a swap on one plan', () => {
    type PlanningWeek = Awaited<ReturnType<typeof seedPlanningWeek>>;

    /**
     * The two states §0.5.1 allows after this pair, whichever order the two ran
     * in, asserted in full from the database — and reported back, so a case
     * that DROVE the order can additionally assert which one it got.
     *
     * Both are coherent weeks rather than "one of the writes happened": a
     * regeneration leaves a superseded week linked to its successor and an
     * untouched meal, a swap leaves one week whose meal moved once. Nothing
     * here names a winner.
     */
    const expectOneSurvivingState = async (
        seeded: PlanningWeek,
        refusal: unknown,
    ): Promise<'regenerated' | 'swapped'> => {
        const plans = await plansOf(PLANNING_USER_ID);
        const meal = await mealRow(seeded.meal.id);
        const actions = await ledgerRows(PLANNING_USER_ID);
        const replacement = plans.find((plan) => plan.replaced_plan_id === seeded.plan.id);

        expect(actions).toHaveLength(1);
        await expectOneActivePlanPerStartDate(PLANNING_USER_ID);
        await expectIntactReplacementChains(PLANNING_USER_ID);

        if (replacement !== undefined) {
            const superseded = plans.find((plan) => plan.id === seeded.plan.id);

            expect(plans).toHaveLength(2);
            expect(superseded?.status).toBe(SUPERSEDED_PLAN);
            // The supersede is a compare-and-swap on the revision the request
            // pinned, so the replaced week's revision moved exactly once.
            expect(superseded?.revision).toBe(2);
            expect(dayKeyOf(replacement.start_date)).toBe(dayKeyOf(seeded.plan.start_date));
            expect(replacement.status).toBe(ACTIVE_PLAN);
            expect(replacement.revision).toBe(1);
            expectWholeWeek(replacement);
            // The swap never landed: the old week's meal still holds what it was
            // published with, at its first revision and with no swap stamp.
            expect(meal.recipe_version_id).toBe(seeded.meal.recipe_version_id);
            expect(meal.revision).toBe(1);
            expect(meal.previous_recipe_version_id).toBeNull();
            expect(meal.swapped_at).toBeNull();
            expect(refusal).toBeInstanceOf(PlanNotActiveError);
            // Status is judged before the revision, so the refused swap is told
            // where the current week is rather than which revision to refetch.
            expect((refusal as PlanNotActiveError).data).toEqual({ replacementPlanId: replacement.id });
            expect(actions[0]).toMatchObject({
                action_type: 'regenerate',
                response_status: 201,
                plan_revision_after: 1,
                meal_plan_id: replacement.id,
            });

            return 'regenerated';
        }

        expect(plans).toHaveLength(1);
        expect(plans[0].id).toBe(seeded.plan.id);
        expect(plans[0].status).toBe(ACTIVE_PLAN);
        expect(meal.recipe_version_id).toBe(seeded.candidate.recipeVersionId);
        expect(meal.portion_multiplier).toBe(seeded.candidate.portionMultiplier);
        expect(meal.revision).toBe(2);
        expect(meal.previous_recipe_version_id).toBe(seeded.meal.recipe_version_id);
        expect(await planRevision(seeded.plan.id)).toBe(2);
        expect(refusal).toBeInstanceOf(StalePlanError);
        expect((refusal as StalePlanError).currentRevision).toBe(2);
        expect(actions[0]).toMatchObject({
            action_type: 'swap',
            response_status: 200,
            plan_revision_after: 2,
            meal_plan_id: seeded.plan.id,
            meal_plan_meal_id: seeded.meal.id,
        });

        return 'swapped';
    };

    it('lets exactly one of them commit when raced, and refuses the other', async () => {
        const seeded = await seedPlanningWeek(await seedPlannableWorld());

        const results = await Promise.allSettled([
            regeneratePlan(PLANNING_USER_ID, seeded.plan.id, regenerateBody(1), NOW),
            commitSwap(
                PLANNING_USER_ID,
                seeded.plan.id,
                seeded.meal.id,
                swapBody(seeded.candidate.recipeVersionId, 1, seeded.candidate.portionMultiplier),
                NOW,
            ),
        ]);

        const { fulfilled, rejected } = splitRace<unknown>(results);

        // Both pinned revision 1 of the same plan under one advisory lock, so
        // the second one through is necessarily refused — as stale if the swap
        // won, as not-active if the regeneration did.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        await expectOneSurvivingState(seeded, rejected[0].reason);
    });

    it('refuses the swap after a regeneration, and the regeneration after a swap', async () => {
        // The ordering is the thing under test, so it is driven sequentially
        // each way and each resulting state is asserted in full.
        const regeneratedFirst = await seedPlanningWeek(await seedPlannableWorld());

        expect(
            (await regeneratePlan(PLANNING_USER_ID, regeneratedFirst.plan.id, regenerateBody(1), NOW)).kind,
        ).toBe('ok');

        const refusedSwap = await outcomeOf(() =>
            commitSwap(
                PLANNING_USER_ID,
                regeneratedFirst.plan.id,
                regeneratedFirst.meal.id,
                swapBody(
                    regeneratedFirst.candidate.recipeVersionId,
                    1,
                    regeneratedFirst.candidate.portionMultiplier,
                ),
                NOW,
            ),
        );

        expect(await expectOneSurvivingState(regeneratedFirst, refusedSwap)).toBe('regenerated');

        await truncateFeatureTables();
        week = await seedWeek();

        const swappedFirst = await seedPlanningWeek(await seedPlannableWorld());

        expect(
            (
                await commitSwap(
                    PLANNING_USER_ID,
                    swappedFirst.plan.id,
                    swappedFirst.meal.id,
                    swapBody(
                        swappedFirst.candidate.recipeVersionId,
                        1,
                        swappedFirst.candidate.portionMultiplier,
                    ),
                    NOW,
                )
            ).kind,
        ).toBe('ok');

        const refusedRegeneration = await outcomeOf(() =>
            regeneratePlan(PLANNING_USER_ID, swappedFirst.plan.id, regenerateBody(1), NOW),
        );

        expect(await expectOneSurvivingState(swappedFirst, refusedRegeneration)).toBe('swapped');

        // The counter-proof: the refusal was about the revision the swap moved,
        // not about the plan having become unregenerable. Re-pinned at the
        // revision it now holds, the same regeneration commits.
        const retried = await regeneratePlan(PLANNING_USER_ID, swappedFirst.plan.id, regenerateBody(2), NOW);

        expect(retried.kind).toBe('ok');

        const plans = await plansOf(PLANNING_USER_ID);
        const replacement = plans.find((plan) => plan.replaced_plan_id === swappedFirst.plan.id);

        expect(plans).toHaveLength(2);
        expect(replacement?.status).toBe(ACTIVE_PLAN);
        expect(dayKeyOf(replacement?.start_date ?? new Date(0))).toBe(TODAY);
        // Superseding bumped the swapped week's revision from 2 to 3.
        expect(await planRevision(swappedFirst.plan.id)).toBe(3);
        expect(await ledgerRows(PLANNING_USER_ID)).toHaveLength(2);
        await expectOneActivePlanPerStartDate(PLANNING_USER_ID);
        await expectIntactReplacementChains(PLANNING_USER_ID);
    });
});

/* ---------------------------------------------------------------------------
 * Two swaps on one meal
 * ------------------------------------------------------------------------- */

describe('two swaps on one meal', () => {
    it('lets exactly one of them commit when raced, and refuses the other as stale', async () => {
        // The week's TWO unused breakfast candidates are what make this case
        // possible at all: the ≤2-uses repetition rule refuses the recipe the
        // slot is being swapped out of — the other six days still plan it — so
        // a pair of swaps on one slot needs a pair of candidates neither of
        // which the week already uses.
        const results = await Promise.allSettled([
            commitSwap(USER_ID, week.plan.id, week.breakfastMeal.id, swapBody(week.alternative.id, 1), NOW),
            commitSwap(
                USER_ID,
                week.plan.id,
                week.breakfastMeal.id,
                swapBody(week.secondAlternative.id, 1),
                NOW,
            ),
        ]);

        const { fulfilled, rejected } = splitRace(results);

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(StalePlanError);
        expect((rejected[0].reason as StalePlanError).currentRevision).toBe(2);

        const meal = await mealRow(week.breakfastMeal.id);
        const committed = meal.recipe_version_id;
        const refused = committed === week.alternative.id ? week.secondAlternative.id : week.alternative.id;

        // The slot moved exactly once, and to one of the two candidates.
        expect([week.alternative.id, week.secondAlternative.id]).toContain(committed);
        expect(meal.revision).toBe(2);
        expect(meal.previous_recipe_version_id).toBe(week.breakfast.id);
        expect(meal.swapped_at).toEqual(NOW);
        expect(await planRevision(week.plan.id)).toBe(2);

        const actions = await ledgerRows();

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            action_type: 'swap',
            response_status: 200,
            plan_revision_after: 2,
            meal_plan_meal_id: week.breakfastMeal.id,
        });

        // The refused client can retry at the revision it was handed: its
        // candidate is still the slot's one admissible alternative, while the
        // recipe just swapped OUT is not — six days still plan it.
        expect(
            (await listedAlternatives(USER_ID, week.plan.id, week.breakfastMeal.id)).map(
                (alternative) => alternative.recipeVersionId,
            ),
        ).toEqual([refused]);
    });
});

/* ---------------------------------------------------------------------------
 * A write that reaches the meal while the swap is writing it
 *
 * The meal's own compare-and-swap, which is a DIFFERENT guard from the plan's
 * (§0.5.1, Rule backend-architecture §5.1): `meal_plan_meals.revision` and
 * `meal_plans.revision` move independently, so a change confined to one meal
 * leaves the plan's counter exactly where the commit pinned it and the
 * plan-level check passes straight over it. The predicate
 * `swap.logic.ts::swapMealWhere` builds is what makes that change visible.
 *
 * HOW THE INTERLEAVING IS MADE DETERMINISTIC, since every service writer takes
 * the per-user advisory lock and could not produce this on its own. A second
 * session holds a ROW lock on the meal — `SELECT … FOR UPDATE`, which the
 * advisory lock knows nothing about — so the swap runs unimpeded until its own
 * `UPDATE`, which then waits. That session bumps the revision and commits,
 * PostgreSQL re-evaluates the waiting statement's qualification against the
 * committed row version, and the revision term is what decides the outcome:
 * with it the statement matches nothing, without it the swap overwrites the
 * foreign write and reports success. Nothing here depends on timing beyond
 * {@link BLOCK_OBSERVATION_MS}, which is only how long the blocked call is
 * watched — the counter-proof below settles inside the same window.
 * ------------------------------------------------------------------------- */

describe("a foreign write to the meal a swap is committing", () => {
    /**
     * Holds a row lock on one meal until released, then bumps ONLY that row's
     * `revision` — no recipe change, no plan write — and commits.
     *
     * The bump is deliberately the narrowest possible change: it is what a
     * writer that moved the meal and not the plan looks like, and it is the
     * exact state the plan-level compare-and-swap cannot detect.
     */
    const holdMealRowThenBumpRevision = async (
        mealId: string,
    ): Promise<{ release: () => void; held: Promise<unknown> }> => {
        const taken = deferred();
        const releaseSignal = deferred();

        const held = contendingClient.$transaction(
            async (tx) => {
                await tx.$queryRaw`SELECT revision FROM meal_plan_meals WHERE id = ${mealId}::uuid FOR UPDATE`;
                taken.release();
                await releaseSignal.promise;
                await tx.$executeRaw`UPDATE meal_plan_meals SET revision = revision + 1 WHERE id = ${mealId}::uuid`;
            },
            { timeout: 20_000 },
        );

        await taken.promise;

        return { release: releaseSignal.release, held };
    };

    it('refuses the commit and leaves the foreign revision standing, with nothing else written', async () => {
        const mealBefore = await mealRow(week.breakfastMeal.id);
        const groceriesBefore = await groceryStateOf(week.plan.id);
        const foreignWriter = await holdMealRowThenBumpRevision(week.breakfastMeal.id);

        const swapping = watch(
            commitSwap(USER_ID, week.plan.id, week.breakfastMeal.id, swapBody(week.alternative.id, 1), NOW),
        );

        await sleep(BLOCK_OBSERVATION_MS);

        // Waiting on the row it means to write, with its transaction — and so
        // its ledger reservation — still open and invisible.
        expect(swapping.settled()).toBe(false);
        expect((await mealRow(week.breakfastMeal.id)).recipe_version_id).toBe(week.breakfast.id);

        foreignWriter.release();
        await foreignWriter.held;

        await expect(swapping.done).rejects.toThrow(SwapDataError);

        // ONLY the foreign bump survived. The recipe, the audit columns and the
        // meal's flags are as they were, which is the difference between a
        // compare-and-swap and a write that lost a race silently.
        expect(await mealRow(week.breakfastMeal.id)).toEqual({
            ...mealBefore,
            revision: mealBefore.revision + 1,
        });
        // The plan's revision never moved, so the whole transaction — the day's
        // totals, the grocery rebuild and the reservation with them — rolled
        // back rather than half-applying.
        expect(await planRevision(week.plan.id)).toBe(1);
        expect(await groceryStateOf(week.plan.id)).toEqual(groceriesBefore);
        expect(await ledgerRows()).toHaveLength(0);
    });

    it('commits inside the same window when nothing reaches the meal', async () => {
        // The counter-proof. Without it the case above could pass because of
        // something incidental to a blocked transaction rather than because of
        // the revision term, and a build that had dropped the term would look
        // exactly as correct.
        const swapping = watch(
            commitSwap(USER_ID, week.plan.id, week.breakfastMeal.id, swapBody(week.alternative.id, 1), NOW),
        );

        await sleep(BLOCK_OBSERVATION_MS);

        expect(swapping.settled()).toBe(true);
        expect((await swapping.done).kind).toBe('ok');

        const meal = await mealRow(week.breakfastMeal.id);

        expect(meal.recipe_version_id).toBe(week.alternative.id);
        expect(meal.revision).toBe(2);
        expect(await planRevision(week.plan.id)).toBe(2);
    });

    it('finds the meal at whatever revision it stands at, and advances it from there', async () => {
        // A meal that has been swapped before is the ordinary case, and the
        // predicate has to follow it: the commit must match revision 6 and
        // leave 7. The plan's counter is untouched by the bump, so the client's
        // pinned `expectedPlanRevision` is still 1 — which is precisely why the
        // meal needs its own pin.
        await prisma.$executeRaw`UPDATE meal_plan_meals SET revision = 6 WHERE id = ${week.breakfastMeal.id}::uuid`;

        const result = await commitSwap(
            USER_ID,
            week.plan.id,
            week.breakfastMeal.id,
            swapBody(week.alternative.id, 1),
            NOW,
        );

        if (result.kind !== 'ok') {
            throw new Error(`the swap was refused as invalid: ${JSON.stringify(result)}`);
        }

        const meal = await mealRow(week.breakfastMeal.id);

        expect(meal.revision).toBe(7);
        expect(meal.recipe_version_id).toBe(week.alternative.id);
        expect(result.result.planRevisionAfter).toBe(2);
    });
});

/* ---------------------------------------------------------------------------
 * The current week and the upcoming week regenerated
 * ------------------------------------------------------------------------- */

describe('the current week and the upcoming week regenerated', () => {
    /** The week after the current one, published as a second active plan. */
    const UPCOMING_WEEK = addDaysToDayKey(TODAY, 7);

    const seedCurrentAndUpcoming = async (world: PlannableWorld) => ({
        current: await makePlan(PLANNING_USER_ID, {
            startDate: TODAY,
            recipeVersionId: world.pool[0].version.id,
        }),
        upcoming: await makePlan(PLANNING_USER_ID, {
            startDate: UPCOMING_WEEK,
            recipeVersionId: world.pool[1].version.id,
        }),
    });

    /** The successor of one regenerated week, asserted whole and linked. */
    const expectReplacementOf = async (
        replacedPlanId: string,
        startDayKey: string,
    ): Promise<PlanWithMeals> => {
        const plans = await plansOf(PLANNING_USER_ID);
        const replacement = plans.find((plan) => plan.replaced_plan_id === replacedPlanId);

        if (replacement === undefined) {
            throw new Error(`plan ${replacedPlanId} was regenerated but no successor links back to it`);
        }

        expect(dayKeyOf(replacement.start_date)).toBe(startDayKey);
        expect(replacement.status).toBe(ACTIVE_PLAN);
        expect(replacement.revision).toBe(1);
        expectWholeWeek(replacement);
        expect(plans.find((plan) => plan.id === replacedPlanId)?.status).toBe(SUPERSEDED_PLAN);
        await expectOneActivePlanPerStartDate(PLANNING_USER_ID);
        await expectIntactReplacementChains(PLANNING_USER_ID);

        return replacement;
    };

    it('regenerates the current week beside a standing upcoming one, and the upcoming week against itself', async () => {
        const world = await seedPlannableWorld();
        const { current, upcoming } = await seedCurrentAndUpcoming(world);

        // The overlap check EXCLUDES the plan being replaced, so the current
        // week can replace itself; the upcoming clause never fires for it,
        // because its start date is not after today.
        expect((await regeneratePlan(PLANNING_USER_ID, current.id, regenerateBody(1), NOW)).kind).toBe(
            'ok',
        );

        await expectReplacementOf(current.id, TODAY);

        // And the upcoming week was not touched by its neighbour's replacement.
        expect(await planRevision(upcoming.id)).toBe(1);

        // The upcoming week regenerates too: `upcoming_exists` is not raised
        // against the plan being replaced, which would otherwise make
        // "Regenerate next week" reject itself every time.
        expect((await regeneratePlan(PLANNING_USER_ID, upcoming.id, regenerateBody(1), NOW)).kind).toBe(
            'ok',
        );

        await expectReplacementOf(upcoming.id, UPCOMING_WEEK);

        const plans = await plansOf(PLANNING_USER_ID);

        expect(plans).toHaveLength(4);
        expect(plans.filter((plan) => plan.status === ACTIVE_PLAN).map((plan) => dayKeyOf(plan.start_date))).toEqual(
            [TODAY, UPCOMING_WEEK],
        );
        expect(await ledgerRows(PLANNING_USER_ID)).toHaveLength(2);
    });

    it('commits the current week’s regeneration and refuses a generation for the upcoming week’s dates', async () => {
        const world = await seedPlannableWorld();
        const { current, upcoming } = await seedCurrentAndUpcoming(world);

        const results = await Promise.allSettled([
            regeneratePlan(PLANNING_USER_ID, current.id, regenerateBody(1), NOW),
            generatePlan(PLANNING_USER_ID, generateBody(UPCOMING_WEEK), NOW),
        ]);

        const { fulfilled, rejected } = splitRace<unknown>(results);

        // ONE documented outcome, and it is the same in both orderings rather
        // than a coin toss: the requested week overlaps the upcoming plan,
        // which this pair never touches, so the generation is refused against
        // it whenever it runs — and the regeneration of a DIFFERENT week is
        // refused by nothing.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(PlanOverlapError);
        expect((rejected[0].reason as PlanOverlapError).conflictingPlanId).toBe(upcoming.id);

        const replacement = await expectReplacementOf(current.id, TODAY);
        const plans = await plansOf(PLANNING_USER_ID);

        expect(plans).toHaveLength(3);
        expect(plans.filter((plan) => plan.status === ACTIVE_PLAN).map((plan) => plan.id).sort()).toEqual(
            [replacement.id, upcoming.id].sort(),
        );
        // The upcoming week is untouched — same revision, still whole — so the
        // refusal named a plan the client can still open.
        expect(await planRevision(upcoming.id)).toBe(1);
        expect(await ledgerRows(PLANNING_USER_ID)).toHaveLength(1);
    });
});

/* ---------------------------------------------------------------------------
 * A target save against a swap preview and its commit
 * ------------------------------------------------------------------------- */

describe('a target save against a swap preview and its commit', () => {
    /** A third user, so the week above keeps the targets its own cases rely on. */
    const PORTION_USER_ID = 'concurrency-suite-portion-user';

    /** The two meals a breakfast swap does not touch: 735 + 840 kcal of the day. */
    const FIXED_DAY_CALORIES = SLOT_SIZES.lunch.calories + SLOT_SIZES.dinner.calories;

    /** The portion the moved targets recompute instead of the previewed ×1. */
    const MOVED_MULTIPLIER = 1.25;

    /**
     * A calorie target the portion selector answers with
     * {@link MOVED_MULTIPLIER} rather than the ×1 the preview bound: the
     * candidate at ×1.25 puts the day a quarter of a calorie from it where ×1 is
     * 131 away, and the resulting day stays inside the whole day tolerance
     * (protein 168 against a 158 + 25 ceiling, carbs 223 within 31.5 g of 210,
     * fat 74.5 within 15 g of 70), so the larger portion is admissible as well
     * as closer. Rounded because a manual target is an integer.
     */
    const MOVED_CALORIES = Math.round(
        FIXED_DAY_CALORIES + SLOT_SIZES.breakfast.calories * MOVED_MULTIPLIER,
    );

    /**
     * A calorie target that moves the numbers on screen WITHOUT moving the
     * portion: ×1 lands 10 kcal away and ×1.25 lands 121 away, so the
     * recomputed multiplier is still the one the preview showed. That is the
     * pair's point — the preview binds the portion, not the targets.
     */
    const NUDGED_CALORIES = FIXTURE_TARGETS.calories + 10;

    const manualTargets = (calories: number): Record<string, unknown> => ({
        source: 'manual',
        calories,
        protein: FIXTURE_TARGETS.protein,
        carbs: FIXTURE_TARGETS.carbs,
        fat: FIXTURE_TARGETS.fat,
        expectedTargetsRevision: 1,
    });

    /**
     * A ONE-DAY plan whose day lands exactly on {@link FIXTURE_TARGETS}
     * (525 + 735 + 840 kcal), and the preview of the week's spare breakfast
     * candidate against it.
     *
     * One day rather than a week because a portion is chosen against the day it
     * would produce, so a single day is the whole of what decides the
     * multiplier — and it is built from the WEEK's recipes, which already carry
     * the three slot sizes that put a day on target.
     */
    const seedPortionBoundDay = async () => {
        await makeUser({ id: PORTION_USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
        await makePreferences(PORTION_USER_ID, { time_zone: 'UTC' });

        const plan = await makePlan(PORTION_USER_ID, {
            startDate: TODAY,
            dayCount: 1,
            slots: week.plan.meal_plan_days[0].meal_plan_meals.map((meal) => ({
                slot: meal.slot,
                slot_time: meal.slot_time,
                recipeVersionId: meal.recipe_version_id,
            })),
        });
        const meal = plan.meal_plan_days[0].meal_plan_meals.find(
            (candidate) => candidate.slot === 'breakfast',
        );

        if (meal === undefined) {
            throw new Error('the portion-bound day was built without its breakfast');
        }

        const preview = await getSwapPreview(PORTION_USER_ID, plan.id, meal.id, week.alternative.id);

        if (preview.kind !== 'ok') {
            throw new Error(`the swap preview was refused: ${JSON.stringify(preview)}`);
        }

        return { plan, meal, preview: preview.response };
    };

    /** The multiplier a fresh preview offers now, which a refused commit sends the client back for. */
    const previewedMultiplierNow = async (planId: string, mealId: string): Promise<number> => {
        const preview = await getSwapPreview(PORTION_USER_ID, planId, mealId, week.alternative.id);

        if (preview.kind !== 'ok') {
            throw new Error(`the fresh swap preview was refused: ${JSON.stringify(preview)}`);
        }

        return preview.response.alternative.portionMultiplier;
    };

    /** The meal exactly as the day was published, for a commit that was refused. */
    const expectUnchangedMeal = async (
        seeded: Awaited<ReturnType<typeof seedPortionBoundDay>>,
    ): Promise<void> => {
        const meal = await mealRow(seeded.meal.id);

        expect(meal.recipe_version_id).toBe(seeded.meal.recipe_version_id);
        expect(meal.portion_multiplier).toBe(seeded.meal.portion_multiplier);
        expect(meal.revision).toBe(1);
        expect(meal.previous_recipe_version_id).toBeNull();
        expect(meal.swapped_at).toBeNull();
        expect(await planRevision(seeded.plan.id)).toBe(1);
        // The reservation was rolled back with the transaction that raised the
        // refusal, so there is no ledger row to replay either.
        expect(await ledgerRows(PORTION_USER_ID)).toHaveLength(0);
    };

    /** The meal after the previewed candidate really was committed. */
    const expectCommittedSwap = async (
        seeded: Awaited<ReturnType<typeof seedPortionBoundDay>>,
    ): Promise<void> => {
        const meal = await mealRow(seeded.meal.id);
        const actions = await ledgerRows(PORTION_USER_ID);

        expect(meal.recipe_version_id).toBe(week.alternative.id);
        expect(meal.portion_multiplier).toBe(seeded.preview.alternative.portionMultiplier);
        expect(meal.revision).toBe(2);
        expect(meal.previous_recipe_version_id).toBe(seeded.meal.recipe_version_id);
        expect(await planRevision(seeded.plan.id)).toBe(2);
        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            action_type: 'swap',
            response_status: 200,
            plan_revision_after: 2,
            meal_plan_meal_id: seeded.meal.id,
        });
    };

    it('refuses a commit whose previewed portion the moved targets no longer recompute', async () => {
        const seeded = await seedPortionBoundDay();

        expect(seeded.preview.alternative.portionMultiplier).toBe(1);
        expect(seeded.preview.planRevision).toBe(1);

        expect((await saveTargets(PORTION_USER_ID, manualTargets(MOVED_CALORIES), NOW)).kind).toBe('ok');

        const refusal = await outcomeOf(() =>
            commitSwap(
                PORTION_USER_ID,
                seeded.plan.id,
                seeded.meal.id,
                swapBody(week.alternative.id, 1, seeded.preview.alternative.portionMultiplier),
                NOW,
            ),
        );

        expect(refusal).toBeInstanceOf(PreviewStaleError);
        await expectUnchangedMeal(seeded);

        // What the client is sent back for, and the reason the commit was
        // refused rather than silently rescaled: the same candidate is still on
        // offer, at an amount of food the user has not seen yet.
        expect(await previewedMultiplierNow(seeded.plan.id, seeded.meal.id)).toBe(MOVED_MULTIPLIER);
    });

    it('commits when the moved targets recompute the same portion', async () => {
        const seeded = await seedPortionBoundDay();

        expect(seeded.preview.alternative.portionMultiplier).toBe(1);

        expect((await saveTargets(PORTION_USER_ID, manualTargets(NUDGED_CALORIES), NOW)).kind).toBe('ok');

        // The counter-proof for the case above: the targets moved here too, and
        // the portion they recompute to is the previewed one.
        expect(await previewedMultiplierNow(seeded.plan.id, seeded.meal.id)).toBe(
            seeded.preview.alternative.portionMultiplier,
        );

        const committed = await commitSwap(
            PORTION_USER_ID,
            seeded.plan.id,
            seeded.meal.id,
            swapBody(week.alternative.id, 1, seeded.preview.alternative.portionMultiplier),
            NOW,
        );

        expect(committed.kind).toBe('ok');
        await expectCommittedSwap(seeded);
    });

    it('yields exactly one of those two results when the save and the commit are raced', async () => {
        const seeded = await seedPortionBoundDay();

        expect(seeded.preview.alternative.portionMultiplier).toBe(1);

        const [save, commit] = await Promise.allSettled([
            saveTargets(PORTION_USER_ID, manualTargets(MOVED_CALORIES), NOW),
            commitSwap(
                PORTION_USER_ID,
                seeded.plan.id,
                seeded.meal.id,
                swapBody(week.alternative.id, 1, seeded.preview.alternative.portionMultiplier),
                NOW,
            ),
        ]);

        if (save.status !== 'fulfilled') {
            throw new Error(`the target save was refused: ${JSON.stringify(save.reason)}`);
        }

        // The save cannot lose: it pins targets revision 1 and a swap never
        // moves that counter, so it commits in either ordering and the question
        // is only whether the commit read the targets before or after it.
        expect(save.value.kind).toBe('ok');
        expect(
            (
                await prisma.meal_plan_preferences.findUniqueOrThrow({
                    where: { user_id: PORTION_USER_ID },
                    select: { targets_revision: true },
                })
            ).targets_revision,
        ).toBe(2);

        if (commit.status === 'fulfilled') {
            expect(commit.value.kind).toBe('ok');
            await expectCommittedSwap(seeded);

            return;
        }

        expect(commit.reason).toBeInstanceOf(PreviewStaleError);
        await expectUnchangedMeal(seeded);
    });
});

/* ---------------------------------------------------------------------------
 * A recipe publication and a food retirement beside a generation
 * ------------------------------------------------------------------------- */

describe('a recipe publication and a food retirement', () => {
    /**
     * The successor version, published `retired` so the promotion itself is a
     * single atomic status flip.
     *
     * `unique_current_recipe_version` admits exactly one `current` version per
     * recipe, so a promotion that inserted the successor as `current` would have
     * to retire the predecessor first — and between those two statements the
     * recipe would have NO current version, leaving a reader a pool one recipe
     * short. That window would be the fixture's race rather than the feature's,
     * so the row is created up front and {@link promoteVersion} flips both
     * statuses in one transaction.
     */
    const stageSuccessor = async (
        entry: PoolRecipe,
        staple: catalog_foods,
    ): Promise<FixtureRecipeVersion> =>
        makeRecipeVersion({
            recipeId: entry.version.recipe_id,
            version: entry.version.version + 1,
            status: RETIRED_VERSION,
            catalogFoodId: entry.food.id,
            ingredients: poolIngredients(entry.food, staple),
        });

    /**
     * The publication: the standing version is retired, its successor becomes
     * `current`, and `recipes.current_version_id` moves to it — the three writes
     * §0.7.3 assigns to one transaction, driven here directly because
     * `scripts/recipes-seed.ts` is a stage stub at this checkpoint and exports
     * no runnable entry point.
     */
    const promoteVersion = async (
        standing: { id: string; recipe_id: string },
        successorId: string,
    ): Promise<void> => {
        await prisma.$transaction(async (tx) => {
            await tx.recipe_versions.update({
                where: { id: standing.id },
                data: { status: RETIRED_VERSION, retired_at: NOW },
            });
            await tx.recipe_versions.update({
                where: { id: successorId },
                data: { status: CURRENT_VERSION, retired_at: null, published_at: NOW },
            });
            await tx.recipes.update({
                where: { id: standing.recipe_id },
                data: { current_version_id: successorId },
            });
        });
    };

    /** What a catalog load does to a food a newer release no longer contains. */
    const retireFood = async (catalogFoodId: string): Promise<void> => {
        await prisma.catalog_foods.update({
            where: { id: catalogFoodId },
            data: { publication_status: RETIRED_FOOD },
        });
    };

    it('publishes one whole week against the versions it read while a promotion and a retirement land', async () => {
        const world = await seedPlannableWorld();
        const promoted = world.pool[POOL_RECIPE_COUNT - 1];
        const successor = await stageSuccessor(promoted, world.staple);

        const results = await Promise.allSettled([
            generatePlan(PLANNING_USER_ID, generateBody(TODAY), NOW),
            (async () => {
                await promoteVersion(promoted.version, successor.id);
                await retireFood(world.staple.id);
            })(),
        ]);

        const { fulfilled, rejected } = splitRace<unknown>(results);

        // Neither side fails: the pool never drops below twelve plannable
        // recipes (the promotion is atomic), a retired FOOD is still nameable
        // and convertible, and the plan's inserts reference version ids that
        // were read before the transaction opened.
        expect(rejected).toEqual([]);
        expect(fulfilled).toHaveLength(2);

        const published = await theOnlyPlanOf(PLANNING_USER_ID);

        expectWholeWeek(published);
        expect(published.status).toBe(ACTIVE_PLAN);
        expect(published.revision).toBe(1);

        const referenced = [...new Set(mealsOf(published).map((meal) => meal.recipe_version_id))];
        const seededIds = [...world.pool.map((entry) => entry.version.id), successor.id];
        const versions = await prisma.recipe_versions.findMany({
            where: { id: { in: seededIds } },
            select: { id: true, recipe_id: true, status: true },
        });
        const referencedVersions = versions.filter((version) => referenced.includes(version.id));

        // Nothing invented and nothing half-promoted: every meal points at a
        // version this fixture published.
        expect(referenced.filter((versionId) => !seededIds.includes(versionId))).toEqual([]);
        expect(referencedVersions).toHaveLength(referenced.length);
        // ONE version per recipe, which is what "the version ids it read" means:
        // the plannable set is read in a single statement, so a week carrying
        // both versions of the promoted recipe would have been assembled from
        // two different views of the catalog.
        expect(new Set(referencedVersions.map((version) => version.recipe_id)).size).toBe(
            referencedVersions.length,
        );

        const promotedVersions = versions.filter(
            (version) => version.recipe_id === promoted.version.recipe_id,
        );

        expect(
            promotedVersions
                .filter((version) => version.status === CURRENT_VERSION)
                .map((version) => version.id),
        ).toEqual([successor.id]);
        expect(
            promotedVersions
                .filter((version) => version.status === RETIRED_VERSION)
                .map((version) => version.id),
        ).toEqual([promoted.version.id]);

        for (const version of referencedVersions) {
            const read = await getRecipeVersionForUser(PLANNING_USER_ID, version.id);

            // Readable whatever its status, because this user's plan references
            // it — the clause a retired version's visibility rests on.
            expect(read?.versionId).toBe(version.id);
        }

        for (const version of versions.filter(
            (candidate) => candidate.status === RETIRED_VERSION && !referenced.includes(candidate.id),
        )) {
            const read = await getRecipeVersionForUser(PLANNING_USER_ID, version.id);

            // And the race widened nothing: a retired version nobody here
            // references stays invisible.
            expect(read).toBeNull();
        }

        const ingredientFoodIds = new Set(
            (
                await prisma.recipe_ingredients.findMany({
                    where: { recipe_version_id: { in: referenced } },
                    select: { catalog_food_id: true },
                })
            ).map((row) => row.catalog_food_id),
        );
        const groceryFoodIds = (
            await prisma.grocery_items.findMany({
                where: { meal_plan_id: published.id, user_id: PLANNING_USER_ID },
                select: { catalog_food_id: true },
            })
        ).map((row) => row.catalog_food_id);

        // The list is derived from exactly the versions the plan references —
        // no line for a recipe the week does not plan, and none missing.
        expect([...groceryFoodIds].sort()).toEqual([...ingredientFoodIds].sort());
        // Including the staple the catalog has just withdrawn: every pool recipe
        // shops for it, so its line is one the shopper still needs.
        expect(groceryFoodIds).toContain(world.staple.id);
        expect(
            (
                await prisma.catalog_foods.findUniqueOrThrow({
                    where: { id: world.staple.id },
                    select: { publication_status: true },
                })
            ).publication_status,
        ).toBe(RETIRED_FOOD);

        const actions = await ledgerRows(PLANNING_USER_ID);

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            action_type: 'generate',
            response_status: 201,
            plan_revision_after: 1,
            meal_plan_id: published.id,
        });

        const statusById = new Map(versions.map((version) => [version.id, version.status]));

        for (const meal of published.meal_plan_days[0].meal_plan_meals) {
            for (const alternative of await listedAlternatives(
                PLANNING_USER_ID,
                published.id,
                meal.id,
            )) {
                expect(statusById.get(alternative.recipeVersionId)).toBe(CURRENT_VERSION);
            }
        }
    });

    it('keeps a published week readable when a publication retires a version it holds', async () => {
        // Driven sequentially, and in this order, because that is what makes
        // the retired-but-referenced case CERTAIN: the fixture week plans
        // `week.breakfast` on all seven days, so promoting its recipe retires a
        // version the plan holds rather than one the search happened to pick.
        const successor = await makeRecipeVersion({
            recipeId: week.breakfast.recipe_id,
            version: week.breakfast.version + 1,
            status: RETIRED_VERSION,
            catalogFoodId: week.breakfastFood.id,
            meal_slots: ['breakfast'],
            perServing: { ...SLOT_SIZES.breakfast },
        });

        await promoteVersion(week.breakfast, successor.id);
        await retireFood(week.breakfastFood.id);

        // A catalog publication never rewrites a published week: the version is
        // frozen into the meal rows.
        const breakfasts = await prisma.meal_plan_meals.findMany({
            where: { meal_plan_id: week.plan.id, user_id: USER_ID, slot: 'breakfast' },
            select: { recipe_version_id: true, revision: true },
        });

        expect(breakfasts).toHaveLength(PLAN_DAY_COUNT);
        expect(breakfasts.map((meal) => meal.recipe_version_id)).toEqual(
            Array.from({ length: PLAN_DAY_COUNT }, () => week.breakfast.id),
        );
        expect(breakfasts.map((meal) => meal.revision)).toEqual(
            Array.from({ length: PLAN_DAY_COUNT }, () => 1),
        );
        expect(await planRevision(week.plan.id)).toBe(1);

        const retired = await getRecipeVersionForUser(USER_ID, week.breakfast.id);

        expect(retired?.versionId).toBe(week.breakfast.id);
        expect(retired?.status).toBe(RETIRED_VERSION);

        // The day still reads, with the retired version on its card.
        const envelope = await readDay();

        expect(
            envelope.day.meals.find((meal) => meal.id === week.breakfastMeal.id)?.recipe.versionId,
        ).toBe(week.breakfast.id);

        // The list still renders the line for the withdrawn food.
        const list = await getGroceryList(USER_ID, week.plan.id, NOW);

        expect(list.totalCount).toBe(3);
        expect(
            list.sections.flatMap((section) => section.items).map((item) => item.catalogFoodId),
        ).toContain(week.breakfastFood.id);

        // And the alternatives are the slot's two current candidates, never the
        // retired version the slot itself still holds — nor its successor, which
        // the week's other six days already plan twice over.
        expect(
            (await listedAlternatives(USER_ID, week.plan.id, week.breakfastMeal.id))
                .map((alternative) => alternative.recipeVersionId)
                .sort(),
        ).toEqual([week.alternative.id, week.secondAlternative.id].sort());
    });
});
