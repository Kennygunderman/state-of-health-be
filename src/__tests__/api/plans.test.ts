// The HTTP integration suite for the five plan routes (Agent Action Plan
// §0.5.2's plan rows, §0.5.1's write-safety model, §0.9.2's plan scenarios), and
// the enforcing proof for `src/services/mealPlan.mapper.ts`, which has no logic
// test of its own.
//
//   POST /api/meal-planning/plans
//   GET  /api/meal-planning/plans/current
//   GET  /api/meal-planning/plans/:planId/days/:date
//   GET  /api/meal-planning/plans/:planId/affected-meals
//   POST /api/meal-planning/plans/:planId/regenerate
//
// THE MAPPER IS THIS FILE'S SECOND SUBJECT, and not by preference. Rule 7 §11's
// testing table admits a mapper "unit-testable if non-trivial; otherwise covered
// by integration", and `mealPlan.mapper.ts` names `api/{plans,swaps,log}.test.ts`
// as its verifiers. Every field it DERIVES rather than copies is pinned below —
// the logged-entry ordering and its tiebreaker, the recipe name each entry
// reports, the logged and logged-then-swapped states, `previousRecipe`,
// `targetsStale`, `isLastDay`, `portionText`, the flag round trip, the day-key
// formatting, `summary`, the pinned provenance literal and the clock ordering of
// a day's meals. Those cases build their worlds with `makePlan` and read them
// back through the routes, because a derived field is only worth pinning where a
// client would actually see it.
//
// WHAT THIS SUITE DOES NOT OWN. Every boundary here is deliberate, and crossing
// one would duplicate a neighbour rather than add coverage:
//
//   * `services/__tests__/mealPlan.logic.test.ts` owns the GENERATOR as a pure
//     function — the seeded candidate pre-order, `scoreCandidate`, the DFS and
//     its tie / greedy-dead-end / week-level / budget-exhaustion fixtures,
//     `satisfiesDayTolerance`, the repetition rule and every
//     `analyzeLimitingConstraints` verdict. Rule §11: a rule that needs a
//     database to test is in the wrong layer. What is asserted here is that the
//     search's outcome is PERSISTED and REPORTED correctly — the rows it writes,
//     the status it maps to, and the typed shape of the 422 it produces.
//   * `api/planDayWriteability.test.ts` owns the day envelope's lifecycle × zone
//     matrix (`planLifecycle`, `isWritable`). This file asserts only the
//     route-level contract of that envelope.
//   * `api/ownership.test.ts` owns the exhaustive tenancy matrix. This file
//     carries the local proof that a foreign and an absent plan id are
//     indistinguishable, because it is a property of these routes' own 404.
//   * `api/fault.test.ts` owns the POST-COMMIT abort seam. The DECODED
//     `generation` fault this file arms throws BEFORE the transaction opens, by
//     design (§0.9.4), so it proves the pre-transaction path and nothing else;
//     the cases that need a publication to fail once the week is already
//     written reach that moment through the transaction's own grocery step —
//     see "the publication transaction's own seam" below.
//   * `api/grocery.test.ts` owns the grocery diff and its flags. This file
//     asserts only what a REGENERATION does to the list: an unchanged line keeps
//     its check mark.
//   * `api/targets.test.ts` owns the targets truth matrix. This file asserts
//     only the publication linkage — which target states refuse a week.
//
// WHICH LAYER EACH CASE DRIVES, AND WHY THE SPLIT EXISTS. The default is HTTP
// through `request` from `../setup/testApp`, which drives the shipped `app.ts`
// with its real mount order; identity arrives in `x-test-user-id`, so a handler
// still learns the caller only through `getUserId(req)` (Rule §4). The
// controller passes NO clock to its services, so a request always reads the real
// one. The handful of cases whose SUBJECT is the calendar — the start-date bound
// in a zone ahead of UTC, and a week that has ended — therefore call the service
// directly with an injected `now`, exactly as `planDayWriteability.test.ts` and
// `api/fault.test.ts` do. Asserting a zone rule through HTTP would mean asserting
// it about whatever hour the suite happens to run in, which is the opposite of a
// test.
//
// HOW EVERY OTHER CASE STAYS HOUR-INDEPENDENT. The users these routes are driven
// as store `time_zone: 'UTC'`, so the server's "today" equals
// `utcTodayDayKey()` at every instant of the day. With a stored zone behind UTC
// — `makePreferences`' own default — a plan starting on UTC's today is `current`
// for most of the day and `upcoming` between 00:00 and 05:00 UTC, and a suite
// built on that would fail five hours in twenty-four. Weeks that must be over
// are pinned to `FIXTURE_ENDED_PLAN_START_DAY_KEY`, a fixed past date that stays
// past. Factory `sequence` and `slug` values are stated rather than allowed to
// default, because `factories.ts` mints them from a module-global counter that
// would otherwise hand a rebuilt world different identities — which the
// determinism case at the end depends on.
//
// TWO FIXTURE DETAILS THAT ARE REQUIREMENTS RATHER THAN TASTE. The shared
// catalog food's default portion is stated in GRAMS rather than left at
// `makeCatalogFood`'s own "1 cup". Either publishes: a volume portion with a
// null `density_g_per_ml` is NOT refused, because `grocery.logic.ts` derives the
// density from the portion itself (200 g to the cup) and degrades a food that
// can state neither to mass rather than failing. What the choice fixes is what
// the row then holds — grams make the week's one line a MASS line, whose stored
// `display_unit` the post-write rollback case below invalidates and then
// restores. And every recipe in a generator world shops for the SAME
// food, so the published grocery list is one row whose quantity does not depend
// on which recipes the seed chose; that is what makes the regeneration
// carry-over assertion measure the carry-over rather than the seed.
//
// THE FAULT AND FLAG SEAMS ARE SPIED, NOT ASSIGNED. `utils/featureFlags.ts`
// resolves `MEAL_PLANNING_ENABLED` and `MEAL_PLANNING_FAULT` once at import
// (Rule §9), so assigning `process.env` mid-suite changes nothing and a case
// that trusted the assignment would silently assert the unfaulted path. The
// accessors are plain properties of the module's exports and every caller reads
// them at call time, so `jest.spyOn` reaches the graph `app.ts` already holds —
// no module isolation, and the shared supertest agent keeps working. Each spy is
// restored in the case that installed it, so a neighbouring suite under
// `--runInBand` is unaffected.
//
// Offline by construction: `jestSetup.ts` deletes the vendor keys and planning
// makes no request-time vendor call. A case here that reached USDA or OpenRouter
// would be mis-scoped.

import { randomUUID } from 'node:crypto';

import type { Prisma } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import * as groceryService from '../../services/grocery.service';
// The repetition cap is READ from the policy module rather than restated: the
// rows asserted below have to honour the number the generator actually enforces,
// and a literal `2` here would keep passing if the policy ever moved.
import { MAX_RECIPE_USES_PER_WEEK } from '../../services/mealPlan.logic';
import {
    generatePlan,
    getAffectedMeals,
    getCurrentMealPlan,
    getMealPlanDay,
    regeneratePlan,
} from '../../services/mealPlan.service';
import type {
    AffectedMealsResponse,
    CurrentMealPlanResponse,
    LimitingConstraint,
    MealFlag,
    MealPlanDayEnvelopeResponse,
    MealPlanDayResponse,
    MealPlanMealResponse,
    MealPlanResponse,
} from '../../types/mealPlanning';
import { MEAL_SLOTS, RECIPE_BADGES, RECIPE_ICON_KEYS } from '../../types/recipe';
import * as featureFlags from '../../utils/featureFlags';
import { UnitConversionError } from '../../utils/units';
import {
    FIXTURE_ENDED_PLAN_START_DAY_KEY,
    FIXTURE_TARGETS,
    FIXTURE_USER_TARGET_COLUMNS,
    FixtureRecipeVersion,
    MakePreferencesOptions,
    addDaysToDayKey,
    currentPlanStartDayKey,
    makeCatalogFood,
    makePlan,
    makePreferences,
    makeRecipeVersion,
    makeUser,
    utcTodayDayKey,
} from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

/* ---------------------------------------------------------------------------
 * The world, stated once
 * ------------------------------------------------------------------------- */

/** The caller nearly every case acts as. */
const USER_ID = 'plans-suite-user';

/** The other tenant, whose rows must never move and whose ids must read as absent. */
const OTHER_USER_ID = 'plans-suite-other-user';

/**
 * The zone every HTTP fixture stores, for the reason the header gives: it makes
 * the server's "today" equal `utcTodayDayKey()` at every hour, which a route
 * that cannot be handed a clock otherwise has no way to guarantee.
 */
const PLAN_TIME_ZONE = 'UTC';

/** A published week is seven days — asserted as a literal, never read from the code under test. */
const PLAN_DAY_COUNT = 7;

/** The three-meal schedule's slot count, and the four-meal one's. */
const MEALS_PER_DAY = 3;
const MEALS_PER_DAY_WITH_SNACK = 4;

/** §0.5.2's start-date horizon: today + 30 days, unless a current plan pushes it out. */
const START_DATE_HORIZON_DAYS = 30;

/** `meal_plans.revision` and `generation_attempt` on a first publication. */
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;

/**
 * Enough recipes for a seven-day week under the repeat rule (at most two uses,
 * never on consecutive days), with room to spare over
 * `MIN_ELIGIBLE_RECIPES_PER_SLOT`.
 */
const PLANNABLE_RECIPE_COUNT = 12;

/**
 * Per-100 g values for a single 400 g ingredient over a two-serving yield:
 * `400 × per100g ÷ 100 ÷ 2` collapses to `2 × per100g`, so every generator
 * recipe is 700 kcal / 52 P / 70 C / 23 F per serving. Three of them land a day
 * on `FIXTURE_TARGETS` (2,100 / 158 / 210 / 70) well inside §0.7.3's bands.
 */
const PER_100G = { calories: 350, protein_g: 26, carbs_g: 35, fat_g: 11.5, fiber_g: 0 };

const INGREDIENT_GRAM_WEIGHT = 400;

/** `gram_weight ÷ yield_servings` — the grams one planned serving shops for. */
const GRAMS_PER_SERVING = 200;

/** Pinned factory identities, so a rebuilt world is identical rather than merely similar. */
const SHARED_FOOD_SEQUENCE = 400;
const PLANNABLE_RECIPE_SEQUENCE_BASE = 410;
const MAPPER_FOOD_SEQUENCE = 450;
const MAPPER_RECIPE_SEQUENCE_BASE = 460;

/** A well-formed UUID v4 that names nothing, for the "absent id" half of the 404 proof. */
const ABSENT_PLAN_ID = '00000000-0000-4000-8000-000000000000';

jest.setTimeout(120_000);

/* ---------------------------------------------------------------------------
 * Fixture builders — LOCAL, per Rule §7.1
 *
 * Shared test infrastructure lives in `../setup`, which this file does not own,
 * and a helper module in this directory for one suite's world is the ceremony
 * §7.1 warns against. Everything below is used by cases in this file alone.
 * ------------------------------------------------------------------------- */

/**
 * The shared catalog food every fixture recipe shops for, portioned in GRAMS.
 *
 * The unit matters: see the header. A volume portion without a density makes
 * every generated week fail in the grocery writer.
 */
const seedSharedFood = (sequence: number) =>
    makeCatalogFood({
        sequence,
        defaultPortion: { description: '100 g', amount: 100, unit: 'g', gram_weight: 100 },
    });

interface RecipeSeedOptions {
    /** The slots the recipe declares. A snack schedule needs `snack` among them. */
    readonly slots?: readonly string[];
    /** Allergens the ingredient snapshot carries, for the flagging cases. */
    readonly allergenTags?: readonly string[];
    /** Total prep + cook minutes, for the cooking-time cases. */
    readonly prepMinutes?: number;
    readonly cookMinutes?: number;
}

/** One plannable recipe version: current, source-backed, allergen-known by derivation. */
const seedRecipe = (
    foodId: string,
    sequence: number,
    slug: string,
    options: RecipeSeedOptions = {},
): Promise<FixtureRecipeVersion> =>
    makeRecipeVersion({
        sequence,
        slug,
        catalogFoodId: foodId,
        meal_slots: [...(options.slots ?? ['breakfast', 'lunch', 'dinner'])],
        prep_minutes: options.prepMinutes ?? 10,
        cook_minutes: options.cookMinutes ?? 15,
        ingredients: [
            {
                catalogFoodId: foodId,
                per100g: PER_100G,
                gram_weight: INGREDIENT_GRAM_WEIGHT,
                ...(options.allergenTags === undefined
                    ? {}
                    : { snapshot_allergen_tags: [...options.allergenTags] }),
            },
        ],
    });

interface GeneratorWorld {
    readonly foodId: string;
    readonly recipes: FixtureRecipeVersion[];
}

/**
 * A user who can publish a week: complete preferences, confirmed targets that
 * match them, and a catalog wide enough for the search to close seven days.
 */
