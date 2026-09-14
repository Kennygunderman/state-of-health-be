// The tenancy matrix, against a real PostgreSQL (Agent Action Plan §0.5.2's
// "return 404 for any resource not owned by the caller (never distinguishing
// 'missing' from 'not yours')", §0.9.2's "Ownership matrix, route × id class"
// row, and Rule 7 §1.5/§5.1/§8).
//
// WHICH LAYER THIS EXERCISES, AND WHY.
//
// The meal-planning HTTP boundary does not exist in this checkout — there is no
// `src/routes/mealPlanning.routes.ts`, no `src/controllers/mealPlanning.
// controller.ts`, and `src/app.ts` mounts neither; the plan records that
// boundary as later work. So the matrix is driven against the SERVICE entry
// points, which is where the owner-bearing predicates actually live and
// therefore where tenancy is provable today. Nothing here fakes or simulates a
// request layer. When the mount lands, the same matrix gains its request-level
// rows in THIS file — the assertion becomes "the response status is 404 and the
// bodies are identical" over the very same id classes.
//
// THE PROPERTY, stated once because every case is an instance of it:
//
//   EXISTENCE NEVER LEAKS. For every user-scoped entry point, user A presenting
//   user B's id and user A presenting a well-formed id that names nothing must
//   produce the SAME outcome — the same error class, the same message and the
//   same payload. Not a different code, not a different message, not a
//   403-shaped answer, because any difference between the two is an oracle for
//   what exists in another user's account.
//
// {@link sameOutcome} is how that is asserted rather than approximated: it
// captures both calls' outcomes as plain descriptors and compares them whole,
// so a payload member that differed would fail even if the class matched. Every
// such assertion also pins WHICH outcome it is, so the matrix cannot pass
// vacuously by refusing both calls for some unrelated reason (an incomplete
// setup, a disabled flag, a malformed id).
//
// The matrix is asserted in BOTH directions. Own ids produce the ordinary
// outcome, so "everything is refused" is not how it passes; and the shared,
// tenant-less resources are asserted the other way round — a `current` recipe
// version resolves for every caller, while a retired one resolves only for the
// user whose own plan or diary still references it.
//
// Two things are deliberately not asserted anywhere here: the rounding of
// nutrition on plan DTOs and the exact text of `portionText`. Both are open
// findings against `mealPlan.mapper.ts` (F04, F05) being changed in another
// work unit, so an assertion on either would pin a value that is about to move.
//
// Determinism: the fixture weeks are pinned to a named day and every call takes
// the same injected `now`, so nothing here depends on when the suite runs.

import { randomUUID } from 'node:crypto';

import { prisma } from '../../prisma/client';
import {
    getGroceryList,
    loadPlannedMealsForGroceries,
    rebuildPlanGroceries,
    toggleGroceryItem,
    uncheckAllGroceries,
} from '../../services/grocery.service';
import { getAffectedMeals, getCurrentMealPlan, getMealPlanDay, regeneratePlan } from '../../services/mealPlan.service';
import { PlanNotFoundError } from '../../services/mealPlanning.errors';
import { withMealPlanningTransaction, withUserLock } from '../../services/mealPlanningAction.service';
import { logPlannedMeal } from '../../services/plannedMealLog.service';
import { getRecipeVersionForUser } from '../../services/recipe.service';
import { commitSwap, getSwapAlternatives, getSwapPreview } from '../../services/swap.service';
import {
    FIXTURE_USER_TARGET_COLUMNS,
    addDaysToDayKey,
    makeCatalogFood,
    makePlan,
    makePreferences,
    makeRecipeVersion,
    makeUser,
} from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

/** The caller every case acts as. */
const USER_A = 'ownership-suite-user-a';

/** The other tenant, whose ids must be indistinguishable from ids that name nothing. */
const USER_B = 'ownership-suite-user-b';

/** The day both fixture weeks are built around, and the day every `now` falls on. */
const TODAY = '2026-09-15';

const NOW = new Date(`${TODAY}T12:00:00.000Z`);

