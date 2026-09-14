// The database-backed proof for one meal swap (Agent Action Plan §0.5.1 "Plan
// write-safety model", §0.5.2's `POST …/meals/:mealId/swap` row, §0.7.3's
// grocery diff rules, §0.9.2's `api/swaps.test.ts` rows).
//
// WHICH LAYER THIS SUITE DRIVES, AND WHY. It calls `swap.service.ts`
// (`getSwapAlternatives`, `getSwapPreview`, `commitSwap`) and the grocery
// building blocks DIRECTLY, against real PostgreSQL, and it makes no HTTP
// request. That is not a shortcut: at this checkpoint the meal-planning HTTP
// boundary does not exist yet — there is no `src/routes/mealPlanning.routes.ts`
// and no `src/controllers/mealPlanning.controller.ts`, and `src/app.ts` mounts
// neither — so a supertest call against `/api/meal-planning/...` would answer
// 404 and assert the absence of a route rather than the behaviour of a swap.
// Everything §0.5.1 promises about a swap — the single transaction, the per-user
// advisory lock, the idempotency ledger, the revision compare-and-swap, the
// same-transaction grocery rebuild — lives in the service, so the service is
// where it is provable today. When the routes land, the request-level cases
// (status codes, `invalid_request` bodies, the `x-test-abort-after-commit`
// header) are added to THIS file beside what is already here; the service-level
// cases below stay, because they observe rows a response body cannot.
//
// WHAT EVERY CASE ASSERTS AGAINST. The DATABASE after the call, not merely the
// returned DTO. A response that agrees with a row nobody wrote is exactly the
// failure this suite exists to catch, so each case re-reads `meal_plan_meals`,
// `meal_plan_days`, `meal_plans`, `grocery_items` and `meal_plan_actions` and
// asserts on the stored values.
//
// TWO THINGS ARE DELIBERATELY NOT ASSERTED, because they are being changed by
// another work unit at this checkpoint and an assertion here would pin a value
// that is about to move: the DISPLAY ROUNDING of planned nutrition in the
// meal/day DTOs (`mealPlan.mapper.ts`, review finding F04) and the exact
// `portionText` string (`formatPortionText` ignores
// `recipe_versions.serving_description`, review finding F05). The cases below
// therefore assert ids, revisions, stored planned values, row counts, check
// state, flags, change summaries and error kinds — none of which either fix
// touches.
//
// THE CLOCK IS PINNED. Every entry point takes `now` as its last argument, so
// the suite passes a fixed instant and builds the plan's week around it instead
// of deriving dates from the real clock. That is what makes `swapped_at` and
// `flagged_at` exactly assertable, and it is also how the ended-plan case is
// reached — the same plan, judged at a later instant — rather than by editing
// stored dates.
//
// THE FIXTURE IS SHAPED SO ONE SWAP EXERCISES EVERY GROCERY OUTCOME. The plan is
// a single current day with three slots, each planning a different two-ingredient
// recipe, over five foods chosen so that replacing the lunch produces one
// unchanged line, one visible increase on a checked line, one decrease on a
// checked line, one removal and one new line — the five verdicts §0.7.3's diff
// distinguishes — in a single commit. A one-day plan is what makes a REMOVAL
// reachable at all: with a seven-day week every slot's recipe recurs on the other
// days, so no food a swapped meal needs ever leaves the list.

import { Prisma, catalog_foods } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import { GroceryDataError } from '../../services/grocery.logic';
import { loadPlannedMealsForGroceries, rebuildPlanGroceries, toggleGroceryItem } from '../../services/grocery.service';
import {
    IdempotencyConflictError,
    PlanNotActiveError,
    PlanNotFoundError,
    PreviewStaleError,
    StalePlanError,
    SwapFailedError,
} from '../../services/mealPlanning.errors';
import {
    CommitSwapResult,
    commitSwap,
    getSwapAlternatives,
    getSwapPreview,
} from '../../services/swap.service';
import {
    SwapAlternativesResponse,
    SwapMealPayload,
    SwapMealResponse,
    SwapPreviewResponse,
} from '../../types/mealPlanning';
import {
    FIXTURE_TARGETS,
    FIXTURE_USER_TARGET_COLUMNS,
    FixtureRecipeVersion,
    makeCatalogFood,
    makePlan,
    makePreferences,
    makeRecipeVersion,
    makeUser,
} from '../setup/factories';
import { truncateFeatureTables } from '../setup/testDb';

const USER_ID = 'swap-suite-user';

/** The one plan day, and the day `now` below falls on in the user's zone. */
const PLAN_START_DAY_KEY = '2026-06-10';

/** 11:00 in `America/New_York`, the zone `makePreferences` stores. */
const NOW = new Date('2026-06-10T15:00:00.000Z');

/** Earlier the same local day, so a check mark's instant differs from a swap's. */
const CHECKED_AT = new Date('2026-06-10T13:00:00.000Z');

/** Ten days after the plan's only day: the same plan, now ended. */
const AFTER_THE_PLAN_ENDED = new Date('2026-06-20T15:00:00.000Z');

const SWAP_KEY = '11111111-1111-4111-8111-111111111111';
const SECOND_SWAP_KEY = '22222222-2222-4222-8222-222222222222';

/** `meal_plans.revision` as `makePlan` writes it, and after one swap. */
const PLAN_REVISION_BEFORE = 1;
const PLAN_REVISION_AFTER = 2;

