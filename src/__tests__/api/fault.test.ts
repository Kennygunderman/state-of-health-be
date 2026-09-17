// The database-backed proof for the injected faults (Agent Action Plan §0.9.4
// "Physical-iPhone Verification Checklist", §0.9.2's `api/fault.test.ts` rows,
// §0.5.1's "Failure at any point persists nothing").
//
// TWO SEAMS, AND THE DISTINCTION IS THE POINT OF THE SUITE.
//
//   DECODED FAULT — `MEAL_PLANNING_FAULT=generation | swap`. The service throws
//   in FRONT of its transaction (`mealPlan.service.ts` raises between
//   `searchCandidateWeek` and `prisma.$transaction`; `swap.service.ts` between
//   the parse and `runKeyedAction`), so nothing is written and no ledger row is
//   even reserved, and the client is told so: a `502` carrying the machine code
//   `plan_generation_failed` or `swap_failed`. §0.2.5 classifies a 5xx as a
//   CONFIRMED failure only when its `error` is a code the client recognises, so
//   those two spellings are what make frames 10b and 13e reachable at all — a
//   bare `502` would be classified `unknown` and drive different UI.
//
//   POST-COMMIT ABORT — `MEAL_PLANNING_FAULT=log`, or the
//   `POST_COMMIT_ABORT_HEADER` under `NODE_ENV=test`. The CONTROLLER, after the
//   service has returned, destroys the response socket instead of writing a
//   body. The write is therefore durable AND `completeAction` has already run,
//   so the ledger row is COMPLETED rather than pending, and the client sees a
//   transport error with no response at all. This is the only mechanism in the
//   repository that can produce "the write committed, then the response was
//   lost", which is what makes the client's unknown-outcome handling honest: the
//   same-key retry must return the STORED response rather than committing twice.
//
// WHICH LAYER EACH CASE DRIVES. The decoded-fault invariants are asserted where
// they are decided — `commitSwap`, `generatePlan` and `regeneratePlan` called
// directly against real PostgreSQL — and again at the HTTP boundary for the
// status and code the controller maps them to. The abort seam is REQUEST-level
// by construction (there is no socket to destroy below the controller), so every
// case for it drives the shipped app through supertest.
//
// THE MECHANIC THAT MAKES THE FLAG CASES REAL. `utils/featureFlags.ts` resolves
// `MEAL_PLANNING_FAULT` and `NODE_ENV` ONCE, at import, into module constants
// (it is the module's stated design, and Rule 7 §9's requirement). Setting
// either variable inside a test therefore does nothing on its own — the
// already-imported accessor keeps answering `'off'` and a suite that trusted the
// assignment would silently assert the no-fault path. So
// {@link withIsolatedGraph} sets the variables, calls `jest.resetModules()` and
// re-requires the graph inside `jest.isolateModules`; {@link withFault} captures
// the services out of it and {@link withFaultedApp} captures a supertest agent
// bound to an app built from it. Every flag case asserts the re-imported
// `mealPlanningFault()` FIRST — the fault is proven armed before anything is
// concluded from what then happened. The header cases need none of this: the
// header is read whenever `NODE_ENV` is `test`, which Jest already set, so they
// drive the ambient app directly.
//
// WHAT THE TWO FIXTURES ARE FOR. The service-level cases pass an explicit `now`
// and sit on a pinned week, so they are clock-free. The controller passes no
// `now`, so an HTTP request resolves "today" from the real clock: the
// request-level fixture therefore builds a CURRENT week
// ({@link seedRequestFixture}), because a pinned past week would answer
// `409 plan_not_active` and prove nothing about a fault.
//
// TWO THINGS ARE DELIBERATELY NOT ASSERTED, because another work unit is
// changing them at this checkpoint: the display rounding of planned nutrition in
// the meal/day DTOs (review finding F04) and the exact `portionText` string
// (F05). The cases below assert ids, revisions, row counts, ledger state, status
// codes, machine codes and response bytes, none of which either fix touches.

import supertest from 'supertest';

import { Prisma, catalog_foods } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import { loadPlannedMealsForGroceries, rebuildPlanGroceries } from '../../services/grocery.service';
import { generatePlan } from '../../services/mealPlan.service';
import { commitSwap } from '../../services/swap.service';
// The regeneration case pins its request to the CURRENT targets revision rather
// than a literal, for the reason the targets suite states: publication moves the
// preference row, so both pins are read rather than assumed.
import { getTargets } from '../../services/targets.service';
// The header name is IMPORTED, never spelled out here. A literal would survive a
// rename of the constant and turn every abort case below into a request that is
// answered normally — a suite that still passes while proving nothing, which is
// the one failure mode this file cannot detect from the inside.
import { POST_COMMIT_ABORT_HEADER } from '../../utils/featureFlags';
import {
    FIXTURE_TARGETS,
    FIXTURE_USER_TARGET_COLUMNS,
    FixtureRecipeVersion,
    addDaysToDayKey,
    makeCatalogFood,
    makePlan,
    makePreferences,
    makeRecipeVersion,
    makeUser,
    utcTodayDayKey,
} from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

type FeatureFlagsModule = typeof import('../../utils/featureFlags');
type SwapServiceModule = typeof import('../../services/swap.service');
type MealPlanServiceModule = typeof import('../../services/mealPlan.service');
type PrismaClientModule = typeof import('../../prisma/client');
type AppModule = typeof import('../../app');

/** The user whose one-day plan the swap cases fault. */
const SWAP_USER_ID = 'fault-suite-swap-user';

/** A second user, with preferences and no plan, so a generation has a week to publish. */
const GENERATION_USER_ID = 'fault-suite-generation-user';

const PLAN_START_DAY_KEY = '2026-06-10';

/** 11:00 in `America/New_York`, the zone `makePreferences` stores. */
const NOW = new Date('2026-06-10T15:00:00.000Z');

const SWAP_KEY = '44444444-4444-4444-8444-444444444444';
const GENERATION_KEY = '55555555-5555-4555-8555-555555555555';

const PLAN_REVISION_BEFORE = 1;
const PLAN_REVISION_AFTER = 2;

/** Enough recipes for a seven-day week under the repeat rule (≤ 2 uses, never consecutive). */
const GENERATION_RECIPE_COUNT = 12;

/**
 * Per-100 g values for a single 400 g ingredient over a two-serving yield:
 * `400 × per100g ÷ 100 ÷ 2` is `2 × per100g`, so every recipe below is
 * 700 kcal / 52 P / 70 C / 23 F per serving — three of them at ×1 land a day
 * exactly on `FIXTURE_TARGETS`, which is what keeps both the swap candidates and
 * the generated week inside §0.7.3's day tolerance.
 */
const PER_100G = { calories: 350, protein_g: 26, carbs_g: 35, fat_g: 11.5, fiber_g: 0 };

const INGREDIENT_GRAM_WEIGHT = 400;

/** `gram_weight ÷ yield_servings × portion_multiplier` for one planned meal at ×1. */
const GRAMS_PER_MEAL = 200;

const PLAN_DAY_COUNT = 7;
const MEALS_PER_DAY = 3;

interface SuiteFixture {
    /** Every plan recipe and every generation candidate shops for this food. */
    sharedFood: catalog_foods;
    /** Only the swap candidate shops for this one, so a committed swap changes the list. */
    candidateFood: catalog_foods;
    plannedRecipes: FixtureRecipeVersion[];
    swapCandidate: FixtureRecipeVersion;
    planId: string;
    dayId: string;
    lunchMealId: string;
}

let fixture: SuiteFixture;

/**
 * A food whose default portion is stated in GRAMS, which fixes its grocery line
 * in the `mass` family.
 *
 * `makeCatalogFood`'s own default portion is "1 cup" — a VOLUME unit — with a
 * null `density_g_per_ml`, the combination `utils/units.ts` refuses because
 * millilitres never equal grams, so a list derived from the factory's default
 * food cannot be rendered at all.
 */
const makeShoppableFood = async (displayName: string): Promise<catalog_foods> =>
    makeCatalogFood({
        display_name: displayName,
        food_state: 'raw',
        defaultPortion: { description: '1 portion', amount: 100, unit: 'g', gram_weight: 100 },
    });

const makePlainRecipe = async (
    slug: string,
    name: string,
    food: catalog_foods,
): Promise<FixtureRecipeVersion> =>
    makeRecipeVersion({
        slug,
        name,
        catalogFoodId: food.id,
        ingredients: [
            {
                catalogFoodId: food.id,
                per100g: PER_100G,
                gram_weight: INGREDIENT_GRAM_WEIGHT,
                quantity: INGREDIENT_GRAM_WEIGHT,
                unit: 'g',
                display_text: `${INGREDIENT_GRAM_WEIGHT} g`,
            },
        ],
    });

/**
 * The shopping list a freshly published plan has, written through the production
 * builder (whose docblock names the empty-stored-list case as the one a first
 * publication uses) rather than by hand — so "the grocery rows are unchanged"
 * below is a claim about a list the feature itself produced.
 */
const writeInitialGroceryList = async (userId: string, planId: string): Promise<void> => {
    await prisma.$transaction(async (tx) => {
        const meals = await loadPlannedMealsForGroceries(tx, userId, planId);

        await rebuildPlanGroceries(tx, { userId, planId, meals, now: NOW });
    });
};