/** `makePlan`'s default week around {@link TODAY}. */
const PLAN_START_DAY_KEY = addDaysToDayKey(TODAY, -1);
const PLAN_END_DAY_KEY = addDaysToDayKey(TODAY, 5);

/**
 * The three slot sizes that make a fixture day land exactly on the plan's
 * target snapshot (2,100 kcal / 158 P / 210 C / 70 F), so a swap candidate of
 * the same size is admissible under the day tolerance and the "own id"
 * assertions have a real 200 to produce.
 */
const SLOT_SIZES = {
    breakfast: { calories: 525, protein: 40, carbs: 52, fat: 18 },
    lunch: { calories: 735, protein: 55, carbs: 74, fat: 24 },
    dinner: { calories: 840, protein: 63, carbs: 84, fat: 28 },
} as const;

/**
 * A well-formed v4 UUID that names nothing. Freshly minted per use: a constant
 * would be one collision away from naming a row some other case created.
 */
const missingId = (): string => randomUUID();

/* ---------------------------------------------------------------------------
 * The outcome comparison the whole matrix rests on
 * ------------------------------------------------------------------------- */

/**
 * One call's outcome, flattened so two of them can be compared WHOLE.
 *
 * `payload` carries an error's own enumerable members — the `data` of a
 * `PlanNotActiveError`, the `currentRevision` of a `StalePlanError` — so two
 * outcomes that share a class but differ in what they report do NOT compare
 * equal. That is the point: a body member is as much of an oracle as a status
 * code.
 */
interface Outcome {
    threw: boolean;
    name: string | null;
    message: string | null;
    payload: unknown;
}

const outcomeOf = async (work: () => Promise<unknown>): Promise<Outcome> => {
    try {
        return { threw: false, name: null, message: null, payload: await work() };
    } catch (error) {
        const thrown = error as Error;

        return {
            threw: true,
            name: thrown.name,
            message: thrown.message,
            payload: { ...(thrown as unknown as Record<string, unknown>) },
        };
    }
};

/**
 * Asserts the property: two calls differing only in WHICH foreign id they
 * present are indistinguishable, and the outcome they share is the named one.
 *
 * Naming the expected error is what stops the comparison passing vacuously —
 * two calls refused by an unrelated precondition would also be equal to each
 * other, and would prove nothing about tenancy.
 */
const sameOutcome = async (
    withForeignId: () => Promise<unknown>,
    withMissingId: () => Promise<unknown>,
    expectedErrorName = 'PlanNotFoundError',
): Promise<void> => {
    const foreign = await outcomeOf(withForeignId);
    const missing = await outcomeOf(withMissingId);

    expect(foreign).toEqual(missing);
    expect(foreign.threw).toBe(true);
    expect(foreign.name).toBe(expectedErrorName);
};

/* ---------------------------------------------------------------------------
 * The fixture: two tenants over one shared catalog
 * ------------------------------------------------------------------------- */

type Tenant = Awaited<ReturnType<typeof seedTenant>>;

/** The tenant-less reference data both users plan from (§0.5.1: catalog and recipes have no owner). */
const seedSharedCatalog = async () => {
    const food = await makeCatalogFood({
        sequence: 1,
        defaultPortion: { description: '100 g', amount: 100, unit: 'g', gram_weight: 100 },
    });

    const recipeFor = async (slug: string, slot: keyof typeof SLOT_SIZES) =>
        makeRecipeVersion({
            slug,
            catalogFoodId: food.id,
            meal_slots: [slot],
            perServing: { ...SLOT_SIZES[slot] },
        });

    return {
        food,
        breakfast: await recipeFor('ownership-breakfast', 'breakfast'),
        breakfastAlternative: await recipeFor('ownership-breakfast-alt', 'breakfast'),
        lunch: await recipeFor('ownership-lunch', 'lunch'),
        dinner: await recipeFor('ownership-dinner', 'dinner'),
    };
};

type SharedCatalog = Awaited<ReturnType<typeof seedSharedCatalog>>;

/**
 * One tenant: confirmed targets, a UTC preferences row, the on-target plan week,
 * its grocery list (built by the real rebuild, since no grocery factory exists)
 * and the diary bucket a log body would name.
 */