/**
 * Per-100 g values for a recipe's two 200 g ingredients, over a two-serving
 * yield: `Σ(gram_weight × per100g ÷ 100) ÷ yield` collapses to `2 × per100g`,
 * so each set below states half of the per-serving figures it produces.
 *
 * Every number is exactly representable in binary floating point, so the stored
 * `planned_*` columns and the day sums are exact rather than approximate — which
 * is what lets the assertions use equality instead of a tolerance.
 */
const BASE_PER_100G = { calories: 350, protein_g: 26, carbs_g: 35, fat_g: 11.5, fiber_g: 0 };
const HEAVIER_PER_100G = { calories: 380, protein_g: 29, carbs_g: 38, fat_g: 12.5, fiber_g: 0 };
const HALF_PER_100G = { calories: 190, protein_g: 14.5, carbs_g: 19, fat_g: 6.25, fiber_g: 0 };

/** What the three planned slots carry: `2 × BASE_PER_100G`. */
const PLANNED_MEAL_NUTRITION = { calories: 700, protein: 52, carbs: 70, fat: 23 };

/** What the equal-portion candidate carries at ×1: `2 × HEAVIER_PER_100G`. */
const CANDIDATE_NUTRITION = { calories: 760, protein: 58, carbs: 76, fat: 25 };

/** The day as planned: three meals of {@link PLANNED_MEAL_NUTRITION}. */
const DAY_TOTALS_BEFORE = { calories: 2100, protein: 156, carbs: 210, fat: 69 };

/** The day after the lunch becomes {@link CANDIDATE_NUTRITION}. */
const DAY_TOTALS_AFTER = { calories: 2160, protein: 162, carbs: 216, fat: 71 };

/**
 * The portion the half-sized candidate is offered at.
 *
 * Its per-serving figure is 380 kcal, and the day is 1,400 kcal without the
 * lunch, so 1.75 (2,065 kcal) sits closer to the 2,100 target than 2.0 (2,160)
 * — the one admissible multiplier `selectSwapPortion` minimises the day's
 * calorie gap at. It is the case §0.7.3 names: "a candidate admissible only at a
 * non-default portion is listed with that portion".
 */
const HALF_CANDIDATE_PORTION = 1.75;

/** Grams of one food per meal: `gram_weight ÷ yield_servings × portion_multiplier`. */
const GRAMS_PER_MEAL = 100;

const INGREDIENT_GRAM_WEIGHT = 200;

interface SuiteFixture {
    /** Only ever on the untouched breakfast and dinner: its line never moves. */
    unchangedFood: catalog_foods;
    /** On the breakfast and on the incoming candidate: its line goes up. */
    sharedFood: catalog_foods;
    /** On the outgoing lunch and on the dinner: its line comes down. */
    decreasingFood: catalog_foods;
    /** On the outgoing lunch alone: its line disappears. */
    removedFood: catalog_foods;
    /** On the incoming candidate alone: its line arrives. */
    newFood: catalog_foods;
    lunchRecipe: FixtureRecipeVersion;
    /** The candidate whose portion is ×1, and which every commit case swaps in. */
    equalPortionCandidate: FixtureRecipeVersion;
    /** The candidate admissible only at {@link HALF_CANDIDATE_PORTION}. */
    halfPortionCandidate: FixtureRecipeVersion;
    planId: string;
    dayId: string;
    lunchMealId: string;
}

let fixture: SuiteFixture;

/**
 * A food whose default portion is stated in GRAMS, which fixes its grocery line
 * in the `mass` family.
 *
 * A DELIBERATE CHOICE OF FAMILY, not a way round a refusal. `makeCatalogFood`'s
 * own default portion is "1 cup / 200 g" with a null `density_g_per_ml` — the
 * shape the whole catalog release ships — and it renders perfectly well:
 * `grocery.logic.ts::volumeDensityFor` reads the density the portion itself
 * states (200 g per cup ≈ 0.845 g/ml), which is the stored-portion conversion
 * §0.1.4 prescribes. What a gram portion buys this suite is ARITHMETIC IT CAN
 * STATE: every diff assertion below is written in the grams the recipes plan,
 * so a mass line reads "7.1 oz" from 200 g with no unit conversion in between.
 * The volume family is exercised on its own, in "a volume-portion food's line",
 * below. `food_state: 'raw'` keeps the rendered name free of the state suffix
 * §0.7.3 appends for every other state.
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
 * `makeCatalogFood`'s own defaults are exactly that shape, which is why they are
 * taken here rather than restated. The list this food lands on is rebuilt by
 * `rebuildPlanGroceries` inside the swap's commit, so it is the shape that made
 * every swap-driven rebuild fail: the row is rendered through the density its
 * portion states (200 g per cup ≈ 0.845 g/ml, §0.1.4's stored-portion
 * conversion), and 100 g of it therefore reads "8 tbsp".
 */
const makeVolumePortionFood = async (displayName: string): Promise<catalog_foods> =>
    makeCatalogFood({
        display_name: displayName,
        food_state: 'raw',
        category: 'produce_vegetable',
    });

/** 100 g of a 200 g-per-cup food, in the volume family: half a cup. */
const ARRIVING_VOLUME_DISPLAY_TEXT = '8 tbsp';

/**
 * A recipe version of exactly two ingredients, 200 g of each, at the per-100 g
 * values given — so its per-serving nutrition is `2 × per100g` and each of its
 * two foods contributes {@link GRAMS_PER_MEAL} to the shopping list per planned
 * meal.
 *
 * The nutrition is DERIVED by the factory from these ingredients rather than
 * stated, so a fixture whose stored per-serving figures disagreed with its own
 * ingredient rows is not expressible.
 */
