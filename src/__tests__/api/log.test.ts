// Planned-meal logging, over HTTP, against a real PostgreSQL (Agent Action
// Plan §0.7.3 "Logging", §0.5.1 "Plan write-safety model", §0.9.2's
// `api/log.test.ts` rows).
//
// WHICH LAYER THIS EXERCISES, AND WHY.
//
// The whole request path: `POST /api/meal-planning/plans/:planId/meals/:mealId
// /log` is mounted — `src/routes/mealPlanning.routes.ts` declares it,
// `mealPlanning.controller.ts::logPlannedMealController` handles it, and
// `src/app.ts` mounts the router after the `authenticateFirebaseToken`
// boundary — so this suite drives the ROUTE and nothing below it. That matters
// because half of what §0.5.2 promises about this endpoint is expressed only in
// HTTP: the `201` a first log earns and a replay repeats, the `409` codes a
// stale or superseded plan answers, the `400 invalid_request` a refused parse
// maps to, the `404` that makes a foreign diary bucket indistinguishable from a
// missing one, and the `503` the feature gate returns. A service-level call can
// prove the transaction; only a request can prove the contract the client
// reads. Errors are therefore asserted as STATUS + machine code + payload and
// never as error-class identity, because `mealPlanning.errors.ts` is
// deliberately status-free and the controller is the only layer that decides
// HTTP (Rule 7 §8).
//
// The DIARY routes are driven the same way and for an additional reason:
// `GET /api/macros/:date` is how a client obtains `diaryMealId` in the first
// place (§0.7.3), so taking the bucket id from that response is what makes the
// id in the log body the same id the app would hold. `PUT`/`DELETE
// /api/macros/entry/:id` are where the shipped writer's edit and delete rules
// meet the plan link, and reading a planned entry back through the diary is the
// only way to show that what planning wrote is what the diary shows.
//
// WHAT IS ASSERTED IS WHAT THE DATABASE HOLDS. A response can be right while
// the row is wrong, so every write case re-reads `meal_entries`,
// `meal_plan_actions`, `meal_plans` and `meal_plan_meals` and asserts row
// counts, columns, links and revisions. Two things are deliberately NOT
// asserted: the rounding of nutrition on the plan-meal/day DTOs and the exact
// text of `portionText`. Both are open findings against `mealPlan.mapper.ts`
// (F04, F05) being changed in another work unit, so an assertion on either
// would pin a value that is about to move. The STORED snapshot's own integer
// rounding is a different contract — `nutrition.service.ts::
// insertPlannedMealEntry` owns it and it is stable — so it is asserted in full.
//
// WHAT THIS FILE DOES NOT COVER, because a neighbour owns it.
// `plannedMealLog.logic.test.ts` owns every pure rule: the servings contract
// and its two-decimal scale, day-key and UUID recognition,
// `derivePlannedSnapshot`'s arithmetic, `isDiaryMealAcceptable`,
// `isDateInPlanWeek`. A case that would still pass with the database stubbed
// belongs there and not here (Rule 7 §11). What is left, and what this file
// owns, is the HTTP contract, the transaction, the persisted row, the
// idempotent replay, the logged state the plan card derives, and the diary-side
// consequences of an edit or a delete.
//
// TWO OBLIGATIONS ARE THIS FILE'S ALONE.
//
//  1. THE ROUNDING CONTRACT, end to end. §0.7.3 fixes it as: the planned
//     portion is computed at FULL precision, each per-serving value is rounded
//     ONCE into the stored snapshot, and the diary then shows
//     `Math.round(snapshot × servings)`. Every step of that lives in a
//     different module, so no unit test can observe the composition — and the
//     failure it guards against is silent, because a second rounding produces
//     numbers that merely differ slightly from the ones the app's "This adds"
//     card shows. The fixture is built so that the contract and a plausible
//     double-rounding DISAGREE by whole calories, and both values are computed
//     from the stored rows at run time so neither can drift.
//  2. `mealPlan.mapper.ts` HAS NO LOGIC TEST, so its `loggedEntries` list and
//     its LOGGED / logged-then-swapped derivation are pinned here from real
//     diary rows. The log-driven half is this file's; the swap-driven A→B→C
//     chain is `swaps.test.ts`'s.
//
// DETERMINISM, and the one thing driving HTTP costs. The controller cannot be
// handed a clock — it calls `logPlannedMeal(userId, planId, mealId, req.body)`
// and the service defaults `now` to the real time — so the fixture week must
// contain the real today rather than a named day. It therefore uses
// `makePlan`'s default current week, `[utcToday − 1, utcToday + 5]`, with the
// preferences row pinned to `UTC` so the day key the server resolves is the one
// this file names, and every day key is derived from the created rows rather
// than written down. That window holds both today and tomorrow, so a run that
// crosses UTC midnight still logs into a writable plan. Where ORDERING is under
// test, `logged_at` is set explicitly, so no assertion depends on how fast two
// statements ran.

import { randomUUID } from 'node:crypto';

import { prisma } from '../../prisma/client';
// Namespace imports, and only for the two atomicity seams below. Both modules
// are reached from `plannedMealLog.service.ts` as named imports, which compile
// to property reads on the module object — so replacing the property is what
// puts a failure at a chosen point INSIDE the transaction, and it is the only
// mechanism that can, since the service takes no injectable step (the same
// mechanism `api/targets.test.ts` uses to hold a publication open).
import * as mealPlanMapper from '../../services/mealPlan.mapper';
import * as nutritionService from '../../services/nutrition.service';
import {
    InvalidRequestDetail,
    LogPlannedMealResponse,
    MealPlanDayResponse,
    MealPlanMealResponse,
    MealPlanResponse,
} from '../../types/mealPlanning';
import { MealEntryResponse } from '../../types/nutrition';
import {
    FIXTURE_ENDED_PLAN_START_DAY_KEY,
    FIXTURE_USER_TARGET_COLUMNS,
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

/**
 * The server flag, made switchable for the gate cases.
 *
 * `utils/featureFlags.ts` reads `MEAL_PLANNING_ENABLED` ONCE at import and
 * exposes it through an accessor, which is exactly what Rule 7 §9 requires of
 * configuration — and exactly why mutating `process.env` mid-suite cannot move
 * it. Replacing the accessor is the only mechanism the module admits. Everything
 * else it exports is kept: `postCommitAbort` and `POST_COMMIT_ABORT_HEADER` are
 * the real ones, so nothing about the abort seam changes here.
 *
 * The factory closes over the flag and reads it when CALLED, at request time,
 * so the value below is free to change per case. `beforeEach` restores it to
 * enabled — the suite runs `--runInBand`, and a leaked `false` would fail
 * whichever file came next.
 */
let mockMealPlanningEnabled = true;

jest.mock('../../utils/featureFlags', () => {
    const actual = jest.requireActual<typeof import('../../utils/featureFlags')>('../../utils/featureFlags');

    return { ...actual, isMealPlanningEnabled: (): boolean => mockMealPlanningEnabled };
});

/** The caller every case logs as. */
const USER_ID = 'log-suite-user';

/** A second tenant, for the diary bucket and the entry that must not be reachable. */
const OTHER_USER_ID = 'log-suite-other-user';

/**
 * The four buckets `nutrition.service.ts::DEFAULT_MEALS` backfills on every
 * read, in the order it declares them — `sort_order` is the array index.
 */
const DEFAULT_MEAL_NAMES = ['Breakfast', 'Lunch', 'Dinner', 'Snack'] as const;

/** The fixture's three planned slots, and the diary bucket each one belongs in. */
const BREAKFAST_SLOT = 'breakfast';
const LUNCH_SLOT = 'lunch';
const DINNER_SLOT = 'dinner';

/**
 * The portion multipliers the three slots carry.
 *
 * All three are members of the allowed set §0.7.3 gives a main slot, and all
 * three are needed: `×1` is the case where one stored serving must equal one
 * recipe serving, `×1.5` is a non-unit portion whose serving text must not
 * restate the recipe's own amount, and `×1.25` is the multiplier that turns the
 * recipe's per-serving calories into `503.5` — a planned portion whose single
 * rounding and whose double rounding differ by whole calories once a portion of
 * it is eaten.
 */
const WHOLE_PORTION = 1;
const LARGE_PORTION = 1.5;
const DIVERGENT_PORTION = 1.25;

/**
 * Per-serving nutrition chosen so that every one of the four values is
 * NON-INTEGRAL at each of the three multipliers above.
 *
 * That is the point of the numbers rather than a detail of them: a recipe whose
 * per-serving figures are whole numbers rounds identically however many times
 * it is rounded, so a fixture built on round numbers cannot fail when the
 * contract is broken. `makeRecipeVersion({ perServing })` reproduces these
 * exactly — it synthesises the single ingredient that adds up to them.
 */
const PER_SERVING = { calories: 402.8, protein: 20.2, carbs: 40.6, fat: 10.2 };

/** The largest portion the servings contract admits, and the one that magnifies a rounding error. */
const MAX_SERVINGS = 10;

/** Everything {@link seedPlannedWeek} hands a case. */
type SeededWeek = Awaited<ReturnType<typeof seedPlannedWeek>>;

/**
 * The one fixture every case starts from: a user with confirmed targets, a UTC
 * preferences row, one mass-portioned catalog food, one recipe, and the current
 * plan week with three planned slots at three different portions.
 *
 * A MASS default portion rather than the factory's `1 cup`: a volume portion
 * against a null `density_g_per_ml` cannot be converted, which is the
 * documented grocery contract rather than a defect, and it would fail the
 * unrelated reads this suite performs.
 *
 * The week is the factory's DEFAULT — `[utcToday − 1, utcToday + 5]` — because
 * the route resolves "today" from the real clock (see the header). `dayKey` is
 * today in that week, read back from the plan's own rows.
 *
 * Built from the shared factories and nothing else; no helper here duplicates
 * one of theirs.
 */
const seedPlannedWeek = async () => {
    await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(USER_ID, { time_zone: 'UTC' });

    const food = await makeCatalogFood({
        defaultPortion: { description: '100 g', amount: 100, unit: 'g', gram_weight: 100 },
    });
    const recipe = await makeRecipeVersion({
        slug: 'log-suite-recipe',
        catalogFoodId: food.id,
        perServing: PER_SERVING,
    });

    const plan = await makePlan(USER_ID, {
        recipeVersionId: recipe.id,
        slots: [
            { slot: BREAKFAST_SLOT, slot_time: '08:00', portion_multiplier: WHOLE_PORTION },
            { slot: LUNCH_SLOT, slot_time: '12:30', portion_multiplier: LARGE_PORTION },
            { slot: DINNER_SLOT, slot_time: '18:30', portion_multiplier: DIVERGENT_PORTION },
        ],
    });

    const dayKey = utcTodayDayKey();
    const day = plan.meal_plan_days.find((candidate) => toDayKey(candidate.date) === dayKey);

    if (day === undefined) {
        throw new Error(
            `the fixture plan does not contain ${dayKey}, so the suite cannot log into a writable day`,
        );
    }

    const mealBySlot = (slot: string) => {
        const meal = day.meal_plan_meals.find((candidate) => candidate.slot === slot);

        if (meal === undefined) {
            throw new Error(`the fixture plan day is missing its ${slot} slot`);
        }

        return meal;
    };

    return {
        plan,
        recipe,
        food,
        dayKey,
        planEndDayKey: toDayKey(plan.end_date),
        breakfast: mealBySlot(BREAKFAST_SLOT),
        lunch: mealBySlot(LUNCH_SLOT),
        dinner: mealBySlot(DINNER_SLOT),
    };
};

/** A `@db.Date` column as its own day key: the UTC slice is the stored day, not a conversion. */
function toDayKey(value: Date): string {
    return value.toISOString().slice(0, 10);
}

/**
 * The diary bucket a client would send as `diaryMealId`, obtained the way a
 * client obtains it: through the shipped `GET /api/macros/:date`, which
 * backfills the four default buckets on read (§0.7.3). Driving the real route
 * is what makes the id in the log body the same id the app would hold — a
 * hand-inserted `meals` row would test the fixture instead of the backfill, and
 * would let a real ordering or naming regression pass.
 */
const diaryBucketId = async (
    userId: string,
    dayKey: string,
    bucketName: string = DEFAULT_MEAL_NAMES[0],
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
    date: overrides.date ?? week.dayKey,
    diaryMealId: overrides.diaryMealId,
    expectedPlanRevision: overrides.expectedPlanRevision ?? 1,
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
});

/** `POST …/plans/:planId/meals/:mealId/log`, as the caller. */
const logRequest = (planId: string, mealId: string, body: unknown, uid: string = USER_ID) =>
    asUser(request.post(`/api/meal-planning/plans/${planId}/meals/${mealId}/log`), { uid }).send(
        body as object,
    );

/** The same request, with a non-2xx answer turned into a failure. */
const logOrThrow = async (planId: string, mealId: string, body: unknown, uid: string = USER_ID) => {
    const response = await logRequest(planId, mealId, body, uid);

    if (response.status !== 201) {
        throw new Error(
            `the log was refused with ${String(response.status)}: ${JSON.stringify(response.body)}`,
        );
    }

    return response;
};

/** Every `meal_entries` row of the caller, oldest first. */
const storedEntries = () =>
    prisma.meal_entries.findMany({
        where: { user_id: USER_ID },
        orderBy: [{ logged_at: 'asc' }, { id: 'asc' }],
    });

/** The one entry this case wrote, reported rather than indexed blindly. */
const storedEntry = async () => {
    const entries = await storedEntries();

    if (entries.length !== 1) {
        throw new Error(`expected exactly one stored entry, found ${String(entries.length)}`);
    }

    return entries[0];
};

/** Every ledger row of the caller. */
const storedActions = () =>
    prisma.meal_plan_actions.findMany({ where: { user_id: USER_ID }, orderBy: { created_at: 'asc' } });