const seedGeneratorWorld = async (
    userId: string,
    preferences: MakePreferencesOptions = {},
    recipes: RecipeSeedOptions = {},
): Promise<GeneratorWorld> => {
    await makeUser({ id: userId, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(userId, { time_zone: PLAN_TIME_ZONE, ...preferences });

    const food = await seedSharedFood(SHARED_FOOD_SEQUENCE);
    const seeded: FixtureRecipeVersion[] = [];

    for (let index = 0; index < PLANNABLE_RECIPE_COUNT; index += 1) {
        seeded.push(
            await seedRecipe(
                food.id,
                PLANNABLE_RECIPE_SEQUENCE_BASE + index,
                `plans-suite-recipe-${index}`,
                recipes,
            ),
        );
    }

    return { foodId: food.id, recipes: seeded };
};

/**
 * A user with preferences and one published week already in place, built without
 * running the generator.
 *
 * The mapper cases and the read routes want a week to exist, not a search to
 * have happened, and `makePlan` writes one in a single transaction whose
 * planned nutrition is its recipe's own figures scaled by the slot multiplier.
 */
const seedPlannedWeek = async (
    userId: string,
    options: {
        readonly startDate?: string;
        readonly slots?: readonly { slot: string; slot_time: string; portion_multiplier?: number }[];
        readonly recipeOptions?: RecipeSeedOptions;
        readonly preferences?: MakePreferencesOptions;
        readonly planOverrides?: Partial<Prisma.meal_plansUncheckedCreateInput>;
        readonly sequence?: number;
    } = {},
) => {
    await makeUser({ id: userId, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(userId, { time_zone: PLAN_TIME_ZONE, ...options.preferences });

    const sequence = options.sequence ?? MAPPER_FOOD_SEQUENCE;
    const food = await seedSharedFood(sequence);
    const recipe = await seedRecipe(
        food.id,
        MAPPER_RECIPE_SEQUENCE_BASE + sequence,
        `plans-suite-planned-${sequence}`,
        options.recipeOptions,
    );

    const plan = await makePlan(userId, {
        sequence,
        recipeVersionId: recipe.id,
        ...(options.startDate === undefined ? {} : { startDate: options.startDate }),
        ...(options.slots === undefined ? {} : { slots: [...options.slots] }),
        ...options.planOverrides,
    });

    return { food, recipe, plan };
};

/* ---------------------------------------------------------------------------
 * Requests
 * ------------------------------------------------------------------------- */

const PLANS_PATH = '/api/meal-planning/plans';

interface GenerateBodyOverrides {
    readonly startDate?: string;
    readonly idempotencyKey?: string;
    readonly expectedPreferencesRevision?: number;
    readonly expectedTargetsRevision?: number;
}

/** A well-formed generation body. Every field is required, so each is stated. */
const generateBody = (overrides: GenerateBodyOverrides = {}): Record<string, unknown> => ({
    startDate: overrides.startDate ?? utcTodayDayKey(),
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    expectedPreferencesRevision: overrides.expectedPreferencesRevision ?? 1,
    expectedTargetsRevision: overrides.expectedTargetsRevision ?? 1,
});

/** A well-formed regeneration body; it carries no start date by design (§0.5.1). */
const regenerateBody = (
    overrides: {
        readonly idempotencyKey?: string;
        readonly expectedPlanRevision?: number;
        readonly expectedPreferencesRevision?: number;
        readonly expectedTargetsRevision?: number;
    } = {},
): Record<string, unknown> => ({
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    expectedPlanRevision: overrides.expectedPlanRevision ?? FIRST_REVISION,
    expectedPreferencesRevision: overrides.expectedPreferencesRevision ?? 1,
    expectedTargetsRevision: overrides.expectedTargetsRevision ?? 1,
});

/**
 * A request body as superagent's `send` takes it. `object` rather than a typed
 * payload on purpose: several cases below send deliberately malformed bodies,
 * which is the whole point of the validation section.
 */
type RequestBody = Record<string, unknown>;

const postPlan = (body: RequestBody, userId: string = USER_ID) =>
    asUser(request.post(PLANS_PATH).send(body), { uid: userId });

const postRegenerate = (planId: string, body: RequestBody, userId: string = USER_ID) =>
    asUser(request.post(`${PLANS_PATH}/${planId}/regenerate`).send(body), { uid: userId });

const getCurrent = (userId: string = USER_ID) =>
    asUser(request.get(`${PLANS_PATH}/current`), { uid: userId });

const getDay = (planId: string, dayKey: string, userId: string = USER_ID) =>
    asUser(request.get(`${PLANS_PATH}/${planId}/days/${dayKey}`), { uid: userId });

const getAffected = (planId: string, userId: string = USER_ID) =>
    asUser(request.get(`${PLANS_PATH}/${planId}/affected-meals`), { uid: userId });

/* ---------------------------------------------------------------------------
 * Response narrowing and stored-row readers
 *
 * Every direct read and write below carries the OWNER KEY, the same predicate
 * Rule §5.1 requires of the services themselves. A fixture holds ids it created
 * a line earlier, so an id-only `where` would be safe here — carrying `user_id`
 * anyway keeps the file from teaching the pattern §5.1 forbids, and makes a
 * fixture that accidentally reached across tenants fail instead of succeed.
 * ------------------------------------------------------------------------- */

const asPlan = (body: unknown): MealPlanResponse => body as MealPlanResponse;

const asCurrent = (body: unknown): CurrentMealPlanResponse => body as CurrentMealPlanResponse;

const asEnvelope = (body: unknown): MealPlanDayEnvelopeResponse => body as MealPlanDayEnvelopeResponse;

const asAffected = (body: unknown): AffectedMealsResponse => body as AffectedMealsResponse;

const asErrorBody = (body: unknown): Record<string, unknown> => body as Record<string, unknown>;

/** A day of a plan response, named rather than indexed, so a failure says which. */
const dayOn = (plan: MealPlanResponse, dayKey: string): MealPlanDayResponse => {
    const day = plan.days.find((candidate) => candidate.date === dayKey);

    if (day === undefined) {
        throw new Error(`plan ${plan.id} has no day ${dayKey}; it holds ${plan.days.map((d) => d.date).join(', ')}`);
    }

    return day;
};

/** One slot of a day, likewise. */
const mealIn = (day: MealPlanDayResponse, slot: string): MealPlanMealResponse => {
    const meal = day.meals.find((candidate) => candidate.slot === slot);

    if (meal === undefined) {
        throw new Error(`day ${day.date} has no ${slot}; it holds ${day.meals.map((m) => m.slot).join(', ')}`);
    }

    return meal;
};

const storedPlans = (userId: string = USER_ID) =>
    prisma.meal_plans.findMany({ where: { user_id: userId }, orderBy: [{ start_date: 'asc' }, { id: 'asc' }] });

const storedPlan = (planId: string) => prisma.meal_plans.findUniqueOrThrow({ where: { id: planId } });

const storedDays = (planId: string) =>
    prisma.meal_plan_days.findMany({ where: { meal_plan_id: planId }, orderBy: { day_index: 'asc' } });

const storedMeals = (planId: string) =>
    prisma.meal_plan_meals.findMany({
        where: { meal_plan_id: planId },
        orderBy: [{ meal_plan_days: { date: 'asc' } }, { sort_order: 'asc' }],
    });

const storedGroceries = (planId: string) =>
    prisma.grocery_items.findMany({ where: { meal_plan_id: planId }, orderBy: { sort_order: 'asc' } });

const storedActions = (userId: string = USER_ID) =>
    prisma.meal_plan_actions.findMany({ where: { user_id: userId }, orderBy: { created_at: 'asc' } });

const storedSetupStatus = async (userId: string = USER_ID): Promise<string> =>
    (
        await prisma.meal_plan_preferences.findUniqueOrThrow({
            where: { user_id: userId },
            select: { setup_status: true },
        })
    ).setup_status;

/**
 * A diary bucket for a day, written directly.
 *
 * The diary is not this suite's subject — `api/log.test.ts` drives the real
 * logging route — and the mapper cases need control over `logged_at` that no
 * route offers, so the rows are created here and every assertion is about what
 * the PLAN routes then report of them.
 */
const seedDiaryBucket = (userId: string, dayKey: string, name = 'Breakfast') =>
    prisma.meals.create({ data: { user_id: userId, date: new Date(`${dayKey}T00:00:00.000Z`), name } });

interface DiaryEntrySeed {
    readonly userId?: string;
    readonly mealId: string;
    readonly dayKey: string;
    readonly plannedMealId: string;
    readonly recipeVersionId: string | null;
    readonly loggedAt: Date;
    readonly servings?: number;
    readonly name?: string;
    readonly deletedAt?: Date | null;
}

/** One linked diary entry, with its instant and its recipe stated by the caller. */
const seedDiaryEntry = (seed: DiaryEntrySeed) =>
    prisma.meal_entries.create({
        data: {
            meal_id: seed.mealId,
            user_id: seed.userId ?? USER_ID,
            date: new Date(`${seed.dayKey}T00:00:00.000Z`),
            name: seed.name ?? 'Planned meal',
            servings: seed.servings ?? 1,
            calories: 700,
            protein_g: 52,
            carbs_g: 70,
            fat_g: 23,
            input_method: 'meal_plan',
            logged_at: seed.loggedAt,
            deleted_at: seed.deletedAt ?? null,
            meal_plan_meal_id: seed.plannedMealId,
            recipe_version_id: seed.recipeVersionId,
            nutrition_provenance: 'source_backed',
        },
    });

/** `meal_plan_meals.flags` as the column takes it. */
const asJsonFlags = (flags: readonly MealFlag[]): Prisma.InputJsonValue =>
    flags as unknown as Prisma.InputJsonValue;

/* ---------------------------------------------------------------------------
 * The publication transaction's own seam — failing AFTER the week is written
 *
 * §0.5.1's "a failed generation persists nothing" is a claim about a specific
 * moment: the plan, its seven days and their meals inserted, the old week
 * superseded on a regeneration, and the commit then abandoned. The decoded
 * `generation` fault cannot reach that moment — §0.9.4 fixes it after the
 * in-memory search and BEFORE `prisma.$transaction`, which is the whole point of
 * it — so the two seams below do, and neither alters the code under test:
 *
 *  * REAL DATA. The list is built inside the transaction from the meals as
 *    STORED, so the week can be assembled from a recipe carrying a defect the
 *    search never looks at (`grocery.logic.ts` refuses a non-positive
 *    ingredient gram weight, and the planning projection does not read gram
 *    weights at all), and a regeneration's carry-over can meet a stored row
 *    whose `display_unit` no longer names a unit family. Both raise the grocery
 *    domain's own error classes, which `mealPlan.service.ts` translates into
 *    `PlanGenerationError` — so the route still answers §0.5.2's only 5xx, and
 *    a 500 would mean the translation had been lost. The same taste as
 *    `api/swaps.test.ts`'s "rebuild fails after the meal has been written".
 *  * THE WRITER ITSELF, WRITTEN THEN THROWN, for the one state real data cannot
 *    reach: the grocery rows inserted as well. `writePlanGroceryRows` is spied
 *    with an implementation that awaits the REAL function and then throws, so
 *    everything a publication writes genuinely exists in the transaction that
 *    is about to be abandoned.
 *
 * Each is restored by the case that installed it, like every other spy here.
 * ------------------------------------------------------------------------- */

/** What the publication had already written when the grocery step began. */
interface PublicationWriteObservation {
    /** How many `meal_plan_meals` rows the new plan already holds. */
    readonly plannedMeals: number;
    /** The user's plan statuses, sorted, so a supersede that happened is visible. */
    readonly planStatuses: string[];
    /** The user's grocery rows — the old plan's list, on a regeneration. */
    readonly groceryRows: number;
}

/**
 * Records what the publication transaction can already see, immediately before
 * it builds the grocery list.
 *
 * AN OBSERVER, NOT A STUB: it calls the real loader, reads three counts through
 * the transaction's own client, and returns the loader's result untouched. It is
 * what separates the two readings of an empty database after a 502 — "wrote the
 * week and rolled it back" from "never wrote it at all" — which is the whole
 * distinction a post-write rollback proof rests on. A real-data fault leaves no
 * trace of its own, so without this reading the assertion would be satisfied by
 * a service that refused before opening the transaction.
 *
 * `loadPlannedMealsForGroceries` is where it belongs: `mealPlan.service.ts`
 * calls it with the transaction client as the first statement of the grocery
 * step, by which point the plan, its days and its meals are inserted and, on a
 * regeneration, the old plan is already superseded.
 */
const observePublicationWrites = (userId: string = USER_ID) => {
    const observations: PublicationWriteObservation[] = [];
    const loadPlannedMeals = groceryService.loadPlannedMealsForGroceries;
    const spy = jest
        .spyOn(groceryService, 'loadPlannedMealsForGroceries')
        .mockImplementation(async (tx, owner, planId) => {
            const meals = await loadPlannedMeals(tx, owner, planId);
            const plans = await tx.meal_plans.findMany({
                where: { user_id: userId },
                select: { status: true },
            });

            observations.push({
                plannedMeals: meals.length,
                planStatuses: plans.map((plan) => plan.status).sort(),
                groceryRows: await tx.grocery_items.count({ where: { user_id: userId } }),
            });

            return meals;
        });

    return { observations, restore: () => spy.mockRestore() };
};

/**
 * Makes the grocery write insert the list and then abandon the commit.
 *
 * The real writer runs first and its report is kept, so the case can state that
 * the rows existed rather than assume it. `UnitConversionError` is thrown
 * because the CLASS is what `mealPlan.service.ts` recognises as a grocery
 * rendering fault and translates into `PlanGenerationError`; the message is only
 * for the server log. Throwing an unrecognised class would be a different test —
 * it would assert the 500 that an untranslated fault earns.
 */
const failAfterGroceryRowsAreWritten = () => {
    const insertedBeforeTheThrow: number[] = [];
    const writeRows = groceryService.writePlanGroceryRows;
    const spy = jest
        .spyOn(groceryService, 'writePlanGroceryRows')
        .mockImplementation(async (tx, params) => {
            const written = await writeRows(tx, params);

            insertedBeforeTheThrow.push(written.insertedCount);

            throw new UnitConversionError(
                'injected by api/plans.test.ts after the grocery rows were written, to abandon the commit',
            );
        });

    return { spy, insertedBeforeTheThrow };
};

beforeEach(async () => {
    await truncateFeatureTables();
});

afterAll(async () => {
    await truncateFeatureTables();
});


/* ---------------------------------------------------------------------------
 * POST /api/meal-planning/plans — publishing a week
 * ------------------------------------------------------------------------- */

describe('POST /api/meal-planning/plans', () => {
    describe('publishing a week', () => {
        it('answers 201 with the published plan and writes it whole', async () => {
            // `ready_for_review` rather than `completed`, so the transition
            // §0.5.2 assigns to this route is observable rather than a no-op.
            await seedGeneratorWorld(USER_ID, { setup_status: 'ready_for_review' });

            const startDate = utcTodayDayKey();
            const idempotencyKey = randomUUID();
            const response = await postPlan(generateBody({ startDate, idempotencyKey })).expect(201);
            const plan = asPlan(response.body);

            expect(plan).toMatchObject({
                revision: FIRST_REVISION,
                generationAttempt: FIRST_ATTEMPT,
                startDate,
                endDate: addDaysToDayKey(startDate, PLAN_DAY_COUNT - 1),
                status: 'active',
                targets: FIXTURE_TARGETS,
                generationTargets: FIXTURE_TARGETS,
                targetsStale: false,
                preferencesRevision: 1,
                targetsRevision: 1,
                hasIncompatibilities: false,
            });
            expect(plan.days).toHaveLength(PLAN_DAY_COUNT);
            expect(plan.summary).toEqual({
                plannedMeals: PLAN_DAY_COUNT * MEALS_PER_DAY,
                groceryItemCount: 1,
                loggedEntryCount: 0,
            });

            // The rows, read directly: the response could be right about a plan
            // the database does not hold.
            const plans = await storedPlans();

            expect(plans).toHaveLength(1);
            expect(plans[0]).toMatchObject({
                id: plan.id,
                status: 'active',
                revision: FIRST_REVISION,
                generation_attempt: FIRST_ATTEMPT,
                // §0.5.1: the key IS the generation key, which is what makes a
                // committed publication findable by the intent that produced it.
                generation_key: idempotencyKey,
                replaced_plan_id: null,
            });

            const days = await storedDays(plan.id);

            expect(days).toHaveLength(PLAN_DAY_COUNT);
            expect(days.map((day) => day.day_index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
            expect(days.map((day) => day.date.toISOString().slice(0, 10))).toEqual(
                Array.from({ length: PLAN_DAY_COUNT }, (_unused, index) => addDaysToDayKey(startDate, index)),
            );

            const meals = await storedMeals(plan.id);

            expect(meals).toHaveLength(PLAN_DAY_COUNT * MEALS_PER_DAY);
            for (const day of days) {
                expect(meals.filter((meal) => meal.meal_plan_day_id === day.id)).toHaveLength(MEALS_PER_DAY);
            }

            // Written by the same transaction as the plan; the other half of
            // that claim is the fault case below, where a refused generation
            // leaves neither.
            const groceries = await storedGroceries(plan.id);

            expect(groceries).toHaveLength(1);
            expect(groceries[0]?.user_id).toBe(USER_ID);

            expect(await storedSetupStatus()).toBe('completed');
        });

        it('records the publication in the ledger with the status it answered', async () => {
            await seedGeneratorWorld(USER_ID);

            const idempotencyKey = randomUUID();
            const response = await postPlan(generateBody({ idempotencyKey })).expect(201);
            const actions = await storedActions();

            expect(actions).toHaveLength(1);
            expect(actions[0]).toMatchObject({
                action_type: 'generate',
                idempotency_key: idempotencyKey,
                // Persisted, never inferred (§0.5.1), which is what lets a replay
                // answer with the status the first attempt answered.
                response_status: 201,
                plan_revision_after: FIRST_REVISION,
                meal_plan_id: asPlan(response.body).id,
            });
        });

        it('attaches every meal to the day of its own date, and spaces the week as §0.7.3 requires', async () => {
            // TWO CLAIMS ABOUT THE ROWS A PUBLICATION LEAVES, both of which the
            // response alone cannot make: it groups meals under days by reading
            // these same rows back, so a week whose meals hung off the wrong day
            // would be reported exactly as consistently as a correct one.
            //
            // The first is the parentage the batched insert establishes. Plan,
            // days and meals go in as three statements — one `create`, one
            // `createManyAndReturn` for the seven days, one `createMany` for the
            // week's meals — and the meals find their parent through a map keyed
            // by the day's DATE rather than by the position the bulk insert
            // reported. What makes a mis-keyed map visible is the repetition rule
            // itself: it forbids a recipe on consecutive days, so two adjacent
            // days can never legitimately share one, and a day's meals landing on
            // its neighbour's row would show up here as a week that repeats
            // across a day boundary.
            //
            // The second is that rule as PERSISTED: at most
            // `MAX_RECIPE_USES_PER_WEEK` uses across the week and never on
            // consecutive days — §0.7.3's two clauses and, since the generator no
            // longer adds an unwritten same-day ban, all of them. Whether the
            // search finds a week needing a recipe twice in ONE day is
            // `mealPlan.logic.test.ts`'s subject; what is asserted here is that
            // the week it did find is stored spaced and capped.
            await seedGeneratorWorld(USER_ID);

            const startDate = utcTodayDayKey();
            const plan = await publishWeek({ startDate });
            const days = await storedDays(plan.id);
            const meals = await storedMeals(plan.id);

            expect(days).toHaveLength(PLAN_DAY_COUNT);
            expect(meals).toHaveLength(PLAN_DAY_COUNT * MEALS_PER_DAY);

            // `storedDays` orders by date, so index arithmetic below is calendar
            // order and not insertion order.
            const recipesByDate = days.map((day) => {
                const dayKey = day.date.toISOString().slice(0, 10);
                const attached = meals.filter((meal) => meal.meal_plan_day_id === day.id);

                expect(dayKey).toBe(addDaysToDayKey(startDate, day.day_index));
                expect(attached).toHaveLength(MEALS_PER_DAY);
                // Every child row carries the plan and the owner beside its day,
                // which is the referencing side of the tenant foreign keys
                // (§5.1) and is written by the batch rather than row by row.
                for (const meal of attached) {
                    expect(meal.meal_plan_id).toBe(plan.id);
                    expect(meal.user_id).toBe(USER_ID);
                }
                expect([...attached].map((meal) => meal.sort_order).sort()).toEqual(
                    Array.from({ length: MEALS_PER_DAY }, (_unused, index) => index),
                );

                return attached.map((meal) => meal.recipe_version_id);
            });

            // Uses are counted per MEAL and spacing is compared per DAY, because
            // the two clauses count different things: the cap is on appearances
            // across the week (two of which §0.7.3 allows to fall on one day),
            // while "never on consecutive days" is about a day holding a recipe
            // at all.
            const usesByRecipeVersion = new Map<string, number>();

            recipesByDate.forEach((today, dayIndex) => {
                for (const recipeVersionId of today) {
                    usesByRecipeVersion.set(
                        recipeVersionId,
                        (usesByRecipeVersion.get(recipeVersionId) ?? 0) + 1,
                    );
                }

                if (dayIndex === 0) {
                    return;
                }

                const yesterday = new Set(recipesByDate[dayIndex - 1]);

                for (const recipeVersionId of today) {
                    expect(yesterday.has(recipeVersionId)).toBe(false);
                }
            });

            for (const uses of usesByRecipeVersion.values()) {
                expect(uses).toBeLessThanOrEqual(MAX_RECIPE_USES_PER_WEEK);
            }
        });

        it('plans every slot of the stored schedule at a portion the recipe describes', async () => {
            await seedGeneratorWorld(USER_ID);

            const startDate = utcTodayDayKey();
            const plan = asPlan((await postPlan(generateBody({ startDate })).expect(201)).body);
            const day = dayOn(plan, startDate);

            expect(day.meals.map((meal) => meal.slot)).toEqual(['breakfast', 'lunch', 'dinner']);
            for (const meal of day.meals) {
                // The multiplier set of §0.7.3, and a portion string rendered in
                // the recipe's own serving noun rather than an anonymous serving.
                expect([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]).toContain(meal.portionMultiplier);
                expect(meal.portionText).toMatch(/bowls?$/);
                expect(meal.recipe.nutritionProvenance).toBe('source_backed');
            }
        });
    });

    /* -----------------------------------------------------------------------
     * The ledger — §0.5.1's one replay policy
     * --------------------------------------------------------------------- */

    describe('the idempotency ledger', () => {
        it('replays the stored 201 and body verbatim for a repeated key', async () => {
            await seedGeneratorWorld(USER_ID);

            const body = generateBody();
            const first = await postPlan(body).expect(201);
            const second = await postPlan(body).expect(201);

            // The byte comparison §0.5.1 requires, guarded so it cannot pass on
            // two absent texts.
            expect(typeof first.text).toBe('string');
            expect(first.text.length).toBeGreaterThan(0);
            expect(second.text).toBe(first.text);
            expect(asPlan(second.body).id).toBe(asPlan(first.body).id);

            expect(await storedPlans()).toHaveLength(1);
            expect(await storedActions()).toHaveLength(1);
        });

        it('refuses the same key with a different body and writes nothing new', async () => {
            await seedGeneratorWorld(USER_ID);

            const idempotencyKey = randomUUID();
            const first = await postPlan(generateBody({ idempotencyKey })).expect(201);
            const conflict = await postPlan(
                generateBody({ idempotencyKey, startDate: addDaysToDayKey(utcTodayDayKey(), 7) }),
            ).expect(409);

            expect(asErrorBody(conflict.body)).toEqual({ error: 'idempotency_conflict' });

            const plans = await storedPlans();

            expect(plans).toHaveLength(1);
            expect(plans[0]?.id).toBe(asPlan(first.body).id);
            expect(await storedActions()).toHaveLength(1);
        });

        it('replays a committed key after the plan and the preferences have both moved on', async () => {
            await seedGeneratorWorld(USER_ID);

            const body = generateBody();
            const first = await postPlan(body).expect(201);
            const planId = asPlan(first.body).id;

            // Two things move, and each would refuse this request on its own:
            // another device's write bumps the plan's revision, and a preference
            // save bumps the revision the body pins.
            await prisma.meal_plans.update({
                where: { id: planId, user_id: USER_ID },
                data: { revision: { increment: 1 } },
            });
            await prisma.meal_plan_preferences.update({
                where: { user_id: USER_ID },
                data: { revision: { increment: 1 } },
            });

            const replay = await postPlan(body).expect(201);

            expect(replay.text).toBe(first.text);
            expect(await storedPlans()).toHaveLength(1);
            expect(await storedActions()).toHaveLength(1);

            // The other direction, so the replay above cannot pass because the
            // revision check is simply absent: the same stale pin under a NEW key
            // is refused.
            const refused = await postPlan(
                generateBody({ startDate: addDaysToDayKey(utcTodayDayKey(), 14) }),
            ).expect(409);

            expect(asErrorBody(refused.body)).toMatchObject({ error: 'stale_revision' });
        });
    });


    /* -----------------------------------------------------------------------
     * The stateful refusals
     * --------------------------------------------------------------------- */

    describe('the stateful refusals', () => {
        it('refuses a setup that has not reached review', async () => {
            await seedGeneratorWorld(USER_ID, { setup_status: 'in_progress', setup_step: 'diet' });

            const response = await postPlan(generateBody()).expect(409);

            expect(asErrorBody(response.body)).toEqual({ error: 'preferences_incomplete' });
            expect(await storedPlans()).toHaveLength(0);
        });

        it('names the unset target fields when the user has none', async () => {
            await seedGeneratorWorld(USER_ID);
            await prisma.users.update({
                where: { id: USER_ID },
                data: {
                    target_calories: null,
                    target_protein_g: null,
                    target_carbs_g: null,
                    target_fat_g: null,
                },
            });

            const response = await postPlan(generateBody()).expect(422);
            const body = asErrorBody(response.body);

            expect(body.error).toBe('targets_missing');
            expect(body.missing).toEqual(expect.arrayContaining(['calories', 'protein', 'carbs', 'fat']));
            expect(await storedPlans()).toHaveLength(0);
        });

        it('refuses targets nobody confirmed through the canonical writer', async () => {
            await seedGeneratorWorld(USER_ID);
            // The stored values no longer match `confirmed_targets`, which is the
            // shape a legacy `PUT /api/user/targets` leaves behind. The truth
            // matrix belongs to `api/targets.test.ts`; what matters here is that a
            // week is not built on it.
            await prisma.meal_plan_preferences.update({
                where: { user_id: USER_ID },
                data: { confirmed_targets: { calories: 1800, protein: 120, carbs: 180, fat: 60 } },
            });

            const response = await postPlan(generateBody()).expect(409);

            expect(asErrorBody(response.body)).toEqual({ error: 'targets_unconfirmed' });
            expect(await storedPlans()).toHaveLength(0);
        });

        it('reports both pinned revisions when either has moved', async () => {
            await seedGeneratorWorld(USER_ID);

            const response = await postPlan(
                generateBody({ expectedPreferencesRevision: 99 }),
            ).expect(409);

            // BOTH members, because the client re-runs from the pair (§0.5.2).
            expect(asErrorBody(response.body)).toEqual({
                error: 'stale_revision',
                preferencesRevision: 1,
                targetsRevision: 1,
            });
            expect(await storedPlans()).toHaveLength(0);
        });

        it('identifies the plan a requested week would collide with', async () => {
            const world = await seedGeneratorWorld(USER_ID);
            const startDate = utcTodayDayKey();
            const existing = await makePlan(USER_ID, {
                sequence: 480,
                startDate,
                recipeVersionId: world.recipes[0]?.id,
            });

            const response = await postPlan(
                generateBody({ startDate: addDaysToDayKey(startDate, 3) }),
            ).expect(409);

            expect(asErrorBody(response.body)).toEqual({
                error: 'plan_overlap',
                conflictingPlanId: existing.id,
            });
            expect(await storedPlans()).toHaveLength(1);
        });

        it('refuses a second upcoming week', async () => {
            const world = await seedGeneratorWorld(USER_ID);
            const today = utcTodayDayKey();

            await makePlan(USER_ID, {
                sequence: 481,
                startDate: addDaysToDayKey(today, 7),
                recipeVersionId: world.recipes[0]?.id,
            });

            const response = await postPlan(
                generateBody({ startDate: addDaysToDayKey(today, 14) }),
            ).expect(409);

            expect(asErrorBody(response.body)).toEqual({ error: 'upcoming_exists' });
            expect(await storedPlans()).toHaveLength(1);
        });
    });

    /* -----------------------------------------------------------------------
     * An infeasible week — a verdict, not a failure
     * --------------------------------------------------------------------- */

    describe('an infeasible week', () => {
        it('answers 422 with typed constraints and keeps the allergies promise', async () => {
            // Every recipe takes 45 minutes against a 30-minute limit, so no slot
            // has an eligible candidate and the next cooking tier would open the
            // week back up. Which rows the analysis emits, and in what order, is
            // `mealPlan.logic.test.ts`'s subject; what is asserted here is the
            // SHAPE the route puts on the wire.
            await seedGeneratorWorld(
                USER_ID,
                { cooking_time_limit_min: 30, diet: 'vegan', disliked_food_groups: ['fixture_food'] },
                { prepMinutes: 20, cookMinutes: 25 },
            );

            const response = await postPlan(generateBody()).expect(422);
            const body = asErrorBody(response.body);

            expect(body.error).toBe('no_matching_meals');
            // The literal, because it is a promise rather than a flag (§0.5.2).
            expect(body.allergiesKept).toBe(true);

            const constraints = body.limitingConstraints as LimitingConstraint[];

            expect(constraints.length).toBeGreaterThan(0);
            for (const constraint of constraints) {
                expect([
                    'cooking_time',
                    'dislikes',
                    'diet',
                    'nutrition_tolerance',
                    'portion_limits',
                    'slot_coverage',
                    'catalog_coverage',
                ]).toContain(constraint.constraintKey);
                // Typed values, never formatted prose — the client renders them
                // through its own strings (§0.5.2).
                expect(constraint.value === null || typeof constraint.value === 'number').toBe(true);
                expect(
                    constraint.unit === null ||
                        ['minutes', 'foods', 'percent', 'recipes'].includes(constraint.unit),
                ).toBe(true);
                // `unit` is null exactly when `value` is.
                expect(constraint.unit === null).toBe(constraint.value === null);
                expect(Array.isArray(constraint.slots)).toBe(true);
                // Each row routes the 10c pill at a setup screen.
                expect(typeof constraint.editStep).toBe('string');
                expect(constraint.editStep.length).toBeGreaterThan(0);
            }

            expect(constraints.map((constraint) => constraint.constraintKey)).toContain('slot_coverage');
            expect(await storedPlans()).toHaveLength(0);
            expect(await storedActions()).toHaveLength(0);
        });
    });

    /* -----------------------------------------------------------------------
     * The decoded generation fault
     * --------------------------------------------------------------------- */

    describe('the injected generation fault', () => {
        it('answers 502, persists nothing, and lets the same key commit once armed off', async () => {
            await seedGeneratorWorld(USER_ID);

            const body = generateBody();
            const fault = jest.spyOn(featureFlags, 'mealPlanningFault').mockReturnValue('generation');
            let faulted;

            try {
                // Proven armed before anything is concluded from what the route did.
                expect(featureFlags.mealPlanningFault()).toBe('generation');
                faulted = await postPlan(body).expect(502);
            } finally {
                fault.mockRestore();
            }

            expect(asErrorBody(faulted.body)).toEqual({ error: 'plan_generation_failed' });

            // §0.5.1: a refused generation persists NOTHING. The fault is raised
            // after the in-memory search and before the PUBLISHING transaction
            // opens, so no plan, day, meal or grocery row is ever written — and
            // no ledger row survives either. One reservation WAS attempted
            // before the fault, by the replay preflight
            // (`mealPlanningAction.service.ts::replayCommittedKeyedAction`,
            // which takes the per-user lock and reserves inside its own
            // two-statement transaction); it rolled that transaction back, so
            // the count below is zero because the attempt was undone rather
            // than because it never happened.
            expect(await storedPlans()).toHaveLength(0);
            expect(await prisma.meal_plan_days.count({ where: { user_id: USER_ID } })).toBe(0);
            expect(await prisma.meal_plan_meals.count({ where: { user_id: USER_ID } })).toBe(0);
            expect(await prisma.grocery_items.count({ where: { user_id: USER_ID } })).toBe(0);
            expect(await storedActions()).toHaveLength(0);

            expect(featureFlags.mealPlanningFault()).toBe('off');

            const retried = await postPlan(body).expect(201);

            expect(asPlan(retried.body).revision).toBe(FIRST_REVISION);
            expect(await storedPlans()).toHaveLength(1);
            expect(await storedActions()).toHaveLength(1);
        });
    });

    /* -----------------------------------------------------------------------
     * A publication that fails AFTER the week is written
     *
     * The other half of the fault case above, and the harder half: that one is
     * raised before the transaction opens, so nothing it asserts depends on a
     * rollback. These two fail with the plan, its seven days and their
     * twenty-one meals already inserted — and, in the second case, with the
     * grocery list inserted too. Only the transaction's rollback makes §0.5.1's
     * "failures persist nothing" true here, so it is asserted on every table the
     * commit had touched by then, on the `setup_status` the same transaction
     * writes, and on the ledger key that must still be usable afterwards.
     * --------------------------------------------------------------------- */

    describe('a publication that fails after the plan rows are written', () => {
        it('rolls the week back when the list cannot be built from the meals it wrote', async () => {
            // `ready_for_review`, so `markSetupCompleted` — which shares the
            // publication transaction — has something to move. Left at
            // `completed` the assertion below would hold whether the write rolled
            // back or not.
            const world = await seedGeneratorWorld(USER_ID, { setup_status: 'ready_for_review' });

            // A defect the SEARCH cannot see and the shopping list cannot
            // survive. `recipe.service.ts`'s planning projection reads a
            // recipe's per-serving figures and its ingredient identities and
            // never their gram weights, so every candidate stays eligible and a
            // week still closes; the list is aggregated from exactly those gram
            // weights, and `grocery.logic.ts` refuses a non-positive one rather
            // than shopping for nothing. Zero is the defect a bad import
            // actually leaves behind, and every fixture recipe carries it, so
            // whichever seven days the seed assembles reach it.
            const zeroed = await prisma.recipe_ingredients.updateMany({
                where: { recipe_version_id: { in: world.recipes.map((recipe) => recipe.id) } },
                data: { gram_weight: 0 },
            });

            expect(zeroed.count).toBe(PLANNABLE_RECIPE_COUNT);

            const body = generateBody();
            const observer = observePublicationWrites();
            let faulted;

            try {
                faulted = await postPlan(body).expect(502);
            } finally {
                observer.restore();
            }

            // Proven before anything is concluded from the empty tables below:
            // the transaction had written the whole week when it reached the
            // grocery step it died in. An empty database after a refusal that
            // never opened a transaction would satisfy every other assertion
            // here.
            expect(observer.observations).toEqual([
                {
                    plannedMeals: PLAN_DAY_COUNT * MEALS_PER_DAY,
                    planStatuses: ['active'],
                    groceryRows: 0,
                },
            ]);

            // §0.5.2's only 5xx for this route. The grocery domain's error
            // classes are deliberately outside the meal-planning vocabulary, so
            // an untranslated one would surface as an unclassifiable 500 — which
            // is a different defect from the one this case is about, and worth
            // separating.
            expect(faulted.status).not.toBe(500);
            expect(asErrorBody(faulted.body)).toEqual({ error: 'plan_generation_failed' });

            // §0.5.1: nothing survives — not the week, not its children, not the
            // list the writer got half-way through, and not the reservation.
            expect(await storedPlans()).toHaveLength(0);
            expect(await prisma.meal_plan_days.count({ where: { user_id: USER_ID } })).toBe(0);
            expect(await prisma.meal_plan_meals.count({ where: { user_id: USER_ID } })).toBe(0);
            expect(await prisma.grocery_items.count({ where: { user_id: USER_ID } })).toBe(0);
            expect(await storedActions()).toHaveLength(0);
            // The setup transition rides in the same transaction, so a status
            // that had advanced would mean part of the commit survived it.
            expect(await storedSetupStatus()).toBe('ready_for_review');

            // Repaired, the SAME key publishes once: the reservation rolled back
            // with everything else, so the key is still a first attempt rather
            // than a used one replaying a 502.
            await prisma.recipe_ingredients.updateMany({
                where: { recipe_version_id: { in: world.recipes.map((recipe) => recipe.id) } },
                data: { gram_weight: INGREDIENT_GRAM_WEIGHT },
            });

            const published = asPlan((await postPlan(body).expect(201)).body);

            expect(published.revision).toBe(FIRST_REVISION);
            expect(await storedPlans()).toHaveLength(1);
            expect(await storedDays(published.id)).toHaveLength(PLAN_DAY_COUNT);
            expect(await storedGroceries(published.id)).toHaveLength(1);
            expect(await storedActions()).toHaveLength(1);
            expect(await storedSetupStatus()).toBe('completed');
        });

        it('rolls the grocery rows back too when the write fails after inserting them', async () => {
            await seedGeneratorWorld(USER_ID, { setup_status: 'ready_for_review' });

            const body = generateBody();
            const seam = failAfterGroceryRowsAreWritten();
            let faulted;

            try {
                faulted = await postPlan(body).expect(502);
                // Proven to have run before anything is read from the response:
                // a spy that never fired would leave a green case asserting the
                // unfaulted path, exactly as an unarmed flag would above. Inside
                // the `try` because `mockRestore` clears the call record along
                // with the implementation, so the count is gone by the `finally`.
                expect(seam.spy).toHaveBeenCalledTimes(1);
            } finally {
                seam.spy.mockRestore();
            }

            // One line inserted is the whole list of a week that shops for one
            // food, so the REAL writer ran: the plan, its days, its meals and
            // its groceries all existed inside the transaction. The array is the
            // seam's own closure, so restoring the spy does not empty it.
            expect(seam.insertedBeforeTheThrow).toEqual([1]);

            expect(faulted.status).not.toBe(500);
            expect(asErrorBody(faulted.body)).toEqual({ error: 'plan_generation_failed' });

            expect(await storedPlans()).toHaveLength(0);
            expect(await prisma.meal_plan_days.count({ where: { user_id: USER_ID } })).toBe(0);
            expect(await prisma.meal_plan_meals.count({ where: { user_id: USER_ID } })).toBe(0);
            expect(await prisma.grocery_items.count({ where: { user_id: USER_ID } })).toBe(0);
            expect(await storedActions()).toHaveLength(0);
            expect(await storedSetupStatus()).toBe('ready_for_review');

            // And with the seam gone the same key commits once, at the revision
            // the first attempt would have published.
            const published = asPlan((await postPlan(body).expect(201)).body);

            expect(published.revision).toBe(FIRST_REVISION);
            expect(published.summary.groceryItemCount).toBe(1);
            expect(await storedPlans()).toHaveLength(1);
            expect(await storedGroceries(published.id)).toHaveLength(1);
            expect(await storedActions()).toHaveLength(1);
            expect(await storedSetupStatus()).toBe('completed');
        });
    });

    /* -----------------------------------------------------------------------
     * Request validation — 400 naming the field (Rule §8)
     * --------------------------------------------------------------------- */

    describe('request validation', () => {
        it('names a malformed idempotency key', async () => {
            await seedGeneratorWorld(USER_ID);

            const response = await postPlan(generateBody({ idempotencyKey: 'not-a-uuid' })).expect(400);
            const body = asErrorBody(response.body);

            expect(body.error).toBe('invalid_request');
            expect(body.details).toEqual(
                expect.arrayContaining([{ field: 'idempotencyKey', code: 'invalid_id' }]),
            );
            expect(await storedPlans()).toHaveLength(0);
        });

        it('names a start date that is not a real calendar day', async () => {
            await seedGeneratorWorld(USER_ID);

            const response = await postPlan(generateBody({ startDate: '2026-02-30' })).expect(400);

            expect(asErrorBody(response.body).details).toEqual(
                expect.arrayContaining([{ field: 'startDate', code: 'invalid_date' }]),
            );
        });

        it('reports every malformed field of one request at once', async () => {
            await seedGeneratorWorld(USER_ID);

            const response = await postPlan({
                startDate: 'yesterday',
                idempotencyKey: 42,
                expectedPreferencesRevision: 'one',
                expectedTargetsRevision: -1,
            }).expect(400);
            const details = asErrorBody(response.body).details as { field: string; code: string }[];

            expect(details).toEqual(
                expect.arrayContaining([
                    { field: 'startDate', code: 'invalid_date' },
                    { field: 'idempotencyKey', code: 'invalid_id' },
                    { field: 'expectedPreferencesRevision', code: 'invalid_type' },
                    { field: 'expectedTargetsRevision', code: 'out_of_range' },
                ]),
            );
        });

        it('accepts today, the earliest day the window admits', async () => {
            await seedGeneratorWorld(USER_ID);

            const response = await postPlan(generateBody({ startDate: utcTodayDayKey() })).expect(201);

            expect(asPlan(response.body).startDate).toBe(utcTodayDayKey());
        });

        it('rejects yesterday, one day below the window', async () => {
            await seedGeneratorWorld(USER_ID);

            const response = await postPlan(
                generateBody({ startDate: addDaysToDayKey(utcTodayDayKey(), -1) }),
            ).expect(400);

            expect(asErrorBody(response.body).details).toEqual([
                { field: 'startDate', code: 'out_of_range' },
            ]);
        });

        it('accepts the thirtieth day, the horizon the window admits', async () => {
            await seedGeneratorWorld(USER_ID);

            const horizon = addDaysToDayKey(utcTodayDayKey(), START_DATE_HORIZON_DAYS);
            const response = await postPlan(generateBody({ startDate: horizon })).expect(201);

            expect(asPlan(response.body).startDate).toBe(horizon);
        });

        it('rejects the day after the horizon', async () => {
            await seedGeneratorWorld(USER_ID);

            const response = await postPlan(
                generateBody({ startDate: addDaysToDayKey(utcTodayDayKey(), START_DATE_HORIZON_DAYS + 1) }),
            ).expect(400);

            expect(asErrorBody(response.body).details).toEqual([
                { field: 'startDate', code: 'out_of_range' },
            ]);
        });

        it('admits the successor week of a current plan that ends beyond the horizon', async () => {
            // The second term of the bound, and the reason it exists: "Plan
            // another week" must always be offerable, even when the current plan
            // finishes more than thirty days out (§0.5.2).
            await seedGeneratorWorld(USER_ID);

            const today = utcTodayDayKey();
            const longPlanDayCount = 40;

            await makePlan(USER_ID, {
                sequence: 482,
                startDate: today,
                dayCount: longPlanDayCount,
                slots: [],
            });

            const successor = addDaysToDayKey(today, longPlanDayCount);
            const accepted = await postPlan(generateBody({ startDate: successor })).expect(201);

            expect(asPlan(accepted.body).startDate).toBe(successor);

            const beyond = await postPlan(
                generateBody({ startDate: addDaysToDayKey(successor, 1) }),
            ).expect(400);

            expect(asErrorBody(beyond.body).details).toEqual([
                { field: 'startDate', code: 'out_of_range' },
            ]);
        });
    });
});


/* ---------------------------------------------------------------------------
 * mealPlan.mapper.ts — every field it DERIVES
 *
 * This is the section Rule §11 leaves to integration, and it is read back
 * through the routes because a derived field only matters where a client sees
 * it. The worlds are built with `makePlan` rather than the generator: what is
 * under test is the mapping, not the search.
 * ------------------------------------------------------------------------- */

/**
 * The client's own derivation, applied to the payload a route returned: a meal
 * reads as LOGGED when a non-deleted entry references its CURRENT recipe
 * version.
 *
 * Computed here rather than read from a member, because the DTO deliberately has
 * none (§0.5.2; `plannedMealLog.logic.ts::deriveLoggedStatus` is the server-side
 * spelling of the same rule). That absence is the design: the state is derived
 * live on every read, so deleting the diary entry clears it with no `is_logged`
 * column to correct.
 */
const readsAsLogged = (meal: MealPlanMealResponse): boolean =>
    meal.loggedEntries.some((entry) => entry.recipeVersionId === meal.recipe.versionId);

/**
 * The logged-then-swapped treatment: at least one entry references a DIFFERENT
 * version and none references the current one (§0.2.5). Mutually exclusive with
 * {@link readsAsLogged} by construction, which one of the cases below pins.
 */
const readsAsLoggedThenSwapped = (meal: MealPlanMealResponse): boolean =>
    !readsAsLogged(meal) && meal.loggedEntries.length > 0;

describe('the plan DTO — every field mealPlan.mapper.ts derives', () => {
    describe('loggedEntries', () => {
        it('orders entries by loggedAt, then by entryId at the same instant', async () => {
            const dayKey = utcTodayDayKey();
            const { plan, recipe } = await seedPlannedWeek(USER_ID);
            const day = plan.meal_plan_days.find(
                (candidate) => candidate.date.toISOString().slice(0, 10) === dayKey,
            );
            const breakfast = day?.meal_plan_meals.find((meal) => meal.slot === 'breakfast');

            if (day === undefined || breakfast === undefined) {
                throw new Error('the fixture week does not cover today, so no day can be named');
            }

            const bucket = await seedDiaryBucket(USER_ID, dayKey);
            const earlier = new Date(`${dayKey}T08:15:00.000Z`);
            const later = new Date(`${dayKey}T19:45:00.000Z`);

            // Written newest-first, so an assertion on the order cannot pass
            // because the insertion order happened to agree with it.
            const second = await seedDiaryEntry({
                mealId: bucket.id,
                dayKey,
                plannedMealId: breakfast.id,
                recipeVersionId: recipe.id,
                loggedAt: later,
            });
            const first = await seedDiaryEntry({
                mealId: bucket.id,
                dayKey,
                plannedMealId: breakfast.id,
                recipeVersionId: recipe.id,
                loggedAt: earlier,
            });

            const envelope = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);
            const logged = mealIn(envelope.day, 'breakfast').loggedEntries;

            expect(logged.map((entry) => entry.entryId)).toEqual([first.id, second.id]);
            expect(logged[0]).toMatchObject({
                date: dayKey,
                mealName: 'Breakfast',
                servings: 1,
                loggedAt: earlier.toISOString(),
                recipeVersionId: recipe.id,
                recipeName: recipe.name,
            });

            // The tiebreaker, which only an identical instant can exercise: two
            // taps a millisecond apart genuinely produce one.
            const sameInstant = new Date(`${dayKey}T12:00:00.000Z`);

            await prisma.meal_entries.updateMany({
                where: { id: { in: [first.id, second.id] }, user_id: USER_ID },
                data: { logged_at: sameInstant },
            });

            const tied = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);
            const tiedIds = mealIn(tied.day, 'breakfast').loggedEntries.map((entry) => entry.entryId);

            expect(tiedIds).toEqual([first.id, second.id].sort((left, right) => (left < right ? -1 : 1)));
        });

        it('reports the recipe each entry references, not the meal’s current one', async () => {
            const dayKey = utcTodayDayKey();
            const { plan, recipe: eaten, food } = await seedPlannedWeek(USER_ID);
            const replacement = await seedRecipe(food.id, 471, 'plans-suite-replacement');
            const day = plan.meal_plan_days.find(
                (candidate) => candidate.date.toISOString().slice(0, 10) === dayKey,
            );
            const lunch = day?.meal_plan_meals.find((meal) => meal.slot === 'lunch');

            if (lunch === undefined) {
                throw new Error('the fixture week has no lunch on today');
            }

            const bucket = await seedDiaryBucket(USER_ID, dayKey, 'Lunch');

            await seedDiaryEntry({
                mealId: bucket.id,
                dayKey,
                plannedMealId: lunch.id,
                recipeVersionId: eaten.id,
                loggedAt: new Date(`${dayKey}T12:40:00.000Z`),
            });

            // The slot now holds a different recipe, as a committed swap leaves it.
            await prisma.meal_plan_meals.update({
                where: { id: lunch.id, user_id: USER_ID },
                data: { recipe_version_id: replacement.id, previous_recipe_version_id: eaten.id },
            });

            const envelope = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);
            const meal = mealIn(envelope.day, 'lunch');

            expect(meal.recipe.versionId).toBe(replacement.id);
            expect(meal.recipe.name).toBe(replacement.name);
            // Joined from the ENTRY'S own recipe_versions row, which is what lets
            // the caption name the recipe actually eaten.
            expect(meal.loggedEntries).toHaveLength(1);
            expect(meal.loggedEntries[0]?.recipeVersionId).toBe(eaten.id);
            expect(meal.loggedEntries[0]?.recipeName).toBe(eaten.name);
            expect(eaten.name).not.toBe(replacement.name);
        });

        it('drops an entry whose plan link was cleared', async () => {
            const dayKey = utcTodayDayKey();
            const { plan } = await seedPlannedWeek(USER_ID);
            const day = plan.meal_plan_days.find(
                (candidate) => candidate.date.toISOString().slice(0, 10) === dayKey,
            );
            const dinner = day?.meal_plan_meals.find((meal) => meal.slot === 'dinner');

            if (dinner === undefined) {
                throw new Error('the fixture week has no dinner on today');
            }

            const bucket = await seedDiaryBucket(USER_ID, dayKey, 'Dinner');

            // What `nutrition.service.ts::updateMealEntry` leaves behind when a
            // user rewrites an entry's name or macros: it references no recipe,
            // so it is no longer evidence that this meal was eaten.
            await seedDiaryEntry({
                mealId: bucket.id,
                dayKey,
                plannedMealId: dinner.id,
                recipeVersionId: null,
                loggedAt: new Date(`${dayKey}T18:40:00.000Z`),
            });

            const envelope = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);

            expect(mealIn(envelope.day, 'dinner').loggedEntries).toEqual([]);
        });
    });

    describe('the logged determination', () => {
        it('follows the entries alone, so a soft delete clears it', async () => {
            const dayKey = utcTodayDayKey();
            const { plan, recipe } = await seedPlannedWeek(USER_ID);
            const day = plan.meal_plan_days.find(
                (candidate) => candidate.date.toISOString().slice(0, 10) === dayKey,
            );
            const breakfast = day?.meal_plan_meals.find((meal) => meal.slot === 'breakfast');

            if (breakfast === undefined) {
                throw new Error('the fixture week has no breakfast on today');
            }

            const before = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);

            expect(readsAsLogged(mealIn(before.day, 'breakfast'))).toBe(false);
            expect(readsAsLoggedThenSwapped(mealIn(before.day, 'breakfast'))).toBe(false);

            const bucket = await seedDiaryBucket(USER_ID, dayKey);
            const entry = await seedDiaryEntry({
                mealId: bucket.id,
                dayKey,
                plannedMealId: breakfast.id,
                recipeVersionId: recipe.id,
                loggedAt: new Date(`${dayKey}T08:05:00.000Z`),
            });

            const logged = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);

            expect(readsAsLogged(mealIn(logged.day, 'breakfast'))).toBe(true);

            await prisma.meal_entries.update({
                where: { id: entry.id, user_id: USER_ID },
                data: { deleted_at: new Date() },
            });

            const cleared = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);

            expect(mealIn(cleared.day, 'breakfast').loggedEntries).toEqual([]);
            expect(readsAsLogged(mealIn(cleared.day, 'breakfast'))).toBe(false);
        });

        it('reads as logged-then-swapped after two swaps, and as logged again once the current version is eaten', async () => {
            const dayKey = utcTodayDayKey();
            const { plan, recipe: recipeA, food } = await seedPlannedWeek(USER_ID);
            const recipeB = await seedRecipe(food.id, 472, 'plans-suite-chain-b');
            const recipeC = await seedRecipe(food.id, 473, 'plans-suite-chain-c');
            const day = plan.meal_plan_days.find(
                (candidate) => candidate.date.toISOString().slice(0, 10) === dayKey,
            );
            const lunch = day?.meal_plan_meals.find((meal) => meal.slot === 'lunch');

            if (lunch === undefined) {
                throw new Error('the fixture week has no lunch on today');
            }

            const bucket = await seedDiaryBucket(USER_ID, dayKey, 'Lunch');

            // Two intentional servings of A, then A -> B -> C.
            await seedDiaryEntry({
                mealId: bucket.id,
                dayKey,
                plannedMealId: lunch.id,
                recipeVersionId: recipeA.id,
                loggedAt: new Date(`${dayKey}T12:30:00.000Z`),
            });
            await seedDiaryEntry({
                mealId: bucket.id,
                dayKey,
                plannedMealId: lunch.id,
                recipeVersionId: recipeA.id,
                loggedAt: new Date(`${dayKey}T13:30:00.000Z`),
            });
            await prisma.meal_plan_meals.update({
                where: { id: lunch.id, user_id: USER_ID },
                data: { recipe_version_id: recipeB.id, previous_recipe_version_id: recipeA.id },
            });
            await prisma.meal_plan_meals.update({
                where: { id: lunch.id, user_id: USER_ID },
                data: { recipe_version_id: recipeC.id, previous_recipe_version_id: recipeB.id },
            });

            const swapped = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);
            const meal = mealIn(swapped.day, 'lunch');

            expect(meal.recipe.versionId).toBe(recipeC.id);
            expect(readsAsLogged(meal)).toBe(false);
            // Derived from the entries alone, so any number of swaps is
            // represented: both entries still name A.
            expect(readsAsLoggedThenSwapped(meal)).toBe(true);
            expect(meal.loggedEntries.map((entry) => entry.recipeVersionId)).toEqual([
                recipeA.id,
                recipeA.id,
            ]);
            expect(meal.loggedEntries.map((entry) => entry.recipeName)).toEqual([
                recipeA.name,
                recipeA.name,
            ]);

            // The two states are mutually exclusive: one entry on the CURRENT
            // version makes the meal logged, even with the earlier ones present.
            await seedDiaryEntry({
                mealId: bucket.id,
                dayKey,
                plannedMealId: lunch.id,
                recipeVersionId: recipeC.id,
                loggedAt: new Date(`${dayKey}T14:30:00.000Z`),
            });

            const relogged = mealIn(
                asEnvelope((await getDay(plan.id, dayKey).expect(200)).body).day,
                'lunch',
            );

            expect(readsAsLogged(relogged)).toBe(true);
            expect(readsAsLoggedThenSwapped(relogged)).toBe(false);
            expect(relogged.loggedEntries).toHaveLength(3);
        });
    });

    describe('previousRecipe', () => {
        it('is null until a swap, and then names the version the slot held last', async () => {
            const dayKey = utcTodayDayKey();
            const { plan, recipe: recipeA, food } = await seedPlannedWeek(USER_ID);
            const recipeB = await seedRecipe(food.id, 474, 'plans-suite-previous-b');
            const recipeC = await seedRecipe(food.id, 475, 'plans-suite-previous-c');
            const day = plan.meal_plan_days.find(
                (candidate) => candidate.date.toISOString().slice(0, 10) === dayKey,
            );
            const dinner = day?.meal_plan_meals.find((meal) => meal.slot === 'dinner');

            if (dinner === undefined) {
                throw new Error('the fixture week has no dinner on today');
            }

            const fresh = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);

            expect(mealIn(fresh.day, 'dinner').previousRecipe).toBeNull();

            await prisma.meal_plan_meals.update({
                where: { id: dinner.id, user_id: USER_ID },
                data: { recipe_version_id: recipeB.id, previous_recipe_version_id: recipeA.id },
            });

            const once = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);

            expect(mealIn(once.day, 'dinner').previousRecipe).toEqual({
                versionId: recipeA.id,
                name: recipeA.name,
            });

            await prisma.meal_plan_meals.update({
                where: { id: dinner.id, user_id: USER_ID },
                data: { recipe_version_id: recipeC.id, previous_recipe_version_id: recipeB.id },
            });

            const twice = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);

            // An AUDIT value and not a history: after A -> B -> C it names B,
            // while the logged entries still name whatever was eaten.
            expect(mealIn(twice.day, 'dinner').previousRecipe).toEqual({
                versionId: recipeB.id,
                name: recipeB.name,
            });
        });
    });
});


