// The tenancy matrix, against a real PostgreSQL (Agent Action Plan §0.5.2's
// "return 404 for any resource not owned by the caller (never distinguishing
// 'missing' from 'not yours')", §0.9.2's "Ownership matrix, route × id class"
// row, and Rule 7 §1.5/§5.1/§8).
//
// WHICH LAYERS THIS EXERCISES, AND WHY BOTH.
//
// The matrix is asserted TWICE over the same id classes, because the two
// layers can fail independently.
//
//   * At the REQUEST boundary, through the shipped app and its real mount order
//     (`../setup/testApp` drives `src/app.ts`, which never calls listen). This
//     is the only place the requirement can be checked as the client meets it:
//     a 404 whose STATUS, BODY and HEADERS differ between "not yours" and "no
//     such thing" leaks existence however carefully the predicate underneath
//     was written. The route table below is built from
//     `src/routes/mealPlanning.routes.ts` and `src/routes/catalog.routes.ts`,
//     and `the route inventory this matrix is built from` walks those two
//     routers' own stacks so a route added later WITHOUT a row here fails this
//     suite rather than shipping unproved.
//   * At the SERVICE entry points, where the owner-bearing Prisma predicates
//     actually live. A service row pins the error CLASS and its payload, which
//     a status code cannot distinguish: two refusals can both be 404 and still
//     disagree about what they report to the layer above.
//
// Neither half fakes the other. The service rows call services, the request
// rows make requests, and nothing here simulates a request layer.
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
// {@link sameOutcome} and {@link sameRefusal} are how that is asserted rather
// than approximated. Each captures both calls' outcomes whole and compares
// them: the service form compares the thrown class, its message and its own
// enumerable members, so a payload member that differed would fail even if the
// class matched; the request form compares the status, the body twice (deep
// equality AND serialised equality, which catches a key-order or
// undefined-vs-absent difference the first can miss) and every response header
// except `date`. Every such assertion also pins WHICH outcome it is, so the
// matrix cannot pass vacuously by refusing both calls for some unrelated reason
// (an incomplete setup, a disabled flag, a malformed id).
//
// The matrix is asserted in BOTH directions. Own ids produce the ordinary
// outcome — `every user-scoped route answers the caller's own ids` covers all
// twenty-two of them, so "everything is refused" is not how this suite passes —
// and the shared, tenant-less resources are asserted the other way round: a
// `current` recipe version resolves for every caller, while a retired one
// resolves only for the user whose own plan or diary still references it.
//
// Two things are deliberately not asserted anywhere here: the rounding of
// nutrition on plan DTOs and the exact text of `portionText`. Both are open
// findings against `mealPlan.mapper.ts` (F04, F05) being changed in another
// work unit, so an assertion on either would pin a value that is about to move.
//
// DETERMINISM, and why the fixture week is not a pinned calendar week. Every
// service call takes the same injected `now`, but a REQUEST cannot be given
// one: the handlers read the clock, and §0.5.1 treats an `active` plan whose
// `end_date` has passed as ended — so a week pinned to a named day would
// quietly turn every request-level write into a `409 plan_not_active` the day
// it went by, and the matrix would stop measuring tenancy. The week is
// therefore derived from ONE clock read ({@link TODAY}) and `now` is noon on
// that same day, which is what `factories.ts` prescribes ("pass `today` to fix
// what now means and let the current week follow from it"): the fixture is a
// function of that one reading, and the behaviour it asserts is the same
// whenever the suite runs. The week spans `[TODAY - 1, TODAY + 5]`, so it still
// contains the server's today even if UTC midnight passes mid-run.

import { randomUUID } from 'node:crypto';