const planRevision = async (planId: string): Promise<number> =>
    (await prisma.meal_plans.findUniqueOrThrow({ where: { id: planId }, select: { revision: true } }))
        .revision;

const mealRow = (mealId: string) => prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: mealId } });

/** The day DTO for a plan day, read through the shipped route. */
const readDay = async (planId: string, dayKey: string): Promise<MealPlanDayResponse> => {
    const response = await asUser(request.get(`/api/meal-planning/plans/${planId}/days/${dayKey}`), {
        uid: USER_ID,
    }).expect(200);

    return (response.body as { day: MealPlanDayResponse }).day;
};

/** One planned meal as the day read reports it. */
const readMeal = async (planId: string, dayKey: string, mealId: string): Promise<MealPlanMealResponse> => {
    const day = await readDay(planId, dayKey);
    const meal = day.meals.find((candidate) => candidate.id === mealId);

    if (meal === undefined) {
        throw new Error(`the day read for ${dayKey} reported no meal ${mealId}`);
    }

    return meal;
};

/** The caller's current plan, which is the surface `summary.loggedEntryCount` reaches the client on. */
const readCurrentPlan = async (): Promise<MealPlanResponse> => {
    const response = await asUser(request.get('/api/meal-planning/plans/current'), { uid: USER_ID }).expect(
        200,
    );
    const body = response.body as { current: MealPlanResponse | null };

    if (body.current === null) {
        throw new Error('GET /plans/current reported no current plan for the fixture week');
    }

    return body.current;
};

/** The entries the shipped diary read reports for one bucket of one day. */
const diaryEntries = async (
    dayKey: string,
    bucketName: string = DEFAULT_MEAL_NAMES[0],
): Promise<Record<string, unknown>[]> => {
    const response = await asUser(request.get(`/api/macros/${dayKey}`), { uid: USER_ID }).expect(200);
    const body = response.body as {
        meals: { name: string; entries: Record<string, unknown>[] }[];
    };

    return body.meals.find((meal) => meal.name === bucketName)?.entries ?? [];
};

/** The day totals the shipped diary read reports. */
const diaryTotals = async (dayKey: string) => {
    const response = await asUser(request.get(`/api/macros/${dayKey}`), { uid: USER_ID }).expect(200);

    return (response.body as { totals: Record<string, number> }).totals;
};

/**
 * The full-precision planned portion of a slot: the recipe's per-serving values
 * times the slot's stored multiplier, with nothing rounded.
 *
 * Read from the rows rather than written down, so the expectations below cannot
 * drift from the fixture, and so the arithmetic under test is measured rather
 * than restated.
 */
const plannedPortion = (multiplier: number) => ({
    calories: week.recipe.per_serving_calories * multiplier,
    protein: week.recipe.per_serving_protein_g * multiplier,
    carbs: week.recipe.per_serving_carbs_g * multiplier,
    fat: week.recipe.per_serving_fat_g * multiplier,
});

let week: SeededWeek;

beforeEach(async () => {
    mockMealPlanningEnabled = true;
    await truncateFeatureTables();
    week = await seedPlannedWeek();
});