/* ---------------------------------------------------------------------------
 * mealPlan.mapper.ts — the remaining derived fields
 * ------------------------------------------------------------------------- */

const TARGETS_PATH = '/api/meal-planning/targets';

/** Targets confirmed through the canonical writer, which is the only honest way to move them. */
const putTargets = (body: RequestBody, userId: string = USER_ID) =>
    asUser(request.put(TARGETS_PATH).send(body), { uid: userId });

/** A second confirmed set, distinguishable from `FIXTURE_TARGETS` in every member. */
const RECONFIRMED_TARGETS = { calories: 1800, protein: 140, carbs: 180, fat: 60 };

describe('the plan DTO — targets, dates, portions, flags and counts', () => {
    describe('targets, generationTargets and targetsStale', () => {
        it('reports one set of numbers while the confirmed targets still match the snapshot', async () => {
            const { plan } = await seedPlannedWeek(USER_ID);
            const current = asCurrent((await getCurrent().expect(200)).body);

            expect(current.current?.id).toBe(plan.id);
            expect(current.current?.targets).toEqual(FIXTURE_TARGETS);
            expect(current.current?.generationTargets).toEqual(FIXTURE_TARGETS);
            expect(current.current?.targetsStale).toBe(false);
        });

        it('moves the current targets, leaves the snapshot, and changes nothing about the plan', async () => {
            const { plan } = await seedPlannedWeek(USER_ID);
            const plannedBefore = (await storedMeals(plan.id)).map((meal) => ({
                id: meal.id,
                recipe: meal.recipe_version_id,
                multiplier: meal.portion_multiplier,
            }));

            await putTargets({ source: 'manual', ...RECONFIRMED_TARGETS, expectedTargetsRevision: 1 }).expect(200);

            const current = asCurrent((await getCurrent().expect(200)).body);

            // `targets` is what Account, Progress and the diary now show; the
            // snapshot is what the week was actually searched against.
            expect(current.current?.targets).toEqual(RECONFIRMED_TARGETS);
            expect(current.current?.generationTargets).toEqual(FIXTURE_TARGETS);
            expect(current.current?.targetsStale).toBe(true);

            // Nothing regenerates on its own (§0.5.2): the caption is the whole
            // of the behaviour, and the plan is untouched.
            const stored = await storedPlan(plan.id);

            expect(stored.revision).toBe(FIRST_REVISION);
            expect(stored.status).toBe('active');
            expect(await storedPlans()).toHaveLength(1);
            expect(
                (await storedMeals(plan.id)).map((meal) => ({
                    id: meal.id,
                    recipe: meal.recipe_version_id,
                    multiplier: meal.portion_multiplier,
                })),
            ).toEqual(plannedBefore);
        });
    });

    describe('isLastDay', () => {
        it('marks the plan’s end date and no other day, however many days it holds', async () => {
            const { plan, recipe } = await seedPlannedWeek(USER_ID);
            const shortStart = addDaysToDayKey(utcTodayDayKey(), 10);

            // A three-day plan puts its last day at index 2, so a reader that
            // trusted `day_index === 6` would flag nothing here.
            await makePlan(USER_ID, {
                sequence: 481,
                recipeVersionId: recipe.id,
                startDate: shortStart,
                dayCount: 3,
            });

            const current = asCurrent((await getCurrent().expect(200)).body);
            const week = current.current;
            const short = current.upcoming;

            if (week === null || short === null) {
                throw new Error('both the current week and the short upcoming plan must be returned');
            }

            expect(week.days).toHaveLength(PLAN_DAY_COUNT);
            expect(week.days.filter((day) => day.isLastDay).map((day) => day.date)).toEqual([week.endDate]);
            expect(dayOn(week, week.endDate).dayIndex).toBe(PLAN_DAY_COUNT - 1);

            expect(short.days).toHaveLength(3);
            expect(short.days.filter((day) => day.isLastDay).map((day) => day.date)).toEqual([short.endDate]);
            expect(dayOn(short, short.endDate).dayIndex).toBe(2);
            expect(short.endDate).toBe(addDaysToDayKey(shortStart, 2));
        });
    });

    describe('portionText', () => {
        it('describes each multiplier in the recipe’s own serving words', async () => {
            const dayKey = utcTodayDayKey();
            const { plan, recipe } = await seedPlannedWeek(USER_ID, {
                slots: [
                    { slot: 'breakfast', slot_time: '08:00', portion_multiplier: 0.75 },
                    { slot: 'lunch', slot_time: '12:30', portion_multiplier: 1 },
                    { slot: 'dinner', slot_time: '18:30', portion_multiplier: 1.5 },
                ],
            });

            // Stated so a factory change to the serving description fails here
            // with a sentence rather than as an unexplained string mismatch.
            expect(recipe.serving_description).toBe('1 bowl');

            const day = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body).day;

            expect(mealIn(day, 'breakfast')).toMatchObject({
                portionMultiplier: 0.75,
                portionText: '¾ bowl',
            });
            expect(mealIn(day, 'lunch')).toMatchObject({
                portionMultiplier: 1,
                portionText: '1 bowl',
            });
            // Plural past one serving, and the fraction rendered as a glyph.
            expect(mealIn(day, 'dinner')).toMatchObject({
                portionMultiplier: 1.5,
                portionText: '1½ bowls',
            });
        });
    });

    describe('flags', () => {
        it('round-trips every code with every detail, and reports an unflagged meal as an empty list', async () => {
            const dayKey = utcTodayDayKey();
            const { plan } = await seedPlannedWeek(USER_ID);
            const day = plan.meal_plan_days.find(
                (candidate) => candidate.date.toISOString().slice(0, 10) === dayKey,
            );
            const breakfast = day?.meal_plan_meals.find((meal) => meal.slot === 'breakfast');
            const lunch = day?.meal_plan_meals.find((meal) => meal.slot === 'lunch');

            if (breakfast === undefined || lunch === undefined) {
                throw new Error('the fixture week does not hold today’s breakfast and lunch');
            }

            const unflagged = asCurrent((await getCurrent().expect(200)).body);

            expect(unflagged.current?.hasIncompatibilities).toBe(false);
            // The column defaults to `'[]'::jsonb`, and the wire shape keeps that
            // a list rather than a null the client would have to guess about (§6).
            expect(mealIn(dayOn(unflagged.current as MealPlanResponse, dayKey), 'dinner').flags).toEqual([]);

            // Several details under one code, and several codes on one meal:
            // both survive because the column stores the DTO's own shape.
            await prisma.meal_plan_meals.update({
                where: { id: breakfast.id, user_id: USER_ID },
                data: { flags: asJsonFlags([{ code: 'allergen', detail: ['milk', 'eggs'] }]) },
            });
            await prisma.meal_plan_meals.update({
                where: { id: lunch.id, user_id: USER_ID },
                data: {
                    flags: asJsonFlags([
                        { code: 'diet', detail: ['vegan'] },
                        { code: 'cooking_time', detail: ['30'] },
                    ]),
                },
            });

            const envelope = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);

            expect(mealIn(envelope.day, 'breakfast').flags).toEqual([
                { code: 'allergen', detail: ['milk', 'eggs'] },
            ]);
            expect(mealIn(envelope.day, 'lunch').flags).toEqual([
                { code: 'diet', detail: ['vegan'] },
                { code: 'cooking_time', detail: ['30'] },
            ]);
            expect(mealIn(envelope.day, 'dinner').flags).toEqual([]);

            const flagged = asCurrent((await getCurrent().expect(200)).body);

            // Derived from the meals themselves, never from the audit column on
            // the plan row.
            expect(flagged.current?.hasIncompatibilities).toBe(true);
        });
    });

    describe('day keys', () => {
        it('formats every date as a bare calendar day, across a month and a year boundary', async () => {
            const straddleStart = '2026-12-29';
            const { plan } = await seedPlannedWeek(USER_ID, { startDate: straddleStart });
            const expected = Array.from({ length: PLAN_DAY_COUNT }, (_unused, index) =>
                addDaysToDayKey(straddleStart, index),
            );

            expect(expected[expected.length - 1]).toBe('2027-01-04');

            const upcoming = asCurrent((await getCurrent().expect(200)).body).upcoming;

            if (upcoming === null) {
                throw new Error('a plan starting after today must be reported as upcoming');
            }

            expect(upcoming.id).toBe(plan.id);
            expect(upcoming.startDate).toBe(straddleStart);
            expect(upcoming.endDate).toBe('2027-01-04');
            expect(upcoming.days.map((day) => day.date)).toEqual(expected);
            // No time component and no offset: a `@db.Date` column read through
            // UTC components, not a local ISO conversion.
            for (const day of upcoming.days) {
                expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            }
            expect(upcoming.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(upcoming.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

            // The same read with the PROCESS fourteen hours ahead of UTC. A
            // mapper using local components would shift every key by a day;
            // this one must answer identically.
            const originalZone = process.env.TZ;

            try {
                process.env.TZ = 'Pacific/Kiritimati';

                const shifted = asCurrent((await getCurrent().expect(200)).body).upcoming;

                expect(shifted?.startDate).toBe(straddleStart);
                expect(shifted?.endDate).toBe('2027-01-04');
                expect(shifted?.days.map((day) => day.date)).toEqual(expected);
            } finally {
                if (originalZone === undefined) {
                    delete process.env.TZ;
                } else {
                    process.env.TZ = originalZone;
                }
            }
        });
    });

    describe('summary and the pinned provenance', () => {
        it('counts the planned meals, the grocery lines and the entries that still stand', async () => {
            const dayKey = utcTodayDayKey();
            const { plan, recipe, food } = await seedPlannedWeek(USER_ID);
            const day = plan.meal_plan_days.find(
                (candidate) => candidate.date.toISOString().slice(0, 10) === dayKey,
            );
            const breakfast = day?.meal_plan_meals.find((meal) => meal.slot === 'breakfast');

            if (breakfast === undefined) {
                throw new Error('the fixture week has no breakfast on today');
            }

            for (const [index, state] of ['raw', 'cooked'].entries()) {
                await prisma.grocery_items.create({
                    data: {
                        meal_plan_id: plan.id,
                        user_id: USER_ID,
                        catalog_food_id: food.id,
                        food_state: state,
                        category: 'protein',
                        name: food.display_name,
                        quantity_grams: 1400,
                        display_quantity: 3.1,
                        display_unit: 'lb',
                        display_text: '3.1 lb',
                        sort_order: index,
                    },
                });
            }

            const bucket = await seedDiaryBucket(USER_ID, dayKey);
            const kept = await seedDiaryEntry({
                mealId: bucket.id,
                dayKey,
                plannedMealId: breakfast.id,
                recipeVersionId: recipe.id,
                loggedAt: new Date(`${dayKey}T08:10:00.000Z`),
            });
            const removed = await seedDiaryEntry({
                mealId: bucket.id,
                dayKey,
                plannedMealId: breakfast.id,
                recipeVersionId: recipe.id,
                loggedAt: new Date(`${dayKey}T08:20:00.000Z`),
            });

            const both = asCurrent((await getCurrent().expect(200)).body).current;

            expect(both?.summary).toEqual({
                plannedMeals: PLAN_DAY_COUNT * MEALS_PER_DAY,
                groceryItemCount: 2,
                loggedEntryCount: 2,
            });

            await prisma.meal_entries.update({
                where: { id: removed.id, user_id: USER_ID },
                data: { deleted_at: new Date() },
            });

            const afterDelete = asCurrent((await getCurrent().expect(200)).body).current;

            // A soft-deleted entry is gone from the count, which is what makes
            // deleting a diary row clear the plan's logged state.
            expect(afterDelete?.summary.loggedEntryCount).toBe(1);
            expect(afterDelete?.summary.plannedMeals).toBe(PLAN_DAY_COUNT * MEALS_PER_DAY);
            expect(
                dayOn(afterDelete as MealPlanResponse, dayKey).meals.flatMap((meal) =>
                    meal.loggedEntries.map((entry) => entry.entryId),
                ),
            ).toEqual([kept.id]);
        });

        // §0.5.2 declares this response as fourteen members, and `generationKey`
        // is not one of them: it is an additive extra this server sends so the
        // screen that owns a pending generation can recognise its own result
        // (§0.7.4), and a client may not require it — `MealPlanResponse` types
        // it optional and the mobile codec admits a response without it, so a
        // contract-conforming payload can never fail to decode over it. What is
        // asserted here is the other half: this server does send it, and it is
        // the key of the write that published the plan rather than anything
        // rederived.
        it('carries every member the contract declares, and the publishing key as an extra', async () => {
            const idempotencyKey = '41414141-4141-4141-8141-414141414141';

            await seedGeneratorWorld(USER_ID);

            const published = asPlan(
                (await postPlan(generateBody({ idempotencyKey, startDate: utcTodayDayKey() })).expect(201))
                    .body,
            );

            expect(Object.keys(published).sort()).toEqual(
                [
                    'days',
                    'endDate',
                    'generationAttempt',
                    'generationKey',
                    'generationTargets',
                    'hasIncompatibilities',
                    'id',
                    'preferencesRevision',
                    'revision',
                    'startDate',
                    'status',
                    'summary',
                    'targets',
                    'targetsRevision',
                    'targetsStale',
                ].sort(),
            );
            expect(published.generationKey).toBe(idempotencyKey);

            // And on the read path too, which is where a client whose 201 was
            // lost looks — though what retires its pending request is the
            // answer to that key, never this read (§0.2.5).
            const current = asCurrent((await getCurrent().expect(200)).body).current;

            expect(current?.generationKey).toBe(idempotencyKey);
        });

        it('states every planned recipe’s provenance as source-backed', async () => {
            const { plan } = await seedPlannedWeek(USER_ID);
            const current = asCurrent((await getCurrent().expect(200)).body).current;

            if (current === null) {
                throw new Error('the seeded week must be the current plan');
            }

            expect(current.id).toBe(plan.id);

            const provenances = new Set(
                current.days.flatMap((day) => day.meals.map((meal) => meal.recipe.nutritionProvenance)),
            );

            // Only source-backed recipes are plannable (§0.7.3), so the literal is
            // the contract rather than a copied column.
            expect([...provenances]).toEqual(['source_backed']);
        });
    });

    describe('slotTime and the order of a day', () => {
        it('returns a day’s meals in clock order, so a mid-afternoon snack sits between lunch and dinner', async () => {
            const dayKey = utcTodayDayKey();
            const { plan } = await seedPlannedWeek(USER_ID, {
                preferences: { meal_schedule: 'three_plus_snack' },
                recipeOptions: { slots: ['breakfast', 'lunch', 'dinner', 'snack'] },
                // Wire order — breakfast, lunch, dinner, snack — which is NOT
                // clock order, and is exactly what §0.5.2 permits.
                slots: [
                    { slot: 'breakfast', slot_time: '08:00' },
                    { slot: 'lunch', slot_time: '12:30' },
                    { slot: 'dinner', slot_time: '18:30' },
                    { slot: 'snack', slot_time: '15:30' },
                ],
            });

            const day = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body).day;

            expect(day.meals).toHaveLength(MEALS_PER_DAY_WITH_SNACK);
            expect(day.meals.map((meal) => meal.slot)).toEqual(['breakfast', 'lunch', 'snack', 'dinner']);
            expect(day.meals.map((meal) => meal.slotTime)).toEqual(['08:00', '12:30', '15:30', '18:30']);

            for (const meal of day.meals) {
                expect(meal.slotTime).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
            }

            // The stored `sort_order` keeps the wire order, so the response's
            // order is the mapper's work and not the query's.
            const stored = await prisma.meal_plan_meals.findMany({
                where: { meal_plan_day_id: day.id },
                orderBy: { sort_order: 'asc' },
                select: { slot: true },
            });

            expect(stored.map((meal) => meal.slot)).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
        });
    });
});