const seedTenant = async (userId: string, catalog: SharedCatalog) => {
    await makeUser({ id: userId, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(userId, { time_zone: 'UTC' });

    const plan = await makePlan(userId, {
        today: TODAY,
        slots: [
            { slot: 'breakfast', slot_time: '08:00', recipeVersionId: catalog.breakfast.id },
            { slot: 'lunch', slot_time: '12:30', recipeVersionId: catalog.lunch.id },
            { slot: 'dinner', slot_time: '18:30', recipeVersionId: catalog.dinner.id },
        ],
    });

    const day = plan.meal_plan_days.find((candidate) => candidate.day_index === 1);

    if (day === undefined) {
        throw new Error('the fixture plan has no second day');
    }

    const breakfast = day.meal_plan_meals.find((meal) => meal.slot === 'breakfast');

    if (breakfast === undefined) {
        throw new Error('the fixture plan day has no breakfast slot');
    }

    await withMealPlanningTransaction((tx) =>
        withUserLock(tx, userId, async (locked) =>
            rebuildPlanGroceries(locked, {
                userId,
                planId: plan.id,
                meals: await loadPlannedMealsForGroceries(locked, userId, plan.id),
                now: NOW,
            }),
        ),
    );

    const groceryItems = await prisma.grocery_items.findMany({
        where: { meal_plan_id: plan.id, user_id: userId },
        orderBy: { sort_order: 'asc' },
    });

    if (groceryItems.length === 0) {
        throw new Error(`the grocery rebuild produced no rows for ${userId}`);
    }

    const response = await asUser(request.get(`/api/macros/${TODAY}`), { uid: userId }).expect(200);
    const bucket = (response.body as { meals: { id: string; name: string }[] }).meals.find(
        (meal) => meal.name === 'Breakfast',
    );

    if (bucket === undefined) {
        throw new Error(`GET /api/macros/${TODAY} returned no Breakfast bucket for ${userId}`);
    }

    return { userId, plan, day, breakfast, groceryItem: groceryItems[0], diaryMealId: bucket.id };
};

/** A well-formed log body aimed at whichever plan and bucket the case names. */
const logBody = (diaryMealId: string, expectedPlanRevision = 1): Record<string, unknown> => ({
    servings: 1,
    date: TODAY,
    diaryMealId,
    expectedPlanRevision,
    idempotencyKey: randomUUID(),
});

/** A well-formed swap body aimed at whichever candidate the case names. */
const swapBody = (recipeVersionId: string, expectedPlanRevision = 1): Record<string, unknown> => ({
    recipeVersionId,
    portionMultiplier: 1,
    expectedPlanRevision,
    idempotencyKey: randomUUID(),
});

/** A well-formed regenerate body. */
const regenerateBody = (expectedPlanRevision: number): Record<string, unknown> => ({
    idempotencyKey: randomUUID(),
    expectedPlanRevision,
    expectedPreferencesRevision: 1,
    expectedTargetsRevision: 1,
});

/**
 * Everything the write halves of the matrix must leave untouched: neither
 * tenant gained a diary entry or a ledger row, neither plan's revision moved,
 * neither meal was re-pointed, and no grocery check mark was set.
 */
const expectNothingWritten = async (a: Tenant, b: Tenant): Promise<void> => {
    expect(await prisma.meal_entries.count()).toBe(0);
    expect(await prisma.meal_plan_actions.count()).toBe(0);

    for (const tenant of [a, b]) {
        const plan = await prisma.meal_plans.findUniqueOrThrow({
            where: { id: tenant.plan.id },
            select: { revision: true },
        });

        expect(plan.revision).toBe(1);
        expect(
            (await prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: tenant.breakfast.id } }))
                .recipe_version_id,
        ).toBe(tenant.breakfast.recipe_version_id);
        expect(
            await prisma.grocery_items.count({
                where: { meal_plan_id: tenant.plan.id, is_checked: true },
            }),
        ).toBe(0);
    }
};

let catalog: SharedCatalog;
let a: Tenant;
let b: Tenant;