afterAll(async () => {
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * The precondition the whole endpoint rests on
 *
 * The body names a bucket by id and never by name, so the client has to get
 * that id from somewhere. `GET /api/macros/:date` is that somewhere, and it
 * self-heals the four default buckets on every read.
 * ------------------------------------------------------------------------- */

describe('the diary buckets a planned log targets', () => {
    it('backfills the four default buckets in order for a date never touched before', async () => {
        const untouchedDayKey = addDaysToDayKey(week.dayKey, 40);

        expect(
            await prisma.meals.count({ where: { user_id: USER_ID, date: new Date(untouchedDayKey) } }),
        ).toBe(0);

        const response = await asUser(request.get(`/api/macros/${untouchedDayKey}`), {
            uid: USER_ID,
        }).expect(200);
        const body = response.body as { meals: { name: string; sortOrder: number }[] };

        // The names AND their order, because `sort_order` is the array index of
        // `DEFAULT_MEALS` and the slot picker on frame 15 renders them in it.
        expect(body.meals.map((meal) => meal.name)).toEqual([...DEFAULT_MEAL_NAMES]);
        expect(body.meals.map((meal) => meal.sortOrder)).toEqual([0, 1, 2, 3]);
    });

    it('gives each user their own buckets for the same day', async () => {
        await makeUser({ id: OTHER_USER_ID });

        const mine = await diaryBucketId(USER_ID, week.dayKey);
        const theirs = await diaryBucketId(OTHER_USER_ID, week.dayKey);

        expect(mine).not.toBe(theirs);
    });
});

/* ---------------------------------------------------------------------------
 * The feature gate, which answers before anything is looked up
 * ------------------------------------------------------------------------- */

describe('the meal-planning feature gate', () => {
    it('answers 503 feature_disabled when the server flag is off', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        mockMealPlanningEnabled = false;

        const response = await logRequest(
            week.plan.id,
            week.breakfast.id,
            logBody({ diaryMealId: bucketId }),
        );

        expect(response.status).toBe(503);
        expect(response.body).toStrictEqual({ error: 'feature_disabled' });
        expect(await storedEntries()).toHaveLength(0);
        expect(await storedActions()).toHaveLength(0);
    });

    it('gates before any lookup, so a plan that does not exist still answers 503', async () => {
        // The order is the whole assertion: `assertMealPlanningEnabled()` runs
        // as the handler's first statement, so a disabled release reports a
        // CAPABILITY rather than leaking whether a plan id exists. Were the gate
        // placed after the plan read, this same request would answer 404 and a
        // client would treat a switched-off feature as a missing plan.
        mockMealPlanningEnabled = false;

        const response = await logRequest(randomUUID(), randomUUID(), {
            servings: 1,
            date: week.dayKey,
            diaryMealId: randomUUID(),
            expectedPlanRevision: 1,
            idempotencyKey: randomUUID(),
        });

        expect(response.status).toBe(503);
        expect(response.body).toStrictEqual({ error: 'feature_disabled' });
    });

    it('gates before the request is parsed, so a malformed body also answers 503', async () => {
        mockMealPlanningEnabled = false;

        const response = await logRequest(week.plan.id, week.breakfast.id, { servings: 'lots' });

        expect(response.status).toBe(503);
        expect(response.body).toStrictEqual({ error: 'feature_disabled' });
    });

    it('does not gate the diary routes the planner writes into', async () => {
        // `/api/macros/*` is ungated by design (§0.5.2): the diary is the
        // shipped feature and must keep working while planning is switched off,
        // which is also what lets a client resolve a bucket id either way.
        mockMealPlanningEnabled = false;

        await asUser(request.get(`/api/macros/${week.dayKey}`), { uid: USER_ID }).expect(200);
    });
});

/* ---------------------------------------------------------------------------
 * Refusals: status, machine code and payload — never an error class
 *
 * Every case also asserts that NOTHING was written, because a refusal that
 * rolls back partially is indistinguishable from one that does not at the
 * status line alone.
 * ------------------------------------------------------------------------- */

describe('a refused planned log', () => {
    /** The verbatim body every 404 on this route answers with. */
    const PLAN_NOT_FOUND_BODY = { error: 'Plan not found' };

    /** Nothing was written: no entry, no ledger row, and the plan has not moved. */
    const expectNothingWritten = async (planId: string, expectedRevision = 1): Promise<void> => {
        expect(await storedEntries()).toHaveLength(0);
        expect(await storedActions()).toHaveLength(0);
        expect(await planRevision(planId)).toBe(expectedRevision);
    };

    describe('a request the parser cannot accept', () => {
        const parserCases: [string, Record<string, unknown>, string, string][] = [
            ['servings below the contract', { servings: 0.1 }, 'servings', 'invalid_servings'],
            ['servings above the contract', { servings: 10.5 }, 'servings', 'invalid_servings'],
            ['servings with three decimals', { servings: 1.125 }, 'servings', 'invalid_servings'],
            ['a malformed date', { date: '2026-13-45' }, 'date', 'invalid_date'],
            ['a non-UUID diaryMealId', { diaryMealId: 'not-a-uuid' }, 'diaryMealId', 'invalid_id'],
            ['a non-UUID idempotencyKey', { idempotencyKey: 'not-a-uuid' }, 'idempotencyKey', 'invalid_id'],
            [
                'a fractional expectedPlanRevision',
                { expectedPlanRevision: 1.5 },
                'expectedPlanRevision',
                'not_an_integer',
            ],
        ];

        it.each(parserCases)(
            'answers 400 invalid_request naming the field for %s',
            async (_case, overrides, field, code) => {
                const bucketId = await diaryBucketId(USER_ID, week.dayKey);

                const response = await logRequest(week.plan.id, week.breakfast.id, {
                    ...logBody({ diaryMealId: bucketId }),
                    ...overrides,
                });

                expect(response.status).toBe(400);
                expect(response.body).toMatchObject({ error: 'invalid_request' });
                expect((response.body as { details: unknown[] }).details).toContainEqual({ field, code });

                await expectNothingWritten(week.plan.id);
            },
        );

        it('answers 400 invalid_request when expectedPlanRevision is absent', async () => {
            // Absent rather than malformed: the revision is what makes this
            // write a compare-and-swap, so a body without one has to be refused
            // instead of defaulted to the plan's current value — defaulting
            // would turn every stale client into a silent overwrite.
            const bucketId = await diaryBucketId(USER_ID, week.dayKey);
            const { expectedPlanRevision: _omitted, ...body } = logBody({ diaryMealId: bucketId });

            const response = await logRequest(week.plan.id, week.breakfast.id, body);

            expect(response.status).toBe(400);
            expect((response.body as { details: unknown[] }).details).toContainEqual({
                field: 'expectedPlanRevision',
                code: 'required',
            });

            await expectNothingWritten(week.plan.id);
        });

        it('refuses mealName as an unknown field rather than honouring it', async () => {
            // The bucket is addressed by id, and `mealName` is absent from
            // `ACCEPTED_FIELDS` deliberately: honouring a name would let a
            // client write into — or invent — a bucket of its own choosing. It
            // is REPORTED rather than dropped, so a client never believes a
            // value it sent was applied.
            const bucketId = await diaryBucketId(USER_ID, week.dayKey);

            const response = await logRequest(week.plan.id, week.breakfast.id, {
                ...logBody({ diaryMealId: bucketId }),
                mealName: 'Dinner',
            });

            expect(response.status).toBe(400);
            expect(response.body).toStrictEqual({
                error: 'invalid_request',
                details: [{ field: 'mealName', code: 'unknown_field' }],
            });

            await expectNothingWritten(week.plan.id);
        });

        it('reports every offending field of one request in a single answer', async () => {
            const response = await logRequest(
                'not-a-uuid',
                week.breakfast.id,
                {
                    servings: 0,
                    date: '2026-13-45',
                    diaryMealId: 'also-not-a-uuid',
                    expectedPlanRevision: 1.5,
                    idempotencyKey: 'nor-this',
                    mealName: 'Breakfast',
                },
            );

            expect(response.status).toBe(400);
            // Path ids first, then the body's own fields, so the order the
            // client renders its inline errors in follows the order the request
            // is read in — and one round trip fixes everything.
            expect((response.body as { details: { field: string }[] }).details.map((d) => d.field)).toEqual([
                'planId',
                'servings',
                'date',
                'diaryMealId',
                'expectedPlanRevision',
                'idempotencyKey',
                'mealName',
            ]);

            await expectNothingWritten(week.plan.id);
        });
    });

    /* -----------------------------------------------------------------------
     * A malformed PARENT path id
     *
     * The body's five ids are covered above; the two the URL carries are not,
     * and they are the ones every request to this route has. Unparsed, a
     * non-UUID `planId` or `mealId` reaches a `where: { id }` predicate on a
     * `uuid` column — a PostgreSQL cast error, surfacing as a `500` with a
     * driver message where §0.5.2 promises a `400 invalid_request` naming the
     * field — and it does so on a WRITE, past the advisory lock, the ledger
     * reservation and `buildRequestFingerprint`. That is why
     * `parseLogPlannedMealCall` is `logPlannedMeal`'s first statement, before
     * any await.
     *
     * The ORDER of `details` is asserted as well as their content: the path is
     * judged first and the body second, in one verdict, so a request with a bad
     * id and a bad field is fixed in one round trip and the client renders its
     * inline errors in the order the request reads.
     * --------------------------------------------------------------------- */

    describe('a malformed parent path id', () => {
        /** Not a UUID of any version, and not an id this route could ever mint. */
        const MALFORMED_ID = 'not-a-uuid';

        const PLAN_ID_DETAIL: InvalidRequestDetail = { field: 'planId', code: 'invalid_id' };
        const MEAL_ID_DETAIL: InvalidRequestDetail = { field: 'mealId', code: 'invalid_id' };

        /**
         * A case name, the two path ids it sends, what it overrides in an
         * otherwise-valid body, and the details it must be answered with.
         *
         * The ids come from a THUNK because the fixture is seeded per case in
         * `beforeEach`: a table holding `week.plan.id` would read it while the
         * `describe` is still being collected, before any fixture exists.
         */
        type MalformedPathCase = [
            string,
            () => { planId: string; mealId: string },
            Record<string, unknown>,
            InvalidRequestDetail[],
        ];

        const pathCases: MalformedPathCase[] = [
            [
                'the planId',
                () => ({ planId: MALFORMED_ID, mealId: week.breakfast.id }),
                {},
                [PLAN_ID_DETAIL],
            ],
            [
                'the mealId',
                () => ({ planId: week.plan.id, mealId: MALFORMED_ID }),
                {},
                [MEAL_ID_DETAIL],
            ],
            [
                'both path ids',
                () => ({ planId: MALFORMED_ID, mealId: MALFORMED_ID }),
                {},
                [PLAN_ID_DETAIL, MEAL_ID_DETAIL],
            ],
            [
                // The path AND the body wrong together: the two path details
                // come FIRST and the body's follow, which is the ordering
                // `parseLogPlannedMealCall` composes and the reason a client
                // never has to send the same request twice to learn both.
                'both path ids beside a body field',
                () => ({ planId: MALFORMED_ID, mealId: MALFORMED_ID }),
                { servings: 0.1 },
                [PLAN_ID_DETAIL, MEAL_ID_DETAIL, { field: 'servings', code: 'invalid_servings' }],
            ],
        ];

        it.each(pathCases)(
            'answers 400 invalid_request naming %s, and reserves nothing',
            async (_case, pathIds, overrides, details) => {
                const bucketId = await diaryBucketId(USER_ID, week.dayKey);
                const idempotencyKey = randomUUID();
                const { planId, mealId } = pathIds();
                const mealBefore = await mealRow(week.breakfast.id);

                const response = await logRequest(planId, mealId, {
                    ...logBody({ diaryMealId: bucketId, idempotencyKey }),
                    ...overrides,
                });

                expect(response.status).toBe(400);
                expect(response.body).toStrictEqual({ error: 'invalid_request', details });

                await expectNothingWritten(week.plan.id);
                // And the key itself is untouched, so the request the client
                // repairs is still a FIRST attempt under it rather than a
                // reservation nothing will complete.
                expect(
                    await prisma.meal_plan_actions.findMany({
                        where: { user_id: USER_ID, idempotency_key: idempotencyKey },
                    }),
                ).toEqual([]);
                // Byte-equal, not merely un-revisioned: no column of the meal
                // row is touched by a refusal at the boundary.
                expect(await mealRow(week.breakfast.id)).toEqual(mealBefore);
            },
        );

        it('answers a malformed planId 400 rather than the 404 a plan that is absent gets', async () => {
            // The distinction the client acts on, and the reason parsing is not
            // interchangeable with querying: a `404 Plan not found` tells a
            // client its plan is gone and sends it to regenerate, when in fact
            // it built a bad URL and its plan is exactly where it was. A
            // well-formed id that matches nothing is the genuine 404.
            const bucketId = await diaryBucketId(USER_ID, week.dayKey);

            const malformed = await logRequest(
                MALFORMED_ID,
                week.breakfast.id,
                logBody({ diaryMealId: bucketId }),
            );
            const absent = await logRequest(
                randomUUID(),
                week.breakfast.id,
                logBody({ diaryMealId: bucketId }),
            );

            expect(malformed.status).toBe(400);
            expect(absent.status).toBe(404);
            expect(malformed.body).not.toEqual(absent.body);
            expect(absent.body).toStrictEqual(PLAN_NOT_FOUND_BODY);
            // Neither is a 500, which is what an unparsed id reaching the `uuid`
            // predicate would be, and neither body names the column or the
            // driver that would have produced one (Rule §4).
            expect(JSON.stringify(malformed.body)).not.toMatch(/PrismaClient|Invalid `|uuid|meal_plan/i);

            await expectNothingWritten(week.plan.id);
        });
    });

    describe('a target the caller may not write to', () => {
        it('refuses a diary bucket belonging to another user, with the shared 404', async () => {
            await makeUser({ id: OTHER_USER_ID });
            const foreignBucketId = await diaryBucketId(OTHER_USER_ID, week.dayKey);

            const response = await logRequest(
                week.plan.id,
                week.breakfast.id,
                logBody({ diaryMealId: foreignBucketId }),
            );

            expect(response.status).toBe(404);
            expect(response.body).toStrictEqual(PLAN_NOT_FOUND_BODY);

            await expectNothingWritten(week.plan.id);
            // And nothing landed in the other user's diary either.
            expect(await prisma.meal_entries.count({ where: { user_id: OTHER_USER_ID } })).toBe(0);
        });

        it('refuses a bucket whose own date is not the date being logged', async () => {
            const otherDayKey = addDaysToDayKey(week.dayKey, 1);
            const otherDayBucketId = await diaryBucketId(USER_ID, otherDayKey);

            const response = await logRequest(
                week.plan.id,
                week.breakfast.id,
                // A bucket the caller owns, inside the plan week — only its own
                // date disagrees with `date`.
                logBody({ diaryMealId: otherDayBucketId, date: week.dayKey }),
            );

            expect(response.status).toBe(404);
            expect(response.body).toStrictEqual(PLAN_NOT_FOUND_BODY);

            await expectNothingWritten(week.plan.id);
        });

        it('refuses a date outside the plan week even when the bucket belongs to the caller', async () => {
            // §0.5.2 lists the in-week rule beside the request validations, but
            // it is judged against STORED plan data and not against the shape
            // of the request — the parser cannot know the plan's week — so it
            // is one of this route's indistinguishable 404s rather than a 400.
            // A well-formed day key outside the week is the case; a malformed
            // one is the parser's, above.
            const outsideDayKey = addDaysToDayKey(week.planEndDayKey, 1);
            const outsideBucketId = await diaryBucketId(USER_ID, outsideDayKey);

            const response = await logRequest(
                week.plan.id,
                week.breakfast.id,
                logBody({ diaryMealId: outsideBucketId, date: outsideDayKey }),
            );

            expect(response.status).toBe(404);
            expect(response.body).toStrictEqual(PLAN_NOT_FOUND_BODY);

            await expectNothingWritten(week.plan.id);
        });

        it('answers a nonexistent plan, a nonexistent meal and a foreign bucket identically', async () => {
            // Rules §1.5 and §8: a response must never be an oracle for what
            // exists, so "no such plan", "no such meal" and "not yours" are ONE
            // answer. Asserted together, because the risk is that one of the
            // three drifts on its own.
            await makeUser({ id: OTHER_USER_ID });
            const bucketId = await diaryBucketId(USER_ID, week.dayKey);
            const foreignBucketId = await diaryBucketId(OTHER_USER_ID, week.dayKey);

            const answers = await Promise.all([
                logRequest(randomUUID(), week.breakfast.id, logBody({ diaryMealId: bucketId })),
                logRequest(week.plan.id, randomUUID(), logBody({ diaryMealId: bucketId })),
                logRequest(week.plan.id, week.breakfast.id, logBody({ diaryMealId: randomUUID() })),
                logRequest(week.plan.id, week.breakfast.id, logBody({ diaryMealId: foreignBucketId })),
            ]);

            for (const answer of answers) {
                expect(answer.status).toBe(404);
                expect(answer.body).toStrictEqual(PLAN_NOT_FOUND_BODY);
            }

            await expectNothingWritten(week.plan.id);
        });

        it('refuses a planned meal of the caller that belongs to a different plan', async () => {
            // The meal read carries the parent chain — `{id, meal_plan_id,
            // user_id}` (Rule §5.1) — so a meal id that is genuinely the
            // caller's still cannot be logged under the wrong plan. Without the
            // `meal_plan_id` term this request would write an entry linked to a
            // meal of another week.
            const otherPlan = await makePlan(USER_ID, {
                startDate: addDaysToDayKey(week.planEndDayKey, 1),
                recipeVersionId: week.recipe.id,
                dayCount: 2,
            });
            const bucketId = await diaryBucketId(USER_ID, week.dayKey);

            const response = await logRequest(
                week.plan.id,
                otherPlan.meal_plan_days[0].meal_plan_meals[0].id,
                logBody({ diaryMealId: bucketId }),
            );

            expect(response.status).toBe(404);
            expect(response.body).toStrictEqual(PLAN_NOT_FOUND_BODY);

            await expectNothingWritten(week.plan.id);
        });
    });

    describe('a plan that cannot be written to', () => {
        it('answers 409 stale_plan with the revision the plan actually holds', async () => {
            const bucketId = await diaryBucketId(USER_ID, week.dayKey);

            const response = await logRequest(
                week.plan.id,
                week.breakfast.id,
                logBody({ diaryMealId: bucketId, expectedPlanRevision: 7 }),
            );

            expect(response.status).toBe(409);
            // The current value travels back, so the client refetches at a
            // revision that exists rather than guessing.
            expect(response.body).toStrictEqual({ error: 'stale_plan', currentRevision: 1 });

            await expectNothingWritten(week.plan.id);
        });

        it('answers 409 plan_not_active pointing at the week that replaced a superseded plan', async () => {
            const superseded = await makePlan(USER_ID, {
                startDate: addDaysToDayKey(week.planEndDayKey, 1),
                recipeVersionId: week.recipe.id,
                status: 'superseded',
                dayCount: 2,
            });
            const replacement = await makePlan(USER_ID, {
                startDate: addDaysToDayKey(week.planEndDayKey, 8),
                recipeVersionId: week.recipe.id,
                replaced_plan_id: superseded.id,
                dayCount: 2,
            });
            const supersededDayKey = toDayKey(superseded.meal_plan_days[0].date);
            const bucketId = await diaryBucketId(USER_ID, supersededDayKey);

            const response = await logRequest(
                superseded.id,
                superseded.meal_plan_days[0].meal_plan_meals[0].id,
                logBody({ diaryMealId: bucketId, date: supersededDayKey }),
            );

            expect(response.status).toBe(409);
            expect(response.body).toStrictEqual({
                error: 'plan_not_active',
                replacementPlanId: replacement.id,
            });

            await expectNothingWritten(superseded.id);
        });

        it('answers 409 plan_not_active with the ended reason for a week that has passed', async () => {
            const ended = await makePlan(USER_ID, {
                startDate: FIXTURE_ENDED_PLAN_START_DAY_KEY,
                recipeVersionId: week.recipe.id,
                dayCount: 2,
            });
            const endedDayKey = toDayKey(ended.meal_plan_days[0].date);
            const bucketId = await diaryBucketId(USER_ID, endedDayKey);

            const response = await logRequest(
                ended.id,
                ended.meal_plan_days[0].meal_plan_meals[0].id,
                logBody({ diaryMealId: bucketId, date: endedDayKey }),
            );

            expect(response.status).toBe(409);
            // A reason rather than a replacement: nothing superseded this plan,
            // its week simply went by, and the client offers the next week
            // instead of refetching a replacement that does not exist.
            expect(response.body).toStrictEqual({ error: 'plan_not_active', reason: 'ended' });

            await expectNothingWritten(ended.id);
        });
    });

    describe('what every refusal has in common', () => {
        /** One refusal of each class this route can answer. */
        const everyRefusal = async () => {
            await makeUser({ id: OTHER_USER_ID });
            const bucketId = await diaryBucketId(USER_ID, week.dayKey);
            const foreignBucketId = await diaryBucketId(OTHER_USER_ID, week.dayKey);

            const responses = [
                await logRequest(week.plan.id, week.breakfast.id, { servings: 'lots' }),
                await logRequest(week.plan.id, week.breakfast.id, logBody({ diaryMealId: foreignBucketId })),
                await logRequest(randomUUID(), week.breakfast.id, logBody({ diaryMealId: bucketId })),
                await logRequest(
                    week.plan.id,
                    week.breakfast.id,
                    logBody({ diaryMealId: bucketId, expectedPlanRevision: 9 }),
                ),
            ];

            mockMealPlanningEnabled = false;
            responses.push(
                await logRequest(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId })),
            );
            mockMealPlanningEnabled = true;

            return responses;
        };

        it('never answers 403, because a cross-user resource is absent rather than forbidden', async () => {
            const responses = await everyRefusal();

            expect(responses.map((response) => response.status).sort()).toEqual([400, 404, 404, 409, 503]);
            expect(responses.some((response) => response.status === 403)).toBe(false);
        });

        it('carries no raw error object, stack or Prisma text in any body', async () => {
            // Rule §4 names `{error: err}` as the pattern to fix rather than
            // follow: an error body is a message and a code, never the thing
            // that was thrown. A stack or a Prisma message here would describe
            // the schema and the query to whoever asked.
            const allowedKeys = ['error', 'details', 'currentRevision', 'replacementPlanId', 'reason'];

            for (const response of await everyRefusal()) {
                const body = response.body as Record<string, unknown>;

                expect(typeof body.error).toBe('string');
                expect(Object.keys(body).every((key) => allowedKeys.includes(key))).toBe(true);

                const serialized = JSON.stringify(body);

                expect(serialized).not.toMatch(/stack|PrismaClient|Invalid `prisma|node_modules|at Object\./i);
            }
        });

        it('cannot be redirected by a userId in the body', async () => {
            // Rule §4: identity is `getUserId(req)` — the verified token's
            // claims — so no body field may name a user. This endpoint is
            // stricter than "ignored": `userId` is not in `ACCEPTED_FIELDS`, so
            // the whole request is refused and the caller learns the value was
            // not applied, rather than sending it forever believing it was.
            await makeUser({ id: OTHER_USER_ID });
            const bucketId = await diaryBucketId(USER_ID, week.dayKey);

            const response = await logRequest(week.plan.id, week.breakfast.id, {
                ...logBody({ diaryMealId: bucketId }),
                userId: OTHER_USER_ID,
            });

            expect(response.status).toBe(400);
            expect(response.body).toStrictEqual({
                error: 'invalid_request',
                details: [{ field: 'userId', code: 'unknown_field' }],
            });

            await expectNothingWritten(week.plan.id);
            expect(await prisma.meal_entries.count({ where: { user_id: OTHER_USER_ID } })).toBe(0);
        });

        it('scopes the plan to the token holder, so another user cannot log into this plan', async () => {
            // The other half of the same rule, and the one a body field could
            // never reach: the plan predicate carries `user_id: userId` from the
            // token (§5.1), so an authenticated stranger sending a
            // perfectly-formed request for this plan, this meal and this
            // caller's own bucket is answered with the shared 404.
            await makeUser({ id: OTHER_USER_ID });
            const bucketId = await diaryBucketId(USER_ID, week.dayKey);

            const response = await logRequest(
                week.plan.id,
                week.breakfast.id,
                logBody({ diaryMealId: bucketId }),
                OTHER_USER_ID,
            );

            expect(response.status).toBe(404);
            expect(response.body).toStrictEqual(PLAN_NOT_FOUND_BODY);

            await expectNothingWritten(week.plan.id);
            expect(await prisma.meal_entries.count({ where: { user_id: OTHER_USER_ID } })).toBe(0);
        });

        it('refuses an unauthenticated request before it reaches the handler', async () => {
            const bucketId = await diaryBucketId(USER_ID, week.dayKey);

            const response = await request
                .post(`/api/meal-planning/plans/${week.plan.id}/meals/${week.breakfast.id}/log`)
                .send(logBody({ diaryMealId: bucketId }));

            expect(response.status).toBe(401);
            await expectNothingWritten(week.plan.id);
        });
    });
});

/* ---------------------------------------------------------------------------
 * What one successful log writes, and what it answers with
 * ------------------------------------------------------------------------- */

describe('a successful planned log', () => {
    /** The response body, typed as the contract the client decodes. */
    const logged = async (mealId: string, body: unknown): Promise<LogPlannedMealResponse> =>
        (await logOrThrow(week.plan.id, mealId, body)).body as LogPlannedMealResponse;

    it('answers 201 with the created entry, the planned meal and the new plan revision', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        const response = await logRequest(
            week.plan.id,
            week.breakfast.id,
            logBody({ diaryMealId: bucketId }),
        );

        expect(response.status).toBe(201);
        expect(Object.keys(response.body as object).sort()).toEqual([
            'entry',
            'mealPlanMeal',
            'planRevision',
        ]);

        const body = response.body as LogPlannedMealResponse;

        expect(body.planRevision).toBe(2);
        expect(body.mealPlanMeal.id).toBe(week.breakfast.id);
    });

    it('writes exactly one meal_entries row carrying the planned origin, provenance and both links', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logged(week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const entry = await storedEntry();

        expect(entry).toMatchObject({
            meal_id: bucketId,
            user_id: USER_ID,
            // The three independent facts §0.7.3 keeps separate: the ORIGIN
            // (`input_method`), the PROVENANCE, and the two links the plan card
            // derives its logged state from.
            input_method: 'meal_plan',
            nutrition_provenance: 'source_backed',
            meal_plan_meal_id: week.breakfast.id,
            recipe_version_id: week.recipe.id,
            catalog_food_id: null,
            deleted_at: null,
        });
        expect(toDayKey(entry.date)).toBe(week.dayKey);
    });

    it('creates no personal food row, so the legacy dedupe branch cannot be reached', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logged(week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const entry = await storedEntry();

        // `logMealEntry`'s dedupe branch keys on `food_id`, and a planned meal
        // has none at all. `insertPlannedMealEntry` exists so that branch stays
        // unreachable from here (§0.5.1), and the absence of any `foods` row is
        // what shows it was not entered.
        expect(entry.food_id).toBeNull();
        expect(await prisma.foods.count({ where: { user_id: USER_ID } })).toBe(0);
        expect(await prisma.foods.count()).toBe(0);
    });

    it('treats a second log of the same meal under a new key as a second entry, never a merge', async () => {
        // The behavioural half of the same rule, and the one a reader can see:
        // were the dedupe branch reachable, an intentional second serving would
        // silently become `servings: 2` on the first row instead of its own
        // entry — and `loggedEntries` is a LIST precisely because two intents
        // are two entries (§0.5.2).
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logged(week.breakfast.id, logBody({ diaryMealId: bucketId, expectedPlanRevision: 1 }));
        await logged(week.breakfast.id, logBody({ diaryMealId: bucketId, expectedPlanRevision: 2 }));

        const entries = await storedEntries();

        expect(entries).toHaveLength(2);
        expect(entries.map((entry) => entry.servings)).toEqual([1, 1]);
        expect(entries[0].id).not.toBe(entries[1].id);
        expect(await prisma.foods.count()).toBe(0);
    });

    it('advances the plan revision by exactly one and leaves the meal revision alone', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        expect(await planRevision(week.plan.id)).toBe(1);

        const body = await logged(week.breakfast.id, logBody({ diaryMealId: bucketId }));

        // A log IS a plan-state change: the meal's derived logged state moved,
        // so the plan's revision moves and the response carries the new value.
        expect(body.planRevision).toBe(2);
        expect(await planRevision(week.plan.id)).toBe(2);
        // No column of the meal row changes — the link lives on the entry — so
        // bumping the meal's own revision would invalidate every client's
        // pinned meal revision for a write that did not touch the meal.
        expect((await mealRow(week.breakfast.id)).revision).toBe(1);
    });

    it('completes exactly one ledger row for the key, carrying the ids the action created', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);
        const idempotencyKey = randomUUID();

        await logged(week.breakfast.id, logBody({ diaryMealId: bucketId, idempotencyKey }));

        const entry = await storedEntry();
        const actions = await storedActions();

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            idempotency_key: idempotencyKey,
            action_type: 'log',
            // The status is PERSISTED, not inferred at read time: a later change
            // to this endpoint's success status must not retroactively rewrite
            // what an already-stored action replays.
            response_status: 201,
            plan_revision_after: 2,
            meal_plan_id: week.plan.id,
            meal_plan_meal_id: week.breakfast.id,
            meal_entry_id: entry.id,
        });
        expect(actions[0].response_snapshot).not.toBeNull();
    });

    it('returns the diary DTO with all thirteen keys present, two of them possibly null', async () => {
        // Rule §6: `src/types/` is the shape the client's io-ts codecs decode,
        // and for a codec a MISSING key is a different thing from a null one —
        // `io.type` rejects the first and accepts the second. The client reads
        // `mealPlanMealId` and `nutritionProvenance` straight off this response
        // to render the "From meal plan" caption without a refetch, so the KEY
        // SET is asserted and not merely the values.
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        const body = await logged(week.breakfast.id, logBody({ diaryMealId: bucketId }));

        expect(Object.keys(body.entry).sort()).toEqual([
            'calories',
            'carbs',
            'fat',
            'foodId',
            'id',
            'inputMethod',
            'loggedAt',
            'mealPlanMealId',
            'name',
            'nutritionProvenance',
            'protein',
            'servingText',
            'servings',
        ]);

        const entry: MealEntryResponse = body.entry;

        // Present AND null, asserted as the distinct facts they are: there is no
        // personal food behind a planned meal…
        expect(Object.prototype.hasOwnProperty.call(entry, 'foodId')).toBe(true);
        expect(entry.foodId).toBeNull();
        // …and the two new fields carry real values rather than being absent.
        expect(entry.mealPlanMealId).toBe(week.breakfast.id);
        expect(entry.nutritionProvenance).toBe('source_backed');
        expect(entry.inputMethod).toBe('meal_plan');
    });

    it('returns the planned meal already in its logged state, so the card needs no refetch', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        const body = await logged(week.breakfast.id, logBody({ diaryMealId: bucketId, servings: 2 }));
        const entry = await storedEntry();

        expect(body.mealPlanMeal.loggedEntries).toHaveLength(1);
        expect(body.mealPlanMeal.loggedEntries[0]).toMatchObject({
            entryId: entry.id,
            date: week.dayKey,
            mealName: DEFAULT_MEAL_NAMES[0],
            servings: 2,
            recipeVersionId: week.recipe.id,
            recipeName: week.recipe.name,
        });

        // The same meal, read a moment later through the day route, is
        // identical — the log response is not a specially-shaped one-off.
        const reread = await readMeal(week.plan.id, week.dayKey, week.breakfast.id);

        expect(reread.loggedEntries).toEqual(body.mealPlanMeal.loggedEntries);
    });

    it('reaches the shipped diary response with its origin and provenance intact', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logged(week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const entries = await diaryEntries(week.dayKey);

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            mealPlanMealId: week.breakfast.id,
            inputMethod: 'meal_plan',
            nutritionProvenance: 'source_backed',
            foodId: null,
        });
    });
});

/* ---------------------------------------------------------------------------
 * The rounding contract, end to end
 *
 * §0.7.3 fixes three steps, each owned by a different module:
 *
 *   1. the planned portion is `per_serving × portion_multiplier` at FULL
 *      precision (`derivePlannedPortion`);
 *   2. each of the four values is rounded ONCE into the stored snapshot
 *      (`derivePlannedSnapshot`, re-applied identically by
 *      `insertPlannedMealEntry`);
 *   3. the diary shows `Math.round(snapshot × servings)` (`nutrition.service
 *      .ts::asEaten`, and the same arithmetic in its SQL aggregates).
 *
 * No unit test can observe that composition, and the failure mode is silent —
 * an extra rounding yields numbers that merely differ a little from the ones
 * the app's "This adds" card shows. So the fixture is built so the contract and
 * each plausible double-rounding DISAGREE, and both candidate values are
 * computed here from the stored rows: the disagreement is asserted first, and
 * only then is the observed value pinned to the contract's side of it. A
 * fixture whose two candidates agreed would pass either way.
 * ------------------------------------------------------------------------- */

describe('the rounding contract', () => {
    /** The fixture's three planned-meal ROWS, by the portion each one plans. */
    const mealFor = (slot: string): SeededWeek['breakfast'] => {
        if (slot === BREAKFAST_SLOT) return week.breakfast;
        if (slot === LUNCH_SLOT) return week.lunch;

        return week.dinner;
    };

    const slotCases: [string, string, number, string][] = [
        ['a whole portion', BREAKFAST_SLOT, WHOLE_PORTION, DEFAULT_MEAL_NAMES[0]],
        ['a one-and-a-half portion', LUNCH_SLOT, LARGE_PORTION, DEFAULT_MEAL_NAMES[1]],
        ['a one-and-a-quarter portion', DINNER_SLOT, DIVERGENT_PORTION, DEFAULT_MEAL_NAMES[2]],
    ];

    describe('step 2 — the single rounding into the stored snapshot', () => {
        it.each(slotCases)(
            'stores %s as the planned portion rounded once per nutrient',
            async (_case, slot, multiplier, bucketName) => {
                const bucketId = await diaryBucketId(USER_ID, week.dayKey, bucketName);
                const meal = mealFor(slot);

                expect(meal.portion_multiplier).toBe(multiplier);

                await logOrThrow(week.plan.id, meal.id, logBody({ diaryMealId: bucketId }));

                const entry = await storedEntry();
                const planned = plannedPortion(multiplier);

                expect(entry.calories).toBe(Math.round(planned.calories));
                expect(entry.protein_g).toBe(Math.round(planned.protein));
                expect(entry.carbs_g).toBe(Math.round(planned.carbs));
                expect(entry.fat_g).toBe(Math.round(planned.fat));
            },
        );

        it('scales the recipe\'s exact per-serving values, never its rounded ones', async () => {
            // The first double-rounding this contract forbids: rounding the
            // recipe's per-serving figures BEFORE applying the multiplier. At
            // ×1.5 that inflates a 402.8 kcal serving to 605 instead of 604,
            // and 40.6 g of carbs to 62 instead of 61 — a whole unit each, on
            // the very card the user compares against their target.
            const bucketId = await diaryBucketId(USER_ID, week.dayKey, DEFAULT_MEAL_NAMES[1]);
            const planned = plannedPortion(LARGE_PORTION);

            const contractCalories = Math.round(planned.calories);
            const preRoundedCalories = Math.round(
                Math.round(week.recipe.per_serving_calories) * LARGE_PORTION,
            );
            const contractCarbs = Math.round(planned.carbs);
            const preRoundedCarbs = Math.round(Math.round(week.recipe.per_serving_carbs_g) * LARGE_PORTION);

            // The fixture earns its keep: the two candidates genuinely differ,
            // so the assertions below can fail.
            expect(Math.abs(contractCalories - preRoundedCalories)).toBeGreaterThanOrEqual(1);
            expect(Math.abs(contractCarbs - preRoundedCarbs)).toBeGreaterThanOrEqual(1);

            await logOrThrow(week.plan.id, week.lunch.id, logBody({ diaryMealId: bucketId }));

            const entry = await storedEntry();

            expect(entry.calories).toBe(contractCalories);
            expect(entry.calories).not.toBe(preRoundedCalories);
            expect(entry.carbs_g).toBe(contractCarbs);
            expect(entry.carbs_g).not.toBe(preRoundedCarbs);
        });

        it('describes one stored serving by the recipe itself at a whole portion', async () => {
            const bucketId = await diaryBucketId(USER_ID, week.dayKey);

            await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

            const entry = await storedEntry();

            expect(entry.name).toBe(week.recipe.name);
            expect(entry.serving_text).toBe(week.recipe.serving_description);
            expect(entry.servings).toBe(1);
        });

        it('shows a non-unit portion as a factor of the recipe, not folded into its amount', async () => {
            // `'1.5 × 1 bowl'` rather than `'1.5 bowl'`: folding the multiplier
            // into the leading number would restate a gram figure that did not
            // scale, and claim something untrue.
            const bucketId = await diaryBucketId(USER_ID, week.dayKey, DEFAULT_MEAL_NAMES[1]);

            await logOrThrow(week.plan.id, week.lunch.id, logBody({ diaryMealId: bucketId }));

            const entry = await storedEntry();

            expect(entry.serving_text).toContain(String(LARGE_PORTION));
            expect(entry.serving_text).toContain(week.recipe.serving_description);
        });
    });

    describe('step 3 — what the diary shows', () => {
        it('equals the planned-portion integers exactly at one serving', async () => {
            // The user-visible promise: "1 serving" in the diary IS the planned
            // meal, to the integer.
            const bucketId = await diaryBucketId(USER_ID, week.dayKey, DEFAULT_MEAL_NAMES[2]);
            const planned = plannedPortion(DIVERGENT_PORTION);

            await logOrThrow(week.plan.id, week.dinner.id, logBody({ diaryMealId: bucketId, servings: 1 }));

            expect(await diaryTotals(week.dayKey)).toEqual({
                calories: Math.round(planned.calories),
                protein: Math.round(planned.protein),
                carbs: Math.round(planned.carbs),
                fat: Math.round(planned.fat),
            });
        });

        it('scales the stored snapshot and not the full-precision planned portion', async () => {
            // The second double-rounding this contract forbids, and the one
            // that grows with the portion eaten: rounding
            // `planned × servings` instead of `snapshot × servings`. At ten
            // servings of the ×1.25 slot that is a five-calorie lie, and the
            // client — which only ever has the snapshot — would show the other
            // number.
            const bucketId = await diaryBucketId(USER_ID, week.dayKey, DEFAULT_MEAL_NAMES[2]);
            const planned = plannedPortion(DIVERGENT_PORTION);

            await logOrThrow(
                week.plan.id,
                week.dinner.id,
                logBody({ diaryMealId: bucketId, servings: MAX_SERVINGS }),
            );

            const entry = await storedEntry();

            // Asserted before the comparison below is built from it: the row
            // must hold ONE planned portion, never the as-eaten total. A
            // snapshot pre-scaled by `servings` would double-count what the
            // diary then multiplies, and a contract derived from such a row
            // would agree with the diary and prove nothing.
            expect(entry.calories).toBe(Math.round(planned.calories));
            expect(entry.protein_g).toBe(Math.round(planned.protein));
            expect(entry.carbs_g).toBe(Math.round(planned.carbs));
            expect(entry.fat_g).toBe(Math.round(planned.fat));

            const contract = {
                calories: Math.round(entry.calories * MAX_SERVINGS),
                protein: Math.round(entry.protein_g * MAX_SERVINGS),
                carbs: Math.round(entry.carbs_g * MAX_SERVINGS),
                fat: Math.round(entry.fat_g * MAX_SERVINGS),
            };
            const unrounded = {
                calories: Math.round(planned.calories * MAX_SERVINGS),
                protein: Math.round(planned.protein * MAX_SERVINGS),
                carbs: Math.round(planned.carbs * MAX_SERVINGS),
                fat: Math.round(planned.fat * MAX_SERVINGS),
            };

            // Every one of the four diverges, calories by five, so the
            // assertion that follows has teeth.
            expect(Math.abs(contract.calories - unrounded.calories)).toBeGreaterThanOrEqual(1);
            expect(contract.protein).not.toBe(unrounded.protein);
            expect(contract.carbs).not.toBe(unrounded.carbs);
            expect(contract.fat).not.toBe(unrounded.fat);

            expect(await diaryTotals(week.dayKey)).toEqual(contract);
        });

        it.each([
            ['a third', 0.33],
            ['a half', 0.5],
        ])('scales the snapshot by %s of a serving without moving it', async (_case, servings) => {
            const bucketId = await diaryBucketId(USER_ID, week.dayKey, DEFAULT_MEAL_NAMES[2]);
            const planned = plannedPortion(DIVERGENT_PORTION);

            await logOrThrow(week.plan.id, week.dinner.id, logBody({ diaryMealId: bucketId, servings }));

            const entry = await storedEntry();

            // The snapshot is still one whole planned portion — the eaten
            // fraction lives in `servings` and is applied on read, so editing it
            // later cannot corrupt what the meal WAS.
            expect(entry.calories).toBe(Math.round(planned.calories));
            expect(entry.servings).toBe(servings);

            expect(await diaryTotals(week.dayKey)).toEqual({
                calories: Math.round(entry.calories * servings),
                protein: Math.round(entry.protein_g * servings),
                carbs: Math.round(entry.carbs_g * servings),
                fat: Math.round(entry.fat_g * servings),
            });
        });

        it('sums a day as the per-entry rounded contributions, entry by entry', async () => {
            // Rounding once per ENTRY and then adding, rather than adding at
            // full precision and rounding the day — which is what the SQL
            // aggregates `SUM(ROUND(x * servings))::int` also do, so the diary,
            // the history and this response agree by construction.
            const servings = [1, 0.5, 0.25];
            const slots = [
                [week.breakfast.id, DEFAULT_MEAL_NAMES[0]],
                [week.lunch.id, DEFAULT_MEAL_NAMES[1]],
                [week.dinner.id, DEFAULT_MEAL_NAMES[2]],
            ] as const;

            for (const [index, [mealId, bucketName]] of slots.entries()) {
                const bucketId = await diaryBucketId(USER_ID, week.dayKey, bucketName);

                await logOrThrow(
                    week.plan.id,
                    mealId,
                    logBody({
                        diaryMealId: bucketId,
                        servings: servings[index],
                        expectedPlanRevision: index + 1,
                    }),
                );
            }

            const entries = await storedEntries();

            expect(entries).toHaveLength(3);

            const expected = entries.reduce(
                (totals, entry) => ({
                    calories: totals.calories + Math.round(entry.calories * entry.servings),
                    protein: totals.protein + Math.round(entry.protein_g * entry.servings),
                    carbs: totals.carbs + Math.round(entry.carbs_g * entry.servings),
                    fat: totals.fat + Math.round(entry.fat_g * entry.servings),
                }),
                { calories: 0, protein: 0, carbs: 0, fat: 0 },
            );

            expect(await diaryTotals(week.dayKey)).toEqual(expected);
        });
    });
});

/* ---------------------------------------------------------------------------
 * The idempotency ledger
 *
 * §0.5.1: a repeat of the same key and body replays the STORED status and body
 * "unchanged … so a client can never distinguish a replay from the original
 * response", and it does so BEFORE any revision or status check — which is the
 * whole reason a client whose response was lost can learn that its own log
 * succeeded even though the plan has since moved on.
 * ------------------------------------------------------------------------- */

describe('the idempotency ledger', () => {
    it('replays the stored 201 byte-for-byte for the same key and body', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);
        const body = logBody({ diaryMealId: bucketId });

        const first = await logOrThrow(week.plan.id, week.breakfast.id, body);
        const replay = await logOrThrow(week.plan.id, week.breakfast.id, body);

        // The PERSISTED status, not an inferred 200: `meal_plan_actions
        // .response_status` holds the value the first response carried, and a
        // replay is indistinguishable from the original by design.
        expect(replay.status).toBe(201);
        expect(replay.status).toBe(first.status);

        // Three strengths of the same claim, weakest first. Deep value
        // equality…
        expect(replay.body).toEqual(first.body);
        // …then key order and numeric formatting, which `toEqual` cannot see.
        // `response_snapshot` is a `jsonb` column that normalises key order at
        // rest, so `shapeStoredResponse` stores the body in exactly the order
        // the column will hold it — which is what makes this hold literally
        // rather than approximately.
        expect(JSON.stringify(replay.body)).toBe(JSON.stringify(first.body));
        // …and finally the bytes that actually crossed the wire.
        expect(replay.text).toBe(first.text);
    });

    it('inserts no second row and does not advance the revision a second time', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);
        const body = logBody({ diaryMealId: bucketId });

        await logOrThrow(week.plan.id, week.breakfast.id, body);
        await logOrThrow(week.plan.id, week.breakfast.id, body);

        expect(await storedEntries()).toHaveLength(1);
        expect(await storedActions()).toHaveLength(1);
        // The revision moved once, for the one write that happened.
        expect(await planRevision(week.plan.id)).toBe(2);
    });

    it('still replays after the plan revision has advanced past the one the key pinned', async () => {
        const breakfastBucketId = await diaryBucketId(USER_ID, week.dayKey);
        const lunchBucketId = await diaryBucketId(USER_ID, week.dayKey, DEFAULT_MEAL_NAMES[1]);
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
        // revision 1. This is the case that proves the ORDERING inside
        // `runKeyedAction`: were the revision checked before the replay gate,
        // this request would be answered `409 stale_plan` forever, retrying
        // something that already succeeded.
        const replay = await logRequest(week.plan.id, week.breakfast.id, firstBody);

        expect(replay.status).toBe(201);
        expect(replay.body).toEqual(first.body);
        expect(replay.text).toBe(first.text);
        // And the replayed body still reports the revision the action itself
        // produced, not the plan's current one.
        expect((replay.body as LogPlannedMealResponse).planRevision).toBe(2);

        // Two writes happened, and the replay was not a third.
        expect(await storedEntries()).toHaveLength(2);
        expect(await storedActions()).toHaveLength(2);
        expect(await planRevision(week.plan.id)).toBe(3);
    });

    it('answers 409 idempotency_conflict for the same key with a different body', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);
        const idempotencyKey = randomUUID();

        await logOrThrow(
            week.plan.id,
            week.breakfast.id,
            logBody({ diaryMealId: bucketId, idempotencyKey }),
        );

        const conflict = await logRequest(
            week.plan.id,
            week.breakfast.id,
            // Same key, a genuinely different request: two servings rather than
            // one. Replaying the stored answer here would tell the client its
            // NEW intent succeeded when nothing of the sort was recorded.
            logBody({ diaryMealId: bucketId, idempotencyKey, servings: 2 }),
        );

        expect(conflict.status).toBe(409);
        expect(conflict.body).toStrictEqual({ error: 'idempotency_conflict' });

        const entry = await storedEntry();

        // Nothing of the second body survives: one entry, still one serving.
        expect(entry.servings).toBe(1);
        expect(await storedActions()).toHaveLength(1);
        expect(await planRevision(week.plan.id)).toBe(2);
    });

    it('writes one entry for a double tap that sends the same key twice at once', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);
        const body = logBody({ diaryMealId: bucketId });

        const [first, second] = await Promise.all([
            logRequest(week.plan.id, week.breakfast.id, body),
            logRequest(week.plan.id, week.breakfast.id, body),
        ]);

        // Both are answered 201 — the per-user advisory lock serialises them,
        // so the loser reserves nothing and replays the winner's stored
        // response. Neither client can tell which it was.
        expect([first.status, second.status]).toEqual([201, 201]);
        expect(second.body).toEqual(first.body);

        expect(await storedEntries()).toHaveLength(1);
        expect(await storedActions()).toHaveLength(1);
        expect(await planRevision(week.plan.id)).toBe(2);
    });

    it('records a separate ledger row for each key, because each is a separate intent', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);
        const firstKey = randomUUID();
        const secondKey = randomUUID();

        await logOrThrow(
            week.plan.id,
            week.breakfast.id,
            logBody({ diaryMealId: bucketId, idempotencyKey: firstKey, expectedPlanRevision: 1 }),
        );
        await logOrThrow(
            week.plan.id,
            week.breakfast.id,
            logBody({ diaryMealId: bucketId, idempotencyKey: secondKey, expectedPlanRevision: 2 }),
        );

        const actions = await storedActions();
        const entries = await storedEntries();

        expect(actions.map((action) => action.idempotency_key)).toEqual([firstKey, secondKey]);
        expect(actions.map((action) => action.plan_revision_after)).toEqual([2, 3]);
        // Each ledger row points at the entry its own action created.
        expect(actions.map((action) => action.meal_entry_id).sort()).toEqual(
            entries.map((entry) => entry.id).sort(),
        );
    });
});