const makeTwoIngredientRecipe = async (
    slug: string,
    name: string,
    foods: readonly [catalog_foods, catalog_foods],
    per100g: typeof BASE_PER_100G,
): Promise<FixtureRecipeVersion> =>
    makeRecipeVersion({
        slug,
        name,
        catalogFoodId: foods[0].id,
        ingredients: foods.map((food) => ({
            catalogFoodId: food.id,
            per100g,
            gram_weight: INGREDIENT_GRAM_WEIGHT,
            quantity: INGREDIENT_GRAM_WEIGHT,
            unit: 'g',
            display_text: `${INGREDIENT_GRAM_WEIGHT} g`,
        })),
    });

/**
 * The shopping list a freshly published plan has.
 *
 * Written through `rebuildPlanGroceries` — the production builder, whose own
 * docblock names the empty-stored-list case as the one a first publication uses
 * — rather than by inserting rows by hand, because what the swap cases assert is
 * the DIFF applied to a list the feature itself produced. A hand-built list
 * could disagree with the aggregation rules and the diff would then be measured
 * against the wrong starting point.
 */
const writeInitialGroceryList = async (planId: string): Promise<void> => {
    await prisma.$transaction(async (tx) => {
        const meals = await loadPlannedMealsForGroceries(tx, USER_ID, planId);

        await rebuildPlanGroceries(tx, { userId: USER_ID, planId, meals, now: CHECKED_AT });
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
    // so the swap's own rebuild has to render a volume row to commit at all. It
    // is the right one to shape that way: every other line carries a diff
    // assertion stated in grams, while this one only has to appear.
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

    const plan = await makePlan(USER_ID, {
        startDate: PLAN_START_DAY_KEY,
        dayCount: 1,
        slots: [
            { slot: 'breakfast', slot_time: '08:00', recipeVersionId: breakfastRecipe.id },
            { slot: 'lunch', slot_time: '12:30', recipeVersionId: lunchRecipe.id },
            { slot: 'dinner', slot_time: '18:30', recipeVersionId: dinnerRecipe.id },
        ],
    });

    const day = plan.meal_plan_days[0];
    const lunch = day.meal_plan_meals.find((meal) => meal.slot === 'lunch');

    if (lunch === undefined) {
        throw new Error('The swap fixture plan was published without the lunch it is built to replace.');
    }

    await writeInitialGroceryList(plan.id);

    return {
        unchangedFood,
        sharedFood,
        decreasingFood,
        removedFood,
        newFood,
        lunchRecipe,
        equalPortionCandidate,
        halfPortionCandidate,
        planId: plan.id,
        dayId: day.id,
        lunchMealId: lunch.id,
    };
};

/** The commit body for one candidate at one portion. */
const swapBody = (
    recipeVersionId: string,
    portionMultiplier: number,
    overrides: Partial<SwapMealPayload> = {},
): Record<string, unknown> => ({
    recipeVersionId,
    portionMultiplier,
    expectedPlanRevision: PLAN_REVISION_BEFORE,
    idempotencyKey: SWAP_KEY,
    ...overrides,
});

/**
 * `commitSwap`, with the parser's refusal turned into a failure.
 *
 * The three entry points return `{kind: 'error'}` for a malformed request and
 * THROW every state conflict, so a case that means to exercise a state conflict
 * has to fail loudly on a refusal rather than silently asserting nothing — the
 * arrangement `targets.service.test.ts` uses for the same union.
 */
const commitOrThrow = async (body: Record<string, unknown>, now: Date = NOW): Promise<SwapMealResponse> => {
    const result = await commitSwap(USER_ID, fixture.planId, fixture.lunchMealId, body, now);

    if (result.kind !== 'ok') {
        throw new Error(`the swap was refused as invalid: ${JSON.stringify(result)}`);
    }

    return result.result.body as SwapMealResponse;
};

/** The whole `KeyedActionResult`, for the cases that assert on status and revision. */
const commitResultOrThrow = async (
    body: Record<string, unknown>,
    now: Date = NOW,
): Promise<Extract<CommitSwapResult, { kind: 'ok' }>['result']> => {
    const result = await commitSwap(USER_ID, fixture.planId, fixture.lunchMealId, body, now);

    if (result.kind !== 'ok') {
        throw new Error(`the swap was refused as invalid: ${JSON.stringify(result)}`);
    }

    return result.result;
};

const alternativesOrThrow = async (): Promise<SwapAlternativesResponse> => {
    const result = await getSwapAlternatives(USER_ID, fixture.planId, fixture.lunchMealId);

    if (result.kind !== 'ok') {
        throw new Error(`the alternatives list was refused as invalid: ${JSON.stringify(result)}`);
    }

    return result.response;
};

const previewOrThrow = async (recipeVersionId: string): Promise<SwapPreviewResponse> => {
    const result = await getSwapPreview(USER_ID, fixture.planId, fixture.lunchMealId, recipeVersionId);

    if (result.kind !== 'ok') {
        throw new Error(`the preview was refused as invalid: ${JSON.stringify(result)}`);
    }

    return result.response;
};

/* ---------------------------------------------------------------------------
 * Stored-state readers — every assertion below measures the database
 * ------------------------------------------------------------------------- */

const storedLunch = () => prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: fixture.lunchMealId } });