/* ---------------------------------------------------------------------------
 * GET /api/meal-planning/plans/current
 * ------------------------------------------------------------------------- */

describe('GET /api/meal-planning/plans/current', () => {
    describe('the four states of the collection', () => {
        it('answers with both members null, and never a 404, for a user who has no plan', async () => {
            await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });

            // No preferences row either — a brand-new account, which is the
            // state that must still answer 200. §0.2.5 makes a BARE 404 from
            // this exact route the client's signal that the backend has been
            // rolled back and the meal-planning routes are not mounted, so a
            // 404 here would render the whole feature unavailable for a user
            // whose only fault is not having started.
            const response = await getCurrent().expect(200);

            expect(response.body).toEqual({ current: null, upcoming: null });
            expect(asErrorBody(response.body).error).toBeUndefined();
        });

        it('answers with both members null once preferences exist but no week does', async () => {
            await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
            await makePreferences(USER_ID, { time_zone: PLAN_TIME_ZONE });

            expect((await getCurrent().expect(200)).body).toEqual({ current: null, upcoming: null });
        });

        it('reports the week that contains today as current, with nothing upcoming', async () => {
            const dayKey = utcTodayDayKey();
            const { plan } = await seedPlannedWeek(USER_ID);
            const current = asCurrent((await getCurrent().expect(200)).body);

            expect(current.current?.id).toBe(plan.id);
            expect(current.upcoming).toBeNull();

            const week = current.current as MealPlanResponse;

            // The fixture's default week is the one around today, whatever zone
            // its user is in, which is what makes it `current` rather than
            // upcoming or ended.
            expect(week.startDate).toBe(currentPlanStartDayKey());
            expect(week.startDate <= dayKey).toBe(true);
            expect(week.endDate >= dayKey).toBe(true);
            expect(week.status).toBe('active');
            expect(week.days).toHaveLength(PLAN_DAY_COUNT);
        });

        it('reports a week that starts after today as upcoming, with nothing current', async () => {
            const upcomingStart = addDaysToDayKey(utcTodayDayKey(), 3);
            const { plan } = await seedPlannedWeek(USER_ID, { startDate: upcomingStart });
            const current = asCurrent((await getCurrent().expect(200)).body);

            expect(current.current).toBeNull();
            expect(current.upcoming?.id).toBe(plan.id);
            expect(current.upcoming?.startDate).toBe(upcomingStart);
            expect(current.upcoming?.startDate.localeCompare(utcTodayDayKey())).toBeGreaterThan(0);
        });

        it('separates the two when both exist', async () => {
            const dayKey = utcTodayDayKey();
            const { plan, recipe } = await seedPlannedWeek(USER_ID);
            const successorStart = addDaysToDayKey(plan.end_date.toISOString().slice(0, 10), 1);
            const successor = await makePlan(USER_ID, {
                sequence: 491,
                recipeVersionId: recipe.id,
                startDate: successorStart,
            });

            const current = asCurrent((await getCurrent().expect(200)).body);

            expect(current.current?.id).toBe(plan.id);
            expect(current.upcoming?.id).toBe(successor.id);
            // The split is by the calendar and not by insertion order: the
            // successor was written second and is the later week.
            expect(current.current?.endDate).toBe(addDaysToDayKey(successorStart, -1));
            expect(current.upcoming?.startDate).toBe(successorStart);
            expect(current.current?.startDate.localeCompare(dayKey)).toBeLessThanOrEqual(0);
        });
    });

    describe('the plans it must not report', () => {
        it('excludes a week that has ended, however its status column reads', async () => {
            const { plan } = await seedPlannedWeek(USER_ID, {
                startDate: FIXTURE_ENDED_PLAN_START_DAY_KEY,
            });

            // The storage-versus-semantics split §0.5.1 draws: the row keeps
            // `status: 'active'`, and every rule treats the week as ended.
            const stored = await storedPlan(plan.id);

            expect(stored.status).toBe('active');
            expect(stored.end_date.toISOString().slice(0, 10).localeCompare(utcTodayDayKey())).toBeLessThan(0);

            expect((await getCurrent().expect(200)).body).toEqual({ current: null, upcoming: null });
        });

        it('excludes a superseded week', async () => {
            const { plan } = await seedPlannedWeek(USER_ID);

            await prisma.meal_plans.update({
                where: { id: plan.id, user_id: USER_ID },
                data: { status: 'superseded', revision: FIRST_REVISION + 1 },
            });

            expect((await getCurrent().expect(200)).body).toEqual({ current: null, upcoming: null });
        });

        it('reports the replacement, and never the week it replaced, after a regeneration', async () => {
            // THE COHERENCE THIS COLLECTION OWES ITS CLIENT. Resolving which
            // plan is `current` and describing that plan are separate reads, and
            // a regeneration committing between them used to produce a body no
            // state of the database ever held: the superseded predecessor,
            // reported under `current`, carrying the `'superseded'` status the
            // later read saw. `mealPlan.service.ts::readInPlanSnapshot` answers
            // both from one `RepeatableRead` snapshot, so the member a plan
            // arrives under and the status inside it are the same instant.
            //
            // Driven through the real regeneration route rather than an UPDATE
            // to `status`, because a hand-written column would leave no
            // successor — and the successor is the half of the answer that must
            // appear.
            await seedGeneratorWorld(USER_ID);

            const replaced = await publishWeek({ startDate: utcTodayDayKey() });
            const replacement = asPlan(
                (await postRegenerate(replaced.id, regenerateBody()).expect(201)).body,
            );

            expect(await storedPlan(replaced.id)).toMatchObject({ status: 'superseded' });

            const current = asCurrent((await getCurrent().expect(200)).body);

            expect(current.current?.id).toBe(replacement.id);
            expect(current.current?.status).toBe('active');
            expect(current.current?.revision).toBe(FIRST_REVISION);
            // The replaced week occupied the same dates, so it can only have
            // been excluded by its lifecycle; and it is not hiding in the other
            // member either.
            expect(current.upcoming).toBeNull();

            for (const member of [current.current, current.upcoming]) {
                if (member !== null && member !== undefined) {
                    expect(member.status).toBe('active');
                    expect(member.id).not.toBe(replaced.id);
                }
            }
        });

        it('excludes another tenant’s week', async () => {
            const { plan } = await seedPlannedWeek(OTHER_USER_ID, { sequence: 492 });

            await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
            await makePreferences(USER_ID, { time_zone: PLAN_TIME_ZONE });

            expect((await getCurrent().expect(200)).body).toEqual({ current: null, upcoming: null });

            // Visible to the tenant who owns it, so the exclusion above is the
            // predicate at work rather than an empty database.
            expect(asCurrent((await getCurrent(OTHER_USER_ID).expect(200)).body).current?.id).toBe(plan.id);
        });
    });

    describe('route resolution', () => {
        it('reaches its own handler rather than being read as a plan id', async () => {
            const { plan } = await seedPlannedWeek(USER_ID);
            const response = await getCurrent().expect(200);
            const body = asErrorBody(response.body);

            // `current` is a literal segment declared before `/plans/:planId/...`
            // (Rule §3.1). Were it captured as an id, this would be a
            // `400 invalid_request` naming `planId` — or, with a permissive
            // parser, a day envelope.
            expect(Object.keys(body).sort()).toEqual(['current', 'upcoming']);
            expect(body.planId).toBeUndefined();
            expect(body.day).toBeUndefined();
            expect(body.error).toBeUndefined();
            expect(asCurrent(response.body).current?.id).toBe(plan.id);
        });

        it('refuses an unauthenticated caller before any of that', async () => {
            await seedPlannedWeek(USER_ID);

            // Identity comes only from the verified token the harness stands in
            // for; without it the request never reaches a handler (Rule §4).
            await request.get(`${PLANS_PATH}/current`).expect(401);
        });
    });
});