const seedFixture = async (): Promise<SuiteFixture> => {
    await makeUser({ id: SWAP_USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(SWAP_USER_ID);
    await makeUser({ id: GENERATION_USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(GENERATION_USER_ID);

    const sharedFood = await makeShoppableFood('Fault Suite Staple');
    const candidateFood = await makeShoppableFood('Fault Suite Candidate Food');

    const plannedRecipes: FixtureRecipeVersion[] = [];

    for (let index = 0; index < GENERATION_RECIPE_COUNT; index += 1) {
        plannedRecipes.push(
            await makePlainRecipe(`fault-suite-recipe-${index}`, `Fault Suite Recipe ${index}`, sharedFood),
        );
    }

    // Its own food, so committing it removes grams from one line and adds
    // another — which is what makes "the list was not updated" falsifiable.
    //
    // ITS SLUG SORTS FIRST ON PURPOSE. `selectSwapCandidates` ranks by the
    // resulting day's target proximity and then by `(slug, version)`, and keeps
    // only `MAX_SWAP_ALTERNATIVES` (8) rows; `selectSwapCandidate` then selects
    // out of that TRUNCATED list, so an admissible recipe ranked ninth is
    // `recipe_ineligible` by design. Every recipe here is nutritionally
    // identical, so proximity ties and the slug decides: `fault-suite-a…` ranks
    // ahead of the eleven `fault-suite-recipe-…` versions and the candidate is
    // reliably on the offer this suite commits from.
    const swapCandidate = await makePlainRecipe(
        'fault-suite-alternative',
        'Fault Suite Alternative',
        candidateFood,
    );

    const plan = await makePlan(SWAP_USER_ID, {
        startDate: PLAN_START_DAY_KEY,
        dayCount: 1,
        slots: [
            { slot: 'breakfast', slot_time: '08:00', recipeVersionId: plannedRecipes[0].id },
            { slot: 'lunch', slot_time: '12:30', recipeVersionId: plannedRecipes[1].id },
            { slot: 'dinner', slot_time: '18:30', recipeVersionId: plannedRecipes[2].id },
        ],
    });

    const day = plan.meal_plan_days[0];
    const lunch = day.meal_plan_meals.find((meal) => meal.slot === 'lunch');

    if (lunch === undefined) {
        throw new Error('The fault fixture plan was published without the lunch its swap cases replace.');
    }

    await writeInitialGroceryList(SWAP_USER_ID, plan.id);

    return {
        sharedFood,
        candidateFood,
        plannedRecipes,
        swapCandidate,
        planId: plan.id,
        dayId: day.id,
        lunchMealId: lunch.id,
    };
};

/* ---------------------------------------------------------------------------
 * The re-import window
 * ------------------------------------------------------------------------- */

/** The modules a faulted window hands its caller, each from the isolated graph. */
interface FaultedModules {
    /** What the re-imported accessor resolved — asserted before anything else. */
    readonly resolvedFault: string;
    readonly commitSwap: SwapServiceModule['commitSwap'];
    readonly generatePlan: MealPlanServiceModule['generatePlan'];
    // §0.9.4 arms `generation` for BOTH publication entry points, so the
    // regeneration case needs the faulted graph's copy too — the one whose
    // assurance is that the week it was asked to replace is still there.
    readonly regeneratePlan: MealPlanServiceModule['regeneratePlan'];
}

interface FaultWindowOptions {
    /** `production`, for the case that proves the switch is inert there. */
    readonly nodeEnv?: string;
}

/** What {@link withFaultedApp} hands its caller: the shipped app, faulted. */
interface FaultedApp {
    /** What the re-imported accessor resolved — asserted before anything else. */
    readonly resolvedFault: string;
    /** A supertest agent bound to an app built inside the isolated graph. */
    readonly agent: supertest.Agent;
}

/**
 * Runs `work` against a module graph imported with `MEAL_PLANNING_FAULT` (and,
 * optionally, `NODE_ENV`) already set, having captured whatever that graph is
 * needed for.
 *
 * This is the only way to reach the flag branches at all: `featureFlags.ts`
 * reads both variables once at import, so the graph has to be built again after
 * the assignment. `jest.isolateModules` keeps that second graph in a registry of
 * its own, and whatever `capture` takes out of it stays bound to it after the
 * callback returns — so the service a case calls, or the app it drives, is the
 * faulted one, while the assertions' own `prisma` import (taken at the top of
 * this file) still observes the same database. `capture` runs INSIDE the window,
 * which is what puts its `require` calls in the isolated registry.
 *
 * ONE window, and therefore one restore path, for both kinds of case. A second
 * copy of the save-and-restore below is exactly how one of the two copies comes
 * to be wrong, and the whole suite runs under `--runInBand`: a leaked
 * `MEAL_PLANNING_FAULT` would silently fault every later suite, and a leaked
 * `NODE_ENV` would fail `assertTestDatabase()` for all of them.
 *
 * The isolated graph constructs its own `PrismaClient`; it is disconnected in
 * the `finally`, and the environment is restored there too (DELETED rather than
 * assigned when it was previously unset, since assigning `undefined` would store
 * the string "undefined" and fail the flag module's own validation).
 */
const withIsolatedGraph = async <TCaptured, TResult>(
    fault: string,
    options: FaultWindowOptions,
    capture: () => TCaptured,
    work: (captured: TCaptured, resolvedFault: string) => Promise<TResult>,
): Promise<TResult> => {
    const previousFault = process.env.MEAL_PLANNING_FAULT;
    const previousNodeEnv = process.env.NODE_ENV;

    process.env.MEAL_PLANNING_FAULT = fault;

    if (options.nodeEnv !== undefined) {
        process.env.NODE_ENV = options.nodeEnv;
    }

    jest.resetModules();

    // Held on an object rather than in locals: the assignments happen inside
    // `isolateModules`' callback, and a property is still typed as possibly
    // absent afterwards where a captured local would need a cast to be read.
    const isolated: { client?: PrismaClientModule; resolvedFault?: string; captured?: TCaptured } = {};

    try {
        jest.isolateModules(() => {
            const featureFlags = require('../../utils/featureFlags') as FeatureFlagsModule;

            isolated.client = require('../../prisma/client') as PrismaClientModule;
            isolated.resolvedFault = featureFlags.mealPlanningFault();
            isolated.captured = capture();
        });

        const { captured, resolvedFault } = isolated;

        if (captured === undefined || resolvedFault === undefined) {
            throw new Error('The faulted module graph was not built, so no case can be run against it.');
        }

        return await work(captured, resolvedFault);
    } finally {
        if (isolated.client !== undefined) {
            await isolated.client.prisma.$disconnect();
        }

        if (previousFault === undefined) {
            delete process.env.MEAL_PLANNING_FAULT;
        } else {
            process.env.MEAL_PLANNING_FAULT = previousFault;
        }

        if (previousNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = previousNodeEnv;
        }

        jest.resetModules();
    }
};

/** The faulted graph's service functions, for the cases decided below HTTP. */
const withFault = async <TResult>(
    fault: string,
    work: (modules: FaultedModules) => Promise<TResult>,
    options: FaultWindowOptions = {},
): Promise<TResult> =>
    withIsolatedGraph(
        fault,
        options,
        () => {
            const swapService = require('../../services/swap.service') as SwapServiceModule;
            const mealPlanService = require('../../services/mealPlan.service') as MealPlanServiceModule;

            return {
                commitSwap: swapService.commitSwap,
                generatePlan: mealPlanService.generatePlan,
                regeneratePlan: mealPlanService.regeneratePlan,
            };
        },
        (captured, resolvedFault) => work({ resolvedFault, ...captured }),
    );

/**
 * The faulted graph's APP, for the cases that are only decided at the HTTP
 * boundary: the `log` fault's abort (which the controller performs), and the
 * `NODE_ENV` cases where the whole question is whether a request is answered.
 *
 * The app is built from the isolated graph rather than reused from
 * `../setup/testApp`, because that agent is bound to the ambient app whose
 * controller closed over the ambient flag values. `jestSetup.ts`'s
 * `jest.mock` factories for `utils/firebase` and `middleware/auth` survive
 * `jest.resetModules()` — the module registry is cleared, the mock registry is
 * not — so the isolated app authenticates through the same `x-test-user-id`
 * channel and needs no credentials.
 */
const withFaultedApp = async <TResult>(
    fault: string,
    work: (faulted: FaultedApp) => Promise<TResult>,
    options: FaultWindowOptions = {},
): Promise<TResult> =>
    withIsolatedGraph(
        fault,
        options,
        () => {
            const appModule = require('../../app') as AppModule;

            return { agent: supertest(appModule.default) };
        },
        (captured, resolvedFault) => work({ resolvedFault, ...captured }),
    );

/* ---------------------------------------------------------------------------
 * Request bodies and stored-state readers
 * ------------------------------------------------------------------------- */

const swapBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    recipeVersionId: fixture.swapCandidate.id,
    portionMultiplier: 1,
    expectedPlanRevision: PLAN_REVISION_BEFORE,
    idempotencyKey: SWAP_KEY,
    ...overrides,
});

const generateBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    startDate: PLAN_START_DAY_KEY,
    idempotencyKey: GENERATION_KEY,
    expectedPreferencesRevision: 1,
    expectedTargetsRevision: 1,
    ...overrides,
});

type StoredGroceryRow = Prisma.grocery_itemsGetPayload<Record<string, never>>;

const storedLunch = () => prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: fixture.lunchMealId } });

const storedDay = () => prisma.meal_plan_days.findUniqueOrThrow({ where: { id: fixture.dayId } });

const storedPlanRevision = async (): Promise<number> =>
    (await prisma.meal_plans.findUniqueOrThrow({ where: { id: fixture.planId }, select: { revision: true } }))
        .revision;

const storedGroceryRows = (): Promise<StoredGroceryRow[]> =>
    prisma.grocery_items.findMany({
        where: { meal_plan_id: fixture.planId, user_id: SWAP_USER_ID },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    });

const ledgerRowsFor = (userId: string, idempotencyKey: string) =>
    prisma.meal_plan_actions.findMany({ where: { user_id: userId, idempotency_key: idempotencyKey } });

const generatedPlans = () =>
    prisma.meal_plans.findMany({ where: { user_id: GENERATION_USER_ID }, orderBy: { id: 'asc' } });

/** Moves the stored preferences revision so a pinned request reads as stale. */
const setStoredPreferencesRevision = async (revision: number): Promise<void> => {
    await prisma.meal_plan_preferences.update({
        where: { user_id: GENERATION_USER_ID },
        data: { revision },
    });
};

/* ---------------------------------------------------------------------------
 * The request-level fixture
 *
 * A CURRENT week, because the controller passes no `now` and every service
 * defaults it to `new Date()`: an HTTP request resolves "today" from the real
 * clock, so the pinned week the service-level cases sit on would be an ended
 * plan and every write against it would answer `409 plan_not_active`.
 *
 * Two users, because the two halves of the seam need opposite states. A
 * generation may not overlap an active week, so the user it publishes for has
 * preferences and NO plan; a regeneration, a swap and a log all act on an
 * existing week, so the other user has one, with the shopping list a
 * publication would have left beside it.
 *
 * The recipes are the thirteen the shared fixture above already seeded —
 * `catalog_foods` and `recipes` are the tenant-less tables §0.5.1 describes, so
 * they serve both users. Thirteen is not decorative: a week is 21 planned meals
 * and §0.7.3 caps a recipe at two uses, so a feasible week needs at least
 * eleven distinct recipes and a smaller set answers `422 no_matching_meals`.
 * ------------------------------------------------------------------------- */

/** Publishes over HTTP, so it must own no week of its own. */
const HTTP_GENERATION_USER_ID = 'fault-suite-http-generation-user';

/** Owns the current week the regenerate, swap and log cases act on. */
const HTTP_PLAN_USER_ID = 'fault-suite-http-plan-user';

/** A third identity, which owns nothing — for the cross-user case. */
const HTTP_STRANGER_USER_ID = 'fault-suite-http-stranger';

const PLANS_PATH = '/api/meal-planning/plans';

/** The `yyyy-MM-dd` key of a `@db.Date` column value, which Prisma reads at UTC midnight. */
const DAY_KEY_LENGTH = 10;

const toDayKey = (date: Date): string => date.toISOString().slice(0, DAY_KEY_LENGTH);

interface RequestFixture {
    /** Today in UTC, read ONCE so no two assertions can straddle midnight. */
    readonly today: string;
    readonly planId: string;
    /** The plan day whose date IS `today`, so a log's diary date is inside the week. */
    readonly breakfastMealId: string;
    readonly lunchMealId: string;
}

let requestFixture: RequestFixture;