const storedDay = () => prisma.meal_plan_days.findUniqueOrThrow({ where: { id: fixture.dayId } });

const storedPlan = () => prisma.meal_plans.findUniqueOrThrow({ where: { id: fixture.planId } });

const storedGroceryRows = () =>
    prisma.grocery_items.findMany({
        where: { meal_plan_id: fixture.planId, user_id: USER_ID },
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

const ledgerRowsFor = (idempotencyKey: string) =>
    prisma.meal_plan_actions.findMany({ where: { user_id: USER_ID, idempotency_key: idempotencyKey } });

/** Checks one line through the real toggle, so its acknowledged baseline is real. */
const checkGroceryLine = async (food: catalog_foods): Promise<void> => {
    const row = await requireGroceryRowFor(food);

    await toggleGroceryItem(USER_ID, fixture.planId, row.id, { isChecked: true }, CHECKED_AT);
};

beforeEach(async () => {
    await truncateFeatureTables();
    fixture = await seedFixture();
});

afterAll(async () => {
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * The committed swap: one transaction, every consequence
 * ------------------------------------------------------------------------- */

describe('a committed swap', () => {
    it('starts from a plan whose stored day totals are the sum of its three meals', async () => {
        // The baseline every case below measures a change against, asserted
        // rather than assumed: a fixture whose day totals disagreed with its
        // meals would let a "totals were recomputed" assertion pass against a
        // number that was already wrong.
        const day = await storedDay();
        const meals = await prisma.meal_plan_meals.findMany({
            where: { meal_plan_id: fixture.planId },
            orderBy: { sort_order: 'asc' },
        });

        expect(meals).toHaveLength(3);
        expect(meals.map((meal) => meal.planned_calories)).toEqual([700, 700, 700]);
        expect(day.planned_calories).toBe(DAY_TOTALS_BEFORE.calories);
        expect(day.planned_protein_g).toBe(DAY_TOTALS_BEFORE.protein);
        expect(day.planned_carbs_g).toBe(DAY_TOTALS_BEFORE.carbs);
        expect(day.planned_fat_g).toBe(DAY_TOTALS_BEFORE.fat);
    });

    it('moves the meal to the new version and records the one it replaced', async () => {
        await commitOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        const lunch = await storedLunch();

        expect(lunch.recipe_version_id).toBe(fixture.equalPortionCandidate.id);
        expect(lunch.previous_recipe_version_id).toBe(fixture.lunchRecipe.id);
        expect(lunch.swapped_at).toEqual(NOW);
        expect(lunch.portion_multiplier).toBe(1);
        expect(lunch.planned_calories).toBe(CANDIDATE_NUTRITION.calories);
        expect(lunch.planned_protein_g).toBe(CANDIDATE_NUTRITION.protein);
        expect(lunch.planned_carbs_g).toBe(CANDIDATE_NUTRITION.carbs);
        expect(lunch.planned_fat_g).toBe(CANDIDATE_NUTRITION.fat);
        // §0.7.3: a swap to a compatible recipe clears that meal's flags, and
        // the column is written on every commit rather than only when something
        // was flagged.
        expect(lunch.flags).toEqual([]);
    });

    it("advances the meal's own revision and the plan's by exactly one", async () => {
        const result = await commitResultOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        expect(result.status).toBe(200);
        expect(result.planRevisionAfter).toBe(PLAN_REVISION_AFTER);
        expect((await storedLunch()).revision).toBe(2);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER);
        // The two other meals are untouched, which is what "swapping one meal
        // leaves the others unchanged" means at the row level.
        const others = (
            await prisma.meal_plan_meals.findMany({ where: { meal_plan_id: fixture.planId } })
        ).filter((meal) => meal.id !== fixture.lunchMealId);

        expect(others.map((meal) => meal.revision)).toEqual([1, 1]);
        expect(others.map((meal) => meal.swapped_at)).toEqual([null, null]);
    });

    it('writes the meal through a predicate carrying the revision it currently stands at', async () => {
        // §0.5.1 addresses a revisioned row by `{id, user_id, meal_plan_id}`
        // AND its expected `revision`, and this is the case that proves the
        // fourth column is the CURRENT one rather than a constant or the
        // advanced value. The meal is moved off revision 1 first — a plan whose
        // meal has already been swapped once is the ordinary state of things —
        // and the commit then has to find it at 4 and leave it at 5. A predicate
        // pinning `revision + 1` would match nothing here and the commit would
        // fail; one pinning a literal 1 would match nothing either. The plan's
        // own revision is untouched by the bump, which is exactly why the
        // plan-level compare-and-swap cannot stand in for this one: the two
        // counters move independently.
        await prisma.$executeRaw`UPDATE meal_plan_meals SET revision = 4 WHERE id = ${fixture.lunchMealId}::uuid`;

        const result = await commitResultOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));
        const lunch = await storedLunch();

        expect(lunch.revision).toBe(5);
        expect(lunch.recipe_version_id).toBe(fixture.equalPortionCandidate.id);
        expect(lunch.previous_recipe_version_id).toBe(fixture.lunchRecipe.id);
        // The plan's counter still advanced by exactly one from the revision the
        // client pinned, so the meal's history has no effect on the plan's.
        expect(result.planRevisionAfter).toBe(PLAN_REVISION_AFTER);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER);
    });

    it("rewrites the day's stored totals from the candidate's own resulting day", async () => {
        const preview = await previewOrThrow(fixture.equalPortionCandidate.id);

        await commitOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        const day = await storedDay();

        expect(day.planned_calories).toBe(DAY_TOTALS_AFTER.calories);
        expect(day.planned_protein_g).toBe(DAY_TOTALS_AFTER.protein);
        expect(day.planned_carbs_g).toBe(DAY_TOTALS_AFTER.carbs);
        expect(day.planned_fat_g).toBe(DAY_TOTALS_AFTER.fat);
        // The stored totals ARE the numbers the preview showed — the same
        // `dayTotalsIfSwapped` value, not a second summation that happens to
        // agree.
        expect(preview.dayTotalsIfSwapped).toEqual(DAY_TOTALS_AFTER);
    });

    it('reports the grocery change summary the diff actually applied', async () => {
        const body = await commitOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        expect(body.groceryChangeSummary).toEqual({ added: 1, removed: 1, increased: 1 });
        expect(body.planRevision).toBe(PLAN_REVISION_AFTER);
    });
});