import { prisma } from '../../prisma/client';
import catalogRoutes from '../../routes/catalog.routes';
import mealPlanningRoutes from '../../routes/mealPlanning.routes';
import nutritionRoutes from '../../routes/nutrition.routes';
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
    FIXTURE_TARGETS,
    addDaysToDayKey,
    makeCatalogFood,
    makePlan,
    makePreferences,
    makeRecipeVersion,
    makeUser,
    utcTodayDayKey,
} from '../setup/factories';
import { TEST_USER_ID_HEADER, asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

/** The caller every case acts as. */
const USER_A = 'ownership-suite-user-a';

/** The other tenant, whose ids must be indistinguishable from ids that name nothing. */
const USER_B = 'ownership-suite-user-b';

/**
 * The day both fixture weeks are built around, and the day every injected `now`
 * falls on. One clock read for the whole file — see the determinism note in the
 * header for why this is derived rather than pinned.
 */
const TODAY = utcTodayDayKey();

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
 * What makes each tenant's rows TELLABLE APART, and the only reason the two
 * tenants are not byte-identical.
 *
 * Five of the twenty-two routes carry no id at all — the preferences read and
 * both writes, the targets read and write, the estimate, and the current-plan
 * read — so there is no foreign id to present and "existence never leaks" has
 * nothing to say about them. The question they answer instead is whether the
 * response was scoped to the caller, and that is only observable when the two
 * tenants hold DIFFERENT values: with identical fixtures, a handler that read
 * the wrong row would produce the right answer by accident and every assertion
 * would pass.
 *
 * Every value here is therefore a marker some route reports:
 *  - `targets` reach `users.target_*` and `confirmed_targets` together, which
 *    is what keeps `TargetsResponse.source` at 'estimated' rather than
 *    resolving to 'legacy' (see `makePreferences`).
 *  - `cookingTimeLimitMin` is reported by the preferences read, and both values
 *    exceed the fixture recipes' 25 total minutes, so neither tenant's planning
 *    eligibility differs.
 *  - `age` moves the calculated estimate, so the estimate route has a value of
 *    its own to be scoped to.
 *  - `revision` is what a save must be pinned against, so a save accepted with
 *    A's revision proves the row it read was A's; the two are deliberately far
 *    apart, since equal revisions would make a cross-tenant read invisible.
 */
const TENANT_PROFILES = {
    [USER_A]: {
        targets: FIXTURE_TARGETS,
        cookingTimeLimitMin: 30,
        age: 34,
        revision: 1,
    },
    [USER_B]: {
        targets: { calories: 2500, protein: 188, carbs: 250, fat: 83 },
        cookingTimeLimitMin: 45,
        age: 41,
        revision: 7,
    },
} as const;

/**
 * A well-formed v4 UUID that names nothing. Freshly minted per use: a constant
 * would be one collision away from naming a row some other case created.
 *
 * Well-formed is the load-bearing word: every path id in this feature is parsed
 * before any database work, so a malformed one earns `400 invalid_request` and
 * would mask the 404 these cases exist to compare (§0.5.2).
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
 * The name a plan-scoped service's refusal carries, read from the class itself
 * rather than written out, so renaming the error cannot leave a stale string
 * here that still passes.
 */
const PLAN_NOT_FOUND_ERROR_NAME = new PlanNotFoundError().name;

/**
 * Asserts the property: two calls differing only in WHICH foreign id they
 * present are indistinguishable, and the outcome they share is the named one.
 *
 * Naming the expected error is what stops the comparison passing vacuously —
 * two calls refused by an unrelated precondition would also be equal to each
 * other, and would prove nothing about tenancy.
 *
 * The NAME is compared, not the class: `instanceof` would pass for any
 * subclass, and at the service boundary the declared contract is the named
 * error and its payload (Rule 7 §8) — the status that boundary has none of is
 * asserted separately, over HTTP, by {@link sameRefusal}.
 */
const sameOutcome = async (
    withForeignId: () => Promise<unknown>,
    withMissingId: () => Promise<unknown>,
    expectedErrorName = PLAN_NOT_FOUND_ERROR_NAME,
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
        // Flagged so `/catalog/foods/suggestions` has a chip to return: the
        // route selects published foods carrying this flag, and an empty answer
        // would make "A and B see the same list" true without measuring
        // anything.
        is_common_dislike: true,
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
 * One tenant: its own confirmed targets, a UTC preferences row carrying that
 * tenant's markers ({@link TENANT_PROFILES}), the on-target plan week, its
 * grocery list (built by the real rebuild, since no grocery factory exists) and
 * the diary bucket a log body would name.
 *
 * The zone is UTC for both tenants so that "today" on the server is
 * {@link TODAY} for both: the tenants must differ in the values a response
 * reports, never in the calendar a request is judged against.
 */
const seedTenant = async (userId: keyof typeof TENANT_PROFILES, catalog: SharedCatalog) => {
    const profile = TENANT_PROFILES[userId];

    await makeUser({
        id: userId,
        target_calories: profile.targets.calories,
        target_protein_g: profile.targets.protein,
        target_carbs_g: profile.targets.carbs,
        target_fat_g: profile.targets.fat,
    });
    await makePreferences(userId, {
        time_zone: 'UTC',
        age: profile.age,
        cooking_time_limit_min: profile.cookingTimeLimitMin,
        confirmed_targets: { ...profile.targets },
        revision: profile.revision,
        targets_revision: profile.revision,
        targets_input_revision: profile.revision,
        estimate_inputs_revision: profile.revision,
    });

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

/* ---------------------------------------------------------------------------
 * The request boundary: one table, every user-scoped route
 * ------------------------------------------------------------------------- */

/** The four verbs the two routers declare. */
type HttpMethod = 'get' | 'put' | 'post' | 'delete';

/** What supertest hands back before it is awaited. Named from the agent so no second import states it. */
type PendingRequest = ReturnType<typeof request.get>;

/**
 * One route of the two meal-planning routers, addressed by each id class the
 * matrix presents to it.
 *
 * The path builders are thunks rather than strings because the fixture is
 * rebuilt before every test: a string captured at module load would name a row
 * from a previous test's database.
 */
interface RouteCase {
    /**
     * The method and path EXACTLY as the router declares them. The inventory
     * check compares this against the routers' own stacks, so a route added
     * there without a row here fails that check.
     */
    declaration: string;
    method: HttpMethod;
    /** How a failing case names the route. */
    label: string;
    /** The path with the caller's own ids. */
    own: () => string;
    /** The path with the other tenant's ids, or null where the declaration carries no owned id. */
    foreign: (() => string) | null;
    /** The path with well-formed ids that name nothing, or null for the same reason. */
    missing: (() => string) | null;
    /** A well-formed body, for the verbs that take one. */
    body?: () => Record<string, unknown>;
    /** The status the caller's OWN ids earn — the control that stops the matrix passing vacuously. */
    ownStatus: number;
    /** Why that status proves the id resolved, in the words the test name uses. */
    ownMeaning: string;
    /** True when the route writes, so a refused call is also checked for having written nothing. */
    mutates: boolean;
}

const planPath = (planId: string): string => `/meal-planning/plans/${planId}`;

const mealPath = (planId: string, mealId: string): string => `${planPath(planId)}/meals/${mealId}`;

/** A plan revision no fixture plan holds, so a write pinned to it cannot be applied. */
const STALE_PLAN_REVISION = 999;

/**
 * The twenty-two user-scoped routes, in the order the routers declare them.
 *
 * Two of the own-id controls are deliberately not 2xx, and both are more useful
 * than a 2xx would be:
 *
 *  * `POST /meal-planning/plans` is pinned to revisions the caller's row does
 *    not hold, so it answers `409 stale_revision` carrying the revisions it
 *    READ. The tenants' revisions are far apart ({@link TENANT_PROFILES}), so
 *    those numbers are themselves the proof that the caller's own row was the
 *    one read. A generation with matching revisions would instead run the whole
 *    week search over a four-recipe fixture and answer `422 no_matching_meals`
 *    — a second's work to learn nothing about tenancy.
 *  * `POST …/regenerate` is pinned to a plan revision the plan does not hold,
 *    so it answers `409 stale_plan` with the current one. That check runs AFTER
 *    the plan is loaded by `{id, user_id}`, so reaching it proves the id
 *    resolved for this caller — and it skips the same week search.
 */
const ROUTE_CASES: readonly RouteCase[] = [
    {
        declaration: 'GET /meal-planning/preferences',
        method: 'get',
        label: 'the preferences read',
        own: () => '/meal-planning/preferences',
        foreign: null,
        missing: null,
        ownStatus: 200,
        ownMeaning: 'the caller’s own preferences',
        mutates: false,
    },
    {
        declaration: 'PUT /meal-planning/preferences',
        method: 'put',
        label: 'the full preferences save',
        own: () => '/meal-planning/preferences',
        foreign: null,
        missing: null,
        body: () => ({
            cookingTimeLimitMin: 45,
            timeZone: 'UTC',
            expectedRevision: TENANT_PROFILES[USER_A].revision,
        }),
        ownStatus: 200,
        ownMeaning: 'a save pinned to the caller’s own revision',
        mutates: true,
    },
    {
        declaration: 'PUT /meal-planning/preferences/steps/:step',
        method: 'put',
        label: 'a setup-step save',
        own: () => '/meal-planning/preferences/steps/activity',
        foreign: null,
        missing: null,
        body: () => ({
            activityLevel: 'active',
            timeZone: 'UTC',
            expectedRevision: TENANT_PROFILES[USER_A].revision,
        }),
        ownStatus: 200,
        ownMeaning: 'a step save pinned to the caller’s own revision',
        mutates: true,
    },
    {
        declaration: 'GET /meal-planning/targets/estimate',
        method: 'get',
        label: 'the target estimate',
        own: () => '/meal-planning/targets/estimate',
        foreign: null,
        missing: null,
        ownStatus: 200,
        ownMeaning: 'an estimate calculated from the caller’s own measurements',
        mutates: false,
    },
    {
        declaration: 'GET /meal-planning/targets',
        method: 'get',
        label: 'the targets read',
        own: () => '/meal-planning/targets',
        foreign: null,
        missing: null,
        ownStatus: 200,
        ownMeaning: 'the caller’s own confirmed targets',
        mutates: false,
    },
    {
        declaration: 'PUT /meal-planning/targets',
        method: 'put',
        label: 'the targets save',
        own: () => '/meal-planning/targets',
        foreign: null,
        missing: null,
        body: () => ({
            source: 'manual',
            calories: 2000,
            protein: 150,
            carbs: 200,
            fat: 67,
            expectedTargetsRevision: TENANT_PROFILES[USER_A].revision,
        }),
        ownStatus: 200,
        ownMeaning: 'a save pinned to the caller’s own targets revision',
        mutates: true,
    },
    {
        declaration: 'POST /meal-planning/plans',
        method: 'post',
        label: 'plan generation',
        own: () => '/meal-planning/plans',
        foreign: null,
        missing: null,
        body: () => ({
            startDate: TODAY,
            idempotencyKey: randomUUID(),
            expectedPreferencesRevision: 99,
            expectedTargetsRevision: 99,
        }),
        ownStatus: 409,
        ownMeaning: 'the revisions the caller’s own row holds',
        mutates: true,
    },
    {
        declaration: 'GET /meal-planning/plans/current',
        method: 'get',
        label: 'the current-plan read',
        own: () => '/meal-planning/plans/current',
        foreign: null,
        missing: null,
        ownStatus: 200,
        ownMeaning: 'the caller’s own week',
        mutates: false,
    },
    {
        declaration: 'GET /meal-planning/plans/:planId/days/:date',
        method: 'get',
        label: 'a plan day',
        own: () => `${planPath(a.plan.id)}/days/${TODAY}`,
        foreign: () => `${planPath(b.plan.id)}/days/${TODAY}`,
        missing: () => `${planPath(missingId())}/days/${TODAY}`,
        ownStatus: 200,
        ownMeaning: 'a day of the caller’s own plan',
        mutates: false,
    },
    {
        declaration: 'GET /meal-planning/plans/:planId/affected-meals',
        method: 'get',
        label: 'the affected-meals list',
        own: () => `${planPath(a.plan.id)}/affected-meals`,
        foreign: () => `${planPath(b.plan.id)}/affected-meals`,
        missing: () => `${planPath(missingId())}/affected-meals`,
        ownStatus: 200,
        ownMeaning: 'the caller’s own flagged meals',
        mutates: false,
    },
    {
        declaration: 'POST /meal-planning/plans/:planId/regenerate',
        method: 'post',
        label: 'a regeneration',
        own: () => `${planPath(a.plan.id)}/regenerate`,
        foreign: () => `${planPath(b.plan.id)}/regenerate`,
        missing: () => `${planPath(missingId())}/regenerate`,
        body: () => regenerateBody(STALE_PLAN_REVISION),
        ownStatus: 409,
        ownMeaning: 'the revision the caller’s own plan holds',
        mutates: true,
    },
    {
        declaration: 'GET /meal-planning/plans/:planId/meals/:mealId/alternatives/:recipeVersionId/preview',
        method: 'get',
        label: 'a swap preview',
        own: () =>
            `${mealPath(a.plan.id, a.breakfast.id)}/alternatives/${catalog.breakfastAlternative.id}/preview`,
        foreign: () =>
            `${mealPath(b.plan.id, b.breakfast.id)}/alternatives/${catalog.breakfastAlternative.id}/preview`,
        missing: () =>
            `${mealPath(missingId(), missingId())}/alternatives/${catalog.breakfastAlternative.id}/preview`,
        ownStatus: 200,
        ownMeaning: 'a candidate for the caller’s own meal',
        mutates: false,
    },
    {
        declaration: 'GET /meal-planning/plans/:planId/meals/:mealId/alternatives',
        method: 'get',
        label: 'the alternatives list',
        own: () => `${mealPath(a.plan.id, a.breakfast.id)}/alternatives`,
        foreign: () => `${mealPath(b.plan.id, b.breakfast.id)}/alternatives`,
        missing: () => `${mealPath(missingId(), missingId())}/alternatives`,
        ownStatus: 200,
        ownMeaning: 'the alternatives to the caller’s own meal',
        mutates: false,
    },
    {
        declaration: 'POST /meal-planning/plans/:planId/meals/:mealId/swap',
        method: 'post',
        label: 'a swap commit',
        own: () => `${mealPath(a.plan.id, a.breakfast.id)}/swap`,
        foreign: () => `${mealPath(b.plan.id, b.breakfast.id)}/swap`,
        missing: () => `${mealPath(missingId(), missingId())}/swap`,
        body: () => swapBody(catalog.breakfastAlternative.id),
        ownStatus: 200,
        ownMeaning: 'a swap of the caller’s own meal',
        mutates: true,
    },
    {
        declaration: 'POST /meal-planning/plans/:planId/meals/:mealId/log',
        method: 'post',
        label: 'a planned log',
        own: () => `${mealPath(a.plan.id, a.breakfast.id)}/log`,
        foreign: () => `${mealPath(b.plan.id, b.breakfast.id)}/log`,
        missing: () => `${mealPath(missingId(), missingId())}/log`,
        body: () => logBody(a.diaryMealId),
        ownStatus: 201,
        ownMeaning: 'an entry in the caller’s own diary',
        mutates: true,
    },
    {
        declaration: 'GET /meal-planning/plans/:planId/groceries',
        method: 'get',
        label: 'the grocery list',
        own: () => `${planPath(a.plan.id)}/groceries`,
        foreign: () => `${planPath(b.plan.id)}/groceries`,
        missing: () => `${planPath(missingId())}/groceries`,
        ownStatus: 200,
        ownMeaning: 'the caller’s own list',
        mutates: false,
    },
    {
        declaration: 'POST /meal-planning/plans/:planId/groceries/uncheck-all',
        method: 'post',
        label: 'uncheck-all',
        own: () => `${planPath(a.plan.id)}/groceries/uncheck-all`,
        foreign: () => `${planPath(b.plan.id)}/groceries/uncheck-all`,
        missing: () => `${planPath(missingId())}/groceries/uncheck-all`,
        ownStatus: 200,
        ownMeaning: 'the caller’s own list cleared',
        mutates: true,
    },
    {
        declaration: 'PUT /meal-planning/plans/:planId/groceries/:itemId',
        method: 'put',
        label: 'a grocery toggle',
        own: () => `${planPath(a.plan.id)}/groceries/${a.groceryItem.id}`,
        foreign: () => `${planPath(b.plan.id)}/groceries/${b.groceryItem.id}`,
        missing: () => `${planPath(missingId())}/groceries/${missingId()}`,
        body: () => ({ isChecked: true }),
        ownStatus: 200,
        ownMeaning: 'a check mark on the caller’s own item',
        mutates: true,
    },
    // The four shared reads. They carry no owned id — `catalog_foods` and
    // `recipe_versions` have no `user_id` at all (§0.5.1) — so `foreign` is
    // null by design and the assertion inverts: see `the shared reads`.
    {
        declaration: 'GET /catalog/foods/suggestions',
        method: 'get',
        label: 'the dislike suggestions',
        own: () => '/catalog/foods/suggestions?kind=dislike',
        foreign: null,
        missing: null,
        ownStatus: 200,
        ownMeaning: 'the shared suggestion chips',
        mutates: false,
    },
    {
        declaration: 'GET /catalog/foods',
        method: 'get',
        label: 'the catalog search',
        own: () => '/catalog/foods?q=fixture',
        foreign: null,
        missing: null,
        ownStatus: 200,
        ownMeaning: 'the shared catalog',
        mutates: false,
    },
    {
        declaration: 'GET /catalog/status',
        method: 'get',
        label: 'the catalog status',
        own: () => '/catalog/status',
        foreign: null,
        missing: null,
        ownStatus: 200,
        ownMeaning: 'the shared release counts',
        mutates: false,
    },
    {
        declaration: 'GET /recipes/:recipeVersionId',
        method: 'get',
        label: 'a recipe version',
        own: () => `/recipes/${catalog.breakfast.id}`,
        foreign: null,
        missing: () => `/recipes/${missingId()}`,
        ownStatus: 200,
        ownMeaning: 'a published recipe every caller may read',
        mutates: false,
    },
];

/**
 * The path for one id class of one route, refusing a class the row does not
 * define rather than silently requesting `/api` and asserting on Express's own
 * answer.
 */
const pathFor = (routeCase: RouteCase, idClass: 'foreign' | 'missing'): string => {
    const thunk = routeCase[idClass];

    if (thunk === null) {
        throw new Error(`${routeCase.declaration} declares no ${idClass} id class`);
    }

    return thunk();
};

/** Builds the request for one id class of one route, as the given caller or as nobody. */
const sendAs = (routeCase: RouteCase, path: string, uid: string | null): PendingRequest => {
    const url = `/api${path}`;
    const started =
        routeCase.method === 'get'
            ? request.get(url)
            : routeCase.method === 'put'
              ? request.put(url)
              : routeCase.method === 'post'
                ? request.post(url)
                : request.delete(url);
    const addressed = uid === null ? started : asUser(started, { uid });

    return routeCase.body === undefined ? addressed : addressed.send(routeCase.body());
};

/**
 * One response, flattened so two of them can be compared WHOLE.
 *
 * `serialised` is kept beside `body` because the two catch different things:
 * `toEqual` ignores key order and treats an explicitly `undefined` member as
 * absent, while the serialised form is what actually went down the wire.
 *
 * `date` is the one header dropped. It is a timestamp of the moment, not a
 * property of the resource, so comparing it would fail on the clock rather than
 * on an information leak. Every other header — `content-type`,
 * `content-length`, `etag`, `x-powered-by` — is compared, because each is
 * derived from the response and any difference between the two refusals would
 * be an oracle: a shorter body, a different entity tag, a header present on one
 * answer and not the other.
 */
interface Refusal {
    status: number;
    body: unknown;
    serialised: string;
    headers: Record<string, string>;
}

const HEADER_NOT_COMPARED = 'date';

const refusalOf = (response: {
    status: number;
    body: unknown;
    headers: Record<string, string>;
}): Refusal => ({
    status: response.status,
    body: response.body,
    serialised: JSON.stringify(response.body),
    headers: Object.fromEntries(
        Object.entries(response.headers).filter(([name]) => name.toLowerCase() !== HEADER_NOT_COMPARED),
    ),
});

/**
 * Asserts the property at the request boundary: the answer to another tenant's
 * id is indistinguishable from the answer to an id that names nothing, and the
 * answer they share is the named one.
 *
 * Naming the status is what stops this passing vacuously — two requests refused
 * by an unrelated precondition would also be equal to each other.
 */
const sameRefusal = async (
    foreign: PendingRequest,
    missing: PendingRequest,
    expectedStatus: number,
): Promise<Refusal> => {
    const withForeignId = refusalOf(await foreign);
    const withMissingId = refusalOf(await missing);

    expect(withForeignId.status).toBe(expectedStatus);
    expect(withForeignId.body).toEqual(withMissingId.body);
    expect(withForeignId.serialised).toBe(withMissingId.serialised);
    expect(withForeignId.headers).toEqual(withMissingId.headers);
    // 403 would announce that the resource exists and is someone else's, which
    // is the answer §1.5 forbids; asserted here as well as in the sweep so a
    // single-route regression fails its own case.
    expect(withForeignId.status).not.toBe(403);

    return withForeignId;
};

/** The 404 every plan-scoped route answers, whatever the reason (§0.5.2). */
const PLAN_NOT_FOUND_BODY = { error: 'Plan not found' } as const;

/** The 404 `GET /recipes/:recipeVersionId` answers for a version the caller may not see. */
const RECIPE_NOT_FOUND_BODY = { error: 'Recipe not found' } as const;

/** What `middleware/auth.ts` answers a request carrying no token, verbatim. */
const UNAUTHENTICATED_BODY = { error: 'No token provided' } as const;

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

/* ---------------------------------------------------------------------------
 * The request boundary — the promise both route files make about this file
 * ------------------------------------------------------------------------- */

describe('the route inventory this matrix is built from', () => {
    /** Just enough of an Express router's internals to read what it declares. */
    interface RouteLayer {
        route?: { path: string; methods: Record<string, boolean> };
    }

    /**
     * Every `METHOD /path` a router declares, read from the router itself.
     *
     * This is what makes the matrix self-policing rather than a list somebody
     * has to remember to extend: `mealPlanning.routes.ts` states that this
     * suite walks every user-scoped path it declares, and a promise checked
     * against the router's own stack cannot quietly stop being true.
     */
    const declaredRoutes = (router: unknown): string[] =>
        ((router as { stack?: RouteLayer[] }).stack ?? [])
            .flatMap((layer) =>
                layer.route === undefined
                    ? []
                    : Object.entries(layer.route.methods)
                          .filter(([, declared]) => declared)
                          .map(([method]) => `${method.toUpperCase()} ${layer.route?.path ?? ''}`),
            )
            .sort();

    const covered = [...new Set(ROUTE_CASES.map((routeCase) => routeCase.declaration))].sort();

    it('has a case for every route the two meal-planning routers declare', () => {
        const declared = [...declaredRoutes(mealPlanningRoutes), ...declaredRoutes(catalogRoutes)].sort();

        expect(covered).toEqual(declared);
    });

    it('addresses only routes that are really declared, so no case can drift onto a dead path', async () => {
        // The converse of the check above, and not redundant with it: set
        // equality would also hold if a case and a declaration were BOTH wrong
        // in the same way. Driving each own-id path proves the path exists — a
        // path no router declares falls through both mounts to Express's own
        // 404, whose body is HTML rather than this feature's JSON.
        for (const routeCase of ROUTE_CASES) {
            const response = await sendAs(routeCase, routeCase.own(), USER_A);

            expect(response.status).not.toBe(404);
            expect(response.type).toBe('application/json');
        }
    });

    it('declares every diary route this matrix also covers', () => {
        // Asserted in one direction only, and deliberately: `nutrition.routes.ts`
        // owns paths outside this matrix (history, AI usage, estimates, the
        // legacy target write), so set equality would be a claim about that
        // router rather than about tenancy.
        const declared = declaredRoutes(nutritionRoutes);

        expect(declared).toEqual(
            expect.arrayContaining([
                'GET /macros/:date',
                'POST /macros/meal/:mealId/entries',
                'PUT /macros/entry/:id',
                'DELETE /macros/entry/:id',
            ]),
        );
    });
});

describe('every user-scoped route answers the caller’s own ids', () => {
    // The control for the whole matrix. Without it a blanket-404 regression
    // would satisfy every refusal case in this file, and the suite would report
    // a tenancy boundary that was really a broken feature. One test per route,
    // each against a freshly seeded fixture, so no row can be made to pass or
    // fail by what another row wrote.
    it.each(ROUTE_CASES)('$label answers $ownStatus with $ownMeaning', async (routeCase: RouteCase) => {
        const response = await sendAs(routeCase, routeCase.own(), USER_A);

        // The route and the body ride along with the status: the route so a
        // failure names which row broke, and the body so the report shows what
        // the route actually said instead of only that the number was wrong.
        expect({ route: routeCase.declaration, status: response.status, body: response.body }).toEqual({
            route: routeCase.declaration,
            status: routeCase.ownStatus,
            body: expect.anything(),
        });
    });
});

describe('another tenant’s id is indistinguishable from an id that names nothing', () => {
    const scoped = ROUTE_CASES.filter(
        (routeCase): routeCase is RouteCase & { foreign: () => string; missing: () => string } =>
            routeCase.foreign !== null && routeCase.missing !== null,
    );

    it.each(scoped)('$label refuses both alike', async (routeCase) => {
        const refusal = await sameRefusal(
            sendAs(routeCase, routeCase.foreign(), USER_A),
            sendAs(routeCase, routeCase.missing(), USER_A),
            404,
        );

        // The body is pinned as well as compared: two refusals could agree with
        // each other and still have stopped being the 404 the contract owes.
        expect(refusal.body).toEqual(PLAN_NOT_FOUND_BODY);
    });

    it('never answers 403 to any id class of any route', async () => {
        // Swept programmatically so a route added to the table is covered
        // without anyone remembering to add a case: 403 is the one status
        // §1.5 forbids outright, because it confirms the resource exists and
        // belongs to somebody else.
        const forbidden: string[] = [];

        for (const routeCase of ROUTE_CASES) {
            const paths = [routeCase.own(), routeCase.foreign?.(), routeCase.missing?.()].filter(
                (path): path is string => path !== undefined,
            );

            for (const path of paths) {
                const response = await sendAs(routeCase, path, USER_A);

                if (response.status === 403) {
                    forbidden.push(`${routeCase.declaration} -> ${path}`);
                }
            }
        }

        expect(forbidden).toEqual([]);
    });
});


describe('a nested id needs its parent, not just its owner', () => {
    /**
     * A second week of the caller's OWN, so every id below belongs to the
     * caller and only the parent it is addressed under is wrong.
     *
     * This is the one class an owner-only predicate passes the rest of the
     * matrix on and fails here: `where: {id, user_id}` finds the caller's own
     * meal, item or day whatever plan the URL names, which is why §0.5.1 puts
     * the parent ids in the predicate too. Built per case rather than in the
     * shared fixture because only these cases need it.
     */
    const seedSecondWeek = async () => {
        const startDate = addDaysToDayKey(PLAN_END_DAY_KEY, 1);
        const plan = await makePlan(USER_A, {
            startDate,
            dayCount: 1,
            slots: [{ slot: 'breakfast', slot_time: '08:00', recipeVersionId: catalog.breakfast.id }],
        });

        await withMealPlanningTransaction((tx) =>
            withUserLock(tx, USER_A, async (locked) =>
                rebuildPlanGroceries(locked, {
                    userId: USER_A,
                    planId: plan.id,
                    meals: await loadPlannedMealsForGroceries(locked, USER_A, plan.id),
                    now: NOW,
                }),
            ),
        );

        const day = plan.meal_plan_days[0];
        const meal = day?.meal_plan_meals[0];

        if (day === undefined || meal === undefined) {
            throw new Error('the second fixture week has no planned meal');
        }

        return {
            planId: plan.id,
            mealId: meal.id,
            date: startDate,
            groceryItemId: (
                await prisma.grocery_items.findFirstOrThrow({
                    where: { meal_plan_id: plan.id, user_id: USER_A },
                    orderBy: { sort_order: 'asc' },
                })
            ).id,
        };
    };

    /** The route rows that address a meal, all four of which take the crossed id. */
    const mealRoutes = ROUTE_CASES.filter((routeCase) =>
        routeCase.declaration.includes('/meals/:mealId'),
    );

    it.each(mealRoutes)(
        '$label refuses the caller’s own meal from another plan exactly as an absent one',
        async (routeCase) => {
            const second = await seedSecondWeek();
            const crossed = routeCase.own().replace(a.breakfast.id, second.mealId);

            const refusal = await sameRefusal(
                sendAs(routeCase, crossed, USER_A),
                sendAs(routeCase, pathFor(routeCase, 'missing'), USER_A),
                404,
            );

            expect(refusal.body).toEqual(PLAN_NOT_FOUND_BODY);
            expect(
                (await prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: second.mealId } }))
                    .recipe_version_id,
            ).toBe(catalog.breakfast.id);
        },
    );

    it('refuses the caller’s own grocery item from another plan exactly as an absent one', async () => {
        const second = await seedSecondWeek();
        const toggle = ROUTE_CASES.find(
            (routeCase) => routeCase.declaration === 'PUT /meal-planning/plans/:planId/groceries/:itemId',
        );

        if (toggle === undefined) {
            throw new Error('the grocery toggle has no route case');
        }

        const refusal = await sameRefusal(
            sendAs(toggle, `${planPath(a.plan.id)}/groceries/${second.groceryItemId}`, USER_A),
            sendAs(toggle, pathFor(toggle, 'missing'), USER_A),
            404,
        );

        expect(refusal.body).toEqual(PLAN_NOT_FOUND_BODY);
        // The item the URL named is the caller's own, so "refused" has to mean
        // "not checked" as well as "404" — a handler that answered 404 after
        // writing would otherwise pass.
        expect(
            await prisma.grocery_items.count({ where: { user_id: USER_A, is_checked: true } }),
        ).toBe(0);
    });

    it('refuses a day of the caller’s other plan exactly as a plan that does not exist', async () => {
        const second = await seedSecondWeek();
        const day = ROUTE_CASES.find(
            (routeCase) => routeCase.declaration === 'GET /meal-planning/plans/:planId/days/:date',
        );

        if (day === undefined) {
            throw new Error('the plan-day read has no route case');
        }

        // `second.date` is a real day of a real plan of this caller's — just not
        // of the plan in the URL. §0.5.2 gives this route one 404 for "not your
        // plan" and "not in this plan" alike, because distinguishing them would
        // confirm the plan exists.
        const refusal = await sameRefusal(
            sendAs(day, `${planPath(a.plan.id)}/days/${second.date}`, USER_A),
            sendAs(day, pathFor(day, 'missing'), USER_A),
            404,
        );

        expect(refusal.body).toEqual(PLAN_NOT_FOUND_BODY);
    });

    it('refuses a log whose body names the other tenant’s diary bucket', async () => {
        // Everything in the path is the caller's own, so the only foreign value
        // is in the BODY — the bucket the entry would land in, which is exactly
        // what a client could tamper with to write into someone else's diary. A
        // handler that validated the path and trusted the body passes every
        // other case in this file and fails here.
        const log = ROUTE_CASES.find(
            (routeCase) => routeCase.declaration === 'POST /meal-planning/plans/:planId/meals/:mealId/log',
        );

        if (log === undefined) {
            throw new Error('the planned log has no route case');
        }

        const ownPath = log.own();
        const withForeignBucket = asUser(request.post(`/api${ownPath}`), { uid: USER_A }).send(
            logBody(b.diaryMealId),
        );
        const withAbsentBucket = asUser(request.post(`/api${ownPath}`), { uid: USER_A }).send(
            logBody(missingId()),
        );

        const refusal = await sameRefusal(withForeignBucket, withAbsentBucket, 404);

        expect(refusal.body).toEqual(PLAN_NOT_FOUND_BODY);
        expect(await prisma.meal_entries.count()).toBe(0);
    });
});