/* ---------------------------------------------------------------------------
 * A failure AFTER the diary entry has been inserted
 *
 * §0.5.1 makes the whole keyed write one transaction: the reservation, the
 * diary insert, the plan-revision bump and the ledger completion either all
 * commit or none of them do. Every refusal above fails BEFORE the insert — the
 * parser, the plan's status, the pinned revision, the diary bucket — so none of
 * them can tell a transaction apart from four sequential statements that happen
 * to be issued in the right order. The failure that would distinguish them is a
 * partial one: an entry in the diary with no ledger row behind it (the key
 * stranded, the retry answered `409 idempotency_conflict` forever), or a plan
 * revision that moved for a log the diary never received (every client
 * refetching at a number produced by nothing).
 *
 * TWO SEAMS, at the two steps that follow the insert, both installed as spies on
 * the module boundary `plannedMealLog.service.ts` reaches these functions
 * through — the only way to fail INSIDE its transaction, since the service
 * exposes no injectable step:
 *
 *  1. `nutrition.service.ts::insertPlannedMealEntry` is CALLED THROUGH and then
 *     throws. The row genuinely exists in the transaction's snapshot — the case
 *     proves the id it was given, so a stub that merely refused to write cannot
 *     be mistaken for this — and the revision bump never runs.
 *  2. `mealPlan.mapper.ts::toMealPlanMealResponse` throws. It is reached from
 *     `requireMealResponse`, which runs AFTER `bumpPlanRevision`, and
 *     `bumpPlanRevision` is a compare-and-swap that THROWS unless it writes
 *     exactly one row — so the mapper being reached at all is the proof that the
 *     increment was applied. That makes this the case for the revision half:
 *     the counter moved inside the transaction and must come back.
 *
 * Neither seam changes a rule, a predicate or a status: production code decides
 * the answer to every request below, and the only thing injected is the moment
 * of failure. Each case ends by proving the client's retry — the SAME key and
 * the SAME body — commits exactly once, which is the half a rollback alone does
 * not establish: rows can be absent because they were rolled back or because
 * the key was quietly burned.
 * ------------------------------------------------------------------------- */