beforeEach(async () => {
    await truncateFeatureTables();
    catalog = await seedSharedCatalog();
    a = await seedTenant(USER_A, catalog);
    b = await seedTenant(USER_B, catalog);
});

afterAll(async () => {
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * The reads
 * ------------------------------------------------------------------------- */

describe('the plan-bearing reads', () => {
    it('answers a day of another user’s plan exactly as it answers a plan that does not exist', async () => {
        await sameOutcome(
            () => getMealPlanDay(USER_A, b.plan.id, TODAY),
            () => getMealPlanDay(USER_A, missingId(), TODAY),
        );
    });

    it('answers a date outside the caller’s own plan with that same refusal', async () => {
        // §0.5.2's 404 for this route covers "not your plan" and "not in the
        // plan" alike: distinguishing them would confirm the plan exists.
        const outsideWeek = addDaysToDayKey(PLAN_END_DAY_KEY, 1);

        await sameOutcome(
            () => getMealPlanDay(USER_A, a.plan.id, outsideWeek),
            () => getMealPlanDay(USER_A, missingId(), TODAY),
        );
    });

    it('answers another user’s affected-meals list exactly as it answers a missing plan', async () => {
        await sameOutcome(
            () => getAffectedMeals(USER_A, b.plan.id),
            () => getAffectedMeals(USER_A, missingId()),
        );
    });

    it('answers another user’s grocery list exactly as it answers a missing plan', async () => {
        await sameOutcome(
            () => getGroceryList(USER_A, b.plan.id, NOW),
            () => getGroceryList(USER_A, missingId(), NOW),
        );
    });

    it('resolves the caller’s own plan for each of those reads', async () => {
        // The counter-proof: the matrix above is not passing by refusing
        // everything.
        const day = await getMealPlanDay(USER_A, a.plan.id, TODAY);

        expect(day.kind).toBe('ok');

        if (day.kind === 'ok') {
            expect(day.envelope.planId).toBe(a.plan.id);
            expect(day.envelope.planRevision).toBe(1);
            expect(day.envelope.planStatus).toBe('active');
            expect(day.envelope.day.date).toBe(TODAY);
        }

        const affected = await getAffectedMeals(USER_A, a.plan.id);

        expect(affected.kind).toBe('ok');

        if (affected.kind === 'ok') {
            expect(affected.response.meals).toEqual([]);
        }

        const groceries = await getGroceryList(USER_A, a.plan.id, NOW);

        expect(groceries.planId).toBe(a.plan.id);
        expect(groceries.totalCount).toBeGreaterThan(0);
    });

    it('never lets the current-plan read reach the other tenant’s week', async () => {
        // The one read that takes no id at all: the scope is the caller, so the
        // assertion is that two tenants with identical weeks see only their own.
        const forA = await getCurrentMealPlan(USER_A, NOW);
        const forB = await getCurrentMealPlan(USER_B, NOW);

        expect(forA.current?.id).toBe(a.plan.id);
        expect(forB.current?.id).toBe(b.plan.id);
        expect(forA.current?.id).not.toBe(forB.current?.id);
        expect(forA.upcoming).toBeNull();
    });
});

describe('the meal-bearing reads', () => {
    it('answers another user’s plan on the alternatives list as it answers a missing plan', async () => {
        await sameOutcome(
            () => getSwapAlternatives(USER_A, b.plan.id, b.breakfast.id),
            () => getSwapAlternatives(USER_A, missingId(), missingId()),
        );
    });

    it('does not let a valid parent rescue another user’s meal id', async () => {
        // The nested case: A's own plan with B's meal under it. One
        // owner-bearing predicate judges the pair, so this is the same answer
        // as a meal that does not exist at all.
        await sameOutcome(
            () => getSwapAlternatives(USER_A, a.plan.id, b.breakfast.id),
            () => getSwapAlternatives(USER_A, a.plan.id, missingId()),
        );
    });

    it('answers another user’s plan on the preview as it answers a missing plan', async () => {
        await sameOutcome(
            () => getSwapPreview(USER_A, b.plan.id, b.breakfast.id, catalog.breakfastAlternative.id),
            () => getSwapPreview(USER_A, missingId(), missingId(), catalog.breakfastAlternative.id),
        );
    });

    it('answers a candidate it never offered as it answers a candidate that does not exist', async () => {
        // The third path segment is not a tenancy axis — §0.5.2 declares only
        // `200` or `422 recipe_ineligible` here — but the same
        // indistinguishability applies: a version that exists and was not
        // listed must not be told apart from one that does not exist.
        await sameOutcome(
            () => getSwapPreview(USER_A, a.plan.id, a.breakfast.id, catalog.dinner.id),
            () => getSwapPreview(USER_A, a.plan.id, a.breakfast.id, missingId()),
            'RecipeIneligibleError',
        );
    });

    it('resolves the caller’s own meal for both of those reads', async () => {
        const alternatives = await getSwapAlternatives(USER_A, a.plan.id, a.breakfast.id);

        expect(alternatives.kind).toBe('ok');

        if (alternatives.kind === 'ok') {
            expect(alternatives.response.current.id).toBe(a.breakfast.id);
            expect(alternatives.response.alternatives.map((row) => row.recipeVersionId)).toEqual([
                catalog.breakfastAlternative.id,
            ]);
        }

        const preview = await getSwapPreview(
            USER_A,
            a.plan.id,
            a.breakfast.id,
            catalog.breakfastAlternative.id,
        );

        expect(preview.kind).toBe('ok');

        if (preview.kind === 'ok') {
            expect(preview.response.alternative.recipe.versionId).toBe(catalog.breakfastAlternative.id);
            expect(preview.response.planRevision).toBe(1);
        }
    });
});

/* ---------------------------------------------------------------------------
 * The writes — same parity, and nothing written
 * ------------------------------------------------------------------------- */

describe('the write paths', () => {
    it('refuses a log against another user’s plan exactly as against a missing one', async () => {
        await sameOutcome(
            () => logPlannedMeal(USER_A, b.plan.id, b.breakfast.id, logBody(a.diaryMealId), NOW),
            () => logPlannedMeal(USER_A, missingId(), missingId(), logBody(a.diaryMealId), NOW),
        );

        await expectNothingWritten(a, b);
    });

    it('refuses another user’s diary bucket nested in the caller’s own log body', async () => {
        // A's own plan and A's own meal: the only foreign value is the bucket
        // the entry would land in, which is exactly the id a client could
        // tamper with to write into someone else's diary.
        await sameOutcome(
            () => logPlannedMeal(USER_A, a.plan.id, a.breakfast.id, logBody(b.diaryMealId), NOW),
            () => logPlannedMeal(USER_A, a.plan.id, a.breakfast.id, logBody(missingId()), NOW),
        );

        await expectNothingWritten(a, b);
    });

    it('refuses a swap against another user’s plan exactly as against a missing one', async () => {
        await sameOutcome(
            () =>
                commitSwap(
                    USER_A,
                    b.plan.id,
                    b.breakfast.id,
                    swapBody(catalog.breakfastAlternative.id),
                    NOW,
                ),
            () =>
                commitSwap(
                    USER_A,
                    missingId(),
                    missingId(),
                    swapBody(catalog.breakfastAlternative.id),
                    NOW,
                ),
        );

        await expectNothingWritten(a, b);
    });

    it('refuses a regeneration of another user’s plan exactly as of a missing one', async () => {
        await sameOutcome(
            () => regeneratePlan(USER_A, b.plan.id, regenerateBody(1), NOW),
            () => regeneratePlan(USER_A, missingId(), regenerateBody(1), NOW),
        );

        await expectNothingWritten(a, b);
    });

    it('refuses a grocery toggle on another user’s plan exactly as on a missing one', async () => {
        await sameOutcome(
            () => toggleGroceryItem(USER_A, b.plan.id, b.groceryItem.id, { isChecked: true }, NOW),
            () => toggleGroceryItem(USER_A, missingId(), missingId(), { isChecked: true }, NOW),
        );

        await expectNothingWritten(a, b);
    });

    it('does not let the caller’s own plan rescue another user’s grocery item id', async () => {
        await sameOutcome(
            () => toggleGroceryItem(USER_A, a.plan.id, b.groceryItem.id, { isChecked: true }, NOW),
            () => toggleGroceryItem(USER_A, a.plan.id, missingId(), { isChecked: true }, NOW),
        );

        await expectNothingWritten(a, b);
    });

    it('refuses uncheck-all on another user’s plan exactly as on a missing one', async () => {
        await toggleGroceryItem(USER_B, b.plan.id, b.groceryItem.id, { isChecked: true }, NOW);

        await sameOutcome(
            () => uncheckAllGroceries(USER_A, b.plan.id, NOW),
            () => uncheckAllGroceries(USER_A, missingId(), NOW),
        );

        // B's own check mark survived A's attempts, which is the state the
        // refusal is supposed to protect.
        expect(
            await prisma.grocery_items.count({ where: { meal_plan_id: b.plan.id, is_checked: true } }),
        ).toBe(1);
        expect(
            await prisma.grocery_items.count({ where: { meal_plan_id: a.plan.id, is_checked: true } }),
        ).toBe(0);
    });

    it('accepts every one of those writes against the caller’s own ids', async () => {
        // The counter-proof for the write half. Each is driven far enough to
        // show the id RESOLVED — a refusal that names the plan's state rather
        // than its existence is exactly the distinction the matrix is about.
        const logged = await logPlannedMeal(USER_A, a.plan.id, a.breakfast.id, logBody(a.diaryMealId), NOW);

        expect(logged.kind).toBe('ok');

        if (logged.kind === 'ok') {
            expect(logged.result.status).toBe(201);
        }

        const swapped = await commitSwap(
            USER_A,
            a.plan.id,
            a.breakfast.id,
            swapBody(catalog.breakfastAlternative.id, 2),
            NOW,
        );

        expect(swapped.kind).toBe('ok');

        if (swapped.kind === 'ok') {
            expect(swapped.result.status).toBe(200);
        }

        const toggled = await toggleGroceryItem(
            USER_A,
            a.plan.id,
            a.groceryItem.id,
            { isChecked: true },
            NOW,
        );

        expect(toggled.item.isChecked).toBe(true);
        expect(toggled.checkedCount).toBe(1);

        expect(await uncheckAllGroceries(USER_A, a.plan.id, NOW)).toEqual({ checkedCount: 0 });

        // The regeneration is driven with a revision the plan no longer holds:
        // it answers `stale_plan` with the current value, which is only
        // reachable once the plan id has RESOLVED, and it stops short of a
        // five-second week search that this matrix has no need of.
        const regenerated = await outcomeOf(() => regeneratePlan(USER_A, a.plan.id, regenerateBody(1), NOW));

        expect(regenerated.name).toBe('StalePlanError');
        expect(regenerated.payload).toEqual({ name: 'StalePlanError', currentRevision: 3 });

        // And nothing about that leaked into the other tenant.
        expect(await prisma.meal_entries.count({ where: { user_id: USER_B } })).toBe(0);
        expect(await prisma.meal_plan_actions.count({ where: { user_id: USER_B } })).toBe(0);
        expect(
            (await prisma.meal_plans.findUniqueOrThrow({ where: { id: b.plan.id }, select: { revision: true } }))
                .revision,
        ).toBe(1);
    });
});

/* ---------------------------------------------------------------------------
 * Shared resources, asserted the other way round
 * ------------------------------------------------------------------------- */

describe('recipe visibility', () => {
    /**
     * `getRecipeVersionForUser` answers the visibility question directly: a
     * `RecipeVersionResponse` when the caller may read the version, and `null`
     * when it does not exist OR is retired and nothing of theirs references it
     * — which is the indistinguishability the matrix asserts. The malformed-id
     * class is refused earlier, at the controller, and is proved there.
     */
    const versionFor = async (userId: string, recipeVersionId: string) =>
        await getRecipeVersionForUser(userId, recipeVersionId);

    it('resolves a current version for every caller, because published recipes have no owner', async () => {
        expect((await versionFor(USER_A, catalog.breakfast.id))?.versionId).toBe(catalog.breakfast.id);
        expect((await versionFor(USER_B, catalog.breakfast.id))?.versionId).toBe(catalog.breakfast.id);
        expect((await versionFor(USER_A, catalog.breakfast.id))?.status).toBe('current');
    });

    it('resolves a retired version for the user whose own plan references it, and for nobody else', async () => {
        const retired = await makeRecipeVersion({
            slug: 'ownership-retired-in-plan',
            catalogFoodId: catalog.food.id,
            meal_slots: ['dinner'],
            status: 'retired',
            perServing: { ...SLOT_SIZES.dinner },
        });

        // A second week of B's, the only thing in the database that points at
        // the retired version.
        await makePlan(USER_B, {
            startDate: addDaysToDayKey(PLAN_START_DAY_KEY, 7),
            dayCount: 1,
            slots: [{ slot: 'dinner', slot_time: '18:30', recipeVersionId: retired.id }],
        });

        expect((await versionFor(USER_B, retired.id))?.versionId).toBe(retired.id);
        expect(await versionFor(USER_A, retired.id)).toBeNull();
        // Indistinguishable from a version that does not exist, which is the
        // whole requirement.
        expect(await versionFor(USER_A, missingId())).toBeNull();
    });

    it('resolves a retired version for the user whose own diary entry references it, and for nobody else', async () => {
        const retired = await makeRecipeVersion({
            slug: 'ownership-retired-in-diary',
            catalogFoodId: catalog.food.id,
            meal_slots: ['dinner'],
            status: 'retired',
            perServing: { ...SLOT_SIZES.dinner },
        });

        // Written directly because this is the one reference class no service
        // path can produce on its own: the entry must reference the retired
        // version while NO plan of B's does, or the plan clause above would be
        // what makes it visible and the diary clause would never be exercised.
        // It is the shape a real entry takes after the meal it was logged from
        // was regenerated away.
        await prisma.meal_entries.create({
            data: {
                meal_id: b.diaryMealId,
                user_id: USER_B,
                date: new Date(`${TODAY}T00:00:00.000Z`),
                name: retired.name,
                serving_text: retired.serving_description,
                servings: 1,
                calories: Math.round(retired.per_serving_calories),
                protein_g: Math.round(retired.per_serving_protein_g),
                carbs_g: Math.round(retired.per_serving_carbs_g),
                fat_g: Math.round(retired.per_serving_fat_g),
                input_method: 'meal_plan',
                nutrition_provenance: 'source_backed',
                recipe_version_id: retired.id,
            },
        });

        expect((await versionFor(USER_B, retired.id))?.versionId).toBe(retired.id);
        expect(await versionFor(USER_A, retired.id)).toBeNull();
    });

    it('hides a retired version from the user whose only claim on it is a deleted entry', async () => {
        const retired = await makeRecipeVersion({
            slug: 'ownership-retired-deleted-entry',
            catalogFoodId: catalog.food.id,
            meal_slots: ['dinner'],
            status: 'retired',
            perServing: { ...SLOT_SIZES.dinner },
        });

        await prisma.meal_entries.create({
            data: {
                meal_id: b.diaryMealId,
                user_id: USER_B,
                date: new Date(`${TODAY}T00:00:00.000Z`),
                name: retired.name,
                servings: 1,
                calories: Math.round(retired.per_serving_calories),
                protein_g: Math.round(retired.per_serving_protein_g),
                carbs_g: Math.round(retired.per_serving_carbs_g),
                fat_g: Math.round(retired.per_serving_fat_g),
                input_method: 'meal_plan',
                nutrition_provenance: 'source_backed',
                recipe_version_id: retired.id,
                deleted_at: NOW,
            },
        });

        // A deleted entry is not a reference: the visibility read requires
        // `deleted_at: null`, so B is answered exactly as A is.
        expect(await versionFor(USER_B, retired.id)).toBeNull();
        expect(await versionFor(USER_A, retired.id)).toBeNull();
    });
});
