// The database-backed proof for the injected faults (Agent Action Plan §0.9.4
// "Physical-iPhone Verification Checklist", §0.9.2's `api/fault.test.ts` rows,
// §0.5.1's "Failure at any point persists nothing").
//
// WHICH LAYER THIS SUITE DRIVES, AND WHY. It calls `swap.service.ts::commitSwap`
// and `mealPlan.service.ts::generatePlan` DIRECTLY, against real PostgreSQL, and
// makes no HTTP request. At this checkpoint the meal-planning HTTP boundary does
// not exist — there is no `src/routes/mealPlanning.routes.ts`, no
// `src/controllers/mealPlanning.controller.ts`, and `src/app.ts` mounts neither
// — so a supertest call would answer 404 and prove nothing about a fault. The
// decoded faults are thrown by the SERVICES before their transactions open, so
// the services are where they are provable today. When the routes land, the
// request-level cases (the `502` status the controller maps `SwapFailedError` to,
// and the `503`/`400` precedence) are added to THIS file beside what is here.
//
// WHAT THIS SUITE CANNOT REACH, AND NOBODY SHOULD READ IT AS COVERING. The
// POST-COMMIT ABORT SEAM — `featureFlags.ts::postCommitAbort` together with the
// `x-test-abort-after-commit` header — is a REQUEST-level mechanic: §0.9.2
// specifies that "the generate, regenerate, swap and log handlers call it once
// the service has returned … and, when true, `res.socket.destroy()` instead of
// writing a body", and supertest observing that destroyed socket is the whole
// point of the seam. There is no handler in this checkout to call it and no
// socket to destroy, so the "one commit, then replay" row of §0.9.2 — a request
// that rejects at the socket over a durable write — is OUT OF REACH until the
// controllers and routes land, and it is not asserted anywhere below. What IS
// reachable, and is asserted, is the other half of that row: a decoded fault
// leaves no ledger row and no change, and the same key retried without the fault
// commits exactly once.
//
// THE MECHANIC THAT MAKES THESE CASES REAL. `utils/featureFlags.ts` resolves
// `MEAL_PLANNING_FAULT` ONCE, at import, into a module constant (it is the
// module's stated design: "Read once, at import"). Setting the variable inside a
// test therefore does nothing on its own — the already-imported accessor keeps
// answering `'off'` and a suite that trusted the assignment would silently
// assert the no-fault path. So {@link withFault} sets the variable, calls
// `jest.resetModules()` and re-requires the module graph inside
// `jest.isolateModules`, and every case asserts the re-imported
// `mealPlanningFault()` FIRST — the fault is proven armed before anything is
// concluded from what the service then did. The isolated graph carries its own
// `PrismaClient`, which is disconnected when the window closes.
//
// TWO THINGS ARE DELIBERATELY NOT ASSERTED, because another work unit is
// changing them at this checkpoint: the display rounding of planned nutrition in
// the meal/day DTOs (review finding F04) and the exact `portionText` string
// (F05). The cases below assert ids, revisions, row counts, ledger state and
// error kinds, none of which either fix touches.

import { Prisma, catalog_foods } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import { loadPlannedMealsForGroceries, rebuildPlanGroceries } from '../../services/grocery.service';
import { generatePlan } from '../../services/mealPlan.service';
import { commitSwap } from '../../services/swap.service';
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

type FeatureFlagsModule = typeof import('../../utils/featureFlags');
type SwapServiceModule = typeof import('../../services/swap.service');
type MealPlanServiceModule = typeof import('../../services/mealPlan.service');
type PrismaClientModule = typeof import('../../prisma/client');

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
const writeInitialGroceryList = async (planId: string): Promise<void> => {
    await prisma.$transaction(async (tx) => {
        const meals = await loadPlannedMealsForGroceries(tx, SWAP_USER_ID, planId);

        await rebuildPlanGroceries(tx, { userId: SWAP_USER_ID, planId, meals, now: NOW });
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

    await writeInitialGroceryList(plan.id);

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
}

interface FaultWindowOptions {
    /** `production`, for the case that proves the switch is inert there. */
    readonly nodeEnv?: string;
}

/**
 * Runs `work` against a module graph imported with `MEAL_PLANNING_FAULT` (and,
 * optionally, `NODE_ENV`) already set.
 *
 * This is the only way to reach the branch at all: `featureFlags.ts` reads the
 * variable once at import, so the graph has to be built again after the
 * assignment. `jest.isolateModules` keeps that second graph in a registry of its
 * own, and the functions captured out of it stay bound to it after the callback
 * returns, so the service the case calls is the faulted one while the
 * assertions' own `prisma` import — taken at the top of this file — still
 * observes the same database.
 *
 * The isolated graph constructs its own `PrismaClient`; it is disconnected in
 * the `finally`, and the environment is restored there too (DELETED rather than
 * assigned when it was previously unset, since assigning `undefined` would store
 * the string "undefined" and fail the flag module's own validation).
 */
const withFault = async <TResult>(
    fault: string,
    work: (modules: FaultedModules) => Promise<TResult>,
    options: FaultWindowOptions = {},
): Promise<TResult> => {
    const previousFault = process.env.MEAL_PLANNING_FAULT;
    const previousNodeEnv = process.env.NODE_ENV;

    process.env.MEAL_PLANNING_FAULT = fault;

    if (options.nodeEnv !== undefined) {
        process.env.NODE_ENV = options.nodeEnv;
    }

    jest.resetModules();

    // Held on an object rather than in two `let`s: the assignments happen inside
    // `isolateModules`' callback, and a property is still typed as possibly
    // absent afterwards where a captured local would need a cast to be read.
    const isolated: { client?: PrismaClientModule; modules?: FaultedModules } = {};

    try {
        jest.isolateModules(() => {
            const featureFlags = require('../../utils/featureFlags') as FeatureFlagsModule;
            const swapService = require('../../services/swap.service') as SwapServiceModule;
            const mealPlanService = require('../../services/mealPlan.service') as MealPlanServiceModule;

            isolated.client = require('../../prisma/client') as PrismaClientModule;
            isolated.modules = {
                resolvedFault: featureFlags.mealPlanningFault(),
                commitSwap: swapService.commitSwap,
                generatePlan: mealPlanService.generatePlan,
            };
        });

        const modules = isolated.modules;

        if (modules === undefined) {
            throw new Error('The faulted module graph was not built, so no case can be run against it.');
        }

        return await work(modules);
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

beforeEach(async () => {
    await truncateFeatureTables();
    fixture = await seedFixture();
});

afterAll(async () => {
    await truncateFeatureTables();
});

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
    it('is decoded by the flag module, which is the whole of what is wired today', async () => {
        // The switch is parsed and reachable — `featureFlags.ts` resolves it and
        // `resolveFault` admits it — and this is the only part of §0.9.4's
        // `generation` fault that exists in this checkout.
        //
        // `mealPlan.service.ts` does NOT consult `mealPlanningFault()`:
        // `generatePlan` runs `searchCandidateWeek` and opens its transaction
        // with no fault check between them, so arming `generation` changes
        // nothing about a generation. That gap is reported to the checkpoint
        // owner rather than asserted here, because asserting the current
        // behaviour would pin the very thing that has to change; the case below
        // proves the INVARIANT §0.9.2 attaches to the fault ("leaves no action
        // row and no plan … and the retry without the fault commits once")
        // through a pre-transaction failure that IS implemented, and the fault's
        // own case belongs beside it the moment the check is added.
        await withFault('generation', async ({ resolvedFault }) => {
            expect(resolvedFault).toBe('generation');
        });
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