/* ---------------------------------------------------------------------------
 * GET /api/meal-planning/plans/:planId/days/:date
 * ------------------------------------------------------------------------- */

describe('GET /api/meal-planning/plans/:planId/days/:date', () => {
    it('answers with the day inside an envelope that states the plan it came from', async () => {
        const dayKey = utcTodayDayKey();
        const { plan } = await seedPlannedWeek(USER_ID);
        const response = await getDay(plan.id, dayKey).expect(200);
        const envelope = asEnvelope(response.body);

        expect(envelope.planId).toBe(plan.id);
        // The two members the client acts on: it disables Swap and Log on a
        // status that is not active, and refetches when the revision has moved
        // past the one it holds.
        expect(envelope.planRevision).toBe(FIRST_REVISION);
        expect(envelope.planStatus).toBe('active');

        expect(envelope.day.date).toBe(dayKey);
        expect(envelope.day.meals).toHaveLength(MEALS_PER_DAY);
        expect(envelope.day.isLastDay).toBe(false);
        expect(Object.keys(envelope.day.plannedTotals).sort()).toEqual([
            'calories',
            'carbs',
            'fat',
            'protein',
        ]);
    });

    it('stays readable for a superseded plan, and says so', async () => {
        const dayKey = utcTodayDayKey();
        const { plan } = await seedPlannedWeek(USER_ID);

        await prisma.meal_plans.update({
            where: { id: plan.id, user_id: USER_ID },
            data: { status: 'superseded', revision: FIRST_REVISION + 1 },
        });

        const envelope = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);

        // History stays available: a diary entry logged from this plan still
        // links to a meal a client can open.
        expect(envelope.planStatus).toBe('superseded');
        expect(envelope.planRevision).toBe(FIRST_REVISION + 1);
        expect(envelope.day.meals).toHaveLength(MEALS_PER_DAY);
    });

    it('reports a regenerated-away week as superseded and unwritable, at the revision it now holds', async () => {
        // The envelope's LIFECYCLE CLAIM and the day rows beside it come from
        // separate reads, and after a real supersession those two reads used to
        // be able to disagree: the plan row read first said `'active'` at
        // revision 1 while the regeneration had already moved it, so the body
        // invited a Swap or a Log that the write path would refuse with
        // `409 plan_not_active`. Both now come from one `RepeatableRead`
        // snapshot (`readInPlanSnapshot`), so what the envelope says about the
        // week matches the day it returns.
        //
        // `api/planDayWriteability.test.ts` owns the lifecycle × zone matrix;
        // what is asserted here is this route's contract after the one
        // transition a user can actually cause, and that history stays readable
        // through it.
        const dayKey = utcTodayDayKey();

        await seedGeneratorWorld(USER_ID);

        const replaced = await publishWeek({ startDate: dayKey });
        const replacement = asPlan((await postRegenerate(replaced.id, regenerateBody()).expect(201)).body);
        const stored = await storedPlan(replaced.id);

        expect(stored.status).toBe('superseded');

        const superseded = asEnvelope((await getDay(replaced.id, dayKey).expect(200)).body);

        expect(superseded.planId).toBe(replaced.id);
        expect(superseded.planStatus).toBe('superseded');
        // The revision the row holds NOW, not the one it held when the client
        // last looked — freshness is what lets a stale screen notice it moved.
        expect(superseded.planRevision).toBe(stored.revision);
        expect(superseded.planRevision).toBe(FIRST_REVISION + 1);
        expect(superseded.isWritable).toBe(false);
        // Readable, and still its own week: the diary entries logged from it
        // link to these meals (§0.5.2 defines no `plan_not_active` on this
        // route).
        expect(superseded.day.date).toBe(dayKey);
        expect(superseded.day.meals).toHaveLength(MEALS_PER_DAY);

        const active = asEnvelope((await getDay(replacement.id, dayKey).expect(200)).body);

        expect(active).toMatchObject({
            planId: replacement.id,
            planStatus: 'active',
            planRevision: FIRST_REVISION,
            isWritable: true,
        });
        expect(active.day.meals).toHaveLength(MEALS_PER_DAY);
    });

    it('reports every day of the week it holds, and no other', async () => {
        const { plan } = await seedPlannedWeek(USER_ID);
        const startKey = plan.start_date.toISOString().slice(0, 10);

        for (let index = 0; index < PLAN_DAY_COUNT; index += 1) {
            const dayKey = addDaysToDayKey(startKey, index);
            const envelope = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);

            expect(envelope.day.date).toBe(dayKey);
            expect(envelope.day.dayIndex).toBe(index);
            expect(envelope.day.isLastDay).toBe(index === PLAN_DAY_COUNT - 1);
        }

        // One day either side of the week: a real calendar date the plan simply
        // does not cover, which is a missing resource and not a bad request.
        await getDay(plan.id, addDaysToDayKey(startKey, -1)).expect(404);
        await getDay(plan.id, addDaysToDayKey(startKey, PLAN_DAY_COUNT)).expect(404);
    });

    it('names the date when it is not a calendar day at all', async () => {
        const { plan } = await seedPlannedWeek(USER_ID);

        for (const malformed of ['2026-13-01', '2026-02-30', 'tomorrow', '2026-9-1']) {
            const body = asErrorBody((await getDay(plan.id, malformed).expect(400)).body);

            expect(body.error).toBe('invalid_request');
            expect(body.details).toEqual([{ field: 'date', code: 'invalid_date' }]);
        }
    });

    it('names the plan id when it is not a uuid', async () => {
        await seedPlannedWeek(USER_ID);

        const body = asErrorBody((await getDay('not-a-uuid', utcTodayDayKey()).expect(400)).body);

        expect(body.error).toBe('invalid_request');
        expect(body.details).toEqual([{ field: 'planId', code: 'invalid_id' }]);
    });

    it('answers a foreign plan and an absent one with the very same 404', async () => {
        const dayKey = utcTodayDayKey();
        const foreign = await seedPlannedWeek(OTHER_USER_ID, { sequence: 495 });

        await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
        await makePreferences(USER_ID, { time_zone: PLAN_TIME_ZONE });

        const foreignResponse = await getDay(foreign.plan.id, dayKey).expect(404);
        const absentResponse = await getDay(ABSENT_PLAN_ID, dayKey).expect(404);

        // Body equality and not merely two 404s: "does not exist" and "is not
        // yours" must be indistinguishable, or the status leaks the existence of
        // another tenant's row (Rules §1.5 and §8).
        expect(foreignResponse.body).toEqual(absentResponse.body);
        expect(foreignResponse.status).toBe(absentResponse.status);

        const body = asErrorBody(foreignResponse.body);

        expect(typeof body.error).toBe('string');
        expect(body.details).toBeUndefined();
        expect(JSON.stringify(foreignResponse.body)).not.toContain(OTHER_USER_ID);

        // And the row itself is untouched and still visible to its owner.
        expect(asEnvelope((await getDay(foreign.plan.id, dayKey, OTHER_USER_ID).expect(200)).body).planId).toBe(
            foreign.plan.id,
        );
    });
});

/* ---------------------------------------------------------------------------
 * The snapshot the two lifecycle-reporting reads share
 *
 * The cases above assert the CONTRACT those reads owe: a plan arrives under the
 * member its lifecycle says it belongs to, and the envelope reports the week's
 * revision as it now stands. Neither can fail on an unlucky interleaving,
 * because neither stages one — so they would both stay green if the reads went
 * back to the autocommit client, which is precisely the defect
 * `mealPlan.service.ts::readInPlanSnapshot` exists to prevent.
 *
 * What the two cases here pin is the MECHANISM, with no race to lose. The first
 * reads back the isolation level each read asks for, because `RepeatableRead` is
 * load-bearing rather than decorative: PostgreSQL's default READ COMMITTED takes
 * a fresh snapshot per statement, so a transaction at that level would leave
 * both reads exactly as interleavable as they were. The second stages the
 * interleaving deliberately — a supersession committed on another connection
 * after the read's snapshot is open — and asserts the read still describes the
 * week it resolved, which is the whole of what one snapshot buys.
 * ------------------------------------------------------------------------- */

/**
 * Captures the options every `prisma.$transaction` of one call is opened with,
 * and lets a test act between BEGIN and the work inside it.
 *
 * The original is bound before the spy is installed, so the pass-through cannot
 * re-enter the mock; `interleave` runs after one statement has been issued on
 * the transaction client — which is where PostgreSQL takes a `RepeatableRead`
 * transaction's snapshot — and before the read's own first statement.
 */
const recordTransactions = async <TResult>(
    call: () => Promise<TResult>,
    interleave?: () => Promise<void>,
): Promise<{ result: TResult; options: unknown[] }> => {
    const options: unknown[] = [];
    const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
        const [work, passed] = args;

        options.push(passed);

        if (interleave === undefined) {
            return original(work, passed);
        }

        return original(async (tx: Prisma.TransactionClient) => {
            // One statement, to open the snapshot, then the concurrent commit.
            await tx.meal_plans.count({ where: { user_id: USER_ID } });
            await interleave();

            return (work as (client: Prisma.TransactionClient) => Promise<unknown>)(tx);
        }, passed);
    }) as never);

    try {
        return { result: await call(), options };
    } finally {
        spy.mockRestore();
    }
};

describe('the two lifecycle reads share one snapshot', () => {
    it('opens exactly one RepeatableRead transaction each, and the flag read opens none', async () => {
        const dayKey = utcTodayDayKey();
        const { plan } = await seedPlannedWeek(USER_ID);

        const current = await recordTransactions(() => getCurrentMealPlan(USER_ID));

        // One transaction for the whole read — the zone, the lifecycle states
        // the members are chosen from, and each chosen week's own rows.
        expect(current.options).toEqual([{ isolationLevel: 'RepeatableRead' }]);
        expect(current.result.current?.id).toBe(plan.id);

        const day = await recordTransactions(() => getMealPlanDay(USER_ID, plan.id, dayKey));

        expect(day.options).toEqual([{ isolationLevel: 'RepeatableRead' }]);
        expect(day.result.kind).toBe('ok');

        // The documented asymmetry: `getAffectedMeals` makes no lifecycle claim,
        // so it stays on the autocommit client and opens nothing. Asserted so
        // the split is a decision on the record rather than an oversight.
        const affected = await recordTransactions(() => getAffectedMeals(USER_ID, plan.id));

        expect(affected.options).toEqual([]);
        expect(affected.result.kind).toBe('ok');
    });

    it('describes the week it resolved even when a supersession commits mid-read', async () => {
        // THE INTERLEAVING ONE SNAPSHOT RULES OUT, STAGED. The read's snapshot
        // is open; then another connection supersedes the very plan it is about
        // to resolve and describe. With one snapshot the answer is the week as it
        // stood — resolved as `current` AND reported `'active'`, one instant
        // throughout. Statement by statement it would not be: the resolution and
        // the hydration would straddle the commit and the body would claim a
        // status no answer of this route may carry.
        await seedGeneratorWorld(USER_ID);

        const plan = await publishWeek({ startDate: utcTodayDayKey() });
        const supersede = async (): Promise<void> => {
            await prisma.meal_plans.update({
                where: { id: plan.id, user_id: USER_ID },
                data: { status: 'superseded', revision: FIRST_REVISION + 1 },
            });
        };

        const { result, options } = await recordTransactions(
            () => getCurrentMealPlan(USER_ID),
            supersede,
        );

        expect(options).toEqual([{ isolationLevel: 'RepeatableRead' }]);
        expect(result.current?.id).toBe(plan.id);
        expect(result.current?.status).toBe('active');
        expect(result.current?.revision).toBe(FIRST_REVISION);
        expect(result.current?.days).toHaveLength(PLAN_DAY_COUNT);

        // The commit really landed, so the coherent answer above was a snapshot
        // and not a database that never changed.
        expect(await storedPlan(plan.id)).toMatchObject({
            status: 'superseded',
            revision: FIRST_REVISION + 1,
        });

        // And nothing of that view outlives the request: the next read resolves
        // against the committed state, where the week is gone.
        expect((await getCurrent().expect(200)).body).toEqual({ current: null, upcoming: null });
    });
});