describe('a refused write writes nothing', () => {
    it('leaves both tenants exactly as they were after every refused write', async () => {
        // §0.5.1 puts the owner key in the WRITE predicate, not only in the read
        // that precedes it. The difference is invisible in the response — both
        // shapes answer 404 — and visible only here, in the rows afterwards.
        const writes = ROUTE_CASES.filter(
            (routeCase) => routeCase.mutates && routeCase.foreign !== null && routeCase.missing !== null,
        );

        expect(writes.map((routeCase) => routeCase.declaration)).toEqual([
            'POST /meal-planning/plans/:planId/regenerate',
            'POST /meal-planning/plans/:planId/meals/:mealId/swap',
            'POST /meal-planning/plans/:planId/meals/:mealId/log',
            'POST /meal-planning/plans/:planId/groceries/uncheck-all',
            'PUT /meal-planning/plans/:planId/groceries/:itemId',
        ]);

        for (const routeCase of writes) {
            await sendAs(routeCase, pathFor(routeCase, 'foreign'), USER_A).expect(404);
            await sendAs(routeCase, pathFor(routeCase, 'missing'), USER_A).expect(404);
        }

        // No diary entry, no ledger row, no revision moved, no meal re-pointed,
        // no check mark set — for either tenant.
        await expectNothingWritten(a, b);

        // And the other tenant's own preferences and targets are where they
        // were, which is what the id-less writes could otherwise have reached.
        const preferences = await prisma.meal_plan_preferences.findUniqueOrThrow({
            where: { user_id: USER_B },
            select: { revision: true, targets_revision: true, cooking_time_limit_min: true },
        });

        expect(preferences).toEqual({
            revision: TENANT_PROFILES[USER_B].revision,
            targets_revision: TENANT_PROFILES[USER_B].revision,
            cooking_time_limit_min: TENANT_PROFILES[USER_B].cookingTimeLimitMin,
        });
    });
});