const seedRequestFixture = async (): Promise<RequestFixture> => {
    const today = utcTodayDayKey();

    // `time_zone: 'UTC'` rather than the factory's `America/New_York`: the
    // server resolves today in the user's stored zone (§0.5.2), and the day keys
    // this fixture computes are UTC ones, so the two agree by construction.
    await makeUser({ id: HTTP_GENERATION_USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(HTTP_GENERATION_USER_ID, { time_zone: 'UTC' });
    await makeUser({ id: HTTP_PLAN_USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(HTTP_PLAN_USER_ID, { time_zone: 'UTC' });
    await makeUser({ id: HTTP_STRANGER_USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(HTTP_STRANGER_USER_ID, { time_zone: 'UTC' });

    // Three DISTINCT recipes, so that every other seeded recipe is unused this
    // week and the swap cases have a non-empty offer to choose from.
    const plan = await makePlan(HTTP_PLAN_USER_ID, {
        today,
        slots: [
            { slot: 'breakfast', slot_time: '08:00', recipeVersionId: fixture.plannedRecipes[3].id },
            { slot: 'lunch', slot_time: '12:30', recipeVersionId: fixture.plannedRecipes[4].id },
            { slot: 'dinner', slot_time: '18:30', recipeVersionId: fixture.plannedRecipes[5].id },
        ],
    });

    const day = plan.meal_plan_days.find((candidate) => toDayKey(candidate.date) === today);

    if (day === undefined) {
        throw new Error(
            `the request fixture's week does not contain today (${today}), so no log could name a diary date inside it`,
        );
    }

    const breakfast = day.meal_plan_meals.find((meal) => meal.slot === 'breakfast');
    const lunch = day.meal_plan_meals.find((meal) => meal.slot === 'lunch');

    if (breakfast === undefined || lunch === undefined) {
        throw new Error("the request fixture's current day is missing one of the slots its cases act on");
    }

    await writeInitialGroceryList(HTTP_PLAN_USER_ID, plan.id);

    return { today, planId: plan.id, breakfastMealId: breakfast.id, lunchMealId: lunch.id };
};

beforeEach(async () => {
    await truncateFeatureTables();
    fixture = await seedFixture();
    requestFixture = await seedRequestFixture();
});

afterAll(async () => {
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * Request-level helpers
 *
 * Local to this file by design (Rule 7 §7.1): the abort and replay shapes below
 * are this seam's vocabulary and no other suite drives them, so they are not
 * promoted to a shared helper module in this folder.
 * ------------------------------------------------------------------------- */

/** Paths under the plan the request-level cases act on. */
const planPath = (suffix = ''): string => `${PLANS_PATH}/${requestFixture.planId}${suffix}`;

const mealPath = (mealId: string, suffix: string): string =>
    planPath(`/meals/${mealId}${suffix}`);

/**
 * Sends a request that is expected to lose its response after committing, and
 * proves that is what happened.
 *
 * A destroyed socket reaches supertest as a REJECTION carrying no `response`,
 * which is precisely what a client cannot distinguish from a dropped connection.
 * The rejection is caught here rather than allowed to escape: an unhandled
 * rejection from a destroyed socket fails a run in a way that looks like an
 * entirely different bug.
 *
 * The outcome is compared as one object so that a request which was ANSWERED
 * instead — the seam silently not firing, the failure mode a renamed header
 * would cause — fails with the status it answered rather than passing quietly.
 * The error's `message` and `code` are deliberately not asserted: which of
 * `socket hang up` and `ECONNRESET` surfaces is a timing detail of when the peer
 * observes the destroyed socket, and this seam's claim is about the database and
 * the absence of a response, not about libuv's wording.
 */
const sendAndExpectLostResponse = async (test: supertest.Test): Promise<void> => {
    const outcome = await test.then(
        (response) => ({ lostResponse: false, answeredWith: response.status }),
        (error: unknown) => ({
            lostResponse: true,
            carriedAResponse: (error as { response?: unknown }).response !== undefined,
        }),
    );

    expect(outcome).toEqual({ lostResponse: true, carriedAResponse: false });
};

/**
 * The one ledger row a keyed action leaves, asserted to be COMPLETED.
 *
 * The distinction from a reserved row is the whole content of the durability
 * claim: §0.5.1 leaves `response_status`, `response_snapshot` and
 * `plan_revision_after` null until `completeAction` fills them, and a reserved
 * row is visible only while its transaction is open. The controller destroys the
 * socket AFTER the service returned, so all three are filled — a pending row
 * here would mean the abort had pre-empted the completion it is supposed to
 * follow.
 */
const expectCompletedLedgerRow = async (
    userId: string,
    idempotencyKey: string,
    expected: { actionType: string; responseStatus: number },
) => {
    const rows = await ledgerRowsFor(userId, idempotencyKey);

    expect(rows).toHaveLength(1);

    const [row] = rows;

    expect(row.action_type).toBe(expected.actionType);
    expect(row.response_status).toBe(expected.responseStatus);
    expect(row.response_snapshot).not.toBeNull();
    expect(row.plan_revision_after).not.toBeNull();

    return row;
};

/**
 * Proves a replay is indistinguishable from the response the client never saw:
 * the PERSISTED status (never an inferred `200`), the stored body, and bytes
 * that do not move between replays.
 *
 * The body is compared against the stored snapshot by value, and the raw text of
 * two successive replays byte for byte. The second comparison is what "verbatim"
 * means to a client — it is strictly stronger than comparing serialisations of
 * parsed objects, since it admits no re-ordering — and it is available here
 * where comparing against the first response is not: that response was
 * destroyed, which is the premise of the case.
 */
const expectVerbatimReplay = async (
    sendReplay: () => supertest.Test,
    stored: { response_status: number | null; response_snapshot: Prisma.JsonValue },
): Promise<void> => {
    const first = await sendReplay();
    const second = await sendReplay();

    expect(first.status).toBe(stored.response_status);
    expect(first.body).toEqual(stored.response_snapshot);
    expect(second.status).toBe(first.status);
    expect(second.text).toBe(first.text);
};

/* ---------------------------------------------------------------------------
 * MEAL_PLANNING_FAULT=swap
 * ------------------------------------------------------------------------- */

describe('the injected swap fault', () => {
    it('fails the commit before its transaction opens, leaving the meal and the list exactly as they were', async () => {
        const mealBefore = await storedLunch();
        const dayBefore = await storedDay();
        const rowsBefore = await storedGroceryRows();

        const thrown = await withFault('swap', async ({ resolvedFault, commitSwap }) => {
            // Proven armed before anything is concluded from the outcome: this
            // is the value the re-imported accessor resolved, and the whole
            // reason the module graph was rebuilt.
            expect(resolvedFault).toBe('swap');

            return commitSwap(SWAP_USER_ID, fixture.planId, fixture.lunchMealId, swapBody(), NOW).then(
                () => null,
                (error: unknown) => error,
            );
        });

        // The class comes from the isolated graph, so it is matched by name
        // rather than by identity — `instanceof` against this file's own import
        // would compare two copies of the same class.
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).name).toBe('SwapFailedError');

        // 13e's copy — "your lunch is unchanged and your grocery list was not
        // updated" — is true because nothing ran, not because a rollback tidied
        // up: there is no ledger row for the key at all.
        expect(await ledgerRowsFor(SWAP_USER_ID, SWAP_KEY)).toHaveLength(0);
        expect(await storedLunch()).toEqual(mealBefore);
        expect(await storedDay()).toEqual(dayBefore);
        expect(await storedGroceryRows()).toEqual(rowsBefore);
        expect(await storedPlanRevision()).toBe(PLAN_REVISION_BEFORE);
        // The list the faulted commit would have changed: one line before, and
        // the candidate's own food is nowhere on it.
        expect(rowsBefore).toHaveLength(1);
        expect(rowsBefore[0].catalog_food_id).toBe(fixture.sharedFood.id);
    });

    it('commits exactly once when the same key and body are retried with the fault off', async () => {
        await withFault('swap', async ({ commitSwap }) =>
            commitSwap(SWAP_USER_ID, fixture.planId, fixture.lunchMealId, swapBody(), NOW).then(
                () => null,
                () => null,
            ),
        );

        // `commitSwap` here is this file's own top-level import — the ambient
        // module graph, whose `MEAL_PLANNING_FAULT` is the `off` that
        // `jestSetup.ts` sets. The same request, unfaulted.
        const retried = await commitSwap(SWAP_USER_ID, fixture.planId, fixture.lunchMealId, swapBody(), NOW);

        expect(retried.kind).toBe('ok');

        const lunch = await storedLunch();
        const ledger = await ledgerRowsFor(SWAP_USER_ID, SWAP_KEY);
        const rows = await storedGroceryRows();

        expect(lunch.recipe_version_id).toBe(fixture.swapCandidate.id);
        expect(lunch.revision).toBe(2);
        expect(await storedPlanRevision()).toBe(PLAN_REVISION_AFTER);
        // Exactly one: the faulted attempt reserved nothing, so the retry is the
        // first and only write under this key.
        expect(ledger).toHaveLength(1);
        expect(ledger[0].response_status).toBe(200);
        expect(ledger[0].plan_revision_after).toBe(PLAN_REVISION_AFTER);
        // And the list really did move, which is what makes the previous case's
        // "unchanged" assertion mean something.
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.catalog_food_id).sort()).toEqual(
            [fixture.sharedFood.id, fixture.candidateFood.id].sort(),
        );
    });

    it('still refuses a malformed body as invalid, so the fault never pre-empts the parse', async () => {
        const mealBefore = await storedLunch();

        const refusal = await withFault('swap', async ({ resolvedFault, commitSwap }) => {
            expect(resolvedFault).toBe('swap');

            return commitSwap(
                SWAP_USER_ID,
                fixture.planId,
                fixture.lunchMealId,
                swapBody({ portionMultiplier: 'half', expectedPlanRevision: 0 }),
                NOW,
            );
        });

        // A malformed request is a 400 whether or not a developer has the switch
        // on; answering `swap_failed` for it would attach 13e's assurance to a
        // request that was never committable.
        expect(refusal.kind).toBe('error');
        expect(refusal).toMatchObject({ code: 'invalid_request' });
        expect(await storedLunch()).toEqual(mealBefore);
        expect(await ledgerRowsFor(SWAP_USER_ID, SWAP_KEY)).toHaveLength(0);
    });

    it('is inert under NODE_ENV=production, where the commit goes through', async () => {
        const committed = await withFault(
            'swap',
            async ({ resolvedFault, commitSwap }) => {
                // The resolver checks production BEFORE it validates the value,
                // so a stray switch can never take the service down or fault it.
                expect(resolvedFault).toBe('off');

                return commitSwap(SWAP_USER_ID, fixture.planId, fixture.lunchMealId, swapBody(), NOW);
            },
            { nodeEnv: 'production' },
        );

        expect(committed.kind).toBe('ok');
        expect((await storedLunch()).recipe_version_id).toBe(fixture.swapCandidate.id);
        expect(await storedPlanRevision()).toBe(PLAN_REVISION_AFTER);
        expect(await ledgerRowsFor(SWAP_USER_ID, SWAP_KEY)).toHaveLength(1);
    });
});

/* ---------------------------------------------------------------------------
 * MEAL_PLANNING_FAULT=generation, and the invariant it is meant to exercise
 * ------------------------------------------------------------------------- */

describe('the injected generation fault', () => {
    it('fails the generation before its transaction opens, leaving no plan and no ledger row', async () => {
        // §0.9.2's invariant, asserted against the switch itself now that
        // `mealPlan.service.ts::raiseInjectedGenerationFault` sits between
        // `searchCandidateWeek` and `prisma.$transaction`.
        //
        // The two emptiness assertions are the whole point: the fault is raised
        // in FRONT of the PUBLISHING transaction, so no plan, day, meal or
        // grocery row is written and no ledger row SURVIVES.
        //
        // "Survives" rather than "was never reached", which would be untrue:
        // `generatePlan` calls `replayCommittedKeyedAction` before this fault,
        // and that preflight opens its own transaction, takes the per-user
        // `pg_advisory_xact_lock` and attempts this key's `INSERT … ON CONFLICT
        // DO NOTHING` reservation before rolling the whole thing back through
        // `KeyedActionPreflightRollback`. So the zero ledger count below is an
        // UNDONE ATTEMPT, not an attempt that never happened — which is exactly
        // what makes it worth asserting. A check armed one statement later,
        // inside the publishing transaction, would leave these same two
        // assertions passing for an entirely different reason, which is why the
        // position is stated in the service and pinned here.
        const refused = await withFault('generation', async ({ resolvedFault, generatePlan: faulted }) => {
            expect(resolvedFault).toBe('generation');

            return faulted(GENERATION_USER_ID, generateBody(), NOW).then(
                () => null,
                (error: unknown) => error,
            );
        });

        expect(refused).toBeInstanceOf(Error);
        expect((refused as Error).name).toBe('PlanGenerationError');
        expect(await generatedPlans()).toHaveLength(0);
        expect(await ledgerRowsFor(GENERATION_USER_ID, GENERATION_KEY)).toHaveLength(0);

        // The identical request — same key, same body — once the switch is off.
        // The faulted attempt DID reserve this key, in the preflight's
        // transaction, and then rolled that reservation back; what matters is
        // that none of it PERSISTED, so the ledger has no row for the key and
        // this is a first publication rather than a replay.
        const published = await generatePlan(GENERATION_USER_ID, generateBody(), NOW);

        expect(published.kind).toBe('ok');

        if (published.kind !== 'ok') {
            throw new Error(`the generation was refused as invalid: ${JSON.stringify(published)}`);
        }

        expect(published.result.status).toBe(201);

        const plans = await generatedPlans();

        expect(plans).toHaveLength(1);
        expect(plans[0].status).toBe('active');
        expect(plans[0].revision).toBe(1);
        expect(await ledgerRowsFor(GENERATION_USER_ID, GENERATION_KEY)).toHaveLength(1);
    });

    it('fails a regeneration the same way, leaving the week it was asked to replace active', async () => {
        // The assurance the 16b dialog makes, and the reason §0.9.4 arms this
        // fault for `/regenerate` as well: a regeneration that fails must leave
        // the user with the week they already had. The fault is raised before
        // the transaction that would have superseded it, so the old plan keeps
        // its `active` status AND its revision — an untouched row, not a
        // restored one.
        const original = await generatePlan(GENERATION_USER_ID, generateBody(), NOW);

        if (original.kind !== 'ok') {
            throw new Error(`the first publication was refused: ${JSON.stringify(original)}`);
        }

        const [before] = await generatedPlans();
        const preferences = await prisma.meal_plan_preferences.findUniqueOrThrow({
            where: { user_id: GENERATION_USER_ID },
            select: { revision: true },
        });
        const { revision: targetsRevision } = await getTargets(GENERATION_USER_ID);
        const regenerationKey = '66666666-6666-4666-8666-666666666666';

        const refused = await withFault('generation', async ({ regeneratePlan: faulted }) =>
            faulted(
                GENERATION_USER_ID,
                before.id,
                {
                    idempotencyKey: regenerationKey,
                    expectedPlanRevision: before.revision,
                    expectedPreferencesRevision: preferences.revision,
                    expectedTargetsRevision: targetsRevision,
                },
                NOW,
            ).then(
                () => null,
                (error: unknown) => error,
            ),
        );

        expect(refused).toBeInstanceOf(Error);
        expect((refused as Error).name).toBe('PlanGenerationError');

        // Still exactly one plan, still the original, still writable.
        const after = await generatedPlans();

        expect(after).toHaveLength(1);
        expect(after[0].id).toBe(before.id);
        expect(after[0].status).toBe('active');
        expect(after[0].revision).toBe(before.revision);
        expect(after[0].replaced_plan_id).toBeNull();
        expect(await ledgerRowsFor(GENERATION_USER_ID, regenerationKey)).toHaveLength(0);
    });

    it('is inert under NODE_ENV=production, where the generation goes through', async () => {
        // The resolver checks production BEFORE it validates the value, so a
        // stray switch on a production host can neither fault a generation nor
        // fail startup. Same guarantee the swap case above pins, asserted for
        // the entry point this file's other cases fault.
        const published = await withFault(
            'generation',
            async ({ resolvedFault, generatePlan: faulted }) => {
                expect(resolvedFault).toBe('off');

                return faulted(GENERATION_USER_ID, generateBody(), NOW);
            },
            { nodeEnv: 'production' },
        );

        expect(published.kind).toBe('ok');

        if (published.kind !== 'ok') {
            throw new Error(`the generation was refused as invalid: ${JSON.stringify(published)}`);
        }

        expect(published.result.status).toBe(201);
        expect(await generatedPlans()).toHaveLength(1);
        expect(await ledgerRowsFor(GENERATION_USER_ID, GENERATION_KEY)).toHaveLength(1);
    });

    it('leaves no plan and no ledger row when a generation fails before its transaction, and then publishes exactly one', async () => {
        // A stale pinned revision is refused by `searchCandidateWeek`, which
        // runs after the replay preflight and BEFORE the transaction — the same
        // position §0.9.4 gives the `generation` fault, so the rollback-only
        // property it is meant to exercise is the property under test here.
        await setStoredPreferencesRevision(2);

        const stale = await generatePlan(GENERATION_USER_ID, generateBody(), NOW).then(
            () => null,
            (error: unknown) => error,
        );

        expect(stale).toBeInstanceOf(Error);
        expect((stale as Error).name).toBe('StaleRevisionError');
        expect(await generatedPlans()).toHaveLength(0);
        expect(await ledgerRowsFor(GENERATION_USER_ID, GENERATION_KEY)).toHaveLength(0);

        // The identical request, once the reason it failed is gone.
        await setStoredPreferencesRevision(1);

        const published = await generatePlan(GENERATION_USER_ID, generateBody(), NOW);

        expect(published.kind).toBe('ok');

        if (published.kind !== 'ok') {
            throw new Error(`the generation was refused as invalid: ${JSON.stringify(published)}`);
        }

        expect(published.result.status).toBe(201);

        const plans = await generatedPlans();
        const ledger = await ledgerRowsFor(GENERATION_USER_ID, GENERATION_KEY);

        expect(plans).toHaveLength(1);
        expect(plans[0].status).toBe('active');
        expect(plans[0].revision).toBe(1);
        expect(ledger).toHaveLength(1);
        expect(ledger[0].response_status).toBe(201);
        expect(ledger[0].meal_plan_id).toBe(plans[0].id);

        // A published week, not a half-written one: seven days, three meals
        // each, and a shopping list the week's meals imply (the case below
        // measures that list food by food).
        expect(
            await prisma.meal_plan_days.count({ where: { meal_plan_id: plans[0].id } }),
        ).toBe(PLAN_DAY_COUNT);
        expect(
            await prisma.meal_plan_meals.count({ where: { meal_plan_id: plans[0].id } }),
        ).toBe(PLAN_DAY_COUNT * MEALS_PER_DAY);
        expect(
            await prisma.grocery_items.count({ where: { meal_plan_id: plans[0].id } }),
        ).toBeGreaterThan(0);
        expect(plans[0].targets_snapshot).toEqual({ ...FIXTURE_TARGETS });
    });

    it('publishes exactly one week however often the same key is replayed', async () => {
        const first = await generatePlan(GENERATION_USER_ID, generateBody(), NOW);
        const replay = await generatePlan(GENERATION_USER_ID, generateBody(), NOW);

        if (first.kind !== 'ok' || replay.kind !== 'ok') {
            throw new Error('the generation was refused as invalid');
        }

        expect(replay.result.status).toBe(first.result.status);
        expect(replay.result.planRevisionAfter).toBe(first.result.planRevisionAfter);
        expect(JSON.parse(JSON.stringify(replay.result.body))).toEqual(
            JSON.parse(JSON.stringify(first.result.body)),
        );
        // Everything a client can see is identical, and `replayed` is the one
        // thing that is not — asserted here, against the real ledger, because
        // this is where the two values are actually produced: the first answer
        // comes from the transaction that completed the reserved row, the
        // second from `response_snapshot` read back. The HTTP edge puts this
        // field in its server event and never in a response, so an operator can
        // tell a duplicate the ledger absorbed from a commit whose response was
        // lost while the client still cannot (AAP §0.5.1).
        expect(first.result.replayed).toBe(false);
        expect(replay.result.replayed).toBe(true);
        // One plan, one ledger row: the replay answered from the ledger without
        // searching or publishing a second week.
        expect(await generatedPlans()).toHaveLength(1);
        expect(await ledgerRowsFor(GENERATION_USER_ID, GENERATION_KEY)).toHaveLength(1);
    });

    it('leaves the grams every planned meal implies on the published list', async () => {
        const published = await generatePlan(GENERATION_USER_ID, generateBody(), NOW);

        if (published.kind !== 'ok') {
            throw new Error('the generation was refused as invalid');
        }

        const plan = (await generatedPlans())[0];
        const meals = await prisma.meal_plan_meals.findMany({
            where: { meal_plan_id: plan.id },
            select: { recipe_version_id: true, portion_multiplier: true },
        });

        expect(meals).toHaveLength(PLAN_DAY_COUNT * MEALS_PER_DAY);

        // The food each plannable recipe shops for. Every recipe in this fixture
        // has exactly ONE ingredient, so a meal's grams land whole on that
        // food's line — `gram_weight ÷ yield_servings × portion_multiplier` —
        // and the expectation is derived from the meals the generator actually
        // chose rather than from an assumption about which recipes it would use.
        const foodByRecipeVersion = new Map<string, string>([
            ...fixture.plannedRecipes.map((recipe): [string, string] => [recipe.id, fixture.sharedFood.id]),
            [fixture.swapCandidate.id, fixture.candidateFood.id],
        ]);

        const expectedGrams = new Map<string, number>();

        for (const meal of meals) {
            const foodId = foodByRecipeVersion.get(meal.recipe_version_id);

            if (foodId === undefined) {
                throw new Error(
                    `the generator planned a recipe version this suite never seeded: ${meal.recipe_version_id}`,
                );
            }

            expectedGrams.set(
                foodId,
                (expectedGrams.get(foodId) ?? 0) + GRAMS_PER_MEAL * meal.portion_multiplier,
            );
        }

        const rows = await prisma.grocery_items.findMany({ where: { meal_plan_id: plan.id } });

        // One line per food the week needs, each carrying the SUMMED grams of
        // every meal that needs it and none of them checked — §0.7.3's numeric
        // contract, measured against the rows the publication wrote rather than
        // against the DTO it returned.
        expect(expectedGrams.size).toBeGreaterThan(0);
        expect(rows).toHaveLength(expectedGrams.size);
        expect(new Set(rows.map((row) => row.catalog_food_id))).toEqual(new Set(expectedGrams.keys()));

        for (const row of rows) {
            const expected = expectedGrams.get(row.catalog_food_id);

            if (expected === undefined) {
                throw new Error(`the published list carries a food no planned meal needs: ${row.catalog_food_id}`);
            }

            expect(row.quantity_grams.toNumber()).toBeCloseTo(expected, 2);
            expect(row.is_checked).toBe(false);
        }
    });
});

/* ---------------------------------------------------------------------------
 * The post-commit abort seam
 *
 * §0.9.2's "one commit, then replay" row, driven through the shipped app for
 * each of the four keyed writes. The shape is identical every time, because the
 * claim is: the request rejects at the socket with no response, the write is
 * durable and singular, the ledger row is COMPLETED, the same key replays the
 * stored response verbatim without moving anything, and the same key with a
 * different body is refused.
 *
 * These cases use the HEADER rather than `MEAL_PLANNING_FAULT=log`, and so need
 * no re-imported graph: `postCommitAbort` reads the header whenever `NODE_ENV`
 * is `test`, which Jest has already set. The flag's own path is proven
 * equivalent once, further down, so the two cannot drift.
 * ------------------------------------------------------------------------- */

const HTTP_GENERATION_KEY = '77777777-7777-4777-8777-777777777777';
const HTTP_REGENERATION_KEY = '88888888-8888-4888-8888-888888888888';
const HTTP_SWAP_KEY = '99999999-9999-4999-8999-999999999999';
const HTTP_LOG_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const httpGenerateBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    startDate: requestFixture.today,
    idempotencyKey: HTTP_GENERATION_KEY,
    expectedPreferencesRevision: 1,
    expectedTargetsRevision: 1,
    ...overrides,
});

const httpRegenerateBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    idempotencyKey: HTTP_REGENERATION_KEY,
    expectedPlanRevision: PLAN_REVISION_BEFORE,
    expectedPreferencesRevision: 1,
    expectedTargetsRevision: 1,
    ...overrides,
});