describe('a fault after the diary entry has been inserted', () => {
    /**
     * The body the controller maps an unrecognised throw on this route to.
     *
     * A 500 and not a 502: `mealPlanning.errors.ts` has no class for "this
     * server's own write broke", and inventing a machine code for it would
     * promise the client an action it does not have. So the answer is the ONE
     * documented residual code every handler in
     * `mealPlanning.controller.ts` shares (`INTERNAL_ERROR`) rather than this
     * route's prose — §0.5.2 gives the client stable codes to map and no
     * display text, and eighteen handlers spelling their own 500 gave it
     * eighteen unmappable shapes. The route it failed on survives as the
     * `action` of the server event, where it costs the client nothing.
     *
     * The body is asserted whole so the fault cannot answer with a leaked
     * message either (Rule §4).
     */
    const WRITE_FAILED_BODY = { error: 'internal_error' };

    /**
     * Everything a rolled-back attempt must leave exactly as it found it: the
     * four tables the transaction touches AND the two wire surfaces a client
     * would have believed the log on.
     *
     * The wire halves are part of the snapshot rather than asserted as
     * emptiness, because the third case starts from a table that already holds a
     * committed log — and "unchanged" is the claim in every case.
     */
    const storedState = async () => ({
        entries: await storedEntries(),
        actions: await storedActions(),
        revision: await planRevision(week.plan.id),
        meal: await mealRow(week.breakfast.id),
        loggedEntries: (await readMeal(week.plan.id, week.dayKey, week.breakfast.id)).loggedEntries,
        diary: await diaryEntries(week.dayKey),
    });

    type StoredState = Awaited<ReturnType<typeof storedState>>;

    /**
     * An observation the injected fault had to make, reported rather than
     * silently skipped.
     *
     * Every case checks its seam RAN before it concludes anything from the
     * response: a 500 also arrives when the spy was never installed on the path
     * the request took, and that 500 would make each assertion below pass while
     * proving nothing about atomicity.
     */
    const requireObserved = (value: string | null, what: string): string => {
        if (value === null) {
            throw new Error(`the injected fault did not run: ${what} was never observed`);
        }

        return value;
    };

    /**
     * Silences the controller's own `console.error` for one request and restores
     * it afterwards, for the reason `api/requestParserWiring.test.ts` gives: the
     * handler logs before it answers 500, and a passing run should stay
     * readable. The response and the rows are the evidence, never the log.
     */
    const withSilencedErrorLog = async <TResult>(run: () => Promise<TResult>): Promise<TResult> => {
        const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            return await run();
        } finally {
            logged.mockRestore();
        }
    };

    /**
     * The complete no-trace proof for one rolled-back attempt.
     *
     * Compared against a snapshot taken with the same readers BEFORE the
     * request rather than against emptiness, so a case that had already logged
     * something proves "exactly the rows I had" instead of "none".
     *
     * `rolledBackEntryId` is the id the insert really produced inside the
     * transaction: asserting that id resolves to nothing is sharper than a count
     * of zero, because it names the row that existed.
     */
    const expectNoTraceOfAttempt = async (
        before: StoredState,
        idempotencyKey: string,
        rolledBackEntryId: string,
    ): Promise<void> => {
        expect(await storedEntries()).toEqual(before.entries);
        expect(await prisma.meal_entries.count({ where: { id: rolledBackEntryId } })).toBe(0);
        // No ledger row for the key, so the key is still a FIRST attempt rather
        // than a reservation nothing will ever complete — the state in which a
        // retry is answered `409 idempotency_conflict` and the log can never be
        // made to happen.
        expect(await storedActions()).toEqual(before.actions);
        expect(
            await prisma.meal_plan_actions.findMany({ where: { user_id: USER_ID, idempotency_key: idempotencyKey } }),
        ).toEqual([]);
        expect(await planRevision(week.plan.id)).toBe(before.revision);
        // The meal row is byte-equal, not merely un-revisioned: a log touches no
        // column of it at all.
        expect(await mealRow(week.breakfast.id)).toEqual(before.meal);

        // And the same facts on the wire, which is where a client would have
        // believed the log happened: the card carries exactly the entries it
        // carried before — for the first two cases, none, so the slot is not
        // LOGGED — the plan's revision has not moved, and the diary shows what
        // it showed.
        const meal = await readMeal(week.plan.id, week.dayKey, week.breakfast.id);

        expect(meal.loggedEntries).toEqual(before.loggedEntries);
        expect(meal.revision).toBe(before.meal.revision);

        const plan = await readCurrentPlan();

        expect(plan.revision).toBe(before.revision);
        expect(plan.summary.loggedEntryCount).toBe(before.entries.length);
        expect(await diaryEntries(week.dayKey)).toEqual(before.diary);
    };

    /**
     * The other half of every case: the client's retry of the identical request
     * commits once, all the way through.
     *
     * The ledger row is asserted as well as the entry, because "committed" for a
     * keyed write means the action was COMPLETED — an entry beside a reserved
     * but uncompleted row is the very state the rollback exists to prevent.
     */
    const expectCommittedExactlyOnce = async (
        idempotencyKey: string,
        body: unknown,
    ): Promise<void> => {
        const response = await logRequest(week.plan.id, week.breakfast.id, body);

        expect(response.status).toBe(201);
        expect((response.body as LogPlannedMealResponse).planRevision).toBe(2);

        const entry = await storedEntry();
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
        expect(await planRevision(week.plan.id)).toBe(2);
        expect((await mealRow(week.breakfast.id)).revision).toBe(1);
        expect(
            (await readMeal(week.plan.id, week.dayKey, week.breakfast.id)).loggedEntries.map(
                (logged) => logged.entryId,
            ),
        ).toEqual([entry.id]);
    };

    it('rolls the diary entry back when the step after the insert fails', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);
        const idempotencyKey = randomUUID();
        const body = logBody({ diaryMealId: bucketId, idempotencyKey });
        const before = await storedState();

        // Stated so the shared no-trace proof below reads as the strong claim it
        // is for this case: the slot is not logged, and after the rollback it
        // must still report `loggedEntries: []`.
        expect(before.entries).toHaveLength(0);
        expect(before.loggedEntries).toEqual([]);

        // The real function, captured before the spy replaces the property, so
        // the insert that runs is production's own — including its single
        // rounding of the snapshot.
        const insertEntry = nutritionService.insertPlannedMealEntry;
        let insertedEntryId: string | null = null;
        let insertCalls = 0;

        const response = await withSilencedErrorLog(async () => {
            const insert = jest
                .spyOn(nutritionService, 'insertPlannedMealEntry')
                .mockImplementation(async (tx, params) => {
                    insertCalls += 1;
                    // Written on the transaction's OWN client, so the row is
                    // visible to every statement that would have followed it,
                    // and only then does the step after it fail.
                    insertedEntryId = (await insertEntry(tx, params)).id;

                    throw new Error('the diary entry was inserted and the next step then failed');
                });

            try {
                return await logRequest(week.plan.id, week.breakfast.id, body);
            } finally {
                insert.mockRestore();
            }
        });

        const rolledBackEntryId = requireObserved(insertedEntryId, 'the inserted entry id');

        expect(insertCalls).toBe(1);
        expect(response.status).toBe(500);
        expect(response.body).toStrictEqual(WRITE_FAILED_BODY);

        await expectNoTraceOfAttempt(before, idempotencyKey, rolledBackEntryId);
        await expectCommittedExactlyOnce(idempotencyKey, body);
    });

    it('rolls the plan-revision bump back when the read-back after it fails', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);
        const idempotencyKey = randomUUID();
        const body = logBody({ diaryMealId: bucketId, idempotencyKey });
        const before = await storedState();

        expect(before.revision).toBe(1);
        expect(before.loggedEntries).toEqual([]);

        // What the mapper was handed, which is what makes this case evidence
        // rather than an assertion about source order: the entries it receives
        // are read INSIDE the transaction, so seeing the just-inserted row there
        // shows the insert had happened, and reaching the mapper at all shows
        // `bumpPlanRevision` had already written its one row (it throws
        // otherwise).
        let mappedEntryId: string | null = null;
        let mapperCalls = 0;

        const response = await withSilencedErrorLog(async () => {
            const mapper = jest
                .spyOn(mealPlanMapper, 'toMealPlanMealResponse')
                .mockImplementation((_meal, _recipeVersion, loggedEntries) => {
                    mapperCalls += 1;
                    mappedEntryId = loggedEntries[loggedEntries.length - 1]?.entryId ?? null;

                    throw new Error('the plan revision was bumped and the meal read-back then failed');
                });

            try {
                return await logRequest(week.plan.id, week.breakfast.id, body);
            } finally {
                // Restored before anything is read back over HTTP: every plan
                // read maps its meals through this same function, so a leaked
                // spy would answer the day read with a 500 and the rollback
                // would look like a broken route.
                mapper.mockRestore();
            }
        });

        const rolledBackEntryId = requireObserved(mappedEntryId, 'the entry the read-back saw');

        expect(mapperCalls).toBe(1);
        expect(response.status).toBe(500);
        expect(response.body).toStrictEqual(WRITE_FAILED_BODY);

        await expectNoTraceOfAttempt(before, idempotencyKey, rolledBackEntryId);
        await expectCommittedExactlyOnce(idempotencyKey, body);
    });

    it('leaves an earlier committed log untouched when a later one fails after its insert', async () => {
        // The same rollback against a NON-EMPTY table, which is the case a
        // `count === 0` assertion could never make: one log has committed, and
        // the failing attempt must remove its own row and nothing else — not the
        // earlier entry, not the earlier ledger row, and not the revision that
        // log legitimately produced.
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);
        const committedKey = randomUUID();

        await logOrThrow(
            week.plan.id,
            week.breakfast.id,
            logBody({ diaryMealId: bucketId, idempotencyKey: committedKey, expectedPlanRevision: 1 }),
        );

        const before = await storedState();

        expect(before.entries).toHaveLength(1);
        expect(before.actions).toHaveLength(1);
        expect(before.revision).toBe(2);
        // The committed log IS on the card, so the no-trace proof below is
        // asserting survival rather than absence.
        expect(before.loggedEntries.map((logged) => logged.entryId)).toEqual([before.entries[0].id]);

        const idempotencyKey = randomUUID();
        const body = logBody({ diaryMealId: bucketId, idempotencyKey, expectedPlanRevision: 2 });
        const insertEntry = nutritionService.insertPlannedMealEntry;
        let insertedEntryId: string | null = null;

        const response = await withSilencedErrorLog(async () => {
            const insert = jest
                .spyOn(nutritionService, 'insertPlannedMealEntry')
                .mockImplementation(async (tx, params) => {
                    insertedEntryId = (await insertEntry(tx, params)).id;

                    throw new Error('the second diary entry was inserted and the next step then failed');
                });

            try {
                return await logRequest(week.plan.id, week.breakfast.id, body);
            } finally {
                insert.mockRestore();
            }
        });

        const rolledBackEntryId = requireObserved(insertedEntryId, 'the inserted entry id');

        expect(response.status).toBe(500);
        expect(response.body).toStrictEqual(WRITE_FAILED_BODY);

        await expectNoTraceOfAttempt(before, idempotencyKey, rolledBackEntryId);

        // The committed log is still exactly one entry, one completed action and
        // the one revision it earned — and the failed attempt's own key is still
        // free, so the second serving can be made to happen.
        const retried = await logRequest(week.plan.id, week.breakfast.id, body);

        expect(retried.status).toBe(201);
        expect((retried.body as LogPlannedMealResponse).planRevision).toBe(3);

        const entries = await storedEntries();
        const actions = await storedActions();

        expect(entries).toHaveLength(2);
        expect(entries[0]).toEqual(before.entries[0]);
        expect(actions.map((action) => action.idempotency_key)).toEqual([committedKey, idempotencyKey]);
        expect(actions.map((action) => action.plan_revision_after)).toEqual([2, 3]);
        expect(await planRevision(week.plan.id)).toBe(3);
    });
});