describe('identity comes from the token, never from the body', () => {
    /**
     * The three spellings a client could plausibly reach for, aimed at the
     * other tenant. Rule 7 §4 allows exactly one identity channel —
     * `getUserId(req)`, which reads the verified token — so none of these may
     * change where a write lands.
     *
     * Two outcomes are both correct and both asserted, because which one a
     * route gives is a property of its parser: the swap, log, targets and
     * preferences parsers declare closed key sets and REFUSE an unknown key
     * (`unknown_field` / `read_only_field`, §0.5.2), while the generation,
     * regeneration and grocery-toggle parsers read the keys they need and
     * IGNORE the rest. What must hold either way is the second assertion: the
     * other tenant's rows do not move.
     */
    const IDENTITY_KEYS = ['userId', 'user_id', 'ownerId'] as const;

    /** Every write in the table, with a body carrying the three keys naming user B. */
    const writeRoutes = ROUTE_CASES.filter((routeCase) => routeCase.mutates);

    /** What user B holds before any of this, read back afterwards unchanged. */
    const snapshotOfUserB = async () => ({
        preferences: await prisma.meal_plan_preferences.findUniqueOrThrow({ where: { user_id: USER_B } }),
        user: await prisma.users.findUniqueOrThrow({ where: { id: USER_B } }),
        plan: await prisma.meal_plans.findUniqueOrThrow({ where: { id: b.plan.id } }),
        meal: await prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: b.breakfast.id } }),
        groceryItems: await prisma.grocery_items.findMany({
            where: { user_id: USER_B },
            orderBy: { sort_order: 'asc' },
        }),
        entries: await prisma.meal_entries.count({ where: { user_id: USER_B } }),
    });

    it.each(writeRoutes)('$label never lands on the tenant its body names', async (routeCase) => {
        const before = await snapshotOfUserB();
        const body = {
            ...(routeCase.body?.() ?? {}),
            ...Object.fromEntries(IDENTITY_KEYS.map((key) => [key, USER_B])),
        };

        const response = await asUser(
            routeCase.method === 'put'
                ? request.put(`/api${routeCase.own()}`)
                : request.post(`/api${routeCase.own()}`),
            { uid: USER_A },
        ).send(body);

        // Either the request was refused for naming a key the route does not
        // accept, or it was accepted and the keys were ignored. It is never
        // 2xx-for-B, and never a 403 (§1.5).
        if (response.status === 400) {
            expect(response.body).toEqual({
                error: 'invalid_request',
                details: expect.arrayContaining([
                    expect.objectContaining({ field: expect.stringMatching(/^(userId|user_id|ownerId)$/) }),
                ]),
            });
        } else {
            expect(response.status).toBe(routeCase.ownStatus);
        }

        expect(await snapshotOfUserB()).toEqual(before);
    });

    it('scopes the id-less reads to the caller, which is the only way they can be scoped at all', async () => {
        // Five routes carry no id, so "another tenant's id" does not exist for
        // them and the property is asserted the only way it can be: the two
        // tenants hold different values ({@link TENANT_PROFILES}) and each
        // caller is answered with their own.
        const preferencesForA = await asUser(request.get('/api/meal-planning/preferences'), {
            uid: USER_A,
        }).expect(200);
        const preferencesForB = await asUser(request.get('/api/meal-planning/preferences'), {
            uid: USER_B,
        }).expect(200);

        expect(preferencesForA.body).toMatchObject({
            cookingTimeLimitMin: TENANT_PROFILES[USER_A].cookingTimeLimitMin,
            age: TENANT_PROFILES[USER_A].age,
            revision: TENANT_PROFILES[USER_A].revision,
        });
        expect(preferencesForB.body).toMatchObject({
            cookingTimeLimitMin: TENANT_PROFILES[USER_B].cookingTimeLimitMin,
            age: TENANT_PROFILES[USER_B].age,
            revision: TENANT_PROFILES[USER_B].revision,
        });

        const targetsForA = await asUser(request.get('/api/meal-planning/targets'), { uid: USER_A }).expect(200);
        const targetsForB = await asUser(request.get('/api/meal-planning/targets'), { uid: USER_B }).expect(200);

        expect(targetsForA.body).toMatchObject({
            targets: TENANT_PROFILES[USER_A].targets,
            revision: TENANT_PROFILES[USER_A].revision,
        });
        expect(targetsForB.body).toMatchObject({
            targets: TENANT_PROFILES[USER_B].targets,
            revision: TENANT_PROFILES[USER_B].revision,
        });

        const estimateForA = await asUser(request.get('/api/meal-planning/targets/estimate'), {
            uid: USER_A,
        }).expect(200);
        const estimateForB = await asUser(request.get('/api/meal-planning/targets/estimate'), {
            uid: USER_B,
        }).expect(200);

        // The estimate is calculated from the caller's own measurements, and the
        // two tenants' ages differ, so equal answers here would mean one of them
        // was computed from the wrong row.
        expect(estimateForA.body).toMatchObject({ inputs: { age: TENANT_PROFILES[USER_A].age } });
        expect(estimateForB.body).toMatchObject({ inputs: { age: TENANT_PROFILES[USER_B].age } });
        expect((estimateForA.body as { calories: number }).calories).not.toBe(
            (estimateForB.body as { calories: number }).calories,
        );

        const plansForA = await asUser(request.get('/api/meal-planning/plans/current'), { uid: USER_A }).expect(
            200,
        );
        const plansForB = await asUser(request.get('/api/meal-planning/plans/current'), { uid: USER_B }).expect(
            200,
        );
        const idsIn = (body: unknown): string[] =>
            [
                (body as { current: { id?: string } | null }).current?.id,
                (body as { upcoming: { id?: string } | null }).upcoming?.id,
            ].filter((id): id is string => id !== undefined);

        expect(idsIn(plansForA.body)).toEqual([a.plan.id]);
        expect(idsIn(plansForB.body)).toEqual([b.plan.id]);
        // Stated as well as implied: the other tenant's week appears in neither
        // member of the caller's answer.
        expect(idsIn(plansForA.body)).not.toContain(b.plan.id);
        expect(idsIn(plansForB.body)).not.toContain(a.plan.id);
    });

    it('answers the header’s caller even when the body names the other tenant on an id-less save', async () => {
        const before = await snapshotOfUserB();
        const response = await asUser(request.put('/api/meal-planning/targets'), { uid: USER_A }).send({
            source: 'manual',
            calories: 1900,
            protein: 150,
            carbs: 190,
            fat: 63,
            expectedTargetsRevision: TENANT_PROFILES[USER_A].revision,
            userId: USER_B,
        });

        // The targets parser declares a closed key set, so this is a refusal
        // naming the key — not a silent save against the caller.
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: 'invalid_request',
            details: [{ field: 'userId', code: 'unknown_field' }],
        });
        expect(await snapshotOfUserB()).toEqual(before);

        // And the caller's own row did not move either, because the request was
        // refused rather than partly applied.
        expect(
            await prisma.users.findUniqueOrThrow({
                where: { id: USER_A },
                select: { target_calories: true },
            }),
        ).toEqual({ target_calories: TENANT_PROFILES[USER_A].targets.calories });
    });
});