/** Every plan of a request-level user, oldest id first. */
const plansOf = (userId: string) =>
    prisma.meal_plans.findMany({ where: { user_id: userId }, orderBy: { id: 'asc' } });

/** Every grocery row of the request fixture's week, in list order. */
const requestGroceryRows = (): Promise<StoredGroceryRow[]> =>
    prisma.grocery_items.findMany({
        where: { meal_plan_id: requestFixture.planId, user_id: HTTP_PLAN_USER_ID },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    });

/**
 * The alternative a client would open: the first row of the offer the shipped
 * endpoint actually returned, with the portion IT chose.
 *
 * Read from the endpoint rather than assumed, for two reasons. The commit
 * recomputes the portion and answers `409 preview_stale` when it disagrees, so
 * the multiplier has to be the server's own; and `selectSwapCandidates` ranks by
 * the resulting day's proximity and then by slug before truncating to eight, so
 * a hard-coded candidate would silently become `recipe_ineligible` if the
 * ranking or the fixture's slugs ever moved.
 */
const firstAlternative = async (
    mealId: string,
): Promise<{ recipeVersionId: string; portionMultiplier: number }> => {
    const response = await asUser(request.get(mealPath(mealId, '/alternatives')), {
        uid: HTTP_PLAN_USER_ID,
    }).expect(200);
    const offer = response.body as {
        alternatives: { recipeVersionId: string; portionMultiplier: number }[];
    };
    const [best] = offer.alternatives;

    if (best === undefined) {
        throw new Error(
            'the request fixture offered no swap alternatives, so no commit could be aborted after committing',
        );
    }

    return { recipeVersionId: best.recipeVersionId, portionMultiplier: best.portionMultiplier };
};