/* ---------------------------------------------------------------------------
 * What the swap does to the shopping list
 * ------------------------------------------------------------------------- */

describe("the grocery consequences of a swap, on a list the shopper has already worked through", () => {
    beforeEach(async () => {
        // Four of the five lines are checked BEFORE the swap, at an earlier
        // instant than the commit, so every flag assertion below is about the
        // swap's own instant and every baseline is one the toggle really wrote.
        await checkGroceryLine(fixture.unchangedFood);
        await checkGroceryLine(fixture.sharedFood);
        await checkGroceryLine(fixture.decreasingFood);
        await checkGroceryLine(fixture.removedFood);
    });

    it('aggregates the published week before anything is swapped', async () => {
        const rows = await storedGroceryRows();

        // Four identities, not five: the incoming candidate's own food is not
        // in the week yet, which is what makes it a genuine arrival below.
        expect(rows).toHaveLength(4);
        expect(grams((await requireGroceryRowFor(fixture.unchangedFood)).quantity_grams)).toBe(
            GRAMS_PER_MEAL * 2,
        );
        expect(grams((await requireGroceryRowFor(fixture.sharedFood)).quantity_grams)).toBe(GRAMS_PER_MEAL);
        expect(grams((await requireGroceryRowFor(fixture.decreasingFood)).quantity_grams)).toBe(
            GRAMS_PER_MEAL * 2,
        );
        expect(grams((await requireGroceryRowFor(fixture.removedFood)).quantity_grams)).toBe(GRAMS_PER_MEAL);
        expect(await groceryRowFor(fixture.newFood)).toBeUndefined();
    });

    it('leaves a surviving unchanged line byte-for-byte as it stood, check included', async () => {
        const before = await requireGroceryRowFor(fixture.unchangedFood);

        await commitOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        // Both slots that need this food are untouched by the swap, so the diff
        // reports it unchanged and writes nothing at all to it.
        expect(await requireGroceryRowFor(fixture.unchangedFood)).toEqual(before);
        expect(before.is_checked).toBe(true);
    });

    it('keeps the check on a visibly increased line and flags it against the acknowledged amount', async () => {
        const before = await requireGroceryRowFor(fixture.sharedFood);

        await commitOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        const after = await requireGroceryRowFor(fixture.sharedFood);

        expect(before.display_text).toBe('3.5 oz');
        expect(after.display_text).toBe('7.1 oz');
        expect(grams(after.quantity_grams)).toBe(GRAMS_PER_MEAL * 2);
        // Nothing disappears from the list: the line stays checked and is shown
        // flagged instead, and the flag is raised at the commit's instant.
        expect(after.is_checked).toBe(true);
        expect(after.flagged_at).toEqual(NOW);
        // "was Y" is the amount the shopper acknowledged when they checked the
        // line, never an intermediate amount.
        expect(grams(after.previous_quantity_grams)).toBe(GRAMS_PER_MEAL);
    });

    it('keeps the check on a decreased line and raises no flag', async () => {
        const before = await requireGroceryRowFor(fixture.decreasingFood);

        await commitOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        const after = await requireGroceryRowFor(fixture.decreasingFood);

        expect(before.display_text).toBe('7.1 oz');
        expect(after.display_text).toBe('3.5 oz');
        expect(grams(after.quantity_grams)).toBe(GRAMS_PER_MEAL);
        expect(after.is_checked).toBe(true);
        expect(after.flagged_at).toBeNull();
        // The acknowledged baseline survives the decrease, so a later increase
        // is still measured from the amount the shopper actually saw.
        expect(grams(after.previous_quantity_grams)).toBe(GRAMS_PER_MEAL * 2);
    });

    it('deletes a line the week no longer needs, even one already checked', async () => {
        await commitOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        expect(await groceryRowFor(fixture.removedFood)).toBeUndefined();
    });

    it('adds the incoming recipe\'s own food as an unchecked line', async () => {
        await commitOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        const arrived = await requireGroceryRowFor(fixture.newFood);

        expect(grams(arrived.quantity_grams)).toBe(GRAMS_PER_MEAL);
        expect(arrived.is_checked).toBe(false);
        expect(arrived.checked_at).toBeNull();
        expect(arrived.flagged_at).toBeNull();
        expect(grams(arrived.previous_quantity_grams)).toBeNull();
    });

    // THE SHIPPED SHAPE, INSIDE THE COMMIT. The arriving food carries a volume
    // default portion and no stored density — the shape all 4,622 volume-portion
    // foods of the catalog release have — so the commit can only succeed if the
    // rebuild renders it through the density that portion states. The failure
    // this replaces arrived AFTER a correct preview, which is what made it worst:
    // the user approved a swap and then met a 500.
    it('renders a volume-portion food\u2019s arriving line instead of failing the commit', async () => {
        await commitOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        const arrived = await requireGroceryRowFor(fixture.newFood);

        expect(arrived.display_text).toBe(ARRIVING_VOLUME_DISPLAY_TEXT);
        // The stored unit is a token `utils/units.ts` resolves, so the row's
        // family is readable back off it on every later update (§0.7.3's
        // unit-family lock).
        expect(arrived.display_unit).toBe('tbsp');
        expect(arrived.display_quantity).toBe(8);
    });

    it('leaves the list holding exactly the identities the new week needs', async () => {
        await commitOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        const identities = (await storedGroceryRows()).map((row) => row.catalog_food_id).sort();

        expect(identities).toEqual(
            [fixture.unchangedFood.id, fixture.sharedFood.id, fixture.decreasingFood.id, fixture.newFood.id].sort(),
        );
    });
});