/* ---------------------------------------------------------------------------
 * The shipped diary routes
 *
 * `nutrition.service.ts::updateMealEntry` moved from read-then-update-by-id to
 * an owner-bearing `where: {id, user_id, deleted_at: null}` (§0.5.1). That is a
 * BEHAVIOUR-PRESERVING change, so these cases pin the shipped answers to the
 * character: the strings below are read by clients already in the field, and an
 * unannounced change to either is a compatibility break. `compat.test.ts`
 * asserts the same routes from the compatibility side; this is the tenancy
 * side, and it is the half that reads the rows back afterwards.
 * ------------------------------------------------------------------------- */

describe('the shipped diary routes', () => {
    /** The 404 both entry routes answer, verbatim. */
    const ENTRY_NOT_FOUND_BODY = { error: 'Entry not found' } as const;

    /** The 404 the log route answers for a bucket that is not the caller's, verbatim. */
    const MEAL_NOT_FOUND_BODY = { error: 'Meal not found' } as const;

    /** A body the shipped legacy shape accepts: a name and the four macros. */
    const legacyEntryBody = (name: string): Record<string, unknown> => ({
        name,
        calories: 210,
        protein: 12,
        carbs: 24,
        fat: 8,
        servings: 1,
    });

    /** An entry in user B's own breakfast, written through the shipped route as B. */
    const entryOfUserB = async () => {
        const created = await asUser(request.post(`/api/macros/meal/${b.diaryMealId}/entries`), {
            uid: USER_B,
        })
            .send(legacyEntryBody('Another tenant’s breakfast'))
            .expect(201);

        const id = (created.body as { id: string }).id;

        return { id, row: await prisma.meal_entries.findUniqueOrThrow({ where: { id } }) };
    };

    it('refuses an edit of the other tenant’s entry exactly as an edit of an absent one', async () => {
        const entry = await entryOfUserB();

        const refusal = await sameRefusal(
            asUser(request.put(`/api/macros/entry/${entry.id}`), { uid: USER_A }).send({ servings: 9 }),
            asUser(request.put(`/api/macros/entry/${missingId()}`), { uid: USER_A }).send({ servings: 9 }),
            404,
        );

        expect(refusal.body).toEqual(ENTRY_NOT_FOUND_BODY);
        // Every column, not just the servings the edit aimed at: the owner key
        // belongs in the UPDATE predicate, and only the row can show that it
        // was.
        expect(await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } })).toStrictEqual(
            entry.row,
        );
    });

    it('refuses a delete of the other tenant’s entry exactly as a delete of an absent one', async () => {
        const entry = await entryOfUserB();

        const refusal = await sameRefusal(
            asUser(request.delete(`/api/macros/entry/${entry.id}`), { uid: USER_A }),
            asUser(request.delete(`/api/macros/entry/${missingId()}`), { uid: USER_A }),
            404,
        );

        expect(refusal.body).toEqual(ENTRY_NOT_FOUND_BODY);

        const after = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        // A soft delete is a column, so "refused" has to mean the column is
        // still null — a 404 after a successful `updateMany` would otherwise
        // read as a refusal while the other tenant's entry vanished from their
        // diary.
        expect(after).toStrictEqual(entry.row);
        expect(after.deleted_at).toBeNull();
    });

    it('refuses a log into the other tenant’s bucket exactly as into an absent one', async () => {
        const refusal = await sameRefusal(
            asUser(request.post(`/api/macros/meal/${b.diaryMealId}/entries`), { uid: USER_A }).send(
                legacyEntryBody('Written into someone else’s breakfast'),
            ),
            asUser(request.post(`/api/macros/meal/${missingId()}/entries`), { uid: USER_A }).send(
                legacyEntryBody('Written into a bucket that does not exist'),
            ),
            404,
        );

        expect(refusal.body).toEqual(MEAL_NOT_FOUND_BODY);
        expect(await prisma.meal_entries.count()).toBe(0);
    });

    it('reads a day as the caller’s own day, with none of the other tenant’s meals or entries in it', async () => {
        const entry = await entryOfUserB();
        const response = await asUser(request.get(`/api/macros/${TODAY}`), { uid: USER_A }).expect(200);
        const body = response.body as {
            meals: { id: string; entries: { id: string; name: string }[] }[];
        };
        const mealIds = body.meals.map((meal) => meal.id);
        const entryIds = body.meals.flatMap((meal) => meal.entries.map((row) => row.id));

        expect(mealIds).toContain(a.diaryMealId);
        expect(mealIds).not.toContain(b.diaryMealId);
        expect(entryIds).toEqual([]);
        expect(entryIds).not.toContain(entry.id);

        // The counter-proof: the same read as B DOES carry that entry, so the
        // assertion above is scoping rather than an empty diary.
        const asOwner = await asUser(request.get(`/api/macros/${TODAY}`), { uid: USER_B }).expect(200);
        const ownerEntryIds = (asOwner.body as { meals: { entries: { id: string }[] }[] }).meals.flatMap(
            (meal) => meal.entries.map((row) => row.id),
        );

        expect(ownerEntryIds).toEqual([entry.id]);
    });
});