/**
 * The diary bucket a client sends as `diaryMealId`, obtained the way a client
 * obtains it: through the shipped `GET /api/macros/:date`, which backfills the
 * four default buckets on read (§0.7.3).
 */
const diaryBucketId = async (userId: string, dayKey: string, bucketName: string): Promise<string> => {
    const response = await asUser(request.get(`/api/macros/${dayKey}`), { uid: userId }).expect(200);
    const diary = response.body as { meals: { id: string; name: string }[] };
    const bucket = diary.meals.find((meal) => meal.name === bucketName);

    if (bucket === undefined) {
        throw new Error(`GET /api/macros/${dayKey} returned no "${bucketName}" bucket for ${userId}`);
    }

    return bucket.id;
};

describe('a generation whose response is lost after it commits', () => {
    it('leaves one published week and one completed ledger row, and replays its stored 201 verbatim', async () => {
        const body = httpGenerateBody();

        await sendAndExpectLostResponse(
            asUser(request.post(PLANS_PATH), { uid: HTTP_GENERATION_USER_ID })
                .set(POST_COMMIT_ABORT_HEADER, 'generate')
                .send(body),
        );

        // Durable, and singular: the transaction committed before the controller
        // dropped the response, so the week belongs to the user whether or not
        // they ever saw it — and there is exactly one of it.
        const published = await plansOf(HTTP_GENERATION_USER_ID);

        expect(published).toHaveLength(1);
        expect(published[0].status).toBe('active');
        expect(published[0].revision).toBe(PLAN_REVISION_BEFORE);
        expect(
            await prisma.meal_plan_days.count({ where: { meal_plan_id: published[0].id } }),
        ).toBe(PLAN_DAY_COUNT);
        expect(
            await prisma.meal_plan_meals.count({ where: { meal_plan_id: published[0].id } }),
        ).toBe(PLAN_DAY_COUNT * MEALS_PER_DAY);

        const row = await expectCompletedLedgerRow(HTTP_GENERATION_USER_ID, HTTP_GENERATION_KEY, {
            actionType: 'generate',
            responseStatus: 201,
        });

        expect(row.meal_plan_id).toBe(published[0].id);
        expect(row.plan_revision_after).toBe(PLAN_REVISION_BEFORE);

        // The retry a client makes when it cannot tell whether its request
        // arrived. The `201` it receives is the PERSISTED status, not one
        // inferred from the fact that a plan now exists.
        await expectVerbatimReplay(
            () => asUser(request.post(PLANS_PATH), { uid: HTTP_GENERATION_USER_ID }).send(body),
            row,
        );

        const afterReplays = await plansOf(HTTP_GENERATION_USER_ID);

        expect(afterReplays).toEqual(published);
        expect(await ledgerRowsFor(HTTP_GENERATION_USER_ID, HTTP_GENERATION_KEY)).toHaveLength(1);
    });

    it('refuses the same key with a different body, leaving the committed week and its stored response alone', async () => {
        await sendAndExpectLostResponse(
            asUser(request.post(PLANS_PATH), { uid: HTTP_GENERATION_USER_ID })
                .set(POST_COMMIT_ABORT_HEADER, 'generate')
                .send(httpGenerateBody()),
        );

        const published = await plansOf(HTTP_GENERATION_USER_ID);
        const ledgerBefore = await ledgerRowsFor(HTTP_GENERATION_USER_ID, HTTP_GENERATION_KEY);

        // Same key, a week later. A client that changed its request has changed
        // its intent, and §0.5.1 refuses to answer it with the stored reply.
        const conflicted = await asUser(request.post(PLANS_PATH), { uid: HTTP_GENERATION_USER_ID }).send(
            httpGenerateBody({ startDate: addDaysToDayKey(requestFixture.today, 1) }),
        );

        expect(conflicted.status).toBe(409);
        expect(conflicted.body).toEqual({ error: 'idempotency_conflict' });
        expect(await plansOf(HTTP_GENERATION_USER_ID)).toEqual(published);
        expect(await ledgerRowsFor(HTTP_GENERATION_USER_ID, HTTP_GENERATION_KEY)).toEqual(ledgerBefore);
    });
});

describe('a regeneration whose response is lost after it commits', () => {
    it('supersedes exactly one week, publishes exactly one, and replays its stored 201 verbatim', async () => {
        const body = httpRegenerateBody();

        await sendAndExpectLostResponse(
            asUser(request.post(planPath('/regenerate')), { uid: HTTP_PLAN_USER_ID })
                .set(POST_COMMIT_ABORT_HEADER, 'regenerate')
                .send(body),
        );

        // The chain §0.5.1 describes: the replaced week is superseded, the new
        // one is active and points back at it. A regeneration whose response was
        // lost must not leave two active weeks, nor none.
        const plans = await plansOf(HTTP_PLAN_USER_ID);
        const active = plans.filter((plan) => plan.status === 'active');
        const superseded = plans.filter((plan) => plan.status === 'superseded');

        expect(plans).toHaveLength(2);
        expect(active).toHaveLength(1);
        expect(superseded).toHaveLength(1);
        expect(superseded[0].id).toBe(requestFixture.planId);
        expect(active[0].replaced_plan_id).toBe(requestFixture.planId);

        const row = await expectCompletedLedgerRow(HTTP_PLAN_USER_ID, HTTP_REGENERATION_KEY, {
            actionType: 'regenerate',
            responseStatus: 201,
        });

        expect(row.meal_plan_id).toBe(active[0].id);

        await expectVerbatimReplay(
            () => asUser(request.post(planPath('/regenerate')), { uid: HTTP_PLAN_USER_ID }).send(body),
            row,
        );

        // Byte-identical rows, which is the strongest available form of "the
        // revision did not advance a second time": neither plan moved at all.
        expect(await plansOf(HTTP_PLAN_USER_ID)).toEqual(plans);
        expect(await ledgerRowsFor(HTTP_PLAN_USER_ID, HTTP_REGENERATION_KEY)).toHaveLength(1);
    });

    it('refuses the same key with a different body, leaving the chain it already committed alone', async () => {
        await sendAndExpectLostResponse(
            asUser(request.post(planPath('/regenerate')), { uid: HTTP_PLAN_USER_ID })
                .set(POST_COMMIT_ABORT_HEADER, 'regenerate')
                .send(httpRegenerateBody()),
        );

        const plans = await plansOf(HTTP_PLAN_USER_ID);
        const ledgerBefore = await ledgerRowsFor(HTTP_PLAN_USER_ID, HTTP_REGENERATION_KEY);

        const conflicted = await asUser(request.post(planPath('/regenerate')), {
            uid: HTTP_PLAN_USER_ID,
        }).send(httpRegenerateBody({ expectedPlanRevision: PLAN_REVISION_AFTER }));

        expect(conflicted.status).toBe(409);
        expect(conflicted.body).toEqual({ error: 'idempotency_conflict' });
        expect(await plansOf(HTTP_PLAN_USER_ID)).toEqual(plans);
        expect(await ledgerRowsFor(HTTP_PLAN_USER_ID, HTTP_REGENERATION_KEY)).toEqual(ledgerBefore);
    });
});