/* ---------------------------------------------------------------------------
 * `loggedEntries` and the logged state the plan card derives
 *
 * `mealPlan.mapper.ts` has NO logic test, so its derivation is pinned here from
 * real diary rows — which is also the only place the join, the ordering and the
 * `deleted_at` predicate can be observed together. The log-driven half is this
 * file's; the A→B→C swap chain is `swaps.test.ts`'s.
 *
 * There is no `is_logged` column and no such field on the DTO: the card's state
 * is DERIVED from `loggedEntries` alone, by the two rules stated below. Each
 * rule is therefore written out as the client applies it, rather than asserted
 * through a flag that does not exist.
 * ------------------------------------------------------------------------- */

describe('the logged state derived from the diary', () => {
    /** The client's LOGGED rule: some live entry references the meal's CURRENT recipe. */
    const isLogged = (meal: MealPlanMealResponse): boolean =>
        meal.loggedEntries.some((entry) => entry.recipeVersionId === meal.recipe.versionId);

    /**
     * The client's logged-then-swapped rule: something was eaten for this slot,
     * but none of it was the recipe the slot now plans.
     */
    const isLoggedThenSwapped = (meal: MealPlanMealResponse): boolean =>
        meal.loggedEntries.length > 0 && !isLogged(meal);

    const breakfast = () => readMeal(week.plan.id, week.dayKey, week.breakfast.id);

    it('carries every member of the contract for one logged entry', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey, DEFAULT_MEAL_NAMES[1]);

        await logOrThrow(week.plan.id, week.lunch.id, logBody({ diaryMealId: bucketId, servings: 0.5 }));

        const entry = await storedEntry();
        const meal = await readMeal(week.plan.id, week.dayKey, week.lunch.id);

        expect(meal.loggedEntries).toHaveLength(1);
        expect(Object.keys(meal.loggedEntries[0]).sort()).toEqual([
            'date',
            'entryId',
            'loggedAt',
            'mealName',
            'recipeName',
            'recipeVersionId',
            'servings',
        ]);
        expect(meal.loggedEntries[0]).toEqual({
            entryId: entry.id,
            // The DIARY date, which is not necessarily the planned date.
            date: week.dayKey,
            // The bucket the user chose, by name — this is what "View in diary"
            // and the plan card's caption read.
            mealName: DEFAULT_MEAL_NAMES[1],
            servings: 0.5,
            loggedAt: entry.logged_at.toISOString(),
            recipeVersionId: week.recipe.id,
            recipeName: week.recipe.name,
        });
    });

    it('joins recipeName from recipe_versions rather than copying the entry snapshot', async () => {
        // The two are equal the moment an entry is written — the snapshot's
        // `name` IS the version's name at log time — so the only way to show
        // which one the DTO reads is to make them disagree. Renaming the
        // version afterwards does that: `meal_entries.name` keeps what was
        // eaten, and `loggedEntries[].recipeName` follows the recipe. Reading
        // the snapshot instead would look identical in every other case and
        // would then misname the recipe on a card whose recipe had been renamed.
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const entry = await storedEntry();
        const renamed = 'Renamed after the entry was written';

        await prisma.recipe_versions.update({ where: { id: week.recipe.id }, data: { name: renamed } });

        const meal = await breakfast();

        expect(entry.name).toBe(week.recipe.name);
        expect(renamed).not.toBe(week.recipe.name);
        expect(meal.loggedEntries[0].recipeName).toBe(renamed);
        expect(meal.loggedEntries[0].recipeName).not.toBe(entry.name);
    });

    it('orders two entries by loggedAt ascending, whatever order they were written in', async () => {
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

        const [written, writtenSecond] = await storedEntries();

        // `logged_at` is set explicitly and INVERTED against insertion order, so
        // the expected order cannot be satisfied by accident: a read that
        // returned rows in insertion order, or in primary-key order, fails.
        const earlier = new Date('2026-01-02T08:00:00.000Z');
        const later = new Date('2026-01-02T19:30:00.000Z');

        await prisma.meal_entries.update({ where: { id: written.id }, data: { logged_at: later } });
        await prisma.meal_entries.update({ where: { id: writtenSecond.id }, data: { logged_at: earlier } });

        const meal = await breakfast();

        expect(meal.loggedEntries.map((logged) => logged.entryId)).toEqual([
            writtenSecond.id,
            written.id,
        ]);
        expect(meal.loggedEntries.map((logged) => logged.loggedAt)).toEqual([
            earlier.toISOString(),
            later.toISOString(),
        ]);
    });

    it('breaks a tie on identical loggedAt by entryId, so the order is total', async () => {
        // Two servings recorded in the same instant is not exotic — a double tap
        // resolved as two intents, or a restore, can produce it. Without a
        // second sort term the order would be whatever the query happened to
        // return, and the card's caption ("you logged X for this slot") would
        // name different entries on successive reads.
        //
        // What this pins is the CONTRACT at the boundary, which is the right
        // place for it: `id` is the second term of the read's own `orderBy` AND
        // `byLoggedAt` re-applies it in the mapper, so the two layers agree and
        // either alone would satisfy this assertion. That redundancy is why the
        // next case matters — it is what catches one of the two drifting.
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

        const sameInstant = new Date('2026-01-02T08:00:00.000Z');
        const entries = await storedEntries();

        await prisma.meal_entries.updateMany({
            where: { id: { in: entries.map((entry) => entry.id) } },
            data: { logged_at: sameInstant },
        });

        const meal = await breakfast();

        expect(new Set(meal.loggedEntries.map((logged) => logged.loggedAt))).toEqual(
            new Set([sameInstant.toISOString()]),
        );
        expect(meal.loggedEntries.map((logged) => logged.entryId)).toEqual(
            entries.map((entry) => entry.id).sort(),
        );
    });

    it('reports the same order on the log response as on the day read', async () => {
        // TWO DIFFERENT READS IN TWO DIFFERENT MODULES build this list:
        // `plannedMealLog.service.ts` re-reads the meal to answer the log, and
        // `mealPlan.service.ts` reads it for the day view. Both project the
        // same mapper contract, so if either one's ordering drifted the card
        // would silently reorder between the response a client just received
        // and its next refetch — which no single-surface assertion can see.
        // Three entries on a tie, so a stable-but-wrong order is visible.
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

        const sameInstant = new Date('2026-03-04T07:15:00.000Z');

        await prisma.meal_entries.updateMany({
            where: { user_id: USER_ID },
            data: { logged_at: sameInstant },
        });

        const third = await logOrThrow(
            week.plan.id,
            week.breakfast.id,
            logBody({ diaryMealId: bucketId, expectedPlanRevision: 3 }),
        );
        const fromLogResponse = (third.body as LogPlannedMealResponse).mealPlanMeal.loggedEntries;
        const fromDayRead = (await breakfast()).loggedEntries;

        expect(fromLogResponse).toHaveLength(3);
        expect(fromDayRead).toEqual(fromLogResponse);
    });

    it('marks the meal logged when a live entry references its current recipe', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        expect(isLogged(await breakfast())).toBe(false);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const meal = await breakfast();

        expect(isLogged(meal)).toBe(true);
        expect(isLoggedThenSwapped(meal)).toBe(false);
        expect(meal.loggedEntries[0].recipeVersionId).toBe(meal.recipe.versionId);
    });

    it('reads as logged-then-swapped when the eaten recipe is no longer the planned one', async () => {
        // The state §0.2.5 draws for a slot that was logged and then swapped:
        // the card shows the NEW recipe as unlogged and captions what was
        // actually eaten. It is derived from the entries alone, which is why it
        // is provable here without the swap selector — the slot is moved to
        // another version directly, because which alternative the selector would
        // have chosen is `swaps.test.ts`'s subject and not this rule.
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const eaten = await storedEntry();
        const replacement = await makeRecipeVersion({
            slug: 'log-suite-replacement-recipe',
            catalogFoodId: week.food.id,
            perServing: PER_SERVING,
        });

        await prisma.meal_plan_meals.update({
            where: { id: week.breakfast.id },
            data: {
                recipe_version_id: replacement.id,
                previous_recipe_version_id: week.recipe.id,
                swapped_at: new Date(),
            },
        });

        const meal = await breakfast();

        expect(meal.recipe.versionId).toBe(replacement.id);
        expect(isLogged(meal)).toBe(false);
        expect(isLoggedThenSwapped(meal)).toBe(true);
        // The retained entry still names the recipe that was eaten, so the
        // caption can say so and "View in diary" can reach it.
        expect(meal.loggedEntries).toHaveLength(1);
        expect(meal.loggedEntries[0]).toMatchObject({
            entryId: eaten.id,
            recipeVersionId: week.recipe.id,
            recipeName: week.recipe.name,
        });
        // `previousRecipe` is the slot's AUDIT value, never the source of the
        // logged state — it is populated here, and the derivation above did not
        // consult it.
        expect(meal.previousRecipe).toEqual({ versionId: week.recipe.id, name: week.recipe.name });
    });

    it('excludes a soft-deleted entry, so a removed meal stops reading as eaten', async () => {
        // The partial index `(meal_plan_meal_id) WHERE deleted_at IS NULL`
        // exists for this read. A query that ignored `deleted_at` would keep the
        // LOGGED badge lit for a meal the user has deleted from their diary —
        // and the row itself survives a soft delete with its links intact, so
        // the link is no evidence on its own.
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const entry = await storedEntry();

        await prisma.meal_entries.update({ where: { id: entry.id }, data: { deleted_at: new Date() } });

        const meal = await breakfast();
        const stillStored = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        expect(stillStored.meal_plan_meal_id).toBe(week.breakfast.id);
        expect(meal.loggedEntries).toEqual([]);
        expect(isLogged(meal)).toBe(false);
        expect(isLoggedThenSwapped(meal)).toBe(false);
    });

    it('counts live linked entries in the plan summary the regeneration dialog reads', async () => {
        const breakfastBucketId = await diaryBucketId(USER_ID, week.dayKey);
        const lunchBucketId = await diaryBucketId(USER_ID, week.dayKey, DEFAULT_MEAL_NAMES[1]);

        expect((await readCurrentPlan()).summary.loggedEntryCount).toBe(0);

        await logOrThrow(
            week.plan.id,
            week.breakfast.id,
            logBody({ diaryMealId: breakfastBucketId, expectedPlanRevision: 1 }),
        );
        await logOrThrow(
            week.plan.id,
            week.lunch.id,
            logBody({ diaryMealId: lunchBucketId, expectedPlanRevision: 2 }),
        );

        expect((await readCurrentPlan()).summary.loggedEntryCount).toBe(2);

        const [first] = await storedEntries();

        await prisma.meal_entries.update({ where: { id: first.id }, data: { deleted_at: new Date() } });

        // "Logged food — kept" is a promise about what survives a
        // regeneration, so a deleted entry must not be counted among it.
        expect((await readCurrentPlan()).summary.loggedEntryCount).toBe(1);
    });
});

