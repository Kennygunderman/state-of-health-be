// Planned-meal logging, against a real PostgreSQL (Agent Action Plan §0.7.3
// "Logging", §0.5.1 "Plan write-safety model", §0.9.2's `api/log.test.ts` rows).
//
// WHICH LAYER THIS EXERCISES, AND WHY.
//
// The meal-planning HTTP boundary does not exist in this checkout: there is no
// `src/routes/mealPlanning.routes.ts`, no `src/controllers/mealPlanning.
// controller.ts`, and `src/app.ts` mounts neither — the plan records that
// boundary as later work. So this suite drives the SERVICE entry point,
// `plannedMealLog.service.ts::logPlannedMeal`, which is where the transaction,
// the per-user advisory lock, the idempotency ledger and the diary insert
// actually live, and therefore where the transactional wiring is provable
// today. Nothing here fakes, stubs or simulates a request layer. When the mount
// lands, request-level cases — status codes, the `400` body the parser's
// refusal maps to, the feature-flag `503` — are added to THIS file beside the
// service cases, because they are the same contract observed one layer out.
//
// The DIARY routes are a genuine exception and are driven as HTTP: `/api/macros
// /:date` and `/api/macros/entry/:id` are mounted and shipped, they are how a
// client obtains `diaryMealId` in the first place (§0.7.3), and reading a
// planned entry back through them is the only way to prove that what planning
// wrote is what the shipped diary shows. `src/__tests__/setup/testApp.ts`
// supplies the supertest handle and the identity headers. The last block of
// this file is entirely those routes: the legacy writer's refusal of a string
// PostgreSQL cannot store, asserted as status codes and response bodies
// because that is what the refusal IS, together with the shipped responses
// beside it that must not have moved.
//
// WHAT IS ASSERTED IS WHAT THE DATABASE HOLDS. A returned object can be right
// while the row is wrong, so every write case re-reads `meal_entries`,
// `meal_plan_actions`, `meal_plans` and `meal_plan_meals` and asserts row
// counts, columns, links and revisions. Two things are deliberately NOT
// asserted: the rounding of nutrition on the plan-meal/day DTOs and the exact
// text of `portionText`. Both are open findings against `mealPlan.mapper.ts`
// (F04, F05) and are being changed in another work unit, so an assertion on
// either would pin a value that is about to move. The STORED snapshot's own
// integer rounding is a different contract — `nutrition.service.ts::
// insertPlannedMealEntry` owns it and it is stable — so it is asserted in full.
//
// Determinism: the fixture week is pinned to a named day ({@link TODAY}) and
// every service call is given the same injected `now`, so no assertion here
// depends on when the suite runs. The plan's zone is UTC so that the day key
// the server resolves is the one this file names.

import { randomUUID } from 'node:crypto';