/* ---------------------------------------------------------------------------
 * The shared reads, asserted the other way round
 *
 * `catalog_foods` and `recipe_versions` carry NO `user_id` — they are shared
 * reference data, the same catalog and the same recipes for every caller, and
 * this feature's one sanctioned exception to the owner-predicate rule (§0.5.1,
 * and `catalog.controller.ts` says so where it is read). So the assertion
 * inverts: sharing must WORK, and a tenant predicate added to a catalog read by
 * a well-meaning future change would make one caller's search come back empty —
 * which nothing else in this suite would catch.
 * ------------------------------------------------------------------------- */

describe('the shared reads', () => {
    /**
     * The three untenanted reads, each with the thing its own answer must
     * actually carry.
     *
     * The second assertion is what stops the first from being vacuous: two
     * empty answers compare equal, so "identical for both tenants" would hold
     * just as well if a tenant predicate had reduced both to nothing.
     */
    const CATALOG_READS = [
        {
            path: '/api/catalog/foods?q=fixture',
            carries: 'the fixture food among its items',
            isPopulated: (body: unknown): boolean => (body as { items: unknown[] }).items.length > 0,
        },
        {
            path: '/api/catalog/foods/suggestions?kind=dislike',
            carries: 'the flagged food among its chips',
            isPopulated: (body: unknown): boolean => (body as { items: unknown[] }).items.length > 0,
        },
        {
            path: '/api/catalog/status',
            carries: 'a published count of the shared catalog',
            isPopulated: (body: unknown): boolean => (body as { publishedCount: number }).publishedCount > 0,
        },
    ] as const;

    it.each(CATALOG_READS)('answers $path identically for both tenants, with $carries', async (read) => {
        const forA = await asUser(request.get(read.path), { uid: USER_A }).expect(200);
        const forB = await asUser(request.get(read.path), { uid: USER_B }).expect(200);

        expect(forA.body).toEqual(forB.body);
        expect(read.isPopulated(forA.body)).toBe(true);
    });

    it('serves a current recipe version to every caller, because a published recipe has no owner', async () => {
        for (const uid of [USER_A, USER_B]) {
            const response = await asUser(request.get(`/api/recipes/${catalog.breakfast.id}`), {
                uid,
            }).expect(200);

            expect(response.body).toMatchObject({ versionId: catalog.breakfast.id, status: 'current' });
        }
    });

    it('serves a retired version only to the tenant whose own plan still references it', async () => {
        const retired = await makeRecipeVersion({
            slug: 'ownership-http-retired-in-plan',
            catalogFoodId: catalog.food.id,
            meal_slots: ['dinner'],
            status: 'retired',
            perServing: { ...SLOT_SIZES.dinner },
        });

        // A second week of B's, the only row in the database pointing at it.
        await makePlan(USER_B, {
            startDate: addDaysToDayKey(PLAN_END_DAY_KEY, 1),
            dayCount: 1,
            slots: [{ slot: 'dinner', slot_time: '18:30', recipeVersionId: retired.id }],
        });

        const owner = await asUser(request.get(`/api/recipes/${retired.id}`), { uid: USER_B }).expect(200);

        // Retired, not deleted: the content is frozen and still readable, which
        // is the whole point of retiring a version a plan or diary still names.
        expect(owner.body).toMatchObject({ versionId: retired.id, status: 'retired', name: retired.name });

        const refusal = await sameRefusal(
            asUser(request.get(`/api/recipes/${retired.id}`), { uid: USER_A }),
            asUser(request.get(`/api/recipes/${missingId()}`), { uid: USER_A }),
            404,
        );

        expect(refusal.body).toEqual(RECIPE_NOT_FOUND_BODY);
    });

    it('serves a retired version only to the tenant whose own diary entry still references it', async () => {
        const retired = await makeRecipeVersion({
            slug: 'ownership-http-retired-in-diary',
            catalogFoodId: catalog.food.id,
            meal_slots: ['dinner'],
            status: 'retired',
            perServing: { ...SLOT_SIZES.dinner },
        });

        // Written directly because this is the one reference class no route can
        // produce on its own: the entry must name the retired version while no
        // plan of B's does, or the plan clause would be what makes it visible
        // and the diary clause would never be exercised. It is the shape an
        // entry takes after the meal it was logged from was regenerated away.
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

        await asUser(request.get(`/api/recipes/${retired.id}`), { uid: USER_B }).expect(200);

        const refusal = await sameRefusal(
            asUser(request.get(`/api/recipes/${retired.id}`), { uid: USER_A }),
            asUser(request.get(`/api/recipes/${missingId()}`), { uid: USER_A }),
            404,
        );

        expect(refusal.body).toEqual(RECIPE_NOT_FOUND_BODY);
    });

    it('serves a retired version nothing references to nobody, with that same refusal', async () => {
        const orphaned = await makeRecipeVersion({
            slug: 'ownership-http-retired-unreferenced',
            catalogFoodId: catalog.food.id,
            meal_slots: ['dinner'],
            status: 'retired',
            perServing: { ...SLOT_SIZES.dinner },
        });

        for (const uid of [USER_A, USER_B]) {
            const refusal = await sameRefusal(
                asUser(request.get(`/api/recipes/${orphaned.id}`), { uid }),
                asUser(request.get(`/api/recipes/${missingId()}`), { uid }),
                404,
            );

            expect(refusal.body).toEqual(RECIPE_NOT_FOUND_BODY);
        }
    });

    it('serves a version in no published state to nobody, with that same refusal', async () => {
        // A version whose `status` is neither `current` nor a retirement the
        // caller references — the state a version sits in before it is promoted.
        // It is not `current`, so the visibility rule falls through to the
        // reference clauses, and nothing references it.
        const unpublished = await makeRecipeVersion({
            slug: 'ownership-http-candidate',
            catalogFoodId: catalog.food.id,
            meal_slots: ['dinner'],
            status: 'candidate',
            perServing: { ...SLOT_SIZES.dinner },
        });

        for (const uid of [USER_A, USER_B]) {
            const refusal = await sameRefusal(
                asUser(request.get(`/api/recipes/${unpublished.id}`), { uid }),
                asUser(request.get(`/api/recipes/${missingId()}`), { uid }),
                404,
            );

            expect(refusal.body).toEqual(RECIPE_NOT_FOUND_BODY);
        }
    });
});