/* ---------------------------------------------------------------------------
 * What the shipped diary's own edit and delete do to the link
 *
 * These two routes are the shipped ones, and the logged state is derived from
 * the entries alone — so there is no `is_logged` column to correct and the only
 * way to observe the rule is to edit the entry the way the app does and read
 * the plan back.
 * ------------------------------------------------------------------------- */

describe('a planned entry edited or deleted through the diary', () => {
    /** The plan card's derived logged state for the fixture's breakfast slot. */
    const loggedEntryIds = async (): Promise<string[]> =>
        (await readMeal(week.plan.id, week.dayKey, week.breakfast.id)).loggedEntries.map(
            (entry) => entry.entryId,
        );

    /** Logs one whole planned breakfast and hands back the stored row. */
    const logBreakfast = async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        return storedEntry();
    };

    const editEntry = (entryId: string, body: Record<string, unknown>, uid: string = USER_ID) =>
        asUser(request.put(`/api/macros/entry/${entryId}`), { uid }).send(body);

    it('keeps the link when only the servings change, so the meal stays logged', async () => {
        const entry = await logBreakfast();
        const beforeTotals = await diaryTotals(week.dayKey);

        const response = await editEntry(entry.id, { servings: 2 }).expect(200);
        const edited = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        expect(edited.servings).toBe(2);
        // Only what was EATEN changed. The snapshot, the origin, the provenance
        // and both links are still what planning wrote, so the caption stays
        // "From meal plan" and the card stays LOGGED.
        expect(edited.calories).toBe(entry.calories);
        expect(edited.meal_plan_meal_id).toBe(week.breakfast.id);
        expect(edited.recipe_version_id).toBe(week.recipe.id);
        expect(edited.input_method).toBe('meal_plan');
        expect(edited.nutrition_provenance).toBe('source_backed');

        // The same four facts on the response the client renders from.
        expect(response.body).toMatchObject({
            mealPlanMealId: week.breakfast.id,
            inputMethod: 'meal_plan',
            nutritionProvenance: 'source_backed',
            servings: 2,
        });

        expect(await loggedEntryIds()).toEqual([entry.id]);
        expect(await diaryTotals(week.dayKey)).toEqual({
            calories: beforeTotals.calories * 2,
            protein: beforeTotals.protein * 2,
            carbs: beforeTotals.carbs * 2,
            fat: beforeTotals.fat * 2,
        });
    });

    it.each([
        ['the name', (entry: { name: string }) => ({ name: `${entry.name} with extra cheese` })],
        ['a macro', (entry: { calories: number }) => ({ calories: entry.calories + 25 })],
    ])('detaches the entry when %s is rewritten, so the meal is no longer logged', async (_case, edit) => {
        const entry = await logBreakfast();

        const response = await editEntry(entry.id, edit(entry)).expect(200);
        const edited = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        // The row no longer describes what planning produced, so it can neither
        // claim to BE that planned meal nor claim its numbers are source-backed.
        expect(edited.meal_plan_meal_id).toBeNull();
        expect(edited.recipe_version_id).toBeNull();
        expect(edited.catalog_food_id).toBeNull();
        // Exactly `'library'` — the column's existing default and one of the
        // four values shipped clients already decode. No new `input_method`
        // reaches an old client from this path (§0.5.1).
        expect(edited.input_method).toBe('library');
        expect(edited.nutrition_provenance).toBe('user_entered');

        expect(response.body).toMatchObject({
            mealPlanMealId: null,
            inputMethod: 'library',
            nutritionProvenance: 'user_entered',
        });

        // Nothing was corrected on the plan side: the state is derived, so the
        // detachment alone clears it.
        expect(await loggedEntryIds()).toEqual([]);
        expect((await readCurrentPlan()).summary.loggedEntryCount).toBe(0);
        expect(await planRevision(week.plan.id)).toBe(2);
    });

    it('keeps the link when an edit resubmits the values the row already holds', async () => {
        // A retry is not a rewrite. `planMealEntryEdit` detaches only when a
        // normalised value actually DIFFERS, so a resend of the same name and
        // macros — which is what a client retrying a lost response sends — must
        // not silently strip the caption and the source label.
        const entry = await logBreakfast();

        await editEntry(entry.id, {
            name: entry.name,
            calories: entry.calories,
            protein: entry.protein_g,
            carbs: entry.carbs_g,
            fat: entry.fat_g,
        }).expect(200);

        const edited = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        expect(edited.meal_plan_meal_id).toBe(week.breakfast.id);
        expect(edited.input_method).toBe('meal_plan');
        expect(edited.nutrition_provenance).toBe('source_backed');
        expect(await loggedEntryIds()).toEqual([entry.id]);
    });

    it('cannot be moved to another bucket or another day by the edit body', async () => {
        // The update contract has no move fields, and none are added: an entry
        // stays in its meal and on its date. Both spellings are sent — the wire
        // name and the column name — because a writer that spread the body would
        // accept one of them, and the plan's day view and the diary would then
        // disagree about where the entry is.
        const entry = await logBreakfast();
        const otherDayKey = addDaysToDayKey(week.dayKey, 1);
        const otherBucketId = await diaryBucketId(USER_ID, otherDayKey);

        await editEntry(entry.id, {
            servings: 2,
            mealId: otherBucketId,
            meal_id: otherBucketId,
            date: otherDayKey,
        }).expect(200);

        const edited = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        expect(edited.meal_id).toBe(entry.meal_id);
        expect(toDayKey(edited.date)).toBe(week.dayKey);
        expect(edited.servings).toBe(2);
        // And the day it was never moved to is still empty.
        expect(await diaryEntries(otherDayKey)).toEqual([]);
    });

    it('clears the logged state when the entry is deleted', async () => {
        const entry = await logBreakfast();

        const response = await asUser(request.delete(`/api/macros/entry/${entry.id}`), {
            uid: USER_ID,
        }).expect(200);

        // The shipped body, character for character.
        expect(response.body).toStrictEqual({ success: true });

        const deleted = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        // A soft delete: the row and its links survive, and the derivation
        // ignores it because it is no longer live.
        expect(deleted.deleted_at).not.toBeNull();
        expect(deleted.meal_plan_meal_id).toBe(week.breakfast.id);
        expect(await loggedEntryIds()).toEqual([]);
        expect((await readCurrentPlan()).summary.loggedEntryCount).toBe(0);
        expect(await diaryEntries(week.dayKey)).toEqual([]);
    });

    it('answers a foreign entry id with the shipped 404 and leaves the row untouched', async () => {
        // `updateMealEntry` carries the owner in the WRITE predicate itself —
        // `where: {id, user_id, deleted_at: null}` — rather than reading the row
        // first and updating by id alone (§5.1). The observable contract must
        // not have moved with it: a foreign id is still the verbatim 404 that
        // shipped clients read, and the entry is still the planned meal's.
        await makeUser({ id: OTHER_USER_ID });
        const entry = await logBreakfast();

        const update = await editEntry(entry.id, { servings: 9 }, OTHER_USER_ID);
        const remove = await asUser(request.delete(`/api/macros/entry/${entry.id}`), {
            uid: OTHER_USER_ID,
        });

        expect(update.status).toBe(404);
        expect(update.body).toStrictEqual({ error: 'Entry not found' });
        expect(remove.status).toBe(404);
        expect(remove.body).toStrictEqual({ error: 'Entry not found' });

        const untouched = await prisma.meal_entries.findUniqueOrThrow({ where: { id: entry.id } });

        expect(untouched.servings).toBe(entry.servings);
        expect(untouched.deleted_at).toBeNull();
        expect(untouched.meal_plan_meal_id).toBe(week.breakfast.id);
        expect(await loggedEntryIds()).toEqual([entry.id]);
    });

    it('answers an entry that does not exist with the same 404', async () => {
        const response = await editEntry(randomUUID(), { servings: 2 });

        expect(response.status).toBe(404);
        expect(response.body).toStrictEqual({ error: 'Entry not found' });
    });
});