import { prisma } from '../../prisma/client';
import {
    IdempotencyConflictError,
    PlanNotActiveError,
    PlanNotFoundError,
    StalePlanError,
} from '../../services/mealPlanning.errors';
import { getMealPlanDay } from '../../services/mealPlan.service';
import { logPlannedMeal } from '../../services/plannedMealLog.service';
import {
    FIXTURE_ENDED_PLAN_START_DAY_KEY,
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

/** The caller every case logs as. */
const USER_ID = 'log-suite-user';

/** A second tenant, for the diary bucket that must not be reachable. */
const OTHER_USER_ID = 'log-suite-other-user';

/**
 * The day the fixture week is built around, and the day every injected `now`
 * falls on. Named rather than derived from the clock: the plan's writability,
 * the diary bucket's date and the "outside the plan week" case are all stated
 * in calendar days, and a suite that read the clock would assert different
 * days on different runs.
 */
const TODAY = '2026-09-15';

/** The instant handed to every service call. Noon UTC, so no zone can shift the day. */
const NOW = new Date(`${TODAY}T12:00:00.000Z`);

/** `makePlan`'s default week around {@link TODAY}: [today − 1, today + 5]. */
const PLAN_START_DAY_KEY = addDaysToDayKey(TODAY, -1);
const PLAN_END_DAY_KEY = addDaysToDayKey(TODAY, 5);

/** The first day after the fixture week — inside no plan of this user's. */
const DAY_AFTER_PLAN = addDaysToDayKey(PLAN_END_DAY_KEY, 1);

/** The slot every case logs unless it says otherwise. */
const BREAKFAST_SLOT = 'breakfast';

/** The portion multiplier the second slot carries, so a non-unit portion is covered. */
const FRACTIONAL_PORTION_MULTIPLIER = 1.5;

/** Everything {@link seedPlannedWeek} hands a case. */
type SeededWeek = Awaited<ReturnType<typeof seedPlannedWeek>>;

/**
 * The one fixture every case starts from: a user with confirmed targets, a UTC
 * preferences row, one mass-portioned catalog food, one recipe, and a current
 * plan week whose breakfast slot is a whole serving and whose lunch slot is
 * 1.5 of one.
 *
 * A MASS default portion rather than the factory's `1 cup`: a volume portion
 * against a null `density_g_per_ml` cannot be converted, which is the
 * documented grocery contract rather than a defect, and it would fail the
 * unrelated reads this suite performs.
 *
 * Built from the shared factories and nothing else — no fixture helper here
 * duplicates one of theirs.
 */
const seedPlannedWeek = async () => {
    await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(USER_ID, { time_zone: 'UTC' });

    const food = await makeCatalogFood({
        defaultPortion: { description: '100 g', amount: 100, unit: 'g', gram_weight: 100 },
    });
    const recipe = await makeRecipeVersion({ slug: 'log-suite-recipe', catalogFoodId: food.id });

    const plan = await makePlan(USER_ID, {
        today: TODAY,
        recipeVersionId: recipe.id,
        slots: [
            { slot: BREAKFAST_SLOT, slot_time: '08:00' },
            { slot: 'lunch', slot_time: '12:30', portion_multiplier: FRACTIONAL_PORTION_MULTIPLIER },
        ],
    });

    const day = plan.meal_plan_days.find((candidate) => candidate.day_index === 1);

    if (day === undefined) {
        throw new Error('the fixture plan has no second day, so the suite cannot name a mid-week day');
    }

    const breakfast = day.meal_plan_meals.find((meal) => meal.slot === BREAKFAST_SLOT);
    const lunch = day.meal_plan_meals.find((meal) => meal.slot === 'lunch');

    if (breakfast === undefined || lunch === undefined) {
        throw new Error('the fixture plan day is missing one of its two slots');
    }

    return { plan, recipe, dayKey: TODAY, breakfast, lunch };
};

/**
 * The diary bucket a client would send as `diaryMealId`, obtained the way a
 * client obtains it: through the shipped `GET /api/macros/:date`, which
 * backfills the four default buckets on read (§0.7.3). Driving the real route
 * is what makes the id in the log body the same id the app would hold.
 */
const diaryBucketId = async (
    userId: string,
    dayKey: string,
    bucketName = 'Breakfast',
): Promise<string> => {
    const response = await asUser(request.get(`/api/macros/${dayKey}`), { uid: userId }).expect(200);
    const body = response.body as { meals: { id: string; name: string }[] };
    const bucket = body.meals.find((meal) => meal.name === bucketName);

    if (bucket === undefined) {
        throw new Error(`GET /api/macros/${dayKey} returned no "${bucketName}" bucket for ${userId}`);
    }

    return bucket.id;
};

/** A well-formed log body. Every field is required, so each is stated. */
const logBody = (overrides: {
    diaryMealId: string;
    date?: string;
    servings?: number;
    expectedPlanRevision?: number;
    idempotencyKey?: string;
}): Record<string, unknown> => ({
    servings: overrides.servings ?? 1,
    date: overrides.date ?? TODAY,
    diaryMealId: overrides.diaryMealId,
    expectedPlanRevision: overrides.expectedPlanRevision ?? 1,
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
});

/** `logPlannedMeal`, with a parser refusal turned into a failure. */
const logOrThrow = async (
    planId: string,
    mealId: string,
    body: Record<string, unknown>,
): Promise<{ status: number; body: unknown; planRevisionAfter: number }> => {
    const result = await logPlannedMeal(USER_ID, planId, mealId, body, NOW);

    if (result.kind !== 'ok') {
        throw new Error(`the log was refused by the parser: ${JSON.stringify(result)}`);
    }

    return result.result;
};

/** Every `meal_entries` row of the caller, oldest first. */
const storedEntries = () =>
    prisma.meal_entries.findMany({
        where: { user_id: USER_ID },
        orderBy: [{ logged_at: 'asc' }, { id: 'asc' }],
    });

/** Every ledger row of the caller. */
const storedActions = () =>
    prisma.meal_plan_actions.findMany({ where: { user_id: USER_ID }, orderBy: { created_at: 'asc' } });

const planRevision = async (planId: string): Promise<number> =>
    (await prisma.meal_plans.findUniqueOrThrow({ where: { id: planId }, select: { revision: true } })).revision;

const mealRow = (mealId: string) =>
    prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: mealId } });

/** The day DTO for the fixture week's named day. */
const readDay = async (planId: string, dayKey: string) => {
    const result = await getMealPlanDay(USER_ID, planId, dayKey);

    if (result.kind !== 'ok') {
        throw new Error(`the day read was refused: ${JSON.stringify(result)}`);
    }

    return result.envelope;
};

let week: SeededWeek;

beforeEach(async () => {
    await truncateFeatureTables();
    week = await seedPlannedWeek();
});