/* ---------------------------------------------------------------------------
 * The authentication boundary
 *
 * Rule 7 §3.1 makes the mount an ordering constraint: `userRoutes` and
 * `/health` sit BEFORE `app.use(authenticateFirebaseToken)` and everything
 * after it is protected, so a router mounted on the wrong side of that line
 * changes its security posture silently. These cases are what make the line
 * observable — and they iterate the route table, so a route added there is
 * covered here without anyone remembering to add a case.
 * ------------------------------------------------------------------------- */

describe('the authentication boundary', () => {
    it('answers every route in this matrix 401 when the request carries no token', async () => {
        const reachable: string[] = [];

        for (const routeCase of ROUTE_CASES) {
            const response = await sendAs(routeCase, routeCase.own(), null);

            if (response.status !== 401) {
                reachable.push(`${routeCase.declaration} -> ${response.status}`);
            }

            expect(response.body).toEqual(UNAUTHENTICATED_BODY);
        }

        expect(reachable).toEqual([]);
    });

    it('answers the diary routes this matrix covers 401 as well', async () => {
        const unauthenticated = [
            request.get(`/api/macros/${TODAY}`),
            request.post(`/api/macros/meal/${a.diaryMealId}/entries`).send({}),
            request.put(`/api/macros/entry/${missingId()}`).send({ servings: 2 }),
            request.delete(`/api/macros/entry/${missingId()}`),
        ];

        for (const pending of unauthenticated) {
            const response = await pending.expect(401);

            expect(response.body).toEqual(UNAUTHENTICATED_BODY);
        }
    });

    it('authenticates before it looks anything up, so an absent id is still 401', async () => {
        // The ordering matters as much as the status: a 404 here would mean the
        // handler ran — and therefore that it decided what exists — before the
        // caller was established at all.
        for (const routeCase of ROUTE_CASES) {
            if (routeCase.missing === null) {
                continue;
            }

            const response = await sendAs(routeCase, routeCase.missing(), null);

            expect({ route: routeCase.declaration, status: response.status }).toEqual({
                route: routeCase.declaration,
                status: 401,
            });
        }
    });

    it('rejects an empty identity as firmly as an absent one', async () => {
        // The header's presence is not the test the middleware applies: an
        // empty value carries no caller, so it cannot be allowed to resolve to
        // one (see `jestSetup.ts`, which reproduces the shipped refusal).
        const response = await request
            .get('/api/meal-planning/preferences')
            .set(TEST_USER_ID_HEADER, '')
            .expect(401);

        expect(response.body).toEqual(UNAUTHENTICATED_BODY);
    });

    it('serves /health without a token, because it is mounted before the boundary', async () => {
        // The counter-proof for the sweep above: the 401s are the auth mount
        // doing its job, not the whole app refusing everything.
        const response = await request.get('/health').expect(200);

        expect(response.body).toMatchObject({ status: 'ok' });
    });
});

/* ---------------------------------------------------------------------------
 * What a refusal body may contain
 *
 * Rule 7 §4 ("don't leak internals in error bodies", naming `{error: err}` as
 * the pattern to fix) and §8 (status + machine code, never the error class).
 * A refusal that leaked a Prisma message would also leak the table and column
 * it failed on — and, for the cases above, the very existence the 404 exists to
 * withhold.
 * ------------------------------------------------------------------------- */