describe('a swap whose response is lost after it commits', () => {
    it('leaves one swapped meal and one rebuilt list, and replays its stored 200 verbatim', async () => {
        const chosen = await firstAlternative(requestFixture.lunchMealId);
        const body = {
            ...chosen,
            expectedPlanRevision: PLAN_REVISION_BEFORE,
            idempotencyKey: HTTP_SWAP_KEY,
        };

        await sendAndExpectLostResponse(
            asUser(request.post(mealPath(requestFixture.lunchMealId, '/swap')), { uid: HTTP_PLAN_USER_ID })
                .set(POST_COMMIT_ABORT_HEADER, 'swap')
                .send(body),
        );

        const swapped = await prisma.meal_plan_meals.findUniqueOrThrow({
            where: { id: requestFixture.lunchMealId },
        });

        expect(swapped.recipe_version_id).toBe(chosen.recipeVersionId);
        expect(swapped.revision).toBe(PLAN_REVISION_AFTER);
        expect(
            (
                await prisma.meal_plans.findUniqueOrThrow({
                    where: { id: requestFixture.planId },
                    select: { revision: true },
                })
            ).revision,
        ).toBe(PLAN_REVISION_AFTER);

        const row = await expectCompletedLedgerRow(HTTP_PLAN_USER_ID, HTTP_SWAP_KEY, {
            actionType: 'swap',
            responseStatus: 200,
        });

        expect(row.meal_plan_meal_id).toBe(requestFixture.lunchMealId);
        expect(row.plan_revision_after).toBe(PLAN_REVISION_AFTER);

        // The list as the commit rebuilt it, before any replay touches it.
        const rebuilt = await requestGroceryRows();

        await expectVerbatimReplay(
            () =>
                asUser(request.post(mealPath(requestFixture.lunchMealId, '/swap')), {
                    uid: HTTP_PLAN_USER_ID,
                }).send(body),
            row,
        );

        // The diff was applied ONCE. A replay that re-ran the commit would show
        // here as moved quantities or a second revision bump, and the grams
        // below are measured against the meals the week actually plans rather
        // than against a number written twice.
        expect(await requestGroceryRows()).toEqual(rebuilt);
        expect(
            await prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: requestFixture.lunchMealId } }),
        ).toEqual(swapped);
        expect(await ledgerRowsFor(HTTP_PLAN_USER_ID, HTTP_SWAP_KEY)).toHaveLength(1);

        const plannedGrams = await prisma.meal_plan_meals
            .findMany({
                where: { meal_plan_id: requestFixture.planId },
                select: { portion_multiplier: true },
            })
            .then((meals) =>
                meals.reduce((total, meal) => total + GRAMS_PER_MEAL * meal.portion_multiplier, 0),
            );

        expect(
            rebuilt.reduce((total, groceryRow) => total + groceryRow.quantity_grams.toNumber(), 0),
        ).toBeCloseTo(plannedGrams, 2);
    });

    it('refuses the same key with a different body, leaving the swapped meal and the list alone', async () => {
        const chosen = await firstAlternative(requestFixture.lunchMealId);
        const body = {
            ...chosen,
            expectedPlanRevision: PLAN_REVISION_BEFORE,
            idempotencyKey: HTTP_SWAP_KEY,
        };

        await sendAndExpectLostResponse(
            asUser(request.post(mealPath(requestFixture.lunchMealId, '/swap')), { uid: HTTP_PLAN_USER_ID })
                .set(POST_COMMIT_ABORT_HEADER, 'swap')
                .send(body),
        );

        const swapped = await prisma.meal_plan_meals.findUniqueOrThrow({
            where: { id: requestFixture.lunchMealId },
        });
        const rebuilt = await requestGroceryRows();
        const ledgerBefore = await ledgerRowsFor(HTTP_PLAN_USER_ID, HTTP_SWAP_KEY);

        const conflicted = await asUser(
            request.post(mealPath(requestFixture.lunchMealId, '/swap')),
            { uid: HTTP_PLAN_USER_ID },
        ).send({ ...body, portionMultiplier: chosen.portionMultiplier === 1 ? 1.5 : 1 });

        expect(conflicted.status).toBe(409);
        expect(conflicted.body).toEqual({ error: 'idempotency_conflict' });
        expect(
            await prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: requestFixture.lunchMealId } }),
        ).toEqual(swapped);
        expect(await requestGroceryRows()).toEqual(rebuilt);
        expect(await ledgerRowsFor(HTTP_PLAN_USER_ID, HTTP_SWAP_KEY)).toEqual(ledgerBefore);
    });
});

describe('a planned log whose response is lost after it commits', () => {
    it('writes exactly one diary entry and one completed ledger row, and replays its stored 201 verbatim', async () => {
        const bucketId = await diaryBucketId(HTTP_PLAN_USER_ID, requestFixture.today, 'Breakfast');
        const body = {
            servings: 1,
            date: requestFixture.today,
            diaryMealId: bucketId,
            expectedPlanRevision: PLAN_REVISION_BEFORE,
            idempotencyKey: HTTP_LOG_KEY,
        };

        await sendAndExpectLostResponse(
            asUser(request.post(mealPath(requestFixture.breakfastMealId, '/log')), {
                uid: HTTP_PLAN_USER_ID,
            })
                .set(POST_COMMIT_ABORT_HEADER, 'log')
                .send(body),
        );

        // One entry, which is the whole point: the user-visible consequence of
        // getting this wrong is a meal logged twice.
        const entries = await prisma.meal_entries.findMany({ where: { user_id: HTTP_PLAN_USER_ID } });

        expect(entries).toHaveLength(1);
        expect(entries[0].meal_plan_meal_id).toBe(requestFixture.breakfastMealId);

        const row = await expectCompletedLedgerRow(HTTP_PLAN_USER_ID, HTTP_LOG_KEY, {
            actionType: 'log',
            responseStatus: 201,
        });

        expect(row.meal_entry_id).toBe(entries[0].id);

        await expectVerbatimReplay(
            () =>
                asUser(request.post(mealPath(requestFixture.breakfastMealId, '/log')), {
                    uid: HTTP_PLAN_USER_ID,
                }).send(body),
            row,
        );

        expect(await prisma.meal_entries.findMany({ where: { user_id: HTTP_PLAN_USER_ID } })).toEqual(
            entries,
        );
        expect(await ledgerRowsFor(HTTP_PLAN_USER_ID, HTTP_LOG_KEY)).toHaveLength(1);

        // And the card the user comes back to says "logged" exactly once: the
        // slot's logged state is derived from its linked entries (§0.5.2), so a
        // second entry would show up here as a second `loggedEntries` member.
        const dayResponse = await asUser(
            request.get(planPath(`/days/${requestFixture.today}`)),
            { uid: HTTP_PLAN_USER_ID },
        ).expect(200);
        const envelope = dayResponse.body as {
            day: { meals: { id: string; loggedEntries: { entryId: string }[] }[] };
        };
        const breakfast = envelope.day.meals.find(
            (meal) => meal.id === requestFixture.breakfastMealId,
        );

        expect(breakfast?.loggedEntries).toHaveLength(1);
        expect(breakfast?.loggedEntries[0].entryId).toBe(entries[0].id);
    });

    it('refuses the same key with a different portion, leaving the one entry it already wrote alone', async () => {
        const bucketId = await diaryBucketId(HTTP_PLAN_USER_ID, requestFixture.today, 'Breakfast');
        const body = {
            servings: 1,
            date: requestFixture.today,
            diaryMealId: bucketId,
            expectedPlanRevision: PLAN_REVISION_BEFORE,
            idempotencyKey: HTTP_LOG_KEY,
        };

        await sendAndExpectLostResponse(
            asUser(request.post(mealPath(requestFixture.breakfastMealId, '/log')), {
                uid: HTTP_PLAN_USER_ID,
            })
                .set(POST_COMMIT_ABORT_HEADER, 'log')
                .send(body),
        );

        const entries = await prisma.meal_entries.findMany({ where: { user_id: HTTP_PLAN_USER_ID } });
        const ledgerBefore = await ledgerRowsFor(HTTP_PLAN_USER_ID, HTTP_LOG_KEY);

        // A user who ate a second helping is making a NEW request, not retrying
        // the old one; reusing the key for it is the mistake §0.5.1 refuses.
        const conflicted = await asUser(
            request.post(mealPath(requestFixture.breakfastMealId, '/log')),
            { uid: HTTP_PLAN_USER_ID },
        ).send({ ...body, servings: 2 });

        expect(conflicted.status).toBe(409);
        expect(conflicted.body).toEqual({ error: 'idempotency_conflict' });
        expect(await prisma.meal_entries.findMany({ where: { user_id: HTTP_PLAN_USER_ID } })).toEqual(
            entries,
        );
        expect(await ledgerRowsFor(HTTP_PLAN_USER_ID, HTTP_LOG_KEY)).toEqual(ledgerBefore);
    });
});

/* ---------------------------------------------------------------------------
 * MEAL_PLANNING_FAULT=log — the same seam, reachable from a device
 *
 * §0.9.4 arms this switch so a developer driving a real iPhone against a dev
 * backend can reach the unconfirmed-outcome UI, where no test header is
 * available. It must therefore behave EXACTLY as the header does, and it must be
 * scoped to the log: `postCommitAbort` matches on `actionType`, so a mis-scoped
 * predicate would silently break three unrelated flows on any host where a
 * developer left the switch on.
 * ------------------------------------------------------------------------- */

const FLAGGED_LOG_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** The plan revision a keyed write must pin, read rather than assumed. */
const currentRequestPlanRevision = async (): Promise<number> =>
    (
        await prisma.meal_plans.findUniqueOrThrow({
            where: { id: requestFixture.planId },
            select: { revision: true },
        })
    ).revision;