afterAll(async () => {
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * What one successful log writes
 * ------------------------------------------------------------------------- */

describe('a successful planned log', () => {
    it('writes exactly one meal_entries row carrying the planned origin, provenance and both links', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        const result = await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        expect(result.status).toBe(201);

        const entries = await storedEntries();

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            meal_id: bucketId,
            user_id: USER_ID,
            // The three independent facts §0.7.3 keeps separate: the ORIGIN,
            // the PROVENANCE, and the two links the card derives its logged
            // state from.
            input_method: 'meal_plan',
            nutrition_provenance: 'source_backed',
            meal_plan_meal_id: week.breakfast.id,
            recipe_version_id: week.recipe.id,
            deleted_at: null,
        });
        expect(entries[0].date.toISOString().slice(0, 10)).toBe(week.dayKey);

        // It did NOT go through the legacy food-id path: that branch dedupes on
        // `food_id` and would have created a personal `foods` row, which would
        // make a second intentional serving silently update the first.
        expect(entries[0].food_id).toBeNull();
        expect(entries[0].catalog_food_id).toBeNull();
        expect(await prisma.foods.count({ where: { user_id: USER_ID } })).toBe(0);
    });

    it('advances the plan revision by exactly one and leaves the meal revision alone', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        expect(await planRevision(week.plan.id)).toBe(1);

        const result = await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        expect(result.planRevisionAfter).toBe(2);
        expect(await planRevision(week.plan.id)).toBe(2);
        // No column of the meal row changes — the link lives on the entry — so
        // the meal's own revision must not move.
        expect((await mealRow(week.breakfast.id)).revision).toBe(1);
    });

    it('completes exactly one ledger row for the key, carrying the ids the action created', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);
        const idempotencyKey = randomUUID();

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId, idempotencyKey }));

        const [entry] = await storedEntries();
        const actions = await storedActions();

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            idempotency_key: idempotencyKey,
            action_type: 'log',
            response_status: 201,
            plan_revision_after: 2,
            meal_plan_id: week.plan.id,
            meal_plan_meal_id: week.breakfast.id,
            meal_entry_id: entry.id,
        });
        expect(actions[0].response_snapshot).not.toBeNull();
    });
});

/* ---------------------------------------------------------------------------
 * The snapshot IS the planned portion
 * ------------------------------------------------------------------------- */

describe('the stored snapshot', () => {
    it('equals the planned portion, so one serving in the diary is the planned meal', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const [entry] = await storedEntries();

        // Derived from the recipe row rather than typed twice: the slot's
        // multiplier is 1, so the planned portion is exactly one recipe
        // serving, rounded once on insert.
        expect(entry.calories).toBe(Math.round(week.recipe.per_serving_calories));
        expect(entry.protein_g).toBe(Math.round(week.recipe.per_serving_protein_g));
        expect(entry.carbs_g).toBe(Math.round(week.recipe.per_serving_carbs_g));
        expect(entry.fat_g).toBe(Math.round(week.recipe.per_serving_fat_g));
        expect(entry.servings).toBe(1);
        expect(entry.name).toBe(week.recipe.name);
        // One stored serving is described by the recipe's own serving
        // description at a multiplier of 1.
        expect(entry.serving_text).toBe(week.recipe.serving_description);
    });

    it('scales with the slot portion, and says so without restating the recipe amount', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey, 'Lunch');

        await logOrThrow(week.plan.id, week.lunch.id, logBody({ diaryMealId: bucketId }));

        const [entry] = await storedEntries();

        expect(entry.calories).toBe(
            Math.round(week.recipe.per_serving_calories * FRACTIONAL_PORTION_MULTIPLIER),
        );
        expect(entry.protein_g).toBe(
            Math.round(week.recipe.per_serving_protein_g * FRACTIONAL_PORTION_MULTIPLIER),
        );
        // The multiplier is shown as a FACTOR of the recipe's description rather
        // than folded into its leading number, which would restate a gram
        // figure that did not scale.
        expect(entry.serving_text).toContain(String(FRACTIONAL_PORTION_MULTIPLIER));
        expect(entry.serving_text).toContain(week.recipe.serving_description);
    });

    it('does not move when a fraction of it is eaten; only the consumed total does', async () => {
        const eatenServings = 0.5;
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(
            week.plan.id,
            week.breakfast.id,
            logBody({ diaryMealId: bucketId, servings: eatenServings }),
        );

        const [entry] = await storedEntries();

        // The snapshot is still one whole planned portion…
        expect(entry.calories).toBe(Math.round(week.recipe.per_serving_calories));
        expect(entry.servings).toBe(eatenServings);

        // …and the shipped diary is what scales it. Read through the real
        // route, so this is the number the app shows.
        const response = await asUser(request.get(`/api/macros/${week.dayKey}`), { uid: USER_ID }).expect(200);
        const body = response.body as {
            totals: { calories: number; protein: number; carbs: number; fat: number };
        };

        expect(body.totals).toEqual({
            calories: Math.round(entry.calories * eatenServings),
            protein: Math.round(entry.protein_g * eatenServings),
            carbs: Math.round(entry.carbs_g * eatenServings),
            fat: Math.round(entry.fat_g * eatenServings),
        });
    });

    it('reaches the shipped diary response with its origin and provenance intact', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const response = await asUser(request.get(`/api/macros/${week.dayKey}`), { uid: USER_ID }).expect(200);
        const body = response.body as {
            meals: {
                id: string;
                entries: {
                    mealPlanMealId: string | null;
                    inputMethod: string;
                    nutritionProvenance: string | null;
                    foodId: string | null;
                }[];
            }[];
        };
        const bucket = body.meals.find((meal) => meal.id === bucketId);

        expect(bucket?.entries).toHaveLength(1);
        expect(bucket?.entries[0]).toMatchObject({
            mealPlanMealId: week.breakfast.id,
            inputMethod: 'meal_plan',
            nutritionProvenance: 'source_backed',
            foodId: null,
        });
    });
});