describe('what a refusal body may contain', () => {
    /** Fragments that would mean an internal detail reached the client. */
    const LEAKED_FRAGMENTS = [
        'prisma',
        'Invalid `prisma',
        'meal_plans',
        'meal_plan_meals',
        'grocery_items',
        'meal_entries',
        'user_id',
        'select *',
        'at Object.',
        'node_modules',
        'Error:',
        'stack',
    ] as const;

    it('answers every refusal with exactly the contract’s key set and nothing else', async () => {
        for (const routeCase of ROUTE_CASES) {
            if (routeCase.foreign === null) {
                continue;
            }

            const response = await sendAs(routeCase, routeCase.foreign(), USER_A);

            // One key, `error`, carrying a machine-readable string. Not the
            // thrown class, not its stack, not the payload of whatever the
            // service raised.
            expect(Object.keys(response.body as Record<string, unknown>)).toEqual(['error']);
            expect(typeof (response.body as { error: unknown }).error).toBe('string');
        }
    });

    it('never puts an internal detail in a refusal body', async () => {
        const planDay = ROUTE_CASES.find(
            (routeCase) => routeCase.declaration === 'GET /meal-planning/plans/:planId/days/:date',
        );

        if (planDay === undefined) {
            throw new Error('the plan-day read has no route case');
        }

        const refusals = [
            await sendAs(planDay, pathFor(planDay, 'foreign'), USER_A),
            await asUser(request.put(`/api/macros/entry/${missingId()}`), { uid: USER_A }).send({ servings: 2 }),
            await asUser(request.get(`/api/recipes/${missingId()}`), { uid: USER_A }),
            await request.get('/api/meal-planning/preferences'),
        ];

        for (const response of refusals) {
            const serialised = JSON.stringify(response.body).toLowerCase();

            for (const fragment of LEAKED_FRAGMENTS) {
                expect(serialised).not.toContain(fragment.toLowerCase());
            }
        }
    });

    it('describes a validation failure by field and code, never by exception', async () => {
        // The other half of §8: the 400s this feature returns name the field
        // and a machine code the client maps, and they are as free of internals
        // as the 404s are.
        const response = await asUser(request.put('/api/meal-planning/targets'), { uid: USER_A })
            .send({ source: 'manual', calories: 2000, protein: 150, carbs: 200, fat: 67, userId: USER_B })
            .expect(400);

        expect(response.body).toEqual({
            error: 'invalid_request',
            details: [{ field: 'userId', code: 'unknown_field' }],
        });
        expect(Object.keys(response.body as Record<string, unknown>).sort()).toEqual(['details', 'error']);
    });
});


describe('a plan the caller does not own leaks nothing through its lifecycle either', () => {
    /**
     * A week each tenant has already replaced: stored `superseded`, still
     * readable by its owner for history, and refused to its owner with
     * `409 plan_not_active` on every write (§0.5.1).
     *
     * That 409 is exactly why this case exists. It is the RIGHT answer for the
     * owner and a disclosure for anybody else — "this plan exists, it is just
     * not active" — so the refusal a stranger gets has to be the same 404 an
     * absent plan gets, not the state their own plan would have earned. A
     * handler that checked the lifecycle before the ownership predicate would
     * pass every other case in this file and fail here.
     */
    const seedSupersededWeek = async (userId: keyof typeof TENANT_PROFILES, active: string) => {
        const superseded = await makePlan(userId, {
            startDate: PLAN_START_DAY_KEY,
            dayCount: 1,
            status: 'superseded',
            slots: [{ slot: 'breakfast', slot_time: '08:00', recipeVersionId: catalog.breakfast.id }],
        });

        // The link production writes on the plan that did the replacing, so the
        // owner's refusal can name where their week went.
        await prisma.meal_plans.update({
            where: { id: active },
            data: { replaced_plan_id: superseded.id },
        });

        return superseded.id;
    };

    it('tells the owner their week was replaced, and tells nobody else it exists', async () => {
        const supersededOfA = await seedSupersededWeek(USER_A, a.plan.id);
        const supersededOfB = await seedSupersededWeek(USER_B, b.plan.id);
        const uncheckAll = ROUTE_CASES.find(
            (routeCase) =>
                routeCase.declaration === 'POST /meal-planning/plans/:planId/groceries/uncheck-all',
        );

        if (uncheckAll === undefined) {
            throw new Error('uncheck-all has no route case');
        }

        // The owner learns the state, which is what proves the id resolved.
        const owner = await sendAs(
            uncheckAll,
            `${planPath(supersededOfA)}/groceries/uncheck-all`,
            USER_A,
        ).expect(409);

        expect(owner.body).toMatchObject({ error: 'plan_not_active' });

        // A stranger learns nothing — not the state, and not that there is
        // anything to have a state.
        const refusal = await sameRefusal(
            sendAs(uncheckAll, `${planPath(supersededOfB)}/groceries/uncheck-all`, USER_A),
            sendAs(uncheckAll, pathFor(uncheckAll, 'missing'), USER_A),
            404,
        );

        expect(refusal.body).toEqual(PLAN_NOT_FOUND_BODY);
    });

    it('keeps a superseded week readable by its owner and invisible to everyone else', async () => {
        const supersededOfB = await seedSupersededWeek(USER_B, b.plan.id);
        const planDay = ROUTE_CASES.find(
            (routeCase) => routeCase.declaration === 'GET /meal-planning/plans/:planId/days/:date',
        );

        if (planDay === undefined) {
            throw new Error('the plan-day read has no route case');
        }

        // Reads survive the lifecycle by design — a diary entry logged from a
        // replaced week still has to be explainable (§0.5.1).
        const owner = await asUser(
            request.get(`/api/meal-planning/plans/${supersededOfB}/days/${PLAN_START_DAY_KEY}`),
            { uid: USER_B },
        ).expect(200);

        expect(owner.body).toMatchObject({ planId: supersededOfB, planStatus: 'superseded' });

        const refusal = await sameRefusal(
            asUser(
                request.get(`/api/meal-planning/plans/${supersededOfB}/days/${PLAN_START_DAY_KEY}`),
                { uid: USER_A },
            ),
            sendAs(planDay, pathFor(planDay, 'missing'), USER_A),
            404,
        );

        expect(refusal.body).toEqual(PLAN_NOT_FOUND_BODY);
    });
});

describe('a body-borne resource id is judged as strictly as a path one', () => {
    it('refuses a swap onto a candidate it never offered exactly as onto one that does not exist', async () => {
        // `recipeVersionId` arrives in the BODY, and recipes are shared, so the
        // question is not whose it is but whether this meal was ever offered it.
        // The two classes — a real recipe that is not a candidate for this slot,
        // and an id naming nothing — must still be one answer, because the
        // difference between them is information about the catalog and the
        // caller's own plan that the refusal has no business carrying.
        const swap = ROUTE_CASES.find(
            (routeCase) => routeCase.declaration === 'POST /meal-planning/plans/:planId/meals/:mealId/swap',
        );

        if (swap === undefined) {
            throw new Error('the swap commit has no route case');
        }

        const path = `/api${swap.own()}`;
        const refusal = await sameRefusal(
            asUser(request.post(path), { uid: USER_A }).send(swapBody(catalog.dinner.id)),
            asUser(request.post(path), { uid: USER_A }).send(swapBody(missingId())),
            422,
        );

        expect(refusal.body).toEqual({ error: 'recipe_ineligible' });
        expect(
            (await prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: a.breakfast.id } }))
                .recipe_version_id,
        ).toBe(catalog.breakfast.id);
    });

    it('refuses a dislike of a food the catalog does not publish, and stores none of the list', async () => {
        // `dislikedFoodIds` is the other body-borne id in the request DTOs. The
        // ids name shared catalog rows, so there is no tenant to leak — what
        // matters is that an id the catalog cannot resolve is refused by name
        // instead of being stored on the caller's own row.
        const response = await asUser(request.put('/api/meal-planning/preferences/steps/dislikes'), {
            uid: USER_A,
        })
            .send({
                dislikedFoodIds: [catalog.food.id, missingId()],
                timeZone: 'UTC',
                expectedRevision: TENANT_PROFILES[USER_A].revision,
            })
            .expect(400);

        expect(response.body).toEqual({
            error: 'invalid_request',
            details: [{ field: 'dislikedFoodIds[1]', code: 'unknown_value' }],
        });

        // Not even the half that resolved: a refused save writes nothing.
        expect(
            await prisma.meal_plan_preferences.findUniqueOrThrow({
                where: { user_id: USER_A },
                select: { disliked_food_ids: true, revision: true },
            }),
        ).toEqual({ disliked_food_ids: [], revision: TENANT_PROFILES[USER_A].revision });
    });
});