/* ---------------------------------------------------------------------------
 * One transaction: the meal never moves without the list
 * ------------------------------------------------------------------------- */

describe('a swap whose grocery rebuild fails after the meal has been written', () => {
    /**
     * The stored `display_unit` of one surviving line, replaced by a token no
     * unit family recognises.
     *
     * This is the deterministic way to fail the rebuild INSIDE the commit and
     * after the meal write: `applySwap` runs first, then
     * `rebuildPlanGroceries`, whose diff reads every surviving row's family back
     * off its own `display_unit` and raises `GroceryDataError` for one it cannot
     * resolve. So the transaction is interrupted exactly between the two halves
     * §0.5.2's 13e copy promises are inseparable — "your lunch is unchanged and
     * your grocery list was not updated" — and what the database holds
     * afterwards is the whole proof.
     *
     * WHAT THE CALLER SEES IS `SwapFailedError`, not the grocery class. §0.5.2
     * gives this endpoint one 5xx, `502 swap_failed`, and 13e's copy is written
     * for exactly that answer; `GroceryDataError` and `UnitConversionError`
     * belong to no error vocabulary a controller maps, so escaping raw would
     * make this a generic 500 the client cannot classify — which is why
     * `swap.service.ts` translates them at its own boundary and keeps the
     * original fault on `cause` for the log.
     */
    const breakTheRebuild = async (): Promise<{ rowId: string; restore: () => Promise<void> }> => {
        const row = await requireGroceryRowFor(fixture.unchangedFood);

        await prisma.grocery_items.update({ where: { id: row.id }, data: { display_unit: 'bottle' } });

        return {
            rowId: row.id,
            restore: async () => {
                await prisma.grocery_items.update({
                    where: { id: row.id },
                    data: { display_unit: row.display_unit },
                });
            },
        };
    };

    it('answers the typed swap refusal rather than letting the grocery fault escape', async () => {
        await breakTheRebuild();

        const thrown = await commitSwap(
            USER_ID,
            fixture.planId,
            fixture.lunchMealId,
            swapBody(fixture.equalPortionCandidate.id, 1),
            NOW,
        ).then(
            () => null,
            (error: unknown) => error,
        );

        // The class the contract names, carrying the fault that caused it: a
        // controller can answer `502 swap_failed` from the first and log the
        // second, and neither has to parse a message.
        expect(thrown).toBeInstanceOf(SwapFailedError);
        expect((thrown as SwapFailedError).cause).toBeInstanceOf(GroceryDataError);
    });

    it('rolls the meal, the day, the plan revision and the whole list back together', async () => {
        const { rowId } = await breakTheRebuild();
        const mealBefore = await storedLunch();
        const dayBefore = await storedDay();
        const rowsBefore = await storedGroceryRows();

        await expect(commitSwap(USER_ID, fixture.planId, fixture.lunchMealId, swapBody(fixture.equalPortionCandidate.id, 1), NOW)).rejects.toThrow(
            SwapFailedError,
        );

        expect(await storedLunch()).toEqual(mealBefore);
        expect(await storedDay()).toEqual(dayBefore);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_BEFORE);
        expect(await storedGroceryRows()).toEqual(rowsBefore);
        expect(rowsBefore.some((row) => row.id === rowId)).toBe(true);
        // The reservation went with the rollback, so the key is free to be
        // retried rather than being stuck holding a pending row.
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
    });

    it('commits exactly once when the same key is retried after the fault is gone', async () => {
        const { restore } = await breakTheRebuild();

        await expect(commitSwap(USER_ID, fixture.planId, fixture.lunchMealId, swapBody(fixture.equalPortionCandidate.id, 1), NOW)).rejects.toThrow(
            SwapFailedError,
        );
        await restore();

        const result = await commitResultOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        expect(result.planRevisionAfter).toBe(PLAN_REVISION_AFTER);
        expect((await storedLunch()).recipe_version_id).toBe(fixture.equalPortionCandidate.id);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER);

        const ledger = await ledgerRowsFor(SWAP_KEY);

        expect(ledger).toHaveLength(1);
        expect(ledger[0].response_status).toBe(200);
        expect(ledger[0].plan_revision_after).toBe(PLAN_REVISION_AFTER);
    });
});

/* ---------------------------------------------------------------------------
 * The idempotency ledger
 * ------------------------------------------------------------------------- */