/* ---------------------------------------------------------------------------
 * Idempotency
 * ------------------------------------------------------------------------- */

describe('the idempotency ledger', () => {
    it('replays the stored 201 for the same key and body, and inserts no second row', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);
        const body = logBody({ diaryMealId: bucketId });

        const first = await logOrThrow(week.plan.id, week.breakfast.id, body);
        const replay = await logOrThrow(week.plan.id, week.breakfast.id, body);

        // Equal BY VALUE, which is the guarantee: the replay comes back out of
        // a `jsonb` column that has normalised key order at rest, so the two
        // responses are compared as parsed values and never as JSON text.
        expect(replay.status).toBe(first.status);
        expect(replay.planRevisionAfter).toBe(first.planRevisionAfter);
        expect(replay.body).toEqual(first.body);

        expect(await storedEntries()).toHaveLength(1);
        expect(await storedActions()).toHaveLength(1);
        // The revision moved once, for the one write that happened.
        expect(await planRevision(week.plan.id)).toBe(2);
    });

    it('refuses the same key with a different body, and writes nothing for it', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);
        const idempotencyKey = randomUUID();

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId, idempotencyKey }));

        await expect(
            logPlannedMeal(
                USER_ID,
                week.plan.id,
                week.breakfast.id,
                // Same key, a genuinely different request: two servings rather
                // than one.
                logBody({ diaryMealId: bucketId, idempotencyKey, servings: 2 }),
                NOW,
            ),
        ).rejects.toThrow(IdempotencyConflictError);

        expect(await storedEntries()).toHaveLength(1);
        expect(await storedActions()).toHaveLength(1);
        expect(await planRevision(week.plan.id)).toBe(2);
    });

    it('still replays after the plan revision has advanced past the one the key pinned', async () => {
        const breakfastBucketId = await diaryBucketId(USER_ID, week.dayKey);
        const lunchBucketId = await diaryBucketId(USER_ID, week.dayKey, 'Lunch');
        const firstBody = logBody({ diaryMealId: breakfastBucketId, expectedPlanRevision: 1 });

        const first = await logOrThrow(week.plan.id, week.breakfast.id, firstBody);

        // An unrelated write moves the plan on, exactly as another device would.
        await logOrThrow(
            week.plan.id,
            week.lunch.id,
            logBody({ diaryMealId: lunchBucketId, expectedPlanRevision: 2 }),
        );

        expect(await planRevision(week.plan.id)).toBe(3);

        // The retry the first client sends after a lost response still pins
        // revision 1. Checking the revision before the replay gate would answer
        // it `stale_plan` forever; the ledger answers it instead.
        const replay = await logOrThrow(week.plan.id, week.breakfast.id, firstBody);

        expect(replay.status).toBe(201);
        expect(replay.planRevisionAfter).toBe(first.planRevisionAfter);
        expect(replay.body).toEqual(first.body);

        // Two writes happened, and the replay was not a third.
        expect(await storedEntries()).toHaveLength(2);
        expect(await storedActions()).toHaveLength(2);
        expect(await planRevision(week.plan.id)).toBe(3);
    });

    it('treats two different keys on one meal as two intentional entries, in one deterministic order', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(
            week.plan.id,
            week.breakfast.id,
            logBody({ diaryMealId: bucketId, expectedPlanRevision: 1 }),
        );
        await logOrThrow(
            week.plan.id,
            week.breakfast.id,
            logBody({ diaryMealId: bucketId, expectedPlanRevision: 2 }),
        );

        const entries = await storedEntries();

        expect(entries).toHaveLength(2);
        expect(await storedActions()).toHaveLength(2);
        expect(await planRevision(week.plan.id)).toBe(3);

        const day = await readDay(week.plan.id, week.dayKey);
        const meal = day.day.meals.find((candidate) => candidate.id === week.breakfast.id);

        // `logged_at` ascending then `id` ascending — the order the read
        // declares — computed here from the stored rows rather than assumed, so
        // this holds whether or not two transactions share a timestamp.
        const expectedOrder = [...entries]
            .sort((left, right) =>
                left.logged_at.getTime() === right.logged_at.getTime()
                    ? left.id.localeCompare(right.id)
                    : left.logged_at.getTime() - right.logged_at.getTime(),
            )
            .map((entry) => entry.id);

        expect(meal?.loggedEntries.map((logged) => logged.entryId)).toEqual(expectedOrder);
        expect(meal?.loggedEntries.every((logged) => logged.recipeVersionId === week.recipe.id)).toBe(true);
    });
});