/* ---------------------------------------------------------------------------
 * GET /api/meal-planning/plans/:planId/affected-meals
 * ------------------------------------------------------------------------- */

const PREFERENCES_PATH = '/api/meal-planning/preferences';

/**
 * A preference edit through the canonical route.
 *
 * `api/preferences.test.ts` owns this endpoint; it is driven here because the
 * flag recomputation it performs is the only honest way to produce a flagged
 * plan, and a hand-written `flags` column would prove nothing about what the
 * product actually flags.
 */
const putPreferences = (body: RequestBody, userId: string = USER_ID) =>
    asUser(request.put(PREFERENCES_PATH).send(body), { uid: userId });

describe('GET /api/meal-planning/plans/:planId/affected-meals', () => {
    it('lists nothing while every planned meal still matches the preferences', async () => {
        const { plan } = await seedPlannedWeek(USER_ID);
        const affected = asAffected((await getAffected(plan.id).expect(200)).body);

        expect(affected).toEqual({ meals: [] });
    });

    it('lists exactly the meals a preference edit made incompatible', async () => {
        // The plan's own recipe carries milk in its ingredient snapshot; the
        // catalog food's allergen status is `known`, so the recipe is plannable
        // today and flaggable the moment the user declares the allergy.
        const { plan, food, recipe: withMilk } = await seedPlannedWeek(USER_ID, {
            recipeOptions: { allergenTags: ['milk'] },
        });
        const clean = await seedRecipe(food.id, 496, 'plans-suite-affected-clean');

        // Two of the three slots move to a recipe without milk, so the response
        // has to discriminate rather than return the whole week.
        await prisma.meal_plan_meals.updateMany({
            where: { meal_plan_id: plan.id, slot: { in: ['breakfast', 'dinner'] }, user_id: USER_ID },
            data: { recipe_version_id: clean.id },
        });

        const save = await putPreferences({
            allergens: ['milk'],
            timeZone: PLAN_TIME_ZONE,
            expectedRevision: 1,
        }).expect(200);

        expect(asErrorBody(save.body).affectedMealCount).toBe(PLAN_DAY_COUNT);

        const affected = asAffected((await getAffected(plan.id).expect(200)).body);

        expect(affected.meals).toHaveLength(PLAN_DAY_COUNT);
        expect(new Set(affected.meals.map((meal) => meal.slot))).toEqual(new Set(['lunch']));
        expect(affected.meals.map((meal) => meal.recipeName)).toEqual(
            Array.from({ length: PLAN_DAY_COUNT }, () => withMilk.name),
        );
        expect(affected.meals.map((meal) => meal.date)).toEqual(
            Array.from({ length: PLAN_DAY_COUNT }, (_unused, index) =>
                addDaysToDayKey(plan.start_date.toISOString().slice(0, 10), index),
            ),
        );

        // The same `{code, detail[]}` shape the day view carries, so one client
        // mapping serves both surfaces.
        for (const meal of affected.meals) {
            expect(meal.flags).toEqual([{ code: 'allergen', detail: ['milk'] }]);
        }

        const dayKey = utcTodayDayKey();
        const envelope = asEnvelope((await getDay(plan.id, dayKey).expect(200)).body);

        expect(mealIn(envelope.day, 'lunch').flags).toEqual([{ code: 'allergen', detail: ['milk'] }]);
        expect(mealIn(envelope.day, 'breakfast').flags).toEqual([]);

        // Every listed meal belongs to this plan and is one of its own rows.
        const mealIds = new Set((await storedMeals(plan.id)).map((meal) => meal.id));

        for (const meal of affected.meals) {
            expect(mealIds.has(meal.mealId)).toBe(true);
        }
    });

    it('answers a foreign plan and an absent one with the very same 404', async () => {
        const foreign = await seedPlannedWeek(OTHER_USER_ID, { sequence: 497 });

        await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
        await makePreferences(USER_ID, { time_zone: PLAN_TIME_ZONE });

        const foreignResponse = await getAffected(foreign.plan.id).expect(404);
        const absentResponse = await getAffected(ABSENT_PLAN_ID).expect(404);

        expect(foreignResponse.body).toEqual(absentResponse.body);
        expect(asAffected((await getAffected(foreign.plan.id, OTHER_USER_ID).expect(200)).body)).toEqual({
            meals: [],
        });
    });

    it('names the plan id when it is not a uuid', async () => {
        await seedPlannedWeek(USER_ID);

        const body = asErrorBody((await getAffected('42').expect(400)).body);

        expect(body.error).toBe('invalid_request');
        expect(body.details).toEqual([{ field: 'planId', code: 'invalid_id' }]);
    });
});


/* ---------------------------------------------------------------------------
 * POST /api/meal-planning/plans/:planId/regenerate
 *
 * These cases publish their first week through the ROUTE rather than with
 * `makePlan`, because a regeneration reads and rewrites a grocery list and
 * carries a generation attempt forward — state only a real publication has.
 * ------------------------------------------------------------------------- */

/** Publishes a week through the route and answers with its response body. */
const publishWeek = async (
    overrides: GenerateBodyOverrides = {},
): Promise<MealPlanResponse> => asPlan((await postPlan(generateBody(overrides)).expect(201)).body);

/**
 * Everything a regeneration would touch about the week it replaces, read as
 * STORED.
 *
 * WHOLE ROWS, not a projection of the interesting columns. Every refusal and
 * every rollback below promises that the published week is exactly as it was,
 * and a projection proves that only of the columns someone thought to name —
 * the revision the supersede bumped, the `replaced_plan_id` it stamped, the
 * `checked_at` a rebuilt list rewrote or the flag it raised would each sit
 * outside it. Prisma's `Decimal` and `Date` values compare BY VALUE under
 * `toEqual`, so two reads of an unchanged row are equal without being
 * reformatted first, and each reader above fixes its own order.
 *
 * The user's OTHER plans and the action ledger travel in the same snapshot,
 * because "nothing moved" includes the successor plan a refused regeneration
 * must not have left behind and the reservation it must not have stranded.
 */
const weekSnapshot = async (planId: string, userId: string = USER_ID) => ({
    plan: await storedPlan(planId),
    days: await storedDays(planId),
    meals: await storedMeals(planId),
    groceries: await storedGroceries(planId),
    plans: await storedPlans(userId),
    actions: await storedActions(userId),
});

type WeekSnapshot = Awaited<ReturnType<typeof weekSnapshot>>;

/**
 * Re-reads the week a snapshot was taken of and insists it is what it was.
 *
 * Six comparisons rather than one deep-equal of the whole object, so a failure
 * names WHICH part of the promise broke: the plan row, a day, a meal, a grocery
 * line's amount or check state, a plan that appeared, or a ledger row.
 */
const expectWeekUnchanged = async (before: WeekSnapshot): Promise<void> => {
    const after = await weekSnapshot(before.plan.id, before.plan.user_id);

    expect(after.plan).toEqual(before.plan);
    expect(after.days).toEqual(before.days);
    expect(after.meals).toEqual(before.meals);
    expect(after.groceries).toEqual(before.groceries);
    expect(after.plans).toEqual(before.plans);
    expect(after.actions).toEqual(before.actions);
};

/**
 * Checks the week's single grocery line through the real route, as a user's tap
 * would, and answers with its id.
 *
 * Through the ROUTE for the reason the carry-over case above states: writing
 * `is_checked` by hand sets no acknowledged baseline, so the check state a
 * refusal has to leave alone would not be the state the product produces. Every
 * generator world here shops for one food, so one line is the whole list and a
 * second would mean the world changed under the case.
 */
const checkTheOnlyGroceryLine = async (planId: string): Promise<string> => {
    const rows = await storedGroceries(planId);
    const line = rows[0];

    if (rows.length !== 1 || line === undefined) {
        throw new Error(
            `a published week shops for exactly one line; plan ${planId} has ${String(rows.length)}`,
        );
    }

    await asUser(
        request.put(`${PLANS_PATH}/${planId}/groceries/${line.id}`).send({ isChecked: true }),
        { uid: USER_ID },
    ).expect(200);

    return line.id;
};