describe('the idempotency ledger', () => {
    it('replays the stored response for the same key and body, and writes nothing a second time', async () => {
        const first = await commitResultOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));
        const mealAfterFirst = await storedLunch();
        const dayAfterFirst = await storedDay();
        const rowsAfterFirst = await storedGroceryRows();

        const replay = await commitResultOrThrow(
            swapBody(fixture.equalPortionCandidate.id, 1),
            AFTER_THE_PLAN_ENDED,
        );

        expect(replay.status).toBe(first.status);
        expect(replay.planRevisionAfter).toBe(first.planRevisionAfter);
        // Compared as PARSED values rather than as text: the replay comes back
        // out of a `jsonb` column, which has normalised the object's key order
        // at rest, so the bodies agree by value and not byte for byte.
        expect(JSON.parse(JSON.stringify(replay.body))).toEqual(JSON.parse(JSON.stringify(first.body)));

        // Nothing moved: no second revision bump, no second grocery diff.
        expect(await storedLunch()).toEqual(mealAfterFirst);
        expect(await storedDay()).toEqual(dayAfterFirst);
        expect(await storedGroceryRows()).toEqual(rowsAfterFirst);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER);

        const ledger = await ledgerRowsFor(SWAP_KEY);

        expect(ledger).toHaveLength(1);
        expect(ledger[0].response_status).toBe(200);
        expect(ledger[0].meal_plan_id).toBe(fixture.planId);
        expect(ledger[0].meal_plan_meal_id).toBe(fixture.lunchMealId);
    });

    it('replays even after the plan it pinned has ended, because the write is already done', async () => {
        await commitResultOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        // The replay gate runs BEFORE the lifecycle and revision checks, so a
        // client whose response was lost still learns that its own action
        // succeeded.
        const replay = await commitResultOrThrow(
            swapBody(fixture.equalPortionCandidate.id, 1),
            AFTER_THE_PLAN_ENDED,
        );

        expect(replay.status).toBe(200);
        expect(replay.planRevisionAfter).toBe(PLAN_REVISION_AFTER);
    });

    it('refuses the same key carrying a different request', async () => {
        await commitOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));
        const mealAfterFirst = await storedLunch();

        await expect(
            commitSwap(
                USER_ID,
                fixture.planId,
                fixture.lunchMealId,
                swapBody(fixture.halfPortionCandidate.id, HALF_CANDIDATE_PORTION, {
                    expectedPlanRevision: PLAN_REVISION_AFTER,
                }),
                NOW,
            ),
        ).rejects.toThrow(IdempotencyConflictError);

        // A genuinely different write wearing a used key changes nothing.
        expect(await storedLunch()).toEqual(mealAfterFirst);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_AFTER);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(1);
    });

    it('accepts a second, differently keyed swap of the same meal', async () => {
        await commitOrThrow(swapBody(fixture.equalPortionCandidate.id, 1));

        const second = await commitResultOrThrow(
            swapBody(fixture.halfPortionCandidate.id, HALF_CANDIDATE_PORTION, {
                expectedPlanRevision: PLAN_REVISION_AFTER,
                idempotencyKey: SECOND_SWAP_KEY,
            }),
        );

        expect(second.planRevisionAfter).toBe(PLAN_REVISION_AFTER + 1);

        const lunch = await storedLunch();

        // Two keys are two intents: the second swap is committed, and its audit
        // column names the version the FIRST swap put there.
        expect(lunch.recipe_version_id).toBe(fixture.halfPortionCandidate.id);
        expect(lunch.previous_recipe_version_id).toBe(fixture.equalPortionCandidate.id);
        expect(lunch.revision).toBe(3);
        expect(await ledgerRowsFor(SECOND_SWAP_KEY)).toHaveLength(1);
    });
});

/* ---------------------------------------------------------------------------
 * Lifecycle and revision gates — each writes nothing
 * ------------------------------------------------------------------------- */

describe('the gates a commit passes before it writes', () => {
    it('refuses a stale plan revision and reports the current one', async () => {
        const mealBefore = await storedLunch();

        await expect(
            commitSwap(
                USER_ID,
                fixture.planId,
                fixture.lunchMealId,
                swapBody(fixture.equalPortionCandidate.id, 1, { expectedPlanRevision: 99 }),
                NOW,
            ),
        ).rejects.toMatchObject({ name: 'StalePlanError', currentRevision: PLAN_REVISION_BEFORE });

        expect(await storedLunch()).toEqual(mealBefore);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_BEFORE);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
    });

    it('refuses a superseded plan and names the plan that replaced it', async () => {
        await prisma.meal_plans.update({ where: { id: fixture.planId }, data: { status: 'superseded' } });
        const successor = await makePlan(USER_ID, {
            startDate: PLAN_START_DAY_KEY,
            dayCount: 1,
            slots: [],
            replaced_plan_id: fixture.planId,
        });
        const mealBefore = await storedLunch();

        await expect(
            commitSwap(USER_ID, fixture.planId, fixture.lunchMealId, swapBody(fixture.equalPortionCandidate.id, 1), NOW),
        ).rejects.toMatchObject({
            name: 'PlanNotActiveError',
            data: { replacementPlanId: successor.id },
        });

        expect(await storedLunch()).toEqual(mealBefore);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
    });

    it('refuses a plan whose last day has passed, as ended', async () => {
        const mealBefore = await storedLunch();

        // The same plan, judged at a later instant. §0.5.1 reads an `active`
        // plan whose `end_date` has gone by as ended for every write rule.
        await expect(
            commitSwap(
                USER_ID,
                fixture.planId,
                fixture.lunchMealId,
                swapBody(fixture.equalPortionCandidate.id, 1),
                AFTER_THE_PLAN_ENDED,
            ),
        ).rejects.toMatchObject({ name: 'PlanNotActiveError', data: { reason: 'ended' } });

        expect(await storedLunch()).toEqual(mealBefore);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
    });

    it('answers a foreign plan and a foreign meal with the same not-found, and writes nothing', async () => {
        const otherUser = await makeUser({});
        const mealBefore = await storedLunch();

        await expect(
            commitSwap(otherUser.id, fixture.planId, fixture.lunchMealId, swapBody(fixture.equalPortionCandidate.id, 1), NOW),
        ).rejects.toThrow(PlanNotFoundError);
        await expect(
            getSwapAlternatives(otherUser.id, fixture.planId, fixture.lunchMealId),
        ).rejects.toThrow(PlanNotFoundError);

        expect(await storedLunch()).toEqual(mealBefore);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
    });
});