/* ---------------------------------------------------------------------------
 * What the shipped diary's own edit and delete do to the link
 *
 * Driven as HTTP, because these two routes ARE mounted and because the logged
 * state is derived from the entries alone — so there is no `is_logged` column
 * to correct and the only way to observe the rule is to edit the entry the way
 * the app does and read the plan back.
 * ------------------------------------------------------------------------- */

describe('the logged state after a diary edit', () => {
    /** The plan card's derived logged state for the fixture's breakfast slot. */
    const loggedEntryIds = async (): Promise<string[]> => {
        const day = await readDay(week.plan.id, week.dayKey);
        const meal = day.day.meals.find((candidate) => candidate.id === week.breakfast.id);

        return (meal?.loggedEntries ?? []).map((entry) => entry.entryId);
    };

    it('keeps the link when only the servings are edited, so the meal stays logged', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const [entry] = await storedEntries();

        await asUser(request.put(`/api/macros/entry/${entry.id}`), { uid: USER_ID })
            .send({ servings: 2 })
            .expect(200);

        const edited = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        expect(edited.servings).toBe(2);
        // Only the consumed total changed: the three links, the origin and the
        // provenance are all still what planning wrote.
        expect(edited.meal_plan_meal_id).toBe(week.breakfast.id);
        expect(edited.recipe_version_id).toBe(week.recipe.id);
        expect(edited.input_method).toBe('meal_plan');
        expect(edited.nutrition_provenance).toBe('source_backed');
        expect(edited.calories).toBe(entry.calories);
        expect(await loggedEntryIds()).toEqual([entry.id]);
    });

    it('detaches the entry when a macro is edited, so the meal is no longer logged', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const [entry] = await storedEntries();

        await asUser(request.put(`/api/macros/entry/${entry.id}`), { uid: USER_ID })
            .send({ calories: entry.calories + 25 })
            .expect(200);

        const edited = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        // The numbers are no longer the recipe's, so the row can no longer claim
        // to be that planned meal or to be source-backed.
        expect(edited.calories).toBe(entry.calories + 25);
        expect(edited.meal_plan_meal_id).toBeNull();
        expect(edited.recipe_version_id).toBeNull();
        expect(edited.catalog_food_id).toBeNull();
        expect(edited.input_method).toBe('library');
        expect(edited.nutrition_provenance).toBe('user_entered');
        // Nothing was corrected on the plan side: the state is derived, so the
        // detachment alone clears it.
        expect(await loggedEntryIds()).toEqual([]);
        expect(await planRevision(week.plan.id)).toBe(2);
    });

    it('clears the logged state when the entry is deleted', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const [entry] = await storedEntries();

        await asUser(request.delete(`/api/macros/entry/${entry.id}`), { uid: USER_ID }).expect(200);

        const deleted = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        // A soft delete: the row and its links survive, and the derivation
        // ignores it because it is no longer live.
        expect(deleted.deleted_at).not.toBeNull();
        expect(deleted.meal_plan_meal_id).toBe(week.breakfast.id);
        expect(await loggedEntryIds()).toEqual([]);
    });
});

/* ---------------------------------------------------------------------------
 * Refusals, every one of which writes nothing
 * ------------------------------------------------------------------------- */