describe('the log fault as the device-reachable form of the abort seam', () => {
    it('drops the response over a durable write, exactly as the header does', async () => {
        const bucketId = await diaryBucketId(HTTP_PLAN_USER_ID, requestFixture.today, 'Breakfast');
        const body = {
            servings: 1,
            date: requestFixture.today,
            diaryMealId: bucketId,
            expectedPlanRevision: PLAN_REVISION_BEFORE,
            idempotencyKey: FLAGGED_LOG_KEY,
        };

        await withFaultedApp('log', async ({ resolvedFault, agent }) => {
            // Proven armed before anything is concluded from the outcome.
            expect(resolvedFault).toBe('log');

            // No header at all: the switch alone is what drops this response.
            await sendAndExpectLostResponse(
                agent
                    .post(mealPath(requestFixture.breakfastMealId, '/log'))
                    .set('x-test-user-id', HTTP_PLAN_USER_ID)
                    .send(body),
            );
        });

        const entries = await prisma.meal_entries.findMany({ where: { user_id: HTTP_PLAN_USER_ID } });

        expect(entries).toHaveLength(1);
        expect(entries[0].meal_plan_meal_id).toBe(requestFixture.breakfastMealId);

        const row = await expectCompletedLedgerRow(HTTP_PLAN_USER_ID, FLAGGED_LOG_KEY, {
            actionType: 'log',
            responseStatus: 201,
        });

        expect(row.meal_entry_id).toBe(entries[0].id);

        // Replayed through the AMBIENT app, whose switch is the `off` that
        // `jestSetup.ts` sets — the developer turning the fault back off. The
        // faulted app would drop this response too, which is the point of it.
        await expectVerbatimReplay(
            () =>
                asUser(request.post(mealPath(requestFixture.breakfastMealId, '/log')), {
                    uid: HTTP_PLAN_USER_ID,
                }).send(body),
            row,
        );

        expect(await prisma.meal_entries.findMany({ where: { user_id: HTTP_PLAN_USER_ID } })).toEqual(
            entries,
        );
    });

    it('does not abort a generation', async () => {
        const body = httpGenerateBody();

        const published = await withFaultedApp('log', async ({ resolvedFault, agent }) => {
            expect(resolvedFault).toBe('log');

            return agent
                .post(PLANS_PATH)
                .set('x-test-user-id', HTTP_GENERATION_USER_ID)
                .send(body);
        });

        expect(published.status).toBe(201);
        expect(published.body).toMatchObject({ id: expect.any(String), status: 'active' });
        expect(await plansOf(HTTP_GENERATION_USER_ID)).toHaveLength(1);
    });

    it('does not abort a swap', async () => {
        const chosen = await firstAlternative(requestFixture.lunchMealId);

        const swapped = await withFaultedApp('log', async ({ resolvedFault, agent }) => {
            expect(resolvedFault).toBe('log');

            return agent
                .post(mealPath(requestFixture.lunchMealId, '/swap'))
                .set('x-test-user-id', HTTP_PLAN_USER_ID)
                .send({
                    ...chosen,
                    expectedPlanRevision: PLAN_REVISION_BEFORE,
                    idempotencyKey: HTTP_SWAP_KEY,
                });
        });

        expect(swapped.status).toBe(200);
        expect(swapped.body).toMatchObject({ planRevision: PLAN_REVISION_AFTER });
        expect(
            (
                await prisma.meal_plan_meals.findUniqueOrThrow({
                    where: { id: requestFixture.lunchMealId },
                })
            ).recipe_version_id,
        ).toBe(chosen.recipeVersionId);
    });

    it('does not abort a regeneration', async () => {
        const regenerated = await withFaultedApp('log', async ({ resolvedFault, agent }) => {
            expect(resolvedFault).toBe('log');

            return agent
                .post(planPath('/regenerate'))
                .set('x-test-user-id', HTTP_PLAN_USER_ID)
                .send(httpRegenerateBody());
        });

        expect(regenerated.status).toBe(201);
        expect(regenerated.body).toMatchObject({ id: expect.any(String), status: 'active' });
        expect(await plansOf(HTTP_PLAN_USER_ID)).toHaveLength(2);
    });
});

/* ---------------------------------------------------------------------------
 * The decoded faults at the HTTP boundary
 *
 * The other seam, seen from the client: a `502` whose `error` is a machine code
 * the client recognises. §0.2.5 treats a 5xx as a CONFIRMED failure only on that
 * basis, so these two spellings are the difference between reaching frames 10b
 * and 13e and falling into the unconfirmed-outcome path instead.
 * ------------------------------------------------------------------------- */

/**
 * A failure body that carries a machine code and NOTHING else.
 *
 * Compared by value rather than by `toMatchObject`, because the claim includes
 * the absence of extra members: Rule 7 §4 names `{ error: err }` as the pattern
 * to fix, and a body that also carried a message, a stack or Prisma's own
 * wording would satisfy a partial match while leaking exactly what that rule
 * forbids. The raw text is checked too, since a serialised `Error` can hide a
 * stack inside a nested member.
 */
const expectMachineReadableFailure = (
    response: supertest.Response,
    expected: { status: number; code: string },
): void => {
    expect(response.status).toBe(expected.status);
    expect(response.body).toEqual({ error: expected.code });
    expect(response.text).not.toMatch(/\bat\s+\S+\s+\(/);
    expect(response.text.toLowerCase()).not.toContain('prisma');
    expect(response.text.toLowerCase()).not.toContain('stack');
};

describe('the injected generation fault at the HTTP boundary', () => {
    it('answers 502 plan_generation_failed, persists nothing, and lets the same key commit once the fault is off', async () => {
        const body = httpGenerateBody();

        const refused = await withFaultedApp('generation', async ({ resolvedFault, agent }) => {
            expect(resolvedFault).toBe('generation');

            return agent
                .post(PLANS_PATH)
                .set('x-test-user-id', HTTP_GENERATION_USER_ID)
                .send(body);
        });

        expectMachineReadableFailure(refused, { status: 502, code: 'plan_generation_failed' });

        // Nothing was written, and — the load-bearing part — no reservation
        // SURVIVED. The fault is raised in front of the publishing transaction,
        // but not in front of everything: `replayCommittedKeyedAction` ran
        // first, took the per-user advisory lock and attempted this key's
        // reservation, and `KeyedActionPreflightRollback` undid both. So the
        // zero ledger count below is a reservation attempted and rolled back,
        // which is precisely why it is worth asserting.
        expect(await plansOf(HTTP_GENERATION_USER_ID)).toHaveLength(0);
        expect(await prisma.meal_plan_days.count({ where: { user_id: HTTP_GENERATION_USER_ID } })).toBe(0);
        expect(await prisma.meal_plan_meals.count({ where: { user_id: HTTP_GENERATION_USER_ID } })).toBe(0);
        expect(await prisma.grocery_items.count({ where: { user_id: HTTP_GENERATION_USER_ID } })).toBe(0);
        expect(await ledgerRowsFor(HTTP_GENERATION_USER_ID, HTTP_GENERATION_KEY)).toHaveLength(0);

        // The identical request once the switch is off. Because the faulted
        // attempt's reservation did not persist, the ledger has never seen this
        // key, so this is a FRESH commit rather than a replay — which is the
        // property that distinguishes this seam from the abort one, where the
        // reservation DOES survive and the retry replays the stored response.
        const published = await asUser(request.post(PLANS_PATH), {
            uid: HTTP_GENERATION_USER_ID,
        }).send(body);

        expect(published.status).toBe(201);
        expect(await plansOf(HTTP_GENERATION_USER_ID)).toHaveLength(1);
        await expectCompletedLedgerRow(HTTP_GENERATION_USER_ID, HTTP_GENERATION_KEY, {
            actionType: 'generate',
            responseStatus: 201,
        });
    });

    it('answers 502 on a regeneration and leaves the week it was asked to replace active', async () => {
        const refused = await withFaultedApp('generation', async ({ resolvedFault, agent }) => {
            expect(resolvedFault).toBe('generation');

            return agent
                .post(planPath('/regenerate'))
                .set('x-test-user-id', HTTP_PLAN_USER_ID)
                .send(httpRegenerateBody());
        });

        expectMachineReadableFailure(refused, { status: 502, code: 'plan_generation_failed' });

        // The assurance the 16b dialog makes: a failed regeneration leaves the
        // user with the week they already had, untouched rather than restored.
        const plans = await plansOf(HTTP_PLAN_USER_ID);

        expect(plans).toHaveLength(1);
        expect(plans[0].id).toBe(requestFixture.planId);
        expect(plans[0].status).toBe('active');
        expect(plans[0].revision).toBe(PLAN_REVISION_BEFORE);
        expect(plans[0].replaced_plan_id).toBeNull();
        expect(await ledgerRowsFor(HTTP_PLAN_USER_ID, HTTP_REGENERATION_KEY)).toHaveLength(0);
    });
});

describe('the injected swap fault at the HTTP boundary', () => {
    it('answers 502 swap_failed with the meal and the grocery list untouched', async () => {
        const chosen = await firstAlternative(requestFixture.lunchMealId);
        const mealBefore = await prisma.meal_plan_meals.findUniqueOrThrow({
            where: { id: requestFixture.lunchMealId },
        });
        const rowsBefore = await requestGroceryRows();

        const refused = await withFaultedApp('swap', async ({ resolvedFault, agent }) => {
            expect(resolvedFault).toBe('swap');

            return agent
                .post(mealPath(requestFixture.lunchMealId, '/swap'))
                .set('x-test-user-id', HTTP_PLAN_USER_ID)
                .send({
                    ...chosen,
                    expectedPlanRevision: PLAN_REVISION_BEFORE,
                    idempotencyKey: HTTP_SWAP_KEY,
                });
        });

        expectMachineReadableFailure(refused, { status: 502, code: 'swap_failed' });

        // 13e's drawn copy — "your lunch is unchanged and your grocery list was
        // not updated" — is truthful ONLY for this response, so the grocery
        // assertion is what keeps that sentence honest.
        expect(
            await prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: requestFixture.lunchMealId } }),
        ).toEqual(mealBefore);
        expect(await requestGroceryRows()).toEqual(rowsBefore);
        expect(await currentRequestPlanRevision()).toBe(PLAN_REVISION_BEFORE);
        expect(await ledgerRowsFor(HTTP_PLAN_USER_ID, HTTP_SWAP_KEY)).toHaveLength(0);
    });
});

/* ---------------------------------------------------------------------------
 * Inertness — where neither switch may reach
 *
 * Both are development affordances, and each is inert in a different way.
 * `MEAL_PLANNING_FAULT` is forced to `'off'` under `NODE_ENV=production` BEFORE
 * its value is validated, so a stray or misspelled setting on a production host
 * can neither fault a request nor fail startup (§0.4.3). The header is read only
 * when `NODE_ENV` is `test`, which makes it unreachable from a deployed
 * environment — a client-supplied header must never be able to drop a response.
 *
 * `featureFlags.test.ts` owns the parser itself (its accepted values, its
 * default and its refusal of an unrecognised one); what is asserted here is the
 * END-TO-END effect of each setting through the shipped app.
 * ------------------------------------------------------------------------- */

const PRODUCTION_LOG_KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVELOPMENT_LOG_KEY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONTROL_SWAP_KEY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CONTROL_LOG_KEY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CONTROL_REGENERATION_KEY = '12121212-1212-4212-8212-121212121212';