/* ---------------------------------------------------------------------------
 * The catalog branch of the shipped entry writer, and what it puts in the diary
 *
 * `POST /api/macros/meal/:mealId/entries` grew a second body shape: a client
 * names a published catalog food instead of carrying its own macros. Which
 * shape the controller chose, and that branch's own 400/404 table, are
 * `catalog.test.ts`'s. What is asserted here is what lands in the DIARY —
 * because the four distinct captions §0.1.4(i) requires are driven entirely by
 * `input_method` and `nutrition_provenance`, and a value collapsed on the way
 * through would label an AI estimate as verified nutrition, which the prompt
 * forbids outright.
 * ------------------------------------------------------------------------- */

describe('a catalog food logged through the diary', () => {
    /** Posts a catalog body into the caller's own breakfast bucket. */
    const postCatalogEntry = async (body: Record<string, unknown>) => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        return asUser(request.post(`/api/macros/meal/${bucketId}/entries`), { uid: USER_ID }).send(body);
    };

    it('links the catalog food, leaves the plan links empty and stamps search server-side', async () => {
        const response = await postCatalogEntry({
            catalogFoodId: week.food.id,
            servings: 2,
            // Whatever the body claims the method was, the server decides: this
            // value must not survive. `'meal_plan'` above all, because that is
            // the field the diary reads as "From meal plan" and no client may
            // award itself a planned origin.
            inputMethod: 'meal_plan',
        });

        expect(response.status).toBe(201);

        const entry = await storedEntry();

        expect(entry).toMatchObject({
            catalog_food_id: week.food.id,
            // Not a planned meal and not a personal food: three links stay
            // empty, so no plan card can read this entry as one of its meals.
            meal_plan_meal_id: null,
            recipe_version_id: null,
            food_id: null,
            input_method: 'search',
            servings: 2,
        });
        expect(entry.input_method).not.toBe('meal_plan');
        expect(await prisma.foods.count()).toBe(0);
    });

    it('derives every number from the catalog row and ignores the macros the body sent', async () => {
        // The server cannot vouch for numbers it did not derive, so a catalog
        // body's macros are dropped by the parser and would be ignored here
        // regardless. Sending absurd ones is how that becomes visible: were any
        // of them honoured, the row would carry a source-backed label over
        // values the client chose.
        const response = await postCatalogEntry({
            catalogFoodId: week.food.id,
            servings: 1,
            inputMethod: 'search',
            calories: 99999,
            protein: 1,
            carbs: 1,
            fat: 1,
            name: 'Something else entirely',
        });

        expect(response.status).toBe(201);

        const entry = await storedEntry();
        const portion = await prisma.catalog_food_portions.findFirstOrThrow({
            where: { catalog_food_id: week.food.id, is_default: true },
        });
        const scale = portion.gram_weight / week.food.basis_amount;

        expect(entry.name).toBe(week.food.display_name);
        expect(entry.serving_text).toBe(portion.description);
        expect(entry.calories).toBe(Math.round((week.food.calories ?? 0) * scale));
        expect(entry.protein_g).toBe(Math.round((week.food.protein_g ?? 0) * scale));
        expect(entry.carbs_g).toBe(Math.round((week.food.carbs_g ?? 0) * scale));
        expect(entry.fat_g).toBe(Math.round((week.food.fat_g ?? 0) * scale));
        expect(entry.calories).not.toBe(99999);
    });

    it.each([['source_backed'], ['ingredient_derived'], ['ai_estimated']])(
        'carries %s from the catalog row through to the diary response',
        async (provenance) => {
            // All three reach the client intact. They are what distinguishes
            // "Source-backed" from "Estimated from ingredients" from
            // "Estimated" in the diary, so collapsing any pair of them — or
            // storing a value `toNutritionProvenance` reads back as null —
            // would strip the estimate label §0.1.4(i) requires.
            const food = await makeCatalogFood({
                nutrition_provenance: provenance,
                defaultPortion: { description: '100 g', amount: 100, unit: 'g', gram_weight: 100 },
            });

            const response = await postCatalogEntry({
                catalogFoodId: food.id,
                servings: 1,
                inputMethod: 'search',
            });

            expect(response.status).toBe(201);
            expect((response.body as MealEntryResponse).nutritionProvenance).toBe(provenance);
            expect((await storedEntry()).nutrition_provenance).toBe(provenance);
            expect((await diaryEntries(week.dayKey))[0]).toMatchObject({
                nutritionProvenance: provenance,
                inputMethod: 'search',
            });
        },
    );

    it('classifies a legacy macro-bearing entry as user_entered, beside the planned source_backed one', async () => {
        // The contrast in one case, because it is the whole point of the
        // column: the numbers on the left arrived from a client, so the server
        // calls them "user-entered" however they were obtained; the numbers on
        // the right were derived from source-backed ingredients by the planner.
        // A legacy row earning `source_backed` would present a client's own
        // typing as verified nutrition.
        const lunchBucketId = await diaryBucketId(USER_ID, week.dayKey, DEFAULT_MEAL_NAMES[1]);

        await asUser(request.post(`/api/macros/meal/${lunchBucketId}/entries`), { uid: USER_ID })
            .send({ name: 'Hand-typed lunch', calories: 500, protein: 30, carbs: 50, fat: 20 })
            .expect(201);

        const breakfastBucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: breakfastBucketId }));

        const [legacyEntry, plannedEntry] = await storedEntries();

        expect(legacyEntry).toMatchObject({
            input_method: 'library',
            nutrition_provenance: 'user_entered',
            meal_plan_meal_id: null,
            catalog_food_id: null,
        });
        expect(plannedEntry).toMatchObject({
            input_method: 'meal_plan',
            nutrition_provenance: 'source_backed',
            meal_plan_meal_id: week.breakfast.id,
        });

        // And both classes travel to the client on the one diary read.
        expect((await diaryEntries(week.dayKey, DEFAULT_MEAL_NAMES[1]))[0]).toMatchObject({
            nutritionProvenance: 'user_entered',
        });
        expect((await diaryEntries(week.dayKey))[0]).toMatchObject({
            nutritionProvenance: 'source_backed',
        });
    });

    it('answers 404 catalog_food_not_found for a food that is not published', async () => {
        // Unpublished is indistinguishable from nonexistent, deliberately: a
        // candidate, quarantined or retired food is simply absent, so no
        // request can confirm one exists before it is publishable.
        const quarantined = await makeCatalogFood({ publication_status: 'quarantined' });

        const response = await postCatalogEntry({
            catalogFoodId: quarantined.id,
            servings: 1,
            inputMethod: 'search',
        });

        expect(response.status).toBe(404);
        expect(response.body).toStrictEqual({ error: 'catalog_food_not_found' });
        expect(await storedEntries()).toHaveLength(0);
    });
});

/* ---------------------------------------------------------------------------
 * `input_method` and `nutrition_provenance` are unrestricted TEXT
 *
 * Neither column has an enum or a CHECK constraint, so the closed set is
 * enforced in code and is provable only THROUGH the API — expecting a raw
 * insert to fail would test PostgreSQL and pass for the wrong reason. The two
 * server-authored values are the ones worth guarding: `'meal_plan'`, which the
 * diary renders as "From meal plan", and `'source_backed'`, which claims the
 * numbers were derived from sourced ingredients.
 * ------------------------------------------------------------------------- */

describe('the origin and provenance a request may not award itself', () => {
    it('refuses a legacy body that claims the planned origin, falling back to library', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await asUser(request.post(`/api/macros/meal/${bucketId}/entries`), { uid: USER_ID })
            .send({
                name: 'Hand-typed breakfast',
                calories: 400,
                protein: 20,
                carbs: 40,
                fat: 10,
                // `'meal_plan'` is absent from `CLIENT_INPUT_METHODS`, so it is
                // not a value a body may choose. Anything unusable has always
                // become `'library'`, and it still does.
                inputMethod: 'meal_plan',
            })
            .expect(201);

        const entry = await storedEntry();

        expect(entry.input_method).toBe('library');
        expect(entry.meal_plan_meal_id).toBeNull();
        expect(entry.recipe_version_id).toBeNull();
    });

    it('refuses a legacy body that claims source-backed provenance', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await asUser(request.post(`/api/macros/meal/${bucketId}/entries`), { uid: USER_ID })
            .send({
                name: 'Hand-typed breakfast',
                calories: 400,
                protein: 20,
                carbs: 40,
                fat: 10,
                nutritionProvenance: 'source_backed',
            })
            .expect(201);

        expect((await storedEntry()).nutrition_provenance).toBe('user_entered');
    });

    it('resolves an unrecognised inputMethod to library rather than storing it', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await asUser(request.post(`/api/macros/meal/${bucketId}/entries`), { uid: USER_ID })
            .send({
                name: 'Hand-typed breakfast',
                calories: 400,
                protein: 20,
                carbs: 40,
                fat: 10,
                inputMethod: 'telepathy',
            })
            .expect(201);

        const entry = await storedEntry();

        // Stored as one of the five the column's vocabulary admits, so the
        // client's decoder never meets a value it has no caption for.
        expect(entry.input_method).toBe('library');
    });
});

/* ---------------------------------------------------------------------------
 * The shipped diary writer's own refusal: a string PostgreSQL cannot store
 *
 * A body whose stored text carries U+0000 used to reach the column, which
 * answers `22021 invalid byte sequence for encoding "UTF8": 0x00`, and the
 * endpoint returned `500 Failed to log meal entry` for a request only the
 * caller can fix.
 *
 * Both halves are asserted. The refusal: a `400` naming the field, with nothing
 * written. And the non-regression half, which is the larger risk of adding a
 * rule to a guard §0.3.1 freezes — the frozen required-fields `400` keeps its
 * exact body, a valid legacy log still writes, and every other control
 * character still round-trips through the diary intact.
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
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        return asUser(request.post(`/api/macros/meal/${bucketId}/entries`), { uid: USER_ID }).send(body);
    };

    /** The entry names the shipped diary read reports for the caller's breakfast. */
    const diaryEntryNames = async (): Promise<unknown[]> =>
        (await diaryEntries(week.dayKey)).map((entry) => entry.name);

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

        const entry = await storedEntry();

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
        const response = await postEntry(
            legacyEntryBody({ servingText: '2 eggs', rawInput: 'two scrambled eggs' }),
        );

        expect(response.status).toBe(201);

        const entry = await storedEntry();

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
        expect((await storedEntry()).name).toBe(name);
        expect(await diaryEntryNames()).toEqual([name]);
    });

    it('still accepts an entry edit that carries no NUL, and still detaches on a macro change', async () => {
        const created = await postEntry(legacyEntryBody());

        expect(created.status).toBe(201);

        const entry = await storedEntry();

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

    it('refuses a NUL name on a planned entry without touching its link', async () => {
        const bucketId = await diaryBucketId(USER_ID, week.dayKey);

        await logOrThrow(week.plan.id, week.breakfast.id, logBody({ diaryMealId: bucketId }));

        const entry = await storedEntry();

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