describe('POST /api/meal-planning/plans/:planId/regenerate', () => {
    describe('replacing a week', () => {
        it('supersedes the old plan, links the replacement and carries the attempt forward', async () => {
            await seedGeneratorWorld(USER_ID);

            const first = await publishWeek({ startDate: utcTodayDayKey() });
            const response = await postRegenerate(first.id, regenerateBody()).expect(201);
            const second = asPlan(response.body);

            expect(second.id).not.toBe(first.id);
            expect(second).toMatchObject({
                status: 'active',
                revision: FIRST_REVISION,
                generationAttempt: FIRST_ATTEMPT + 1,
                // The same week: a regeneration replaces the plan in place and
                // never moves its dates (§0.5.1), which is why its request
                // carries no start date.
                startDate: first.startDate,
                endDate: first.endDate,
            });
            expect(second.days).toHaveLength(PLAN_DAY_COUNT);
            expect(second.summary.plannedMeals).toBe(PLAN_DAY_COUNT * MEALS_PER_DAY);

            const old = await storedPlan(first.id);

            expect(old.status).toBe('superseded');
            expect(old.revision).toBe(FIRST_REVISION + 1);

            const replacement = await storedPlan(second.id);

            expect(replacement.status).toBe('active');
            expect(replacement.generation_attempt).toBe(FIRST_ATTEMPT + 1);
            // The pointer the client's "this plan was replaced" screen follows.
            expect(replacement.replaced_plan_id).toBe(first.id);

            // Exactly one active plan for the week, which the partial unique
            // index on `(user_id, start_date) WHERE status = 'active'` also
            // insists on.
            const active = (await storedPlans()).filter((plan) => plan.status === 'active');

            expect(active.map((plan) => plan.id)).toEqual([second.id]);

            // And the ledger records the second write beside the first.
            const actions = await storedActions();

            expect(actions.map((action) => action.action_type)).toEqual(['generate', 'regenerate']);
            expect(actions[1]).toMatchObject({ response_status: 201, meal_plan_id: second.id });
        });

        it('keeps the check mark on a grocery line the new week did not change', async () => {
            await seedGeneratorWorld(USER_ID);

            const first = await publishWeek({ startDate: utcTodayDayKey() });
            const before = await storedGroceries(first.id);

            expect(before).toHaveLength(1);

            const line = before[0];

            if (line === undefined) {
                throw new Error('a published week must have shopped for something');
            }

            // The aggregate is the plan's own arithmetic, not a number typed
            // twice: §0.7.3's `gram_weight ÷ yield_servings × portion_multiplier`
            // summed over every planned meal, and every fixture recipe shops for
            // the same food.
            const plannedGrams = first.days.reduce(
                (total, day) =>
                    total +
                    day.meals.reduce((sum, meal) => sum + meal.portionMultiplier * GRAMS_PER_SERVING, 0),
                0,
            );

            expect(line.quantity_grams.toNumber()).toBeCloseTo(plannedGrams, 2);

            // Checked through the real route, so the row carries the same
            // acknowledged baseline a user's tap would leave behind. Writing
            // `is_checked` by hand would set no baseline and quietly test a
            // state the product never produces.
            await asUser(
                request.put(`${PLANS_PATH}/${first.id}/groceries/${line.id}`).send({ isChecked: true }),
                { uid: USER_ID },
            ).expect(200);

            const checked = await prisma.grocery_items.findUniqueOrThrow({ where: { id: line.id } });

            expect(checked.is_checked).toBe(true);
            expect(checked.previous_quantity_grams?.equals(line.quantity_grams)).toBe(true);

            const second = await postRegenerate(first.id, regenerateBody()).expect(201);
            const after = await storedGroceries(asPlan(second.body).id);

            expect(after).toHaveLength(1);

            const rebuilt = after[0];

            if (rebuilt === undefined) {
                throw new Error('the regenerated week must have shopped for something');
            }

            // Every fixture recipe shops for the same food in the same amount,
            // so the line is identical and the user's check survives the
            // rebuild. What an amount CHANGE does to it is `api/grocery.test.ts`.
            expect(rebuilt.catalog_food_id).toBe(line.catalog_food_id);
            expect(rebuilt.food_state).toBe(line.food_state);
            expect(rebuilt.quantity_grams.equals(line.quantity_grams)).toBe(true);
            expect(rebuilt.is_checked).toBe(true);
            expect(rebuilt.checked_at).not.toBeNull();
            // The baseline the user acknowledged travels with the check mark, so
            // a LATER increase still compares against the amount they actually
            // saw; the flag stays clear because nothing moved (§0.7.3).
            expect(rebuilt.previous_quantity_grams?.equals(line.quantity_grams)).toBe(true);
            expect(rebuilt.flagged_at).toBeNull();

            // The old plan keeps its own list; nothing is moved between plans.
            expect(await storedGroceries(first.id)).toHaveLength(1);
        });

        it('leaves the diary exactly as it was', async () => {
            await seedGeneratorWorld(USER_ID);

            const startDate = utcTodayDayKey();
            const first = await publishWeek({ startDate });
            const firstDay = asEnvelope((await getDay(first.id, startDate).expect(200)).body).day;
            const plannedMeal = firstDay.meals[0];

            if (plannedMeal === undefined) {
                throw new Error('the published week must plan a first meal');
            }

            const bucket = await seedDiaryBucket(USER_ID, startDate);
            const entry = await seedDiaryEntry({
                mealId: bucket.id,
                dayKey: startDate,
                plannedMealId: plannedMeal.id,
                recipeVersionId: plannedMeal.recipe.versionId,
                loggedAt: new Date(`${startDate}T08:05:00.000Z`),
            });

            const second = asPlan((await postRegenerate(first.id, regenerateBody()).expect(201)).body);
            const stored = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

            // §0.7.4's "Logged food — Kept": the entry, its links and its
            // snapshot all survive, because the old plan's meals are superseded
            // rather than deleted.
            expect(stored.deleted_at).toBeNull();
            expect(stored.meal_plan_meal_id).toBe(plannedMeal.id);
            expect(stored.recipe_version_id).toBe(plannedMeal.recipe.versionId);
            expect(stored.calories).toBe(700);
            expect(await prisma.meal_plan_meals.count({ where: { id: plannedMeal.id } })).toBe(1);

            // It stays attached to the week it was eaten from, so the new week
            // does not pretend the meal was already logged.
            expect(second.summary.loggedEntryCount).toBe(0);
            expect(
                dayOn(second, startDate).meals.flatMap((meal) => meal.loggedEntries),
            ).toEqual([]);

            const history = asEnvelope((await getDay(first.id, startDate).expect(200)).body);

            expect(history.planStatus).toBe('superseded');
            expect(
                mealIn(history.day, plannedMeal.slot).loggedEntries.map((logged) => logged.entryId),
            ).toEqual([entry.id]);
        });
    });

    describe('the idempotency ledger', () => {
        it('replays the stored 201 verbatim, even though the plan it pinned is now superseded', async () => {
            await seedGeneratorWorld(USER_ID);

            const first = await publishWeek({ startDate: utcTodayDayKey() });
            const body = regenerateBody();
            const committed = await postRegenerate(first.id, body).expect(201);

            expect(await storedActions()).toHaveLength(2);

            const replayed = await postRegenerate(first.id, body).expect(201);

            // The pinned revision is now wrong and the plan is no longer active,
            // and neither matters: §0.5.1 replays BEFORE any status or revision
            // check, so a lost response resolves to the answer it already earned.
            expect(replayed.body).toEqual(committed.body);
            expect(replayed.text).toBe(committed.text);
            expect(await storedActions()).toHaveLength(2);
            expect((await storedPlans()).filter((plan) => plan.status === 'active')).toHaveLength(1);
        });

        it('refuses a used key that carries a different request', async () => {
            await seedGeneratorWorld(USER_ID);

            const first = await publishWeek({ startDate: utcTodayDayKey() });
            const idempotencyKey = randomUUID();

            const committed = asPlan(
                (await postRegenerate(first.id, regenerateBody({ idempotencyKey })).expect(201)).body,
            );

            // Same key, different pinned revision: a genuinely different write
            // wearing a used key, which is never a retry.
            const conflict = await postRegenerate(
                first.id,
                regenerateBody({ idempotencyKey, expectedPlanRevision: FIRST_REVISION + 1 }),
            ).expect(409);

            expect(asErrorBody(conflict.body)).toEqual({ error: 'idempotency_conflict' });
            expect(await storedActions()).toHaveLength(2);
            expect((await storedPlans()).filter((plan) => plan.status === 'active').map((plan) => plan.id)).toEqual([
                committed.id,
            ]);
        });
    });

    describe('the refusals', () => {
        it('reports the current revision when the client pinned another', async () => {
            await seedGeneratorWorld(USER_ID);

            const first = await publishWeek({ startDate: utcTodayDayKey() });
            const response = await postRegenerate(
                first.id,
                regenerateBody({ expectedPlanRevision: 99 }),
            ).expect(409);

            expect(asErrorBody(response.body)).toEqual({
                error: 'stale_plan',
                currentRevision: FIRST_REVISION,
            });
            expect(await storedPlan(first.id)).toMatchObject({ status: 'active', revision: FIRST_REVISION });
            expect(await storedActions()).toHaveLength(1);
        });

        it('names the plan that replaced a superseded one', async () => {
            await seedGeneratorWorld(USER_ID);

            const first = await publishWeek({ startDate: utcTodayDayKey() });
            const second = asPlan((await postRegenerate(first.id, regenerateBody()).expect(201)).body);

            // The old id with its real, current revision: the refusal is about
            // the plan's lifecycle and not about a stale number.
            const response = await postRegenerate(
                first.id,
                regenerateBody({ expectedPlanRevision: FIRST_REVISION + 1 }),
            ).expect(409);

            expect(asErrorBody(response.body)).toEqual({
                error: 'plan_not_active',
                replacementPlanId: second.id,
            });
        });

        it('says a week has ended rather than naming a replacement', async () => {
            const { plan } = await seedPlannedWeek(USER_ID, {
                startDate: FIXTURE_ENDED_PLAN_START_DAY_KEY,
            });

            const response = await postRegenerate(plan.id, regenerateBody()).expect(409);

            // The same code with a different payload: the stored status still
            // reads `active`, and every write rule treats the week as over.
            expect(asErrorBody(response.body)).toEqual({ error: 'plan_not_active', reason: 'ended' });
            expect((await storedPlan(plan.id)).status).toBe('active');
            expect(await storedActions()).toHaveLength(0);
        });

        it('reports both pinned input revisions when either has moved', async () => {
            await seedGeneratorWorld(USER_ID);

            const first = await publishWeek({ startDate: utcTodayDayKey() });
            const response = await postRegenerate(
                first.id,
                regenerateBody({ expectedPreferencesRevision: 99 }),
            ).expect(409);
            const body = asErrorBody(response.body);

            expect(body.error).toBe('stale_revision');
            expect(body.preferencesRevision).toBe(1);
            expect(body.targetsRevision).toBe(1);
            expect((await storedPlan(first.id)).status).toBe('active');
        });

        it('refuses a setup that has been taken back below review', async () => {
            await seedGeneratorWorld(USER_ID);

            const first = await publishWeek({ startDate: utcTodayDayKey() });

            await prisma.meal_plan_preferences.update({
                where: { user_id: USER_ID },
                data: { setup_status: 'in_progress' },
            });

            const response = await postRegenerate(first.id, regenerateBody()).expect(409);

            expect(asErrorBody(response.body)).toEqual({ error: 'preferences_incomplete' });
            expect((await storedPlan(first.id)).status).toBe('active');
        });

        it('answers a foreign plan and an absent one with the very same 404', async () => {
            const foreign = await seedPlannedWeek(OTHER_USER_ID, { sequence: 498 });

            await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
            await makePreferences(USER_ID, { time_zone: PLAN_TIME_ZONE });

            const foreignResponse = await postRegenerate(foreign.plan.id, regenerateBody()).expect(404);
            const absentResponse = await postRegenerate(ABSENT_PLAN_ID, regenerateBody()).expect(404);

            expect(foreignResponse.body).toEqual(absentResponse.body);

            // The other tenant's week is untouched, and nothing was reserved
            // against either id.
            expect(await storedPlan(foreign.plan.id)).toMatchObject({
                status: 'active',
                revision: FIRST_REVISION,
            });
            expect(await storedActions()).toHaveLength(0);
            expect(await storedActions(OTHER_USER_ID)).toHaveLength(0);
        });

        it('names the plan id when it is not a uuid', async () => {
            await seedGeneratorWorld(USER_ID);

            const body = asErrorBody((await postRegenerate('nope', regenerateBody()).expect(400)).body);

            expect(body.error).toBe('invalid_request');
            expect(body.details).toEqual([{ field: 'planId', code: 'invalid_id' }]);
        });
    });

    /* -----------------------------------------------------------------------
     * The two 422 verdicts — §0.5.2's "the same 422 codes with the old plan
     * intact"
     *
     * Regeneration inherits both of generation's 422s, and each says something
     * different: `targets_missing` is the targets gate refusing to build a week
     * on numbers that are not all there, and `no_matching_meals` is the search
     * itself reporting that no week fits the answers on file. §0.5.2 attaches
     * ONE promise to both — the week the user already has is intact — so each
     * case here is half a shape assertion and half an atomicity proof, compared
     * against a complete snapshot of the published week taken with a grocery
     * line already checked.
     *
     * Both verdicts are raised before the publication transaction opens, so
     * what they prove is that the ledger and the plan are never reached. The
     * failure that fires INSIDE the transaction, once the replacement rows
     * exist, is the last describe of this block.
     * --------------------------------------------------------------------- */

    describe('the 422 verdicts', () => {
        it('answers targets_missing, names the cleared fields, and leaves the week whole', async () => {
            await seedGeneratorWorld(USER_ID);

            const first = await publishWeek({ startDate: utcTodayDayKey() });

            await checkTheOnlyGroceryLine(first.id);

            // Two of the four columns the planner needs, cleared directly: the
            // shape of an account whose target set is not all there, which
            // §0.5.2 describes as the independently nullable legacy case. The
            // gate reads the pair as INCOMPLETE and NAMES the fields, rather
            // than answering `targets_unconfirmed` about values it cannot judge
            // at all. The truth matrix itself is `api/targets.test.ts`'s.
            await prisma.users.update({
                where: { id: USER_ID },
                data: { target_carbs_g: null, target_fat_g: null },
            });

            const before = await weekSnapshot(first.id);
            // Every pin in the body is the CURRENT value — the plan's revision,
            // the preferences' and the targets' — so `targets_missing` is the
            // only refusal this request can earn. A stale pin would be answered
            // 409 by the plan's own gate or by the revision comparison before
            // the targets were ever judged, and the case would pass while
            // proving nothing about either.
            const response = await postRegenerate(first.id, regenerateBody()).expect(422);

            expect(asErrorBody(response.body)).toEqual({
                error: 'targets_missing',
                // In the canonical field order, and only the two that were
                // cleared: 09b asks the user for exactly these.
                missing: ['carbs', 'fat'],
            });

            expect(await storedPlan(first.id)).toMatchObject({
                status: 'active',
                revision: FIRST_REVISION,
                generation_attempt: FIRST_ATTEMPT,
                replaced_plan_id: null,
                // The audit column a regeneration writes about a week it
                // replaces; a refusal leaves it unwritten.
                incompatibility_flags: null,
            });
            expect(await storedDays(first.id)).toHaveLength(PLAN_DAY_COUNT);
            expect(await storedMeals(first.id)).toHaveLength(PLAN_DAY_COUNT * MEALS_PER_DAY);
            // Only the publication's own row: the refusal reserved nothing, so
            // the key it carried is still unused.
            expect((await storedActions()).map((action) => action.action_type)).toEqual(['generate']);
            await expectWeekUnchanged(before);
        });

        it('answers no_matching_meals with typed constraints, and leaves the week whole', async () => {
            await seedGeneratorWorld(USER_ID);

            const first = await publishWeek({ startDate: utcTodayDayKey() });

            await checkTheOnlyGroceryLine(first.id);

            // The week was published from a catalog whose every recipe takes 25
            // minutes. 15 is a real cooking tier (§0.7.3's 15 / 30 / 45 / 60)
            // and leaves every slot without a single eligible recipe, so the
            // same catalog that filled a week a moment ago can no longer fill
            // one. The revision moves with the narrowing because a preference
            // save is what narrows it in the product, and the request pins the
            // NEW value — pinning the old one would be answered
            // `409 stale_revision` and the search would never run, which is the
            // mistake that makes a case like this prove nothing.
            const narrowed = await prisma.meal_plan_preferences.update({
                where: { user_id: USER_ID },
                data: { cooking_time_limit_min: 15, revision: { increment: 1 } },
            });

            const before = await weekSnapshot(first.id);
            const response = await postRegenerate(
                first.id,
                regenerateBody({ expectedPreferencesRevision: narrowed.revision }),
            ).expect(422);
            const body = asErrorBody(response.body);

            // THE WHOLE BODY, not three members of it. The rows come exactly in
            // the order the analysis emits them: with every slot empty it
            // reports the coverage itself and the one relaxation that reopens
            // the week — the next cooking tier — and nothing else, because no
            // nutrition band and no portion can fill a slot that has no recipes
            // at all. `allergiesKept` is the literal `true` because it is a
            // promise rather than a flag (§0.5.2): no relaxation the analysis
            // offers ever trades an allergy away. And the comparison is of the
            // complete object, so a fourth top-level key — a diagnostics blob, a
            // free-text reason, anything the client would not know to render —
            // fails this case rather than riding along unnoticed. WHICH verdicts
            // the analysis reaches is `mealPlan.logic.test.ts`'s subject; that
            // the route puts exactly them on the wire as typed values the client
            // formats itself is this file's.
            expect(body).toEqual({
                error: 'no_matching_meals',
                limitingConstraints: [
                    {
                        constraintKey: 'slot_coverage',
                        value: 0,
                        unit: 'recipes',
                        slots: ['breakfast', 'lunch', 'dinner'],
                        editStep: 'schedule',
                    },
                    {
                        constraintKey: 'cooking_time',
                        value: 15,
                        unit: 'minutes',
                        slots: [],
                        editStep: 'cooking',
                    },
                ],
                allergiesKept: true,
            });

            const constraints = body.limitingConstraints as LimitingConstraint[];

            for (const constraint of constraints) {
                // The same closed sets the generation-side case pins, asserted
                // again here because this body is assembled from a different
                // error instance and a member that stopped belonging would
                // reach the client as an unrenderable pill.
                expect([
                    'cooking_time',
                    'dislikes',
                    'diet',
                    'nutrition_tolerance',
                    'portion_limits',
                    'slot_coverage',
                    'catalog_coverage',
                ]).toContain(constraint.constraintKey);
                expect(['minutes', 'foods', 'percent', 'recipes']).toContain(constraint.unit);
                expect(Array.isArray(constraint.slots)).toBe(true);
                expect(typeof constraint.editStep).toBe('string');
                expect(constraint.editStep.length).toBeGreaterThan(0);
            }

            expect(await storedPlan(first.id)).toMatchObject({
                status: 'active',
                revision: FIRST_REVISION,
                generation_attempt: FIRST_ATTEMPT,
                replaced_plan_id: null,
                incompatibility_flags: null,
            });
            expect(await storedDays(first.id)).toHaveLength(PLAN_DAY_COUNT);
            expect(await storedMeals(first.id)).toHaveLength(PLAN_DAY_COUNT * MEALS_PER_DAY);
            expect((await storedActions()).map((action) => action.action_type)).toEqual(['generate']);
            await expectWeekUnchanged(before);

            // And the verdict is about the ANSWERS rather than about this
            // attempt: widened back to the tier the week was built under, the
            // same request publishes a replacement. That is what makes the 422
            // above a report the user can act on from 10c rather than a dead
            // end.
            const widened = await prisma.meal_plan_preferences.update({
                where: { user_id: USER_ID },
                data: { cooking_time_limit_min: 30, revision: { increment: 1 } },
            });
            const replacement = asPlan(
                (
                    await postRegenerate(
                        first.id,
                        regenerateBody({ expectedPreferencesRevision: widened.revision }),
                    ).expect(201)
                ).body,
            );

            expect(replacement.generationAttempt).toBe(FIRST_ATTEMPT + 1);
            expect((await storedPlan(first.id)).status).toBe('superseded');
            expect((await storedActions()).map((action) => action.action_type)).toEqual([
                'generate',
                'regenerate',
            ]);
        });
    });

    describe('a current week and an upcoming one', () => {
        it('lets either be regenerated, because the conflict checks exclude the plan being replaced', async () => {
            await seedGeneratorWorld(USER_ID);

            const startDate = utcTodayDayKey();
            const current = await publishWeek({ startDate });
            const upcoming = await publishWeek({ startDate: addDaysToDayKey(startDate, PLAN_DAY_COUNT) });

            // The current week first: its own dates would collide with itself,
            // and the exclusion is what makes replacing it possible at all.
            const regeneratedCurrent = asPlan(
                (await postRegenerate(current.id, regenerateBody()).expect(201)).body,
            );

            expect(regeneratedCurrent.startDate).toBe(current.startDate);

            // Then the upcoming one, which starts after today and would
            // otherwise trip `upcoming_exists` against itself.
            const regeneratedUpcoming = asPlan(
                (await postRegenerate(upcoming.id, regenerateBody()).expect(201)).body,
            );

            expect(regeneratedUpcoming.startDate).toBe(upcoming.startDate);

            const collection = asCurrent((await getCurrent().expect(200)).body);

            expect(collection.current?.id).toBe(regeneratedCurrent.id);
            expect(collection.upcoming?.id).toBe(regeneratedUpcoming.id);

            const active = (await storedPlans()).filter((plan) => plan.status === 'active');

            expect(active.map((plan) => plan.id).sort()).toEqual(
                [regeneratedCurrent.id, regeneratedUpcoming.id].sort(),
            );
            expect((await storedPlans()).filter((plan) => plan.status === 'superseded')).toHaveLength(2);
        });
    });

    describe('the injected generation fault', () => {
        it('answers 502 and leaves the week that was already published exactly as it was', async () => {
            await seedGeneratorWorld(USER_ID);

            const startDate = utcTodayDayKey();
            const first = await publishWeek({ startDate });
            const meals = (await storedMeals(first.id)).map((meal) => ({
                id: meal.id,
                recipe: meal.recipe_version_id,
                multiplier: meal.portion_multiplier,
                revision: meal.revision,
            }));
            const groceries = (await storedGroceries(first.id)).map((item) => ({
                id: item.id,
                grams: item.quantity_grams.toString(),
                checked: item.is_checked,
            }));
            const body = regenerateBody();

            const fault = jest.spyOn(featureFlags, 'mealPlanningFault').mockReturnValue('generation');
            let faulted;

            try {
                expect(featureFlags.mealPlanningFault()).toBe('generation');
                faulted = await postRegenerate(first.id, body).expect(502);
            } finally {
                fault.mockRestore();
            }

            expect(asErrorBody(faulted.body)).toEqual({ error: 'plan_generation_failed' });

            // §0.9.2's "injected generator failure → old plan still active": the
            // fault is raised before the transaction, so the supersede never
            // happened and no second plan exists.
            expect(await storedPlan(first.id)).toMatchObject({
                status: 'active',
                revision: FIRST_REVISION,
                generation_attempt: FIRST_ATTEMPT,
            });
            expect(await storedPlans()).toHaveLength(1);
            expect(await storedDays(first.id)).toHaveLength(PLAN_DAY_COUNT);
            expect(
                (await storedMeals(first.id)).map((meal) => ({
                    id: meal.id,
                    recipe: meal.recipe_version_id,
                    multiplier: meal.portion_multiplier,
                    revision: meal.revision,
                })),
            ).toEqual(meals);
            expect(
                (await storedGroceries(first.id)).map((item) => ({
                    id: item.id,
                    grams: item.quantity_grams.toString(),
                    checked: item.is_checked,
                })),
            ).toEqual(groceries);
            // Only the publication's own row: the regeneration reserved nothing.
            expect((await storedActions()).map((action) => action.action_type)).toEqual(['generate']);

            const retried = asPlan((await postRegenerate(first.id, body).expect(201)).body);

            expect(retried.generationAttempt).toBe(FIRST_ATTEMPT + 1);
            expect((await storedPlan(first.id)).status).toBe('superseded');
            expect((await storedActions()).map((action) => action.action_type)).toEqual([
                'generate',
                'regenerate',
            ]);
        });
    });

    /* -----------------------------------------------------------------------
     * A regeneration that fails AFTER the replacement is written
     *
     * The regeneration half of the same proof, and the one 16b's own note rests
     * on: "if generation fails the current plan is retained". By the time these
     * two fail, the old week has been SUPERSEDED and its revision bumped inside
     * the transaction, and the replacement's seven days and twenty-one meals
     * exist — so "retained" is true only because the commit is abandoned whole.
     * The week is therefore compared against a complete pre-call snapshot taken
     * with one grocery line already checked, which puts the check mark, its
     * acknowledged baseline and its clear flag inside the comparison rather
     * than beside it.
     * --------------------------------------------------------------------- */

    describe('a regeneration that fails after the replacement is written', () => {
        it('leaves the published week whole when the carry-over cannot be rendered', async () => {
            await seedGeneratorWorld(USER_ID);

            const first = await publishWeek({ startDate: utcTodayDayKey() });
            const lineId = await checkTheOnlyGroceryLine(first.id);
            const renderedUnit = (
                await prisma.grocery_items.findUniqueOrThrow({ where: { id: lineId } })
            ).display_unit;

            // The unit-family lock, broken the way only real data can break it:
            // a stored row whose `display_unit` no longer names a family. A
            // regeneration re-renders every line it carries over through the
            // family the row was created in and refuses to guess one it cannot
            // read — the same production fault `api/swaps.test.ts` uses for a
            // rebuild, reached here from the publication writer instead.
            await prisma.grocery_items.update({
                where: { id: lineId, user_id: USER_ID },
                data: { display_unit: 'bottle' },
            });

            const before = await weekSnapshot(first.id);
            const body = regenerateBody();
            const observer = observePublicationWrites();
            let faulted;

            try {
                faulted = await postRegenerate(first.id, body).expect(502);
            } finally {
                observer.restore();
            }

            // Inside the transaction the supersede had already happened — two
            // plans, one of them superseded — and the replacement already held
            // the whole week, while the only grocery rows in existence were
            // still the old plan's one line. That is what makes the comparison
            // below a rollback proof rather than a statement that nothing was
            // attempted.
            expect(observer.observations).toEqual([
                {
                    plannedMeals: PLAN_DAY_COUNT * MEALS_PER_DAY,
                    planStatuses: ['active', 'superseded'],
                    groceryRows: 1,
                },
            ]);

            expect(faulted.status).not.toBe(500);
            expect(asErrorBody(faulted.body)).toEqual({ error: 'plan_generation_failed' });

            // §0.9.2's "old plan still active", now for a failure that happened
            // after it had been superseded: the status, the revision the
            // supersede bumped, the attempt and the replacement pointer are all
            // where the publication left them.
            expect(await storedPlan(first.id)).toMatchObject({
                status: 'active',
                revision: FIRST_REVISION,
                generation_attempt: FIRST_ATTEMPT,
                replaced_plan_id: null,
                incompatibility_flags: null,
            });
            // No successor: the plan the transaction inserted is gone with it.
            expect(await storedPlans()).toHaveLength(1);
            expect(await storedDays(first.id)).toHaveLength(PLAN_DAY_COUNT);
            expect(await storedMeals(first.id)).toHaveLength(PLAN_DAY_COUNT * MEALS_PER_DAY);
            expect(await storedGroceries(first.id)).toHaveLength(1);
            // Only the publication's own row: the regeneration's reservation
            // shared the transaction, so no key was stranded.
            expect((await storedActions()).map((action) => action.action_type)).toEqual(['generate']);
            await expectWeekUnchanged(before);

            // Repaired, the same key regenerates once and carries the attempt
            // forward — and the check mark the rollback preserved travels into
            // the week that finally replaces it, which is the carry-over the
            // failed attempt left possible.
            await prisma.grocery_items.update({
                where: { id: lineId, user_id: USER_ID },
                data: { display_unit: renderedUnit },
            });

            const replacement = asPlan((await postRegenerate(first.id, body).expect(201)).body);

            expect(replacement.generationAttempt).toBe(FIRST_ATTEMPT + 1);
            expect((await storedPlan(first.id)).status).toBe('superseded');
            expect((await storedActions()).map((action) => action.action_type)).toEqual([
                'generate',
                'regenerate',
            ]);

            const rebuilt = await storedGroceries(replacement.id);

            expect(rebuilt).toHaveLength(1);
            expect(rebuilt[0]?.is_checked).toBe(true);
            expect(rebuilt[0]?.display_unit).toBe(renderedUnit);
        });

        it('leaves the published week whole when the write fails after inserting the new list', async () => {
            await seedGeneratorWorld(USER_ID);

            const first = await publishWeek({ startDate: utcTodayDayKey() });

            await checkTheOnlyGroceryLine(first.id);

            const before = await weekSnapshot(first.id);
            const body = regenerateBody();
            const observer = observePublicationWrites();
            const seam = failAfterGroceryRowsAreWritten();
            let faulted;

            try {
                faulted = await postRegenerate(first.id, body).expect(502);
                // Inside the `try`, because `mockRestore` in the `finally`
                // clears the call record along with the implementation.
                expect(seam.spy).toHaveBeenCalledTimes(1);
            } finally {
                seam.spy.mockRestore();
                observer.restore();
            }

            // Everything a regeneration writes existed at once: the supersede,
            // the replacement's whole week, and then its grocery line beside the
            // old plan's — two rows where the database now holds one.
            expect(seam.insertedBeforeTheThrow).toEqual([1]);
            expect(observer.observations).toEqual([
                {
                    plannedMeals: PLAN_DAY_COUNT * MEALS_PER_DAY,
                    planStatuses: ['active', 'superseded'],
                    groceryRows: 1,
                },
            ]);

            expect(faulted.status).not.toBe(500);
            expect(asErrorBody(faulted.body)).toEqual({ error: 'plan_generation_failed' });

            expect(await storedPlan(first.id)).toMatchObject({
                status: 'active',
                revision: FIRST_REVISION,
                generation_attempt: FIRST_ATTEMPT,
                replaced_plan_id: null,
                incompatibility_flags: null,
            });
            expect(await storedPlans()).toHaveLength(1);
            expect(await storedDays(first.id)).toHaveLength(PLAN_DAY_COUNT);
            expect(await storedMeals(first.id)).toHaveLength(PLAN_DAY_COUNT * MEALS_PER_DAY);
            expect(await prisma.grocery_items.count({ where: { user_id: USER_ID } })).toBe(1);
            expect((await storedActions()).map((action) => action.action_type)).toEqual(['generate']);
            await expectWeekUnchanged(before);

            // And with the seam gone the same key commits once, at the attempt
            // the failed one would have published.
            const replacement = asPlan((await postRegenerate(first.id, body).expect(201)).body);

            expect(replacement.generationAttempt).toBe(FIRST_ATTEMPT + 1);
            expect((await storedPlan(first.id)).status).toBe('superseded');
            expect((await storedActions()).map((action) => action.action_type)).toEqual([
                'generate',
                'regenerate',
            ]);
            expect((await storedGroceries(replacement.id))[0]?.is_checked).toBe(true);
        });
    });
});


/* ---------------------------------------------------------------------------
 * The user's calendar, not the server's
 *
 * These cases call the services directly with an injected `now`, for the reason
 * the header states: the controllers pass no clock, so through HTTP the answer
 * would depend on the hour the suite happened to run in. `now` is an absolute
 * instant, so the zone arithmetic below is the same on every machine and on
 * every day.
 * ------------------------------------------------------------------------- */

/** UTC+12 in September 2026 — New Zealand daylight time does not begin until the 27th. */
const AUCKLAND = 'Pacific/Auckland';

/** UTC−10, year round. */
const HONOLULU = 'Pacific/Honolulu';

/**
 * Midday UTC on 16 September 2026: already the 17th in Auckland and still the
 * 16th everywhere west of it. One instant, three calendar days, which is the
 * whole point.
 */
const NOON_UTC = new Date('2026-09-16T12:00:00.000Z');
const UTC_DAY_AT_NOON = '2026-09-16';
const AUCKLAND_DAY_AT_NOON = '2026-09-17';