describe('MEAL_PLANNING_FAULT under NODE_ENV=production', () => {
    it('ignores the log fault, so the response arrives and the entry is written once', async () => {
        const bucketId = await diaryBucketId(HTTP_PLAN_USER_ID, requestFixture.today, 'Breakfast');

        const logged = await withFaultedApp(
            'log',
            async ({ resolvedFault, agent }) => {
                // Production is checked before the value is read, which is the
                // load-bearing line of the resolver.
                expect(resolvedFault).toBe('off');

                return agent
                    .post(mealPath(requestFixture.breakfastMealId, '/log'))
                    .set('x-test-user-id', HTTP_PLAN_USER_ID)
                    .send({
                        servings: 1,
                        date: requestFixture.today,
                        diaryMealId: bucketId,
                        expectedPlanRevision: PLAN_REVISION_BEFORE,
                        idempotencyKey: PRODUCTION_LOG_KEY,
                    });
            },
            { nodeEnv: 'production' },
        );

        // A full response, not a dropped one.
        expect(logged.status).toBe(201);
        expect(logged.body).toMatchObject({ planRevision: expect.any(Number) });
        expect(await prisma.meal_entries.findMany({ where: { user_id: HTTP_PLAN_USER_ID } })).toHaveLength(1);
        await expectCompletedLedgerRow(HTTP_PLAN_USER_ID, PRODUCTION_LOG_KEY, {
            actionType: 'log',
            responseStatus: 201,
        });
    });

    it('ignores the generation fault, so the week publishes', async () => {
        const published = await withFaultedApp(
            'generation',
            async ({ resolvedFault, agent }) => {
                expect(resolvedFault).toBe('off');

                return agent
                    .post(PLANS_PATH)
                    .set('x-test-user-id', HTTP_GENERATION_USER_ID)
                    .send(httpGenerateBody());
            },
            { nodeEnv: 'production' },
        );

        expect(published.status).toBe(201);
        expect(await plansOf(HTTP_GENERATION_USER_ID)).toHaveLength(1);
    });

    it('ignores the swap fault, so the meal is replaced', async () => {
        const chosen = await firstAlternative(requestFixture.lunchMealId);

        const swapped = await withFaultedApp(
            'swap',
            async ({ resolvedFault, agent }) => {
                expect(resolvedFault).toBe('off');

                return agent
                    .post(mealPath(requestFixture.lunchMealId, '/swap'))
                    .set('x-test-user-id', HTTP_PLAN_USER_ID)
                    .send({
                        ...chosen,
                        expectedPlanRevision: PLAN_REVISION_BEFORE,
                        idempotencyKey: HTTP_SWAP_KEY,
                    });
            },
            { nodeEnv: 'production' },
        );

        expect(swapped.status).toBe(200);
        expect(
            (
                await prisma.meal_plan_meals.findUniqueOrThrow({
                    where: { id: requestFixture.lunchMealId },
                })
            ).recipe_version_id,
        ).toBe(chosen.recipeVersionId);
    });

    it('starts and serves normally with an unrecognised value set', async () => {
        // The reason the resolver checks production FIRST: outside production an
        // unrecognised value fails loudly at import, which is the right answer
        // for a typo a developer can fix, and the wrong one for a stray variable
        // on a host serving users. Building the app graph here IS the startup
        // this asserts does not fail.
        const answered = await withFaultedApp(
            'genneration',
            async ({ resolvedFault, agent }) => {
                expect(resolvedFault).toBe('off');

                return agent
                    .post(PLANS_PATH)
                    .set('x-test-user-id', HTTP_GENERATION_USER_ID)
                    .send(httpGenerateBody());
            },
            { nodeEnv: 'production' },
        );

        expect(answered.status).toBe(201);
        expect(await plansOf(HTTP_GENERATION_USER_ID)).toHaveLength(1);
    });
});

describe('the abort header outside a test run', () => {
    it('is ignored in development, so the response arrives in full and the write commits once', async () => {
        const bucketId = await diaryBucketId(HTTP_PLAN_USER_ID, requestFixture.today, 'Breakfast');
        const generateRequestBody = httpGenerateBody();

        const answered = await withFaultedApp(
            'off',
            async ({ resolvedFault, agent }) => {
                expect(resolvedFault).toBe('off');

                // Both actions carry the header, and neither may honour it: a
                // header is client-supplied data, so being able to drop a
                // response with one would be a denial of the response itself.
                const published = await agent
                    .post(PLANS_PATH)
                    .set('x-test-user-id', HTTP_GENERATION_USER_ID)
                    .set(POST_COMMIT_ABORT_HEADER, 'generate')
                    .send(generateRequestBody);

                const logged = await agent
                    .post(mealPath(requestFixture.breakfastMealId, '/log'))
                    .set('x-test-user-id', HTTP_PLAN_USER_ID)
                    .set(POST_COMMIT_ABORT_HEADER, 'log')
                    .send({
                        servings: 1,
                        date: requestFixture.today,
                        diaryMealId: bucketId,
                        expectedPlanRevision: PLAN_REVISION_BEFORE,
                        idempotencyKey: DEVELOPMENT_LOG_KEY,
                    });

                return { published, logged };
            },
            { nodeEnv: 'development' },
        );

        expect(answered.published.status).toBe(201);
        expect(answered.published.body).toMatchObject({ id: expect.any(String), status: 'active' });
        expect(answered.logged.status).toBe(201);
        expect(answered.logged.body).toMatchObject({ planRevision: expect.any(Number) });

        // Committed once each, not twice and not not-at-all.
        expect(await plansOf(HTTP_GENERATION_USER_ID)).toHaveLength(1);
        expect(await prisma.meal_entries.findMany({ where: { user_id: HTTP_PLAN_USER_ID } })).toHaveLength(1);
    });
});

describe('MEAL_PLANNING_FAULT=off, with no header', () => {
    it('answers all four keyed writes normally — the control the abort cases are measured against', async () => {
        // Without this case, "the fault fired" proves nothing: every assertion
        // above about a dropped response or a `502` needs the same request to be
        // answered normally when nothing is armed. `jestSetup.ts` sets the
        // switch to `off` suite-wide, so this drives the ambient app as shipped.
        const published = await asUser(request.post(PLANS_PATH), {
            uid: HTTP_GENERATION_USER_ID,
        }).send(httpGenerateBody());

        expect(published.status).toBe(201);

        const chosen = await firstAlternative(requestFixture.lunchMealId);
        const swapped = await asUser(request.post(mealPath(requestFixture.lunchMealId, '/swap')), {
            uid: HTTP_PLAN_USER_ID,
        }).send({
            ...chosen,
            expectedPlanRevision: await currentRequestPlanRevision(),
            idempotencyKey: CONTROL_SWAP_KEY,
        });

        expect(swapped.status).toBe(200);

        const bucketId = await diaryBucketId(HTTP_PLAN_USER_ID, requestFixture.today, 'Breakfast');
        const logged = await asUser(request.post(mealPath(requestFixture.breakfastMealId, '/log')), {
            uid: HTTP_PLAN_USER_ID,
        }).send({
            servings: 1,
            date: requestFixture.today,
            diaryMealId: bucketId,
            expectedPlanRevision: await currentRequestPlanRevision(),
            idempotencyKey: CONTROL_LOG_KEY,
        });

        expect(logged.status).toBe(201);

        const regenerated = await asUser(request.post(planPath('/regenerate')), {
            uid: HTTP_PLAN_USER_ID,
        }).send(
            httpRegenerateBody({
                idempotencyKey: CONTROL_REGENERATION_KEY,
                expectedPlanRevision: await currentRequestPlanRevision(),
            }),
        );

        expect(regenerated.status).toBe(201);

        // Four responses received, four writes committed.
        expect(await plansOf(HTTP_GENERATION_USER_ID)).toHaveLength(1);
        expect(await plansOf(HTTP_PLAN_USER_ID)).toHaveLength(2);
        expect(await prisma.meal_entries.findMany({ where: { user_id: HTTP_PLAN_USER_ID } })).toHaveLength(1);
    });
});

/* ---------------------------------------------------------------------------
 * What the seam must never become
 *
 * The abort header travels on a request, so the two questions it raises are
 * whose request it can affect and what it can be made to stand for. Neither may
 * have an interesting answer.
 * ------------------------------------------------------------------------- */

describe('the seam and the caller it belongs to', () => {
    it('cannot drop a response for a plan the caller does not own, and answers 404 rather than 403', async () => {
        const plansBefore = await plansOf(HTTP_PLAN_USER_ID);

        // A stranger with a complete setup of their own, naming another user's
        // plan id, and asking for the response to be dropped after it commits.
        // Nothing commits, so nothing is dropped.
        const refused = await asUser(request.post(planPath('/regenerate')), {
            uid: HTTP_STRANGER_USER_ID,
        })
            .set(POST_COMMIT_ABORT_HEADER, 'regenerate')
            .send(httpRegenerateBody());

        // Rule 7 §1.5: a cross-user resource is 404 and never 403, so the answer
        // does not confirm that someone else's plan exists.
        expect(refused.status).toBe(404);
        expect(refused.status).not.toBe(403);
        expect(refused.body).toEqual({ error: 'Plan not found' });
        expect(await plansOf(HTTP_PLAN_USER_ID)).toEqual(plansBefore);
        expect(await plansOf(HTTP_STRANGER_USER_ID)).toHaveLength(0);
        expect(await ledgerRowsFor(HTTP_STRANGER_USER_ID, HTTP_REGENERATION_KEY)).toHaveLength(0);
    });

    it('ignores a user id in the body, so the committed week belongs to the verified caller', async () => {
        // `getUserId(req)` reads the verified token claims and the parser ignores
        // members it does not declare, so this body cannot redirect the write.
        await sendAndExpectLostResponse(
            asUser(request.post(PLANS_PATH), { uid: HTTP_GENERATION_USER_ID })
                .set(POST_COMMIT_ABORT_HEADER, 'generate')
                .send(httpGenerateBody({ userId: HTTP_STRANGER_USER_ID })),
        );

        expect(await plansOf(HTTP_GENERATION_USER_ID)).toHaveLength(1);
        expect(await plansOf(HTTP_STRANGER_USER_ID)).toHaveLength(0);
        expect(await ledgerRowsFor(HTTP_STRANGER_USER_ID, HTTP_GENERATION_KEY)).toHaveLength(0);

        const row = await expectCompletedLedgerRow(HTTP_GENERATION_USER_ID, HTTP_GENERATION_KEY, {
            actionType: 'generate',
            responseStatus: 201,
        });

        expect(row.user_id).toBe(HTTP_GENERATION_USER_ID);
    });

    it('leaves the process able to serve the next request after a socket is destroyed', async () => {
        await sendAndExpectLostResponse(
            asUser(request.post(PLANS_PATH), { uid: HTTP_GENERATION_USER_ID })
                .set(POST_COMMIT_ABORT_HEADER, 'generate')
                .send(httpGenerateBody()),
        );

        // Worth asserting rather than assuming: the `log` switch runs this same
        // destroy in production-shaped code on a developer's dev backend, so a
        // dropped response must not leave a connection or a transaction behind
        // that the next request trips over.
        const current = await asUser(request.get(`${PLANS_PATH}/current`), {
            uid: HTTP_GENERATION_USER_ID,
        }).expect(200);
        const resolved = current.body as { current: { id: string } | null; upcoming: { id: string } | null };
        const published = await plansOf(HTTP_GENERATION_USER_ID);

        expect(published).toHaveLength(1);
        expect(resolved.current?.id ?? resolved.upcoming?.id).toBe(published[0].id);
    });
});