describe('a refused planned log', () => {
    /** Nothing was written: no entry, no ledger row, and the plan has not moved. */
    const expectNothingWritten = async (planId: string, expectedRevision = 1): Promise<void> => {
        expect(await storedEntries()).toHaveLength(0);
        expect(await storedActions()).toHaveLength(0);
        expect(await planRevision(planId)).toBe(expectedRevision);
    };

    it('refuses a diary bucket belonging to another user, indistinguishably from a missing one', async () => {
        await makeUser({ id: OTHER_USER_ID });
        const foreignBucketId = await diaryBucketId(OTHER_USER_ID, week.dayKey);

        await expect(
            logPlannedMeal(
                USER_ID,
                week.plan.id,
                week.breakfast.id,
                logBody({ diaryMealId: foreignBucketId }),
                NOW,
            ),
        ).rejects.toThrow(PlanNotFoundError);

        await expectNothingWritten(week.plan.id);
        // And nothing landed in the other user's diary either.
        expect(await prisma.meal_entries.count({ where: { user_id: OTHER_USER_ID } })).toBe(0);
    });

    it('refuses a bucket whose own date is not the date being logged', async () => {
        const otherDayKey = addDaysToDayKey(week.dayKey, 1);
        const otherDayBucketId = await diaryBucketId(USER_ID, otherDayKey);

        await expect(
            logPlannedMeal(
                USER_ID,
                week.plan.id,
                week.breakfast.id,
                // A bucket the caller owns, inside the plan week — only its own
                // date disagrees with `date`.
                logBody({ diaryMealId: otherDayBucketId, date: week.dayKey }),
                NOW,
            ),
        ).rejects.toThrow(PlanNotFoundError);

        await expectNothingWritten(week.plan.id);
    });

    it('refuses a date outside the plan week even when the bucket belongs to the caller', async () => {
        const outsideBucketId = await diaryBucketId(USER_ID, DAY_AFTER_PLAN);

        expect(DAY_AFTER_PLAN > PLAN_END_DAY_KEY).toBe(true);

        await expect(
            logPlannedMeal(
                USER_ID,
                week.plan.id,
                week.breakfast.id,
                logBody({ diaryMealId: outsideBucketId, date: DAY_AFTER_PLAN }),
                NOW,
            ),
        ).rejects.toThrow(PlanNotFoundError);

        await expectNothingWritten(week.plan.id);
    });

    it('refuses a stale expected revision and reports the revision the plan actually holds', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        const refusal = await logPlannedMeal(
            USER_ID,
            week.plan.id,
            week.breakfast.id,
            logBody({ diaryMealId: bucketId, expectedPlanRevision: 7 }),
            NOW,
        ).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(StalePlanError);
        // The current value travels back, so the client refetches at a revision
        // that exists rather than guessing.
        expect((refusal as StalePlanError).currentRevision).toBe(1);

        await expectNothingWritten(week.plan.id);
    });

    it('refuses a superseded plan and points at the week that replaced it', async () => {
        const superseded = await makePlan(USER_ID, {
            today: TODAY,
            recipeVersionId: week.recipe.id,
            status: 'superseded',
            dayCount: 2,
        });
        const replacement = await makePlan(USER_ID, {
            startDate: addDaysToDayKey(PLAN_START_DAY_KEY, 7),
            recipeVersionId: week.recipe.id,
            replaced_plan_id: superseded.id,
            dayCount: 2,
        });
        const supersededMeal = superseded.meal_plan_days[0].meal_plan_meals[0];
        const supersededDayKey = superseded.meal_plan_days[0].date.toISOString().slice(0, 10);
        const bucketId = await diaryBucketId(USER_ID, supersededDayKey);

        const refusal = await logPlannedMeal(
            USER_ID,
            superseded.id,
            supersededMeal.id,
            logBody({ diaryMealId: bucketId, date: supersededDayKey }),
            NOW,
        ).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(PlanNotActiveError);
        expect((refusal as PlanNotActiveError).data).toEqual({ replacementPlanId: replacement.id });

        await expectNothingWritten(superseded.id);
    });

    it('refuses a plan whose week has passed, with the ended reason rather than a replacement', async () => {
        const ended = await makePlan(USER_ID, {
            startDate: FIXTURE_ENDED_PLAN_START_DAY_KEY,
            recipeVersionId: week.recipe.id,
            dayCount: 2,
        });
        const endedMeal = ended.meal_plan_days[0].meal_plan_meals[0];
        const endedDayKey = ended.meal_plan_days[0].date.toISOString().slice(0, 10);
        const bucketId = await diaryBucketId(USER_ID, endedDayKey);

        const refusal = await logPlannedMeal(
            USER_ID,
            ended.id,
            endedMeal.id,
            logBody({ diaryMealId: bucketId, date: endedDayKey }),
            NOW,
        ).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(PlanNotActiveError);
        expect((refusal as PlanNotActiveError).data).toEqual({ reason: 'ended' });

        await expectNothingWritten(ended.id);
    });

    it('refuses a planned meal that is not in the named plan', async () => {
        const otherPlan = await makePlan(USER_ID, {
            startDate: addDaysToDayKey(PLAN_START_DAY_KEY, 7),
            recipeVersionId: week.recipe.id,
            dayCount: 2,
        });
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await expect(
            logPlannedMeal(
                USER_ID,
                week.plan.id,
                // A meal of the caller's own, under the wrong plan: one
                // owner-bearing predicate judges both, so this is the same 404.
                otherPlan.meal_plan_days[0].meal_plan_meals[0].id,
                logBody({ diaryMealId: bucketId }),
                NOW,
            ),
        ).rejects.toThrow(PlanNotFoundError);

        await expectNothingWritten(week.plan.id);
    });

    it('judges the whole request before the ledger, so a malformed body reserves nothing', async () => {
        const result = await logPlannedMeal(
            USER_ID,
            week.plan.id,
            week.breakfast.id,
            {
                servings: 0,
                date: '2026-13-45',
                diaryMealId: 'not-a-uuid',
                expectedPlanRevision: 1.5,
                idempotencyKey: 'also-not-a-uuid',
                mealName: 'Breakfast',
            },
            NOW,
        );

        expect(result.kind).toBe('error');

        if (result.kind === 'ok') {
            throw new Error('a malformed body was accepted');
        }

        expect(result.code).toBe('invalid_request');
        // Every offending field in ONE verdict, so the client shows all of its
        // inline errors at once — including the unknown key, which is reported
        // rather than dropped.
        expect(result.details.map((detail) => detail.field).sort()).toEqual([
            'date',
            'diaryMealId',
            'expectedPlanRevision',
            'idempotencyKey',
            'mealName',
            'servings',
        ]);

        await expectNothingWritten(week.plan.id);
    });
});