describe('the user’s stored time zone decides what “today” is', () => {
    it('admits the user’s own today and refuses the day UTC still calls today', async () => {
        await seedGeneratorWorld(USER_ID, { time_zone: AUCKLAND });

        // UTC's today is yesterday in Auckland, and a week cannot start in the
        // past — the window is `[today, today + 30]` in the USER'S calendar.
        const refused = await generatePlan(
            USER_ID,
            { ...generateBody({ startDate: UTC_DAY_AT_NOON }) },
            NOON_UTC,
        );

        expect(refused.kind).toBe('error');
        if (refused.kind === 'error') {
            expect(refused.code).toBe('invalid_request');
            expect(refused.details).toEqual([{ field: 'startDate', code: 'out_of_range' }]);
        }
        expect(await storedPlans()).toHaveLength(0);

        const accepted = await generatePlan(
            USER_ID,
            { ...generateBody({ startDate: AUCKLAND_DAY_AT_NOON }) },
            NOON_UTC,
        );

        expect(accepted.kind).toBe('ok');
        if (accepted.kind === 'ok') {
            expect(accepted.result.status).toBe(201);
        }

        const plans = await storedPlans();

        expect(plans).toHaveLength(1);
        expect(plans[0]?.start_date.toISOString().slice(0, 10)).toBe(AUCKLAND_DAY_AT_NOON);
        // A bare date plus a Firebase identity cannot establish a calendar day;
        // the stored zone is what does (§0.5.2).
        expect(plans[0]?.end_date.toISOString().slice(0, 10)).toBe(
            addDaysToDayKey(AUCKLAND_DAY_AT_NOON, PLAN_DAY_COUNT - 1),
        );
    });

    it('resolves current and upcoming per zone, so one instant answers two users differently', async () => {
        const endedInAuckland = '2026-09-10';
        const startsOnAucklandToday = AUCKLAND_DAY_AT_NOON;

        // Two users, the same two weeks, different stored zones.
        const ahead = await seedPlannedWeek(USER_ID, {
            startDate: endedInAuckland,
            preferences: { time_zone: AUCKLAND },
        });
        const aheadSuccessor = await makePlan(USER_ID, {
            sequence: 502,
            recipeVersionId: ahead.recipe.id,
            startDate: startsOnAucklandToday,
        });
        const behind = await seedPlannedWeek(OTHER_USER_ID, {
            startDate: endedInAuckland,
            preferences: { time_zone: 'UTC' },
            sequence: 503,
        });
        const behindSuccessor = await makePlan(OTHER_USER_ID, {
            sequence: 504,
            recipeVersionId: behind.recipe.id,
            startDate: startsOnAucklandToday,
        });

        expect(ahead.plan.end_date.toISOString().slice(0, 10)).toBe(UTC_DAY_AT_NOON);

        const inAuckland = await getCurrentMealPlan(USER_ID, NOON_UTC);

        // 17 September there: the first week ENDED yesterday and the second
        // starts today.
        expect(inAuckland.current?.id).toBe(aheadSuccessor.id);
        expect(inAuckland.upcoming).toBeNull();

        const inUtc = await getCurrentMealPlan(OTHER_USER_ID, NOON_UTC);

        // 16 September here: the first week still contains today and the second
        // is next week's.
        expect(inUtc.current?.id).toBe(behind.plan.id);
        expect(inUtc.upcoming?.id).toBe(behindSuccessor.id);
    });

    it('refuses a write to a week the user’s calendar has already ended, and accepts the same write a day earlier', async () => {
        const world = await seedGeneratorWorld(USER_ID, { time_zone: AUCKLAND });
        const first = world.recipes[0];

        if (first === undefined) {
            throw new Error('the generator world must seed at least one recipe');
        }

        // A week ending on the day UTC still calls today, which is therefore
        // yesterday in Auckland.
        const plan = await makePlan(USER_ID, {
            sequence: 505,
            recipeVersionId: first.id,
            startDate: '2026-09-10',
        });

        expect(plan.end_date.toISOString().slice(0, 10)).toBe(UTC_DAY_AT_NOON);

        const body = {
            idempotencyKey: randomUUID(),
            expectedPlanRevision: FIRST_REVISION,
            expectedPreferencesRevision: 1,
            expectedTargetsRevision: 1,
        };

        // The `ended` payload of `plan_not_active`, reached because of the zone
        // and not because of the stored status, which still reads `active`.
        await expect(regeneratePlan(USER_ID, plan.id, body, NOON_UTC)).rejects.toMatchObject({
            name: 'PlanNotActiveError',
            data: { reason: 'ended' },
        });
        expect((await storedPlan(plan.id)).status).toBe('active');
        expect(await storedActions()).toHaveLength(0);

        // Two days earlier in absolute time, the user's calendar day is inside
        // the week, and the very same request is accepted.
        const insideTheWeek = await regeneratePlan(
            USER_ID,
            plan.id,
            { ...body, idempotencyKey: randomUUID() },
            new Date('2026-09-15T00:00:00.000Z'),
        );

        expect(insideTheWeek.kind).toBe('ok');
        if (insideTheWeek.kind === 'ok') {
            expect(insideTheWeek.result.status).toBe(201);
        }
        expect((await storedPlan(plan.id)).status).toBe('superseded');
    });

    it('follows a zone the user changes, from the next read onwards', async () => {
        const { plan } = await seedPlannedWeek(USER_ID, {
            startDate: AUCKLAND_DAY_AT_NOON,
            preferences: { time_zone: AUCKLAND },
        });

        const before = await getCurrentMealPlan(USER_ID, NOON_UTC);

        expect(before.current?.id).toBe(plan.id);
        expect(before.upcoming).toBeNull();

        // Saved through the route, which is where a device reports the zone it
        // is in — the save itself is zone-independent, so it needs no clock.
        //
        // The zone travels WITH an edit and never alone: a body carrying only
        // `timeZone` is `400 invalid_request {field: 'body'}`, because §0.5.2
        // makes the zone a value every save refreshes rather than a preference
        // of its own. The diet is restated at its stored value, so the edit
        // changes nothing but the zone.
        await putPreferences({ diet: 'none', timeZone: HONOLULU, expectedRevision: 1 }).expect(200);

        expect(
            (
                await prisma.meal_plan_preferences.findUniqueOrThrow({
                    where: { user_id: USER_ID },
                    select: { time_zone: true },
                })
            ).time_zone,
        ).toBe(HONOLULU);

        const after = await getCurrentMealPlan(USER_ID, NOON_UTC);

        // Fourteen hours earlier in Honolulu: the same instant is still the
        // 16th, so the very same week is now next week's.
        expect(after.current).toBeNull();
        expect(after.upcoming?.id).toBe(plan.id);
    });
});

/* ---------------------------------------------------------------------------
 * The shape of a planned day follows the saved schedule
 * ------------------------------------------------------------------------- */

/** The stored schedule, as the preferences row holds it. */
const storedMealTimes = async (userId: string = USER_ID): Promise<{ slot: string; time: string }[]> => {
    const row = await prisma.meal_plan_preferences.findUniqueOrThrow({
        where: { user_id: userId },
        select: { meal_times: true },
    });

    return row.meal_times as unknown as { slot: string; time: string }[];
};

describe('the saved schedule shapes every planned day', () => {
    it('plans three meals a day at the three saved times', async () => {
        await seedGeneratorWorld(USER_ID);

        const startDate = addDaysToDayKey(utcTodayDayKey(), 1);
        const plan = await publishWeek({ startDate });
        const times = await storedMealTimes();

        expect(times.map((entry) => entry.slot)).toEqual(['breakfast', 'lunch', 'dinner']);

        for (const day of plan.days) {
            expect(day.meals).toHaveLength(MEALS_PER_DAY);
            expect(day.meals.map((meal) => meal.slot)).toEqual(['breakfast', 'lunch', 'dinner']);
            // The saved times and not the generator's own idea of mealtimes.
            expect(day.meals.map((meal) => meal.slotTime)).toEqual(times.map((entry) => entry.time));
        }
    });

    it('plans four when a snack is scheduled, and returns them in clock order', async () => {
        const world = await seedGeneratorWorld(
            USER_ID,
            { meal_schedule: 'three_plus_snack' },
            { slots: ['breakfast', 'lunch', 'dinner', 'snack'] },
        );

        // Twenty-eight slots a week against the repeat rule's ceiling of two
        // uses per recipe: twelve recipes cannot fill them, so the catalog is
        // widened rather than the rule bent.
        for (let index = 0; index < PLANNABLE_RECIPE_COUNT; index += 1) {
            await seedRecipe(
                world.foodId,
                PLANNABLE_RECIPE_SEQUENCE_BASE + PLANNABLE_RECIPE_COUNT + index,
                `plans-suite-snack-recipe-${index}`,
                { slots: ['breakfast', 'lunch', 'dinner', 'snack'] },
            );
        }

        const startDate = addDaysToDayKey(utcTodayDayKey(), 1);
        const plan = await publishWeek({ startDate });
        const times = await storedMealTimes();

        // Wire order, which the schedule stores: the snack goes last.
        expect(times).toEqual([
            { slot: 'breakfast', time: '08:00' },
            { slot: 'lunch', time: '12:30' },
            { slot: 'dinner', time: '18:30' },
            { slot: 'snack', time: '15:30' },
        ]);

        for (const day of plan.days) {
            expect(day.meals).toHaveLength(MEALS_PER_DAY_WITH_SNACK);
            // Clock order, which the day view returns: §0.5.2 puts no ordering
            // constraint on the times, and Figma 07 draws exactly this — a
            // mid-afternoon snack between lunch and dinner.
            expect(day.meals.map((meal) => meal.slot)).toEqual(['breakfast', 'lunch', 'snack', 'dinner']);
            expect(day.meals.map((meal) => meal.slotTime)).toEqual(['08:00', '12:30', '15:30', '18:30']);
        }

        expect(plan.summary.plannedMeals).toBe(PLAN_DAY_COUNT * MEALS_PER_DAY_WITH_SNACK);

        const stored = await storedMeals(plan.id);

        expect(stored).toHaveLength(PLAN_DAY_COUNT * MEALS_PER_DAY_WITH_SNACK);
        expect(new Set(stored.map((meal) => meal.slot))).toEqual(
            new Set(['breakfast', 'lunch', 'dinner', 'snack']),
        );
    });
});


/* ---------------------------------------------------------------------------
 * The server-side kill switch
 * ------------------------------------------------------------------------- */

describe('the meal-planning feature gate', () => {
    it('refuses all five plan routes with 503 while the flag is off, and writes nothing', async () => {
        await seedGeneratorWorld(USER_ID);

        // Published while the feature is ON, so every id below names a real row
        // and a 503 cannot be mistaken for a missing resource.
        const startDate = addDaysToDayKey(utcTodayDayKey(), 1);
        const published = await publishWeek({ startDate });
        const gate = jest.spyOn(featureFlags, 'isMealPlanningEnabled').mockReturnValue(false);

        try {
            expect(featureFlags.isMealPlanningEnabled()).toBe(false);

            const refusals = [
                await postPlan(generateBody({ startDate: addDaysToDayKey(startDate, PLAN_DAY_COUNT) })),
                await getCurrent(),
                await getDay(published.id, startDate),
                await getAffected(published.id),
                await postRegenerate(published.id, regenerateBody()),
            ];

            for (const refusal of refusals) {
                expect(refusal.status).toBe(503);
                expect(asErrorBody(refusal.body)).toEqual({ error: 'feature_disabled' });
            }

            // The capability code the mobile client already maps, so an
            // unavailable feature is a card and never a crash.
            //
            // The ungated target read still answers — §0.5.2 exempts
            // `/meal-planning/targets*` because Account, Progress and the diary
            // editor depend on it. `api/targets.test.ts` owns that exemption;
            // asserted here only to show the spy disabled the GATE rather than
            // the application.
            await asUser(request.get(TARGETS_PATH), { uid: USER_ID }).expect(200);
        } finally {
            gate.mockRestore();
        }

        expect(featureFlags.isMealPlanningEnabled()).toBe(true);

        // Nothing was published or reserved during the outage.
        expect((await storedPlans()).map((plan) => plan.id)).toEqual([published.id]);
        expect((await storedActions()).map((action) => action.action_type)).toEqual(['generate']);

        // And the feature answers again the moment the flag returns.
        expect(asCurrent((await getCurrent().expect(200)).body).upcoming?.id).toBe(published.id);
    });
});

/* ---------------------------------------------------------------------------
 * Tenancy, and what a refusal is allowed to say
 * ------------------------------------------------------------------------- */

describe('tenancy and refusal hygiene', () => {
    it('publishes into the caller’s own rows and leaves another tenant’s week untouched', async () => {
        const foreign = await seedPlannedWeek(OTHER_USER_ID, { sequence: 510 });
        const foreignMealIds = (await storedMeals(foreign.plan.id)).map((meal) => meal.id);

        await seedGeneratorWorld(USER_ID);

        const published = await publishWeek({ startDate: addDaysToDayKey(utcTodayDayKey(), 1) });

        // Every row the publication wrote carries the caller's id — the days,
        // the meals and the grocery lines, not just the plan (Rule §5.1).
        expect((await storedPlan(published.id)).user_id).toBe(USER_ID);
        for (const day of await storedDays(published.id)) {
            expect(day.user_id).toBe(USER_ID);
        }
        for (const meal of await storedMeals(published.id)) {
            expect(meal.user_id).toBe(USER_ID);
        }
        for (const item of await storedGroceries(published.id)) {
            expect(item.user_id).toBe(USER_ID);
        }

        // The other tenant's week is exactly as it was.
        expect(await storedPlan(foreign.plan.id)).toMatchObject({
            status: 'active',
            revision: FIRST_REVISION,
            generation_attempt: FIRST_ATTEMPT,
        });
        expect((await storedMeals(foreign.plan.id)).map((meal) => meal.id)).toEqual(foreignMealIds);
        expect(await storedActions(OTHER_USER_ID)).toHaveLength(0);
        expect((await storedPlans(OTHER_USER_ID)).map((plan) => plan.id)).toEqual([foreign.plan.id]);
    });

    it('ignores a user id in the request body', async () => {
        await makeUser({ id: OTHER_USER_ID, sequence: 511 });
        await seedGeneratorWorld(USER_ID);

        // The parser reads the fields it names and nothing else, and the handler
        // learns the caller only from the verified token (Rule §4). A body that
        // claims another identity is simply not consulted.
        const response = await postPlan({
            ...generateBody({ startDate: addDaysToDayKey(utcTodayDayKey(), 1) }),
            userId: OTHER_USER_ID,
        }).expect(201);

        expect((await storedPlan(asPlan(response.body).id)).user_id).toBe(USER_ID);
        expect(await storedPlans(OTHER_USER_ID)).toHaveLength(0);
        expect(await storedActions(OTHER_USER_ID)).toHaveLength(0);
        expect((await storedActions()).map((action) => action.user_id)).toEqual([USER_ID]);
    });

    it('never answers 403, and never returns a raw error object', async () => {
        const foreign = await seedPlannedWeek(OTHER_USER_ID, { sequence: 512 });

        await seedGeneratorWorld(USER_ID);

        const startDate = addDaysToDayKey(utcTodayDayKey(), 1);
        const published = await publishWeek({ startDate });

        const refusals = [
            // 401 — no identity at all.
            await request.get(`${PLANS_PATH}/current`),
            // 400 — a malformed path id and a malformed body.
            await getDay('nope', startDate),
            await postPlan(generateBody({ idempotencyKey: 'nope' })),
            // 404 — another tenant's plan, and an id that names nothing.
            await getDay(foreign.plan.id, startDate),
            await postRegenerate(ABSENT_PLAN_ID, regenerateBody()),
            // 409 — a pinned revision that has moved.
            await postRegenerate(published.id, regenerateBody({ expectedPlanRevision: 99 })),
            // 409 — a week that collides with the one just published.
            await postPlan(generateBody({ startDate })),
        ];

        for (const refusal of refusals) {
            // §1.5: a resource that is not the caller's is 404 and never 403,
            // so no refusal on these routes may carry that status.
            expect(refusal.status).not.toBe(403);
            expect(refusal.status).toBeGreaterThanOrEqual(400);

            const text = JSON.stringify(refusal.body);

            // Rule §4 names `{error: err}` as the anti-pattern: no stack, no
            // Prisma text, no file path, no exception class.
            expect(text).not.toMatch(/stack|prisma|node_modules|\bat \w+ \(|Error:|\.ts:\d/i);
            expect(text).not.toContain(OTHER_USER_ID);
            expect(text.length).toBeLessThan(400);
        }

        // The machine-readable codes the client switches on, in order.
        expect(refusals.slice(1).map((refusal) => asErrorBody(refusal.body).error)).toEqual([
            'invalid_request',
            'invalid_request',
            'Plan not found',
            'Plan not found',
            'stale_plan',
            'plan_overlap',
        ]);
    });

    it('reports only closed-set values on the wire', async () => {
        await seedGeneratorWorld(USER_ID);

        const plan = await publishWeek({ startDate: addDaysToDayKey(utcTodayDayKey(), 1) });

        // The sets themselves, pinned: they are plain TEXT columns with no enum
        // and no CHECK constraint, so a silent widening would otherwise reach
        // the client and be decoded leniently into a fallback glyph.
        expect([...MEAL_SLOTS]).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
        expect([...RECIPE_BADGES]).toEqual(['high_protein', 'gluten_free', 'dairy_free', 'vegan', 'quick']);
        expect(RECIPE_ICON_KEYS).toHaveLength(9);

        expect(['active', 'superseded']).toContain(plan.status);

        for (const day of plan.days) {
            for (const meal of day.meals) {
                expect(MEAL_SLOTS as readonly string[]).toContain(meal.slot);
                expect(RECIPE_ICON_KEYS as readonly string[]).toContain(meal.recipe.iconKey);
                expect(meal.recipe.nutritionProvenance).toBe('source_backed');
                for (const badge of meal.recipe.badges) {
                    expect(RECIPE_BADGES as readonly string[]).toContain(badge);
                }
                for (const flag of meal.flags) {
                    expect(['diet', 'allergen', 'dislike', 'cooking_time']).toContain(flag.code);
                }
            }
        }

        // REJECTION of an out-of-set value has no surface on these routes: a
        // plan request carries ids, a date and three revisions, and every one of
        // those refusals is asserted above. The closed sets a CLIENT can send —
        // diet, allergens, schedule — belong to the preferences route, and
        // `api/preferences.test.ts` proves their refusal there.
        const body = asErrorBody((await postPlan(generateBody({ startDate: 'breakfast' })).expect(400)).body);

        expect(body.details).toEqual([{ field: 'startDate', code: 'invalid_date' }]);
    });
});

/* ---------------------------------------------------------------------------
 * Determinism — the same inputs build the same week
 * ------------------------------------------------------------------------- */

/**
 * A week as its PORTABLE identity: per day index and slot, the recipe's
 * `slug@version` and the portion multiplier.
 *
 * Database ids are useless for this comparison — the world is rebuilt from
 * scratch between the two generations, so every uuid differs — and `slug@version`
 * is exactly the identity `mealPlan.logic.ts` orders its candidates by, which is
 * what makes the ordering portable across independently loaded catalogs.
 */
const planAssignment = async (
    plan: MealPlanResponse,
): Promise<{ dayIndex: number; slot: string; recipe: string; multiplier: number }[]> => {
    const versions = await prisma.recipe_versions.findMany({
        select: { id: true, version: true, recipes: { select: { slug: true } } },
    });
    const identityById = new Map(
        versions.map((version) => [version.id, `${version.recipes.slug}@${String(version.version)}`]),
    );

    return plan.days.flatMap((day) =>
        day.meals.map((meal) => {
            const recipe = identityById.get(meal.recipe.versionId);

            if (recipe === undefined) {
                throw new Error(`planned recipe version ${meal.recipe.versionId} has no catalog identity`);
            }

            return {
                dayIndex: day.dayIndex,
                slot: meal.slot,
                recipe,
                multiplier: meal.portionMultiplier,
            };
        }),
    );
};

describe('generation determinism', () => {
    it('builds the identical week from an identical world under a different idempotency key', async () => {
        // Tomorrow rather than today, so the case cannot fail by crossing
        // midnight between the two publications: tomorrow stays inside the
        // window `[today, today + 30]` either way.
        const startDate = addDaysToDayKey(utcTodayDayKey(), 1);

        await seedGeneratorWorld(USER_ID);

        const firstKey = randomUUID();
        const first = await publishWeek({ startDate, idempotencyKey: firstKey });
        const firstAssignment = await planAssignment(first);
        const firstSeed = (await storedPlan(first.id)).generation_seed;

        expect(firstAssignment).toHaveLength(PLAN_DAY_COUNT * MEALS_PER_DAY);

        // The whole world goes, ids included, and is rebuilt from the same
        // pinned sequences and slugs.
        await truncateFeatureTables();
        await seedGeneratorWorld(USER_ID);

        const secondKey = randomUUID();
        const second = await publishWeek({ startDate, idempotencyKey: secondKey });
        const secondAssignment = await planAssignment(second);

        expect(secondKey).not.toBe(firstKey);
        expect(second.id).not.toBe(first.id);

        // §0.7.3: the seed is `user|startDate|preferencesRevision|targetsRevision|
        // generationAttempt`. The IDEMPOTENCY KEY IS DEDUPLICATION ONLY and never
        // enters it, which is precisely why a fresh key must reproduce the same
        // week — and why an infeasible request stays infeasible however many
        // times it is retried.
        expect(secondAssignment).toEqual(firstAssignment);
        expect(second.days.map((day) => day.plannedTotals)).toEqual(
            first.days.map((day) => day.plannedTotals),
        );
        expect(second.generationAttempt).toBe(first.generationAttempt);

        const secondPlanRow = await storedPlan(second.id);

        expect(secondPlanRow.generation_key).toBe(secondKey);
        // The seed itself: a property of the inputs, so it is identical across
        // the two publications even though their keys are not.
        expect(secondPlanRow.generation_seed).toBe(firstSeed);
    });
});