/* ---------------------------------------------------------------------------
 * The preview binding: one selection behind all three entry points
 * ------------------------------------------------------------------------- */

describe('the list, the preview and the commit', () => {
    it('offer the same candidates at the same portions, in a stable order', async () => {
        const first = await alternativesOrThrow();
        const second = await alternativesOrThrow();

        // PRNG-free ranking: two reads of one plan produce the same rows in the
        // same order, so the sheet cannot reshuffle under the user's thumb.
        expect(second.alternatives).toEqual(first.alternatives);
        expect(first.current.id).toBe(fixture.lunchMealId);
        expect(first.current.recipe.versionId).toBe(fixture.lunchRecipe.id);

        // The other two slots' recipes are eligible in every other respect and
        // are excluded by the same-day repetition rule, and the meal's own
        // version is never an alternative to itself — so the sheet is exactly
        // the two candidates.
        expect(
            first.alternatives.map((alternative) => [alternative.recipeVersionId, alternative.portionMultiplier]),
        ).toEqual([
            [fixture.halfPortionCandidate.id, HALF_CANDIDATE_PORTION],
            [fixture.equalPortionCandidate.id, 1],
        ]);
    });

    it('agree on the portion, and the commit stores exactly what the preview showed', async () => {
        const listed = (await alternativesOrThrow()).alternatives.find(
            (alternative) => alternative.recipeVersionId === fixture.equalPortionCandidate.id,
        );
        const preview = await previewOrThrow(fixture.equalPortionCandidate.id);

        expect(listed?.portionMultiplier).toBe(1);
        expect(preview.alternative.portionMultiplier).toBe(1);
        expect(preview.alternative.recipe.versionId).toBe(fixture.equalPortionCandidate.id);
        expect(preview.alternative.nutrition).toEqual(CANDIDATE_NUTRITION);
        expect(preview.targets).toEqual({ ...FIXTURE_TARGETS });
        expect(preview.calorieDelta).toBe(DAY_TOTALS_AFTER.calories - DAY_TOTALS_BEFORE.calories);
        expect(preview.planRevision).toBe(PLAN_REVISION_BEFORE);

        await commitOrThrow(
            swapBody(fixture.equalPortionCandidate.id, preview.alternative.portionMultiplier, {
                expectedPlanRevision: preview.planRevision,
            }),
        );

        const lunch = await storedLunch();

        expect(lunch.portion_multiplier).toBe(preview.alternative.portionMultiplier);
        expect(lunch.planned_calories).toBe(preview.alternative.nutrition.calories);
    });

    it('offer a candidate admissible only at a non-default portion at that portion, and commit it there', async () => {
        const preview = await previewOrThrow(fixture.halfPortionCandidate.id);

        expect(preview.alternative.portionMultiplier).toBe(HALF_CANDIDATE_PORTION);

        await commitOrThrow(swapBody(fixture.halfPortionCandidate.id, HALF_CANDIDATE_PORTION));

        const lunch = await storedLunch();

        expect(lunch.portion_multiplier).toBe(HALF_CANDIDATE_PORTION);
        expect(lunch.planned_calories).toBe(preview.alternative.nutrition.calories);
    });

    it('refuse a commit whose portion is not the one the server recomputes, and write nothing', async () => {
        const mealBefore = await storedLunch();
        const rowsBefore = await storedGroceryRows();

        // A legal multiplier, and not this candidate's: committing it would
        // swap in an amount of food the user never approved.
        await expect(
            commitSwap(USER_ID, fixture.planId, fixture.lunchMealId, swapBody(fixture.halfPortionCandidate.id, 1), NOW),
        ).rejects.toThrow(PreviewStaleError);

        expect(await storedLunch()).toEqual(mealBefore);
        expect(await storedGroceryRows()).toEqual(rowsBefore);
        expect((await storedPlan()).revision).toBe(PLAN_REVISION_BEFORE);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
    });

    it('answer a malformed commit as invalid before any state is read', async () => {
        const mealBefore = await storedLunch();

        const refusal = await commitSwap(
            USER_ID,
            fixture.planId,
            fixture.lunchMealId,
            { recipeVersionId: 'not-a-uuid', portionMultiplier: 'half', idempotencyKey: SWAP_KEY },
            NOW,
        );

        expect(refusal.kind).toBe('error');
        expect(refusal).toMatchObject({ code: 'invalid_request' });
        expect(await storedLunch()).toEqual(mealBefore);
        expect(await ledgerRowsFor(SWAP_KEY)).toHaveLength(0);
    });
});