/* ---------------------------------------------------------------------------
 * The shipped diary writer's own refusal: a string PostgreSQL cannot store
 *
 * Driven as HTTP for the reason the header gives — both routes are mounted and
 * shipped, and the status code is the whole point of these cases. A body whose
 * stored text carries U+0000 used to reach the column, which answers `22021
 * invalid byte sequence for encoding "UTF8": 0x00`, and the endpoint returned
 * `500 Failed to log meal entry` for a request only the caller can fix.
 *
 * Both halves are asserted here. The refusal: a `400` naming the field, with
 * nothing written. And the non-regression half, which is the larger risk of
 * adding a rule to a guard §0.3.1 freezes — the frozen required-fields `400`
 * keeps its exact body, a valid legacy log still writes, and every other
 * control character still round-trips through the diary intact.
 * ------------------------------------------------------------------------- */

describe('a legacy diary write carrying U+0000', () => {
    /** U+0000 as an escape, so no editor or diff can swallow the literal byte. */
    const NUL = '\u0000';

    /** The frozen required-fields text, asserted literally as the wire contract. */
    const LEGACY_REQUIRED_MESSAGE = 'name, calories, protein, carbs, and fat are required';

    /** A well-formed legacy entry body, the shape the shipped app posts. */
    const legacyEntryBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        name: 'Scrambled eggs',
        calories: 220,
        protein: 14,
        carbs: 2,
        fat: 16,
        ...overrides,
    });

    /** Posts a legacy entry into the caller's own breakfast bucket. */
    const postEntry = async (body: Record<string, unknown>) => {
        const bucketId = await diaryBucketId(USER_ID, TODAY);

        return asUser(request.post(`/api/macros/meal/${bucketId}/entries`), { uid: USER_ID }).send(body);
    };

    /** The entries the shipped diary read reports for the caller's breakfast. */
    const diaryEntryNames = async (): Promise<string[]> => {
        const response = await asUser(request.get(`/api/macros/${TODAY}`), { uid: USER_ID }).expect(200);
        const body = response.body as { meals: { name: string; entries: { name: string }[] }[] };

        return (body.meals.find((meal) => meal.name === 'Breakfast')?.entries ?? []).map((entry) => entry.name);
    };

    it.each([
        ['name', { name: `Scrambled${NUL}eggs` }],
        ['servingText', { servingText: `2${NUL}eggs` }],
        ['rawInput', { rawInput: `two${NUL}eggs` }],
    ])('answers a %s carrying U+0000 with 400 and writes nothing', async (field, overrides) => {
        const response = await postEntry(legacyEntryBody(overrides));

        expect(response.status).toBe(400);
        expect(response.body).toStrictEqual({
            error: 'invalid_request',
            details: [{ field, code: 'invalid_characters' }],
        });
        // The 500 this replaces happened at the INSERT, so the proof is the
        // absence of a row rather than the status alone.
        expect(await storedEntries()).toHaveLength(0);
    });

    it('reports every unstorable field of one body at once', async () => {
        const response = await postEntry(
            legacyEntryBody({ name: `a${NUL}b`, servingText: `c${NUL}d`, rawInput: `e${NUL}f` }),
        );

        expect(response.status).toBe(400);
        expect(response.body).toStrictEqual({
            error: 'invalid_request',
            details: [
                { field: 'name', code: 'invalid_characters' },
                { field: 'servingText', code: 'invalid_characters' },
                { field: 'rawInput', code: 'invalid_characters' },
            ],
        });
        expect(await storedEntries()).toHaveLength(0);
    });

    it('answers an entry edit whose name carries U+0000 with 400, leaving the stored name', async () => {
        const created = await postEntry(legacyEntryBody());

        expect(created.status).toBe(201);

        const [entry] = await storedEntries();

        const response = await asUser(request.put(`/api/macros/entry/${entry.id}`), { uid: USER_ID }).send({
            name: `Scrambled${NUL}eggs`,
        });

        expect(response.status).toBe(400);
        expect(response.body).toStrictEqual({
            error: 'invalid_request',
            details: [{ field: 'name', code: 'invalid_characters' }],
        });

        // The refusal is judged before the writer runs, so the row is untouched
        // — not partially updated, and not detached from anything.
        const stored = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        expect(stored.name).toBe('Scrambled eggs');
        expect(stored.calories).toBe(entry.calories);
    });

    it('keeps the frozen required-fields 400 exactly as shipped clients read it', async () => {
        // The rule was added AFTER this guard, so a body the endpoint already
        // refused must still earn the message-only body — no machine code, no
        // details — even though the new verdict renders differently.
        const response = await postEntry({ name: 'eggs' });

        expect(response.status).toBe(400);
        expect(response.body).toStrictEqual({ error: LEGACY_REQUIRED_MESSAGE });
    });

    it('lets the frozen guard answer first when a body fails both ways', async () => {
        const response = await postEntry({ name: `a${NUL}b`, calories: 220, protein: 14, carbs: 2 });

        expect(response.status).toBe(400);
        expect(response.body).toStrictEqual({ error: LEGACY_REQUIRED_MESSAGE });
        expect(await storedEntries()).toHaveLength(0);
    });

    it('still logs a valid legacy entry and shows it in the diary', async () => {
        const response = await postEntry(legacyEntryBody({ servingText: '2 eggs', rawInput: 'two scrambled eggs' }));

        expect(response.status).toBe(201);

        const [entry] = await storedEntries();

        expect(entry.name).toBe('Scrambled eggs');
        expect(entry.serving_text).toBe('2 eggs');
        expect(entry.raw_input).toBe('two scrambled eggs');
        // The legacy path's own classes, unchanged: the server cannot verify
        // numbers it did not derive, so the entry earns no source label.
        expect(entry.input_method).toBe('library');
        expect(entry.nutrition_provenance).toBe('user_entered');
        expect(await diaryEntryNames()).toEqual(['Scrambled eggs']);
    });

    it.each([
        ['BEL and ESC', 'a\u0007b\u001bc'],
        ['a newline', 'line one\nline two'],
        ['a zero-width space', 'a\u200bb'],
    ])('still stores and returns a name containing %s', async (_case, name) => {
        // The boundary of the rule, observed end to end: these characters reach
        // `meal_entries.name` and come back through the shipped diary read
        // unchanged, so the refusal is U+0000 and nothing wider.
        const response = await postEntry(legacyEntryBody({ name }));

        expect(response.status).toBe(201);
        expect((await storedEntries())[0].name).toBe(name);
        expect(await diaryEntryNames()).toEqual([name]);
    });

    it('still accepts an entry edit that carries no NUL, and still detaches on a macro change', async () => {
        const created = await postEntry(legacyEntryBody());

        expect(created.status).toBe(201);

        const [entry] = await storedEntries();

        const renamed = await asUser(request.put(`/api/macros/entry/${entry.id}`), { uid: USER_ID }).send({
            name: 'Poached eggs',
            calories: 240,
        });

        expect(renamed.status).toBe(200);

        const stored = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        expect(stored.name).toBe('Poached eggs');
        expect(stored.calories).toBe(240);
        // Unchanged behaviour on the other side of the new check: the edit is
        // still judged by `planMealEntryEdit`, which detaches on a rewrite.
        expect(stored.input_method).toBe('library');
        expect(stored.nutrition_provenance).toBe('user_entered');
    });

    it('leaves a planned entry reachable by an edit that only changes the servings', async () => {
        // The planned path shares this route, so the new body check sits in
        // front of it too: an edit with no NUL must still reach the writer and
        // keep the link that makes the plan card read LOGGED.
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const [entry] = await storedEntries();

        await asUser(request.put(`/api/macros/entry/${entry.id}`), { uid: USER_ID })
            .send({ servings: 2 })
            .expect(200);

        const stored = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        expect(stored.servings).toBe(2);
        expect(stored.meal_plan_meal_id).toBe(week.breakfast.id);
        expect(stored.input_method).toBe('meal_plan');
    });

    it('refuses a NUL name on a planned entry without touching its link', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const [entry] = await storedEntries();

        const response = await asUser(request.put(`/api/macros/entry/${entry.id}`), { uid: USER_ID }).send({
            name: `a${NUL}b`,
        });

        expect(response.status).toBe(400);

        const stored = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        // A refused edit is not a detachment: the entry is still the planned
        // meal's, so the card must still read LOGGED.
        expect(stored.name).toBe(entry.name);
        expect(stored.meal_plan_meal_id).toBe(week.breakfast.id);
        expect(stored.recipe_version_id).toBe(week.recipe.id);
        expect(stored.nutrition_provenance).toBe('source_backed');
    });

    it('still answers a malformed entry id before it reads the body', async () => {
        // The path parser runs first and keeps its own verdict, so a request
        // that is wrong in both places is told about the id — the field it must
        // fix to address a row at all.
        const response = await asUser(request.put('/api/macros/entry/not-a-uuid'), { uid: USER_ID }).send({
            name: `a${NUL}b`,
        });

        expect(response.status).toBe(400);
        expect(response.body).toStrictEqual({
            error: 'invalid_request',
            details: [{ field: 'id', code: 'invalid_id' }],
        });
    });
});
