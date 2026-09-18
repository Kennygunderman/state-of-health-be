// The write-safety model under real contention (Agent Action Plan §0.5.1 "Plan
// write-safety model" and §0.9.2's `api/concurrency.test.ts` rows).
//
// WHICH LAYER EACH CASE EXERCISES, AND WHY BOTH ARE HERE.
//
// The hazards themselves live in the SERVICE layer: the advisory lock, the
// idempotency reservation, the compare-and-swap revision bumps and the
// transaction that holds them together. So every mechanism is proved there,
// against real PostgreSQL, with an injected `now` that makes the fixture
// clock-free — that is the first two thirds of this file.
//
// THE TWO PIPELINE STAGES A REQUEST CAN COLLIDE WITH ARE DRIVEN AS THEMSELVES,
// through the exported `run*(deps)` entry points §0.9.2 names rather than
// through a fixture that imitates their writes: `scripts/catalog-load.ts::runLoad`
// over a real checksummed release in "the catalog release load beside a real
// generation", and `scripts/recipes-seed.ts::runSeed` over a corpus on disk in
// "the recipe seed stage promoting a version while a week is generated". Each
// brings a transaction boundary the stage chooses and a set of writes no
// per-user lock can exclude, which is the point: the week must still come out
// whole, and the published one must be left exactly where it was.
//
// The CONTRACT the client is held to is decided one layer up, and the sections
// that close this file prove it at the HTTP boundary: `mealPlanning.controller.ts` is the
// only place a `StalePlanError` becomes `409 {error: 'stale_plan',
// currentRevision}`, and an error class carries no status (Rule
// backend-architecture §8). A refusal asserted only as a class is a refusal no
// client has been shown, so the boundary sections assert STATUS, MACHINE CODE
// and PAYLOAD for every code a race can produce, and race two genuine
// supertest requests rather than two service calls. They need their own
// fixture: the controller passes no `now`, so an HTTP request resolves "today"
// from the real clock and the pinned week the service cases sit on would answer
// `409 plan_not_active {reason: 'ended'}` — see {@link seedRequestWeek}. Three
// sections sit there: the races themselves, the real publication stage
// (`scripts/recipes-seed.ts::runSeed`) beside a real `POST /plans`, and a sweep
// over a spread of refusals asserting none of them tells a client anything
// only the server should know.
//
// Two seams deliberately stay out of this file. The post-commit abort
// (`postCommitAbort` + `res.socket.destroy()`) belongs to `api/fault.test.ts`,
// which owns both injected faults and the module-graph isolation Rule §9's
// read-once config forces on anything that flips them; and the HTTP parallel
// same-key LOG double tap belongs to `api/log.test.ts`, which already asserts
// it (this file asserts the same pair below the controller). Nothing here
// duplicates either.
//
// WHY THIS SUITE NEEDS MORE THAN ONE CLIENT. A lock can only be observed from a
// session that is not the one holding it, so {@link contendingClient} is a
// second, independent `PrismaClient`, bounded to a small connection pool for
// the reason given where it is constructed. Races between two
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
// resulting states are compared.
//
// NO OUTCOME HERE IS INFERRED FROM AN INTERVAL. "This write is blocked" is read
// from PostgreSQL's own wait state — an ungranted entry in `pg_locks` belonging
// to a backend of THIS database ({@link blockedWaitTypes}) — so the proof is
// the server's report rather than the absence of a result after a chosen
// number of milliseconds, which on a loaded shared host says nothing either
// way. Each such case is still paired with a counter-proof that the same call
// is NEVER OBSERVED WAITING and settles on its own when nothing holds its lock
// ({@link settleWithoutLockWait}), because a wait observed without that pair
// could belong to something incidental to the transaction. The two intervals
// that remain — {@link LOCK_WAIT_POLL_MS} and {@link LOCK_WAIT_HANG_GUARD_MS} —
// decide nothing: one is how often the wait state is sampled, the other is a
// hang guard that turns a mechanism which never blocks into a named failure
// instead of a suite that stalls.
//
// WHAT IS ASSERTED IS WHAT THE DATABASE HOLDS. Every case re-reads
// `meal_entries`, `meal_plan_actions`, `meal_plan_meals`, `meal_plan_days`,
// `meal_plans`, `grocery_items` and `meal_plan_preferences` — and, for the
// generation rows, `recipe_versions`, `recipe_ingredients` and `catalog_foods`
// — and asserts ids, row counts, statuses, columns, orderings and revisions.
// Two things are deliberately not asserted: the rounding of nutrition on plan
// DTOs and the exact text of `portionText`. Both are `mealPlan.mapper.ts`'s
// DISPLAY contract — `readPlannedTotals` and `formatPortionText` — and both are
// pinned where a client reads them, by `api/plans.test.ts` and
// `api/swaps.test.ts`, so re-pinning either here would duplicate a neighbour
// rather than add coverage. A portion MULTIPLIER is asserted where a preview
// binds one — it is the stored number the binding is judged on, not the display
// string a neighbour owns.
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

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runLoad } from '../../../scripts/catalog-load';
import type { LoadDb, LoadDeps, LoadSummary } from '../../../scripts/catalog-load';
import { getActiveReleaseLoad } from '../../../scripts/lib/checkpoint';
import { loadCoveragePlan } from '../../../scripts/lib/manifest';
import type { CatalogReleaseManifest } from '../../../scripts/lib/manifest';
import { runSeed } from '../../../scripts/recipes-seed';
import type { SeedDeps } from '../../../scripts/recipes-seed';
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
    MealPlanDataError,
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
import { deriveRecipeVersionFields } from '../../services/recipe.logic';
import type { RecipePublicationIngredient } from '../../services/recipe.logic';
import { getRecipeVersionForUser } from '../../services/recipe.service';
import { SwapDataError, commitSwap, getSwapAlternatives, getSwapPreview } from '../../services/swap.service';
import { saveTargets } from '../../services/targets.service';
import {
    FIXTURE_ENDED_PLAN_START_DAY_KEY,
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
    utcTodayDayKey,
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
 * How often PostgreSQL's wait state is sampled while a contended write is
 * watched.
 *
 * It bounds how soon a wait that has appeared is noticed, and nothing else: a
 * wait shows up within tens of milliseconds of the blocking statement being
 * issued, so a sample every {@link LOCK_WAIT_POLL_MS} costs one cheap catalog
 * read per sample and never decides an outcome.
 */
const LOCK_WAIT_POLL_MS = 10;

/**
 * The hang guard on every wait-state observation, used ONLY to fail with a
 * message rather than to prove anything.
 *
 * A mechanism that has stopped blocking, or a counter-proof that never
 * commits, would otherwise stall until Jest's own timeout fired anonymously;
 * with the guard it fails naming the wait that never appeared or the call that
 * never settled. It is deliberately generous — this host is shared, and a slow
 * sample is not a failed assertion — while staying inside the 20 s transaction
 * the holders below keep open, so a guard that does fire fires before the
 * holder's transaction expires and takes the diagnosis with it.
 */
const LOCK_WAIT_HANG_GUARD_MS = 15_000;

/** The kinds of lock wait this suite observes; see {@link LOCK_WAIT_TYPES}. */
type LockWaitKind = 'advisory' | 'row';

/**
 * The `pg_locks.locktype` values each kind of wait appears as.
 *
 * A session waiting for `pg_advisory_xact_lock` reports `advisory`. A statement
 * waiting for a row another transaction has locked is queued behind that
 * transaction's id and reports `transactionid`, and may hold a `tuple` lock on
 * the contended row while it waits — so both spellings count as the same row
 * wait rather than pinning one of PostgreSQL's two internal steps.
 */
const LOCK_WAIT_TYPES: Record<LockWaitKind, readonly string[]> = {
    advisory: ['advisory'],
    row: ['transactionid', 'tuple'],
};

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
 * How many connections the second session below may open.
 *
 * Prisma sizes a client's pool at `cpus * 2 + 1` unless told otherwise — 25 on
 * a 12-core runner — and this suite already holds one such pool through the
 * singleton. An unbounded second client would therefore claim a second 25
 * against a PostgreSQL whose `max_connections` is shared with every other
 * suite and, on CI, every other job on the host; the cap is then reached by
 * whichever suite happens to ask next, which reports it as
 * `FATAL: sorry, too many clients already` far from the client that took the
 * connections.
 *
 * This client only ever holds the lock — every assertion around it reads
 * through the singleton — so one connection is enough; the rest is headroom.
 * Exhausting the bound is an explicit `P2024` pool timeout rather than a hang,
 * so a future concurrent use on this client fails loudly instead of being
 * hidden by the bound.
 */
const CONTENDING_CLIENT_CONNECTION_LIMIT = 3;

/** The ambient test datasource, bounded to {@link CONTENDING_CLIENT_CONNECTION_LIMIT}. */
const boundedDatasourceUrl = (): string => {
    const configured = process.env.DATABASE_URL;

    if (configured === undefined || configured === '') {
        // Unreachable through `npm test`: `jestSetup.ts` runs
        // `assertTestDatabase()` before any module loads and refuses a run
        // whose DATABASE_URL is missing or unusable.
        throw new Error('DATABASE_URL is not set, so the contending client cannot be bounded');
    }

    const url = new URL(configured);
    url.searchParams.set('connection_limit', String(CONTENDING_CLIENT_CONNECTION_LIMIT));

    return url.toString();
};

/**
 * A second session, so the per-user advisory lock can be held from OUTSIDE the
 * transaction under test. Query logging is not needed, so this client differs
 * from the singleton only in the connection bound above.
 */
const contendingClient = new PrismaClient({ datasourceUrl: boundedDatasourceUrl() });

/**
 * A THIRD session, which is neither party to any contention here: it only reads
 * PostgreSQL's wait state.
 *
 * The reader has to be outside both sides of the contention to be trustworthy —
 * the holder sits idle inside an open transaction and the waiter is, by
 * definition, stuck — so the observation cannot be taken from either of their
 * connections. Disconnected beside {@link contendingClient} in `afterAll`.
 */
const observerClient = new PrismaClient();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise plus its resolver, for sequencing two sessions without a sleep. */
const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
        release = () => resolve();
    });

    return { promise, release };
};

/** A watched operation: whether it has settled, and its eventual result. */
interface Watched<T> {
    readonly settled: () => boolean;
    readonly done: Promise<T>;
}

/** Tracks whether a promise has settled, without awaiting it. */
const watch = <T>(promise: Promise<T>): Watched<T> => {
    let finished = false;
    const done = promise.finally(() => {
        finished = true;
    });

    // A watched call is asserted on AFTER the holder has been released, so a
    // case that fails one of the expectations in between leaves `done` to
    // settle unobserved — and an unobserved refusal is reported by Node as an
    // unhandled rejection, which fails whichever test happens to be running
    // when it lands. Marking it handled here keeps a failure local to the case
    // that caused it; `await done` still rejects for the cases that assert on
    // a refusal.
    void done.catch(() => undefined);

    return { settled: () => finished, done };
};

/**
 * The `locktype` of every ungranted lock currently waited on in THIS database.
 *
 * Scoped to `current_database()` on purpose: this PostgreSQL server is shared
 * by many clones of this repository, each with its own database, so an unscoped
 * read of `pg_locks` would let another clone's blocked backend stand as
 * evidence about a write in this one. The join to `pg_stat_activity` is what
 * makes the scoping possible — `pg_locks` alone names the database only for the
 * lock types that have one.
 */
const blockedWaitTypes = async (): Promise<string[]> => {
    const rows = await observerClient.$queryRaw<{ locktype: string }[]>`
        SELECT waited_lock.locktype AS locktype
        FROM pg_locks waited_lock
        JOIN pg_stat_activity waiter ON waiter.pid = waited_lock.pid
        WHERE NOT waited_lock.granted
          AND waiter.datname = current_database()
    `;

    return rows.map((row) => row.locktype);
};

/** How many backends of this database are waiting for a lock of one kind. */
const blockedBackends = async (kind: LockWaitKind): Promise<number> =>
    (await blockedWaitTypes()).filter((locktype) => LOCK_WAIT_TYPES[kind].includes(locktype)).length;

/**
 * Returns once PostgreSQL reports a backend of this database blocked on a lock
 * of the given kind — the evidence that the call under test is WAITING, rather
 * than the mere absence of a result after an interval.
 *
 * `what` names the wait that was expected and is what the failure message says
 * never appeared, alongside every wait that was present instead: "the swap is
 * not queued behind the row" and "the swap is queued behind something else" are
 * different defects and the message has to tell them apart.
 */
const awaitLockWait = async (kind: LockWaitKind, what: string): Promise<void> => {
    const deadline = Date.now() + LOCK_WAIT_HANG_GUARD_MS;

    for (;;) {
        if ((await blockedBackends(kind)) > 0) {
            return;
        }

        if (Date.now() >= deadline) {
            throw new Error(
                `no ${kind} lock wait appeared within ${LOCK_WAIT_HANG_GUARD_MS} ms, so ${what} never blocked. ` +
                    `Waits present in this database: ${JSON.stringify(await blockedWaitTypes())}`,
            );
        }

        await sleep(LOCK_WAIT_POLL_MS);
    }
};

/**
 * Awaits a watched call while sampling the same wait state, and answers how
 * many of those samples saw a wait of the given kind.
 *
 * This is the counter-proofs' half of each pair: an uncontended call settles on
 * its own and is never seen waiting, so a zero here states positively that the
 * wait the blocked case observed was caused by the holder rather than by
 * anything the transaction does by itself. Nothing is required to finish inside
 * a window — the call is awaited until it settles, and the interval is the hang
 * guard that turns a call which never settles into a failure naming itself.
 */
const settleWithoutLockWait = async <T>(
    watched: Watched<T>,
    kind: LockWaitKind,
    what: string,
): Promise<number> => {
    const deadline = Date.now() + LOCK_WAIT_HANG_GUARD_MS;
    let samplesSeeingAWait = 0;

    for (;;) {
        if ((await blockedBackends(kind)) > 0) {
            samplesSeeingAWait += 1;
        }

        if (watched.settled()) {
            return samplesSeeingAWait;
        }

        if (Date.now() >= deadline) {
            throw new Error(
                `${what} had not settled within ${LOCK_WAIT_HANG_GUARD_MS} ms although nothing holds its lock`,
            );
        }

        await sleep(LOCK_WAIT_POLL_MS);
    }
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
 *
 * The owner and the clock are parameters because the boundary section's week
 * belongs to another user and is built around the REAL today; they default to
 * the fixture week's pair so every existing call site reads as it did.
 */
const buildGroceries = async (
    planId: string,
    userId: string = USER_ID,
    now: Date = NOW,
): Promise<void> => {
    await withMealPlanningTransaction((tx) =>
        withUserLock(tx, userId, async (locked) =>
            rebuildPlanGroceries(locked, {
                userId,
                planId,
                meals: await loadPlannedMealsForGroceries(locked, userId, planId),
                now,
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

const storedEntries = (userId: string = USER_ID) =>
    prisma.meal_entries.findMany({
        where: { user_id: userId },
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
const groceryStateOf = async (planId: string, userId: string = USER_ID) => {
    const rows = await prisma.grocery_items.findMany({
        where: { meal_plan_id: planId, user_id: userId },
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

    return seedRecipePool();
};

/**
 * The catalog half of the world above, without the user.
 *
 * `recipe_versions` and `catalog_foods` are the tenant-less tables §0.5.1
 * describes, so the pool serves whichever user asks for it — which is what lets
 * the boundary section seed the same plannable universe for its own two
 * identities without inheriting the pinned-clock user this one creates.
 */
const seedRecipePool = async () => {
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
    await observerClient.$disconnect();
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

        try {
            await awaitLockWait('advisory', 'the planned log waiting for the per-user advisory lock');

            // Not merely unfinished: nothing of it is visible, because its
            // transaction has not reached its first write.
            expect(logging.settled()).toBe(false);
            expect(await storedEntries()).toHaveLength(0);
            expect(await ledgerRows()).toHaveLength(0);
        } finally {
            // Released in `finally`, and the holder's transaction awaited here:
            // a failed expectation above would otherwise leave a 20 s
            // transaction pinning the lock that every case after this one needs,
            // and they would fail for a reason that is not theirs.
            lock.release();
            await lock.held;
        }

        const result = await logging.done;

        expect(result.kind).toBe('ok');
        expect(await storedEntries()).toHaveLength(1);
        expect(await planRevision(week.plan.id)).toBe(2);
    });

    it('does not make it wait when nothing holds the lock, and is never observed waiting', async () => {
        // The counter-proof. Without it the test above could pass because of
        // something incidental to the transaction rather than because of the
        // lock, and a build that had lost `withUserLock` would look exactly as
        // correct. What it asserts is not that the call finished inside some
        // interval — that is a claim about this host's speed — but that the
        // same call was never seen waiting for the lock and settled on its own.
        const logging = watch(
            logPlannedMeal(USER_ID, week.plan.id, week.breakfastMeal.id, logBody(week.diaryMealId, 1), NOW),
        );

        expect(await settleWithoutLockWait(logging, 'advisory', 'the uncontended planned log')).toBe(0);
        expect(logging.settled()).toBe(true);
        expect((await logging.done).kind).toBe('ok');
    });

    it('makes a grocery toggle wait for it too, because a toggle must not interleave with a rebuild', async () => {
        const lock = await holdUserLock();

        const toggling = watch(
            toggleGroceryItem(USER_ID, week.plan.id, week.lunchGroceryItem.id, { isChecked: true }, NOW),
        );

        try {
            await awaitLockWait('advisory', 'the grocery toggle waiting for the per-user advisory lock');

            expect(toggling.settled()).toBe(false);
            expect(
                await prisma.grocery_items.count({ where: { meal_plan_id: week.plan.id, is_checked: true } }),
            ).toBe(0);
        } finally {
            lock.release();
            await lock.held;
        }

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
        // `res.socket.destroy()`) lives one layer above this call, in
        // `mealPlanning.controller.ts::answerKeyedWrite`, and is driven at the
        // HTTP boundary by `api/fault.test.ts`, which owns it. What a lost
        // response leaves BEHIND is service state, and that ledger half is this
        // case's subject: the action committed, the client never saw the
        // answer, and its retry carries the same key and the same body —
        // including the revision it pinned before any of this.
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

    /**
     * Both sequential permutations of the pair, as `[label, published, refused]`.
     *
     * The rule under test is about HOW MANY plans start after today, not about
     * which dates they are, so it has to hold whichever of the two free weeks
     * is asked for first: taking only the earlier-first permutation would leave
     * a build that refused by comparing start dates — "a later week may not be
     * asked for once an earlier one stands" — passing here, and the raced
     * sibling case cannot close that gap because it permits either winner. The
     * second permutation is the one that fails against such a build, since the
     * refused week is the EARLIER of the two.
     *
     * Neither week overlaps the other or the current week (today + 7 through
     * today + 13, and today + 14 through today + 20), so `plan_overlap` cannot
     * fire in either permutation and `upcoming_exists` is the only refusal the
     * contract allows.
     *
     * Each permutation is its own case rather than two halves of one, so the
     * suite's `beforeEach` truncation and reseed gives the second a clean
     * database — the same clean start the overlapping-generations describe
     * reaches for with an inline `truncateFeatureTables()` mid-test — and a
     * failure names the permutation that produced it.
     */
    const UPCOMING_PERMUTATIONS: ReadonlyArray<readonly [string, string, string]> = [
        ['the earlier week first', FIRST_UPCOMING, SECOND_UPCOMING],
        ['the later week first', SECOND_UPCOMING, FIRST_UPCOMING],
    ];

    it.each(UPCOMING_PERMUTATIONS)(
        'refuses a second upcoming week as upcoming_exists and leaves the first one intact, asked with %s',
        async (_permutation, publishedWeek, refusedWeek) => {
            const world = await seedPlannableWorld();
            const current = await seedCurrentWeek(world);

            expect((await generatePlan(PLANNING_USER_ID, generateBody(publishedWeek), NOW)).kind).toBe(
                'ok',
            );

            const upcoming = (await plansOf(PLANNING_USER_ID)).find(
                (plan) => dayKeyOf(plan.start_date) === publishedWeek,
            );

            if (upcoming === undefined) {
                throw new Error(`the upcoming week starting ${publishedWeek} was not published`);
            }

            const refusal = await outcomeOf(() =>
                generatePlan(PLANNING_USER_ID, generateBody(refusedWeek), NOW),
            );

            // No id travels with this one: §0.5.2 has the client reach the
            // standing upcoming plan through the current-plan response instead.
            expect(refusal).toBeInstanceOf(UpcomingExistsError);

            const plans = await plansOf(PLANNING_USER_ID);

            // The FIRST-CREATED upcoming week is the one that stands, and the
            // refused week left no row at all — including none for the week it
            // asked for.
            expect(plans.map((plan) => dayKeyOf(plan.start_date))).toEqual([TODAY, publishedWeek]);
            expect(plans.map((plan) => plan.id)).toEqual([current.id, upcoming.id]);
            // That week is exactly as it was published: same id, same start
            // date, same revision, still active, still whole.
            expect(dayKeyOf(upcoming.start_date)).toBe(publishedWeek);
            expect(upcoming.revision).toBe(1);
            expect(upcoming.status).toBe(ACTIVE_PLAN);
            expectWholeWeek(upcoming);

            const actions = await ledgerRows(PLANNING_USER_ID);

            expect(actions).toHaveLength(1);
            expect(actions[0]).toMatchObject({
                action_type: 'generate',
                response_status: 201,
                plan_revision_after: 1,
                meal_plan_id: upcoming.id,
            });

            await expectOneActivePlanPerStartDate(PLANNING_USER_ID);
        },
    );

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
 * A foreign write to the preferences row a publication is completing
 *
 * The pair above races two writers that BOTH take the per-user advisory lock,
 * so one of them always observes settled state. This one removes that
 * assumption. `PUT /api/user/targets` already writes without the lock by
 * design, and a preferences row is one plain `UPDATE` away from being moved by
 * anything that does the same — so the publication's last write to that row,
 * `setup_status`, cannot rest on the lock alone.
 *
 * §0.5.1 answers that with a compare-and-set: the status write carries the
 * owner AND the revision `requirePinnedInputs` certified earlier in the same
 * transaction, and one affected row is required. What the pair below measures
 * is the difference that makes — a publication whose pinned row moved after
 * certification is ROLLED BACK IN FULL rather than committing a week behind a
 * setup that stayed incomplete.
 * ------------------------------------------------------------------------- */

describe('a foreign write to the preferences row a publication is completing', () => {
    /**
     * Holds a row lock on one user's preferences row until released, then bumps
     * ONLY that row's `revision` — no preference value, no status — and commits.
     *
     * The narrowest possible change, for the same reason the swap section's
     * holder bumps only a meal's revision: it is what an unlocked writer that
     * moved the planning inputs looks like, and it is the exact state no check
     * before the status write can detect. `requirePinnedInputs` reads the row
     * with a plain `SELECT`, which MVCC never blocks, so the generation passes
     * its certification against revision 1 and meets this lock later, at the
     * one statement that writes.
     */
    const holdPreferencesRowThenBumpRevision = async (
        userId: string,
    ): Promise<{ release: () => void; held: Promise<unknown> }> => {
        const taken = deferred();
        const releaseSignal = deferred();

        const held = contendingClient.$transaction(
            async (tx) => {
                await tx.$queryRaw`SELECT revision FROM meal_plan_preferences WHERE user_id = ${userId} FOR UPDATE`;
                taken.release();
                await releaseSignal.promise;
                await tx.$executeRaw`UPDATE meal_plan_preferences SET revision = revision + 1 WHERE user_id = ${userId}`;
            },
            { timeout: 20_000 },
        );

        await taken.promise;

        return { release: releaseSignal.release, held };
    };

    const plannerSetup = () =>
        prisma.meal_plan_preferences.findUniqueOrThrow({
            where: { user_id: PLANNING_USER_ID },
            select: { setup_status: true, revision: true },
        });

    /**
     * `ready_for_review`, so the transition the status write performs is
     * MEASURABLE. Left at the factory's `completed` every assertion below would
     * hold whether the write matched a row or not, which is the one thing this
     * pair exists to tell apart.
     */
    const seedSetupAwaitingCompletion = async (): Promise<void> => {
        await seedPlannableWorld();
        await prisma.meal_plan_preferences.update({
            where: { user_id: PLANNING_USER_ID },
            data: { setup_status: 'ready_for_review', setup_step: 'review' },
        });
    };

    it('rolls the whole week back and leaves setup incomplete when the pinned revision moved', async () => {
        await seedSetupAwaitingCompletion();

        const foreignWriter = await holdPreferencesRowThenBumpRevision(PLANNING_USER_ID);
        const generating = watch(generatePlan(PLANNING_USER_ID, generateBody(TODAY), NOW));

        try {
            await awaitLockWait(
                'row',
                'the publication waiting for the preferences row the foreign writer holds',
            );

            // Queued on the row it means to write, with the plan, its days, its
            // meals and its grocery list already inserted by this transaction
            // and its ledger reservation still open and invisible.
            expect(generating.settled()).toBe(false);
        } finally {
            // Released in `finally`, and the holder's transaction awaited here:
            // a failed expectation above would otherwise leave a 20 s
            // transaction holding this row, and every later case that writes it
            // would fail for a reason that is not its own.
            foreignWriter.release();
            await foreignWriter.held;
        }

        // The blocked statement re-evaluates its predicate against the row the
        // holder committed, matches nothing at the certified revision, and
        // refuses rather than reporting a completion it did not perform.
        await expect(generating.done).rejects.toThrow(MealPlanDataError);

        // NOTHING SURVIVED but the foreign bump. Without the revision term the
        // status write would have matched this row by `user_id` alone, and the
        // whole week — plan, days, meals, groceries and a completed ledger row
        // — would be committed against inputs that moved after the publication
        // certified them.
        expect(await plansOf(PLANNING_USER_ID)).toEqual([]);
        expect(await ledgerRows(PLANNING_USER_ID)).toHaveLength(0);
        expect(await plannerSetup()).toEqual({ setup_status: 'ready_for_review', revision: 2 });
    });

    it('completes setup without ever waiting for the row when nothing holds it', async () => {
        // The counter-proof. Without it the case above could pass because of
        // something incidental to a blocked transaction rather than because of
        // the revision term, and a build that had dropped the term would look
        // exactly as correct. Uncontended, the same publication is never seen
        // waiting, commits, and moves the status and nothing else.
        await seedSetupAwaitingCompletion();

        const generating = watch(generatePlan(PLANNING_USER_ID, generateBody(TODAY), NOW));

        expect(await settleWithoutLockWait(generating, 'row', 'the uncontended publication')).toBe(0);

        const published = await generating.done;

        expect(published.kind).toBe('ok');
        expect(await plansOf(PLANNING_USER_ID)).toHaveLength(1);
        // The status moved; the revision it was pinned to did not, because
        // completing setup is not an edit to the planning inputs.
        expect(await plannerSetup()).toEqual({ setup_status: 'completed', revision: 1 });
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
 * foreign write and reports success. Nothing here depends on timing: that the
 * swap is waiting is read from the row wait PostgreSQL reports for it
 * ({@link awaitLockWait}), and the counter-proof below is never observed
 * waiting at all.
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

        try {
            await awaitLockWait('row', 'the swap waiting for the meal row the foreign writer holds');

            // Waiting on the row it means to write, with its transaction — and
            // so its ledger reservation — still open and invisible.
            expect(swapping.settled()).toBe(false);
            expect((await mealRow(week.breakfastMeal.id)).recipe_version_id).toBe(week.breakfast.id);
        } finally {
            // Released in `finally`, and the foreign writer's transaction
            // awaited here: a failed expectation above would otherwise leave a
            // 20 s transaction holding this meal's row, and every later case
            // that writes it would fail for a reason that is not theirs.
            foreignWriter.release();
            await foreignWriter.held;
        }

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

    it('commits without ever waiting for the row when nothing reaches the meal', async () => {
        // The counter-proof. Without it the case above could pass because of
        // something incidental to a blocked transaction rather than because of
        // the revision term, and a build that had dropped the term would look
        // exactly as correct. It asserts what the case above measured in the
        // other direction: with no foreign writer, the same commit is never
        // queued behind the row and settles on its own.
        const swapping = watch(
            commitSwap(USER_ID, week.plan.id, week.breakfastMeal.id, swapBody(week.alternative.id, 1), NOW),
        );

        expect(await settleWithoutLockWait(swapping, 'row', 'the uncontended swap commit')).toBe(0);
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

    /**
     * A week beyond the upcoming one, whose seven days overlap NO standing plan.
     *
     * It is what separates the second pair below from the first: the dates are
     * free, so `plan_overlap` cannot fire and the at-most-one-upcoming rule is
     * the only thing left that can refuse the generation — §0.9.2's "raced with
     * `POST /plans` for a free future week → `upcoming_exists`". The upcoming
     * plan occupies {@link UPCOMING_WEEK} (today + 7 through today + 13), so
     * today + 14 is the first free start date.
     */
    const FREE_FUTURE_WEEK = addDaysToDayKey(TODAY, 14);

    /** Which of the two writes is driven first in a sequential permutation. */
    type SequentialFirst = 'regeneration' | 'generation';

    /**
     * Both sequential permutations of a regeneration-and-generation pair.
     *
     * A raced pair can only assert the outcome SET, so on its own it cannot
     * show that the outcome is the contract rather than the winner of a coin
     * toss: the assertion would hold just as well if one ordering produced a
     * different result and the race happened never to take it. Driving the same
     * pair each way round is what closes that gap, which is why §0.9.2 asks for
     * the orderings as well as the race.
     */
    const SEQUENTIAL_ORDERINGS: ReadonlyArray<readonly [string, SequentialFirst]> = [
        ['the regeneration first', 'regeneration'],
        ['the generation first', 'generation'],
    ];

    /** The two writes driven one after the other, in the named order. */
    const driveSequentially = async (
        first: SequentialFirst,
        regenerate: () => Promise<unknown>,
        generate: () => Promise<unknown>,
    ): Promise<{ regeneration: unknown; generation: unknown }> => {
        if (first === 'regeneration') {
            const regeneration = await outcomeOf(regenerate);

            return { regeneration, generation: await outcomeOf(generate) };
        }

        const generation = await outcomeOf(generate);

        return { regeneration: await outcomeOf(regenerate), generation };
    };

    /** An outcome that has to be the `ok` the contract promises, not a refusal. */
    const expectCommitted = (outcome: unknown): void => {
        expect(outcome).not.toBeInstanceOf(Error);
        expect(outcome).toMatchObject({ kind: 'ok' });
    };

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

    /**
     * The ONE end state both pairs below are allowed to leave, whichever way
     * round the two writes ran and whether they were raced or driven: the
     * current week replaced by a whole successor, the upcoming week exactly as
     * it was published, no third active plan, and one regeneration on record.
     *
     * The refused generation leaves nothing at all — it reserved its ledger row
     * inside the transaction that then rolled back — so the single row is the
     * regeneration's, asserted by type and by the plan it names rather than by
     * count alone: a count of one would also be satisfied by the generation
     * having committed and the regeneration having been refused, which is the
     * opposite outcome.
     */
    const expectRegeneratedBesideUntouchedUpcoming = async (
        current: FixtureMealPlan,
        upcoming: FixtureMealPlan,
    ): Promise<PlanWithMeals> => {
        const replacement = await expectReplacementOf(current.id, TODAY);
        const plans = await plansOf(PLANNING_USER_ID);
        const standing = plans.find((plan) => plan.id === upcoming.id);

        if (standing === undefined) {
            throw new Error(`the upcoming plan ${upcoming.id} is no longer among the user's plans`);
        }

        // Three rows and two of them active: the replaced week, its successor
        // and the upcoming week. A third active plan would mean the refused
        // generation published something.
        expect(plans).toHaveLength(3);
        expect(plans.filter((plan) => plan.status === ACTIVE_PLAN).map((plan) => plan.id).sort()).toEqual(
            [replacement.id, upcoming.id].sort(),
        );
        // The upcoming week is untouched — same id, same start date, same
        // revision, still active, still whole — so a refusal that named it named
        // a plan the client can still open.
        expect(dayKeyOf(standing.start_date)).toBe(UPCOMING_WEEK);
        expect(standing.revision).toBe(1);
        expect(standing.status).toBe(ACTIVE_PLAN);
        expectWholeWeek(standing);

        const actions = await ledgerRows(PLANNING_USER_ID);

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            action_type: 'regenerate',
            response_status: 201,
            plan_revision_after: 1,
            meal_plan_id: replacement.id,
        });

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

        // ONE documented outcome, and the case below drives the same pair each
        // way round to show it is the contract rather than the winner of a coin
        // toss: the requested week overlaps the upcoming plan, which this pair
        // never touches, so the generation is refused against it whenever it
        // runs — and the regeneration of a DIFFERENT week is refused by nothing.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(PlanOverlapError);
        expect((rejected[0].reason as PlanOverlapError).conflictingPlanId).toBe(upcoming.id);

        await expectRegeneratedBesideUntouchedUpcoming(current, upcoming);
    });

    it.each(SEQUENTIAL_ORDERINGS)(
        'refuses that generation as plan_overlap and commits the regeneration when the two are driven with %s',
        async (_ordering, first) => {
            // The race above permits one outcome set; these two runs are what
            // show it is not a coin toss. The generation asks for the upcoming
            // week's own dates, so it collides with a plan neither write
            // replaces, and it is refused against that plan whether it runs
            // before or after the regeneration of the current week.
            const world = await seedPlannableWorld();
            const { current, upcoming } = await seedCurrentAndUpcoming(world);

            const { regeneration, generation } = await driveSequentially(
                first,
                () => regeneratePlan(PLANNING_USER_ID, current.id, regenerateBody(1), NOW),
                () => generatePlan(PLANNING_USER_ID, generateBody(UPCOMING_WEEK), NOW),
            );

            expectCommitted(regeneration);
            expect(generation).toBeInstanceOf(PlanOverlapError);
            expect((generation as PlanOverlapError).conflictingPlanId).toBe(upcoming.id);

            await expectRegeneratedBesideUntouchedUpcoming(current, upcoming);
        },
    );

    it('commits the current week’s regeneration and refuses a generation for a FREE future week as upcoming_exists', async () => {
        const world = await seedPlannableWorld();
        const { current, upcoming } = await seedCurrentAndUpcoming(world);

        const results = await Promise.allSettled([
            regeneratePlan(PLANNING_USER_ID, current.id, regenerateBody(1), NOW),
            generatePlan(PLANNING_USER_ID, generateBody(FREE_FUTURE_WEEK), NOW),
        ]);

        const { fulfilled, rejected } = splitRace<unknown>(results);

        // The requested week collides with nothing, so `plan_overlap` cannot
        // be the refusal: the upcoming plan already stands as the one plan
        // starting after today, and that is what refuses the generation —
        // whichever order the two reached the lock in. The regeneration of the
        // CURRENT week is refused by neither rule, because both checks exclude
        // the plan being replaced and its own start date is not after today.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(UpcomingExistsError);

        await expectRegeneratedBesideUntouchedUpcoming(current, upcoming);
        // No week was published for the free dates, so the refusal left the
        // calendar exactly as the regeneration found it.
        expect(
            (await plansOf(PLANNING_USER_ID)).map((plan) => dayKeyOf(plan.start_date)),
        ).not.toContain(FREE_FUTURE_WEEK);
    });

    it.each(SEQUENTIAL_ORDERINGS)(
        'refuses the free future week as upcoming_exists with the same state when the two are driven with %s',
        async (_ordering, first) => {
            const world = await seedPlannableWorld();
            const { current, upcoming } = await seedCurrentAndUpcoming(world);

            const { regeneration, generation } = await driveSequentially(
                first,
                () => regeneratePlan(PLANNING_USER_ID, current.id, regenerateBody(1), NOW),
                () => generatePlan(PLANNING_USER_ID, generateBody(FREE_FUTURE_WEEK), NOW),
            );

            expectCommitted(regeneration);
            // No id travels with this refusal: §0.5.2 has the client reach the
            // standing upcoming plan through the current-plan response instead.
            expect(generation).toBeInstanceOf(UpcomingExistsError);

            await expectRegeneratedBesideUntouchedUpcoming(current, upcoming);
            expect(
                (await plansOf(PLANNING_USER_ID)).map((plan) => dayKeyOf(plan.start_date)),
            ).not.toContain(FREE_FUTURE_WEEK);
        },
    );
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
     * §0.7.3 assigns to one transaction.
     *
     * DRIVEN DIRECTLY HERE, AND THROUGH THE STAGE BELOW. These two rows need a
     * promotion of a NAMED version at a moment they choose — the second one
     * retires a version the fixture week holds on all seven days, which is what
     * makes the retired-but-referenced case certain rather than a matter of what
     * the search picked — and `scripts/recipes-seed.ts` decides for itself which
     * recipe it promotes, from a corpus on disk. The production stage is raced
     * against a real generation in "the recipe seed stage promoting a version
     * while a week is generated" at the end of this file, which is where
     * `runSeed`'s own transaction boundary is the subject; these two rows are
     * about what a generation and a published week survive.
     *
     * The FOOD retirement has the same split, and for the same reason. Both
     * rows below need a named food withdrawn at a moment they choose, so they
     * flip `publication_status` themselves — the state a load leaves behind —
     * while "the catalog release load beside a real generation", further down
     * this file, races `scripts/catalog-load.ts::runLoad` over a real
     * checksummed release and lets the STAGE decide what to retire. That block
     * is where the reconciliation, the run ledger and the active-release
     * pointer are the subject; these two rows are about what a generation and a
     * published week survive once a food is gone.
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

    /**
     * What a catalog load does to a food a newer release no longer contains,
     * written as the single statement the stage ends up issuing.
     *
     * The STAGE ITSELF is raced in "the catalog release load beside a real
     * generation" below; here the column is moved directly because both rows
     * need a NAMED food withdrawn at a moment they choose (see this block's
     * note above), and a release load chooses for itself from the difference
     * between two releases.
     */
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

/* ---------------------------------------------------------------------------
 * The real catalog release load, beside a real generation
 * ------------------------------------------------------------------------- */

/**
 * WHY THIS BLOCK EXISTS BESIDE THE DIRECT RETIREMENT ABOVE. That block flips
 * `publication_status` itself, which is enough to prove what a generation and a
 * published week survive once a food is gone — but it proves nothing about the
 * STAGE that withdraws it. A release load is not one UPDATE: it verifies five
 * members against their digests, claims a `catalog_import_runs` row, retires
 * every published food the release no longer carries, reconciles each remaining
 * food with its children in a transaction of its own, verifies the loaded counts
 * against the manifest and only then closes the run `succeeded` — which is what
 * makes it the active release. AAP §0.9.2 names this file for the catalog side of
 * the publication race "driven through their exported `run*(deps)` entry points",
 * and only the real `runLoad` exercises any of that.
 *
 * WHY `runLoad` AND NOT THE COMMAND. `scripts/catalog-load.ts` takes the graph's
 * EXCLUSIVE `release_load` stage lock in `main`, outside `runLoad`, exactly as
 * `src/__tests__/scripts/catalog-load.test.ts` drives it — so the call below is
 * the stage's whole body and nothing here contends for that lock. It matters
 * that it stays that way: `scripts/recipes-seed.ts::runSeed` now holds the same
 * graph lock SHARED for a whole-corpus run, so wrapping this call in the
 * exclusive lock would make the seed-stage block at the end of this file refuse
 * with `catalog_locked` for a reason that has nothing to do with either race.
 *
 * WHY THE RELEASE IS DERIVED FROM THE DATABASE. A release carries the published
 * set and nothing else, so the fixture reads the published foods this test has
 * just seeded and writes every one of them EXCEPT the staple — which is exactly
 * what "the newer release dropped that food" means, and it keeps the manifest's
 * counts true of the database by construction, so every post-load count check
 * can be asserted `ok` rather than merely reported. The digests are MEASURED
 * from the bytes written, never asserted from a constant, so the release is only
 * ever loaded against its own real checksums. Aliases and compositions are
 * empty because `makeCatalogFood` writes none; the validation records are
 * authored here, so the load's child reconciliation has real rows to INSERT and
 * the release is not a no-op wearing a retirement.
 *
 * WHAT IS DELIBERATELY NOT HERE. The loader's own scenarios — a v1 load, a
 * no-op rerun, a failure after partial progress, a tampered member, the
 * committed 11,046-food artefact — belong to `scripts/catalog-load.test.ts` and
 * are not repeated. The subject here is the RACE: one generation and one real
 * load, in flight together, and what the database holds afterwards.
 */
describe('the catalog release load beside a real generation', () => {
    /** The release id every case below loads. One release, one directory, one manifest. */
    const RELEASE_ID = 'v1';

    const RELEASE_MEMBER_FILES = {
        foods: 'foods.jsonl',
        aliases: 'aliases.jsonl',
        portions: 'portions.jsonl',
        components: 'components.jsonl',
        validationRecords: 'validation-records.jsonl',
    } as const;

    /**
     * The columns a `foods.jsonl` line states, in the order `catalog-release.ts`
     * writes them. Restated here rather than imported because the release format
     * is a file format: a test that read it from the loader's own constants
     * could not fail when the two drifted apart.
     */
    const FOOD_LINE_COLUMNS: readonly (keyof catalog_foods)[] = [
        'source_key',
        'canonical_name',
        'display_name',
        'category',
        'food_state',
        'food_group',
        'identity_source',
        'identity_status',
        'nutrition_provenance',
        'publication_status',
        'nutrition_basis',
        'basis_amount',
        'calories',
        'protein_g',
        'carbs_g',
        'fat_g',
        'fiber_g',
        'density_g_per_ml',
        'allergen_tags',
        'allergen_status',
        'diet_tags',
        'is_common_dislike',
        'cost_class',
        'nutrition_version',
        'metadata_version',
        'usda_fdc_id',
        'usda_data_type',
        'usda_description',
        'source_version',
        'source_cache_key',
        'search_text',
        'imported_at',
    ];

    /** Directories to remove in `afterAll`, so a failing case still cleans up. */
    const releaseRoots: string[] = [];

    afterAll(() => {
        for (const root of releaseRoots) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    /**
     * The stage logs structurally; a test has nothing to read it with.
     *
     * Typed through `LoadDeps` rather than by importing the logger's own
     * interface, for the reason the seed block states about `SeedDeps`: the only
     * contract this fixture owes is the stage's, so taking it from the stage's
     * own type means a method added there fails to compile here.
     */
    const silentStageLogger: LoadDeps['logger'] = {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        child: () => silentStageLogger,
    };

    /** JSONL as the exporter writes it: one compact object per line, LF-terminated. */
    const toJsonl = (rows: readonly Record<string, unknown>[]): string =>
        rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

    const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

    /**
     * A validation record for one food, as the release states it.
     *
     * Every published food in a release has one — `catalog-release.ts` refuses
     * to export a food without it, and `manifestConsistencyGaps` refuses a
     * manifest whose `counts.validation_records` disagrees with `counts.foods` —
     * so the fixture authors one per exported food and the load inserts them.
     *
     * And the record has to be COMPLETE, not merely present: `catalog-load.ts`
     * assesses a published food's identity evidence in its pre-write
     * verification pass (`scripts/lib/catalogEvidence.ts`, the one rule every
     * catalog stage applies) and refuses the whole release with
     * `release_evidence_incomplete` when a mandatory field of the retrieval
     * record is missing — the floor that keeps a published row from resting on
     * evidence nobody can check. This fixture's records therefore carry the
     * fields a USDA retrieval states, digested from the food's own source key
     * so the bytes are deterministic and each food's record is its own. The
     * values describe a retrieval this test never made, which is what a fixture
     * is; nothing here reaches a catalog a user reads.
     */
    const validationLine = (food: catalog_foods): Record<string, unknown> => ({
        food_source_key: food.source_key,
        canonical_identity: { canonical_name: food.canonical_name, food_state: food.food_state },
        aliases: [],
        category: food.category,
        food_state: food.food_state,
        identity_source: food.identity_source,
        identity_status: food.identity_status,
        nutrition_provenance: food.nutrition_provenance,
        nutrition_method: 'usda_sr_legacy_per_100g',
        nutrition_assumptions: [],
        portion_units: [],
        identity_evidence: [
            {
                url: 'https://api.nal.usda.gov/fdc/v1/foods',
                method: 'POST',
                final_host: 'api.nal.usda.gov',
                http_status: 200,
                source_cache_key: `POST /foods?#{"fdcIds":["${food.source_key}"],"format":"full"}`,
                retrieval_source: 'usda_api_cache',
                body_sha256: createHash('sha256').update(`body:${food.source_key}`).digest('hex'),
                record_sha256: createHash('sha256').update(`record:${food.source_key}`).digest('hex'),
                matched_snippet: food.canonical_name,
                fetched_at: NOW.toISOString(),
            },
        ],
        checks: [{ name: 'energy_vs_macros', pass: true, observed: 0, bound: 30 }],
        llm_review: null,
        outcome: 'accepted',
        reviewed_at: NOW.toISOString(),
        publication_status: 'published',
        source_versions: { usda: 'SR Legacy 2019-04' },
        history: [],
    });

    /**
     * Writes a release holding every currently published food EXCEPT the ones
     * named, with its manifest's digests measured from the bytes on disk.
     *
     * Read from the database rather than composed from a fixture so the
     * manifest's counts describe the graph the load will reconcile against: a
     * release that omitted a food nobody asked to drop would retire it too, and
     * the count checks would then be about the fixture rather than about the
     * load.
     */
    const writeReleaseDroppingFoods = async (
        droppedFoodIds: readonly string[],
    ): Promise<{ readonly root: string; readonly manifest: CatalogReleaseManifest }> => {
        const dropped = new Set(droppedFoodIds);
        const published = (
            await prisma.catalog_foods.findMany({
                where: { publication_status: 'published' },
                orderBy: { source_key: 'asc' },
                include: { catalog_food_portions: true },
            })
        ).filter((food) => !dropped.has(food.id));

        const foodLines = published.map((food) => {
            const line: Record<string, unknown> = {};
            for (const column of FOOD_LINE_COLUMNS) {
                const value = food[column];
                line[column] = value instanceof Date ? value.toISOString() : (value ?? null);
            }
            // The release names a food's generation batch by its portable key and
            // never by a local id; these fixture foods were imported, not
            // generated, so there is no batch to name.
            line.generation_batch_key = null;

            return line;
        });
        const portionLines = published.flatMap((food) =>
            [...food.catalog_food_portions]
                .sort((left, right) => left.description.localeCompare(right.description))
                .map((portion) => ({
                    food_source_key: food.source_key,
                    description: portion.description,
                    amount: portion.amount,
                    unit: portion.unit,
                    gram_weight: portion.gram_weight,
                    is_default: portion.is_default,
                    source: portion.source,
                })),
        );
        const validationLines = published.map(validationLine);

        const root = fs.mkdtempSync(path.join(os.tmpdir(), `concurrency-release-${RELEASE_ID}-`));
        releaseRoots.push(root);

        const contents: Readonly<Record<string, string>> = {
            [RELEASE_MEMBER_FILES.foods]: toJsonl(foodLines),
            [RELEASE_MEMBER_FILES.aliases]: '',
            [RELEASE_MEMBER_FILES.portions]: toJsonl(portionLines),
            [RELEASE_MEMBER_FILES.components]: '',
            [RELEASE_MEMBER_FILES.validationRecords]: toJsonl(validationLines),
        };
        const rowCounts: Readonly<Record<string, number>> = {
            [RELEASE_MEMBER_FILES.foods]: foodLines.length,
            [RELEASE_MEMBER_FILES.aliases]: 0,
            [RELEASE_MEMBER_FILES.portions]: portionLines.length,
            [RELEASE_MEMBER_FILES.components]: 0,
            [RELEASE_MEMBER_FILES.validationRecords]: validationLines.length,
        };

        for (const member of Object.values(RELEASE_MEMBER_FILES)) {
            fs.writeFileSync(path.join(root, member), contents[member], 'utf-8');
        }

        const manifest: CatalogReleaseManifest = {
            release_id: RELEASE_ID,
            manifest_version: 'v1',
            coverage_plan_version: 'v1',
            generated_at: NOW.toISOString(),
            produced_by: 'concurrency-suite',
            // Measured from the bytes on disk, exactly as catalog-release.ts
            // measures them: a digest taken from the string in memory would not
            // describe the file the loader reads.
            files: Object.values(RELEASE_MEMBER_FILES).map((member) => {
                const bytes = fs.readFileSync(path.join(root, member));

                return {
                    path: member,
                    name: member,
                    sha256: digestOf(bytes),
                    row_count: rowCounts[member],
                    bytes: bytes.length,
                };
            }),
            counts: {
                foods: foodLines.length,
                published_foods: foodLines.length,
                aliases: 0,
                portions: portionLines.length,
                components: 0,
                published_ingredient_derived: 0,
                validation_records: validationLines.length,
            },
            source_datasets: [
                {
                    name: 'SR Legacy',
                    version: 'SR Legacy 2019-04',
                    retrieved_at: NOW.toISOString(),
                    public_domain: true,
                },
            ],
            model_versions: {
                generation_model: null,
                review_model: null,
                prompt_version: null,
                generation_prompt_version: null,
                review_prompt_version: null,
            },
            coverage: {
                coverage_plan_version: 'v1',
                published_total: foodLines.length,
                shortfall_total: 0,
                categories: [],
            },
        };

        fs.writeFileSync(
            path.join(root, 'manifest.json'),
            `${JSON.stringify(manifest, null, 2)}\n`,
            'utf-8',
        );

        return { root, manifest };
    };

    /**
     * The stage's dependencies, with the real Prisma client on both seams.
     *
     * `runDb` is the run ledger's client and `db` the graph's; production passes
     * one client for both, and so does this, because the run row recording the
     * load has to be there afterwards for the pointer assertion to mean
     * anything.
     */
    const loadDeps = (built: {
        readonly root: string;
        readonly manifest: CatalogReleaseManifest;
    }): LoadDeps => ({
        db: prisma as unknown as LoadDb,
        runDb: prisma,
        release: RELEASE_ID,
        manifest: built.manifest,
        releaseRoot: built.root,
        logger: silentStageLogger,
        now: () => NOW,
        dryRun: false,
    });

    const publicationStatusOf = async (catalogFoodId: string): Promise<string> =>
        (
            await prisma.catalog_foods.findUniqueOrThrow({
                where: { id: catalogFoodId },
                select: { publication_status: true },
            })
        ).publication_status;

    it('reconciles the release and publishes the whole week, raced against each other', async () => {
        const world = await seedPlannableWorld();
        // The release the load will apply: everything published right now except
        // the staple every pool recipe shops for, so the stage's own retirement
        // pass is what withdraws it.
        const built = await writeReleaseDroppingFoods([world.staple.id]);

        expect(await publicationStatusOf(world.staple.id)).toBe('published');

        const results = await Promise.allSettled([
            generatePlan(PLANNING_USER_ID, generateBody(TODAY), NOW),
            runLoad(loadDeps(built)),
        ]);

        const { fulfilled, rejected } = splitRace<unknown>(results);

        // Neither side fails. The load reconciles tenant-less reference tables
        // and takes no per-user lock; the generation reads the plannable set in
        // one statement before its transaction opens and inserts version ids it
        // has already read. They contend for rows, not for a lock, and
        // PostgreSQL's row locks are enough.
        expect(rejected).toEqual([]);
        expect(fulfilled).toHaveLength(2);

        const summary = results[1].status === 'fulfilled' ? (results[1].value as LoadSummary) : null;

        if (summary === null) {
            throw new Error('the release load was refused');
        }

        /* The load did its whole job, not just the retirement. */

        // Every member verified against its own measured digest.
        expect(summary.verification.map((member) => member.file).sort()).toEqual(
            [...Object.values(RELEASE_MEMBER_FILES)].sort(),
        );
        // The stage decided what to withdraw, from the difference between the
        // release and the graph — and the staple is the only difference there is.
        expect(summary.retiredSourceKeys).toEqual([world.staple.source_key]);
        expect(await publicationStatusOf(world.staple.id)).toBe(RETIRED_FOOD);
        // The children the release declares were INSERTED, so this is a real
        // reconciliation rather than a retirement wearing a load.
        expect(summary.counts.validationRecordsWritten).toBe(
            summary.counts.foodsInserted + summary.counts.foodsUpdated + summary.counts.foodsUnchanged,
        );
        expect(summary.counts.foodsRetired).toBe(1);
        // Every post-load count agrees with the manifest, which is what says the
        // graph now IS the release.
        expect(summary.countChecks.filter((check) => !check.ok)).toEqual([]);
        // And the run is the active release: read back through the same query
        // GET /api/catalog/status answers with, never assumed from the close.
        expect(summary.activated).toBe(true);
        expect(await getActiveReleaseLoad(prisma)).toMatchObject({
            releaseId: RELEASE_ID,
            runId: summary.runId,
        });
        expect(summary.runId).not.toBeNull();
        expect(
            await prisma.catalog_import_runs.findUniqueOrThrow({
                where: { id: summary.runId ?? '' },
                select: { kind: true, manifest_version: true, status: true },
            }),
        ).toEqual({ kind: 'release_load', manifest_version: RELEASE_ID, status: 'succeeded' });

        /* And the week came out whole, against the versions the search read. */

        const published = await theOnlyPlanOf(PLANNING_USER_ID);

        expectWholeWeek(published);
        expect(published.status).toBe(ACTIVE_PLAN);
        expect(published.revision).toBe(1);

        const referenced = [...new Set(mealsOf(published).map((meal) => meal.recipe_version_id))];
        const poolVersionIds = world.pool.map((entry) => entry.version.id);

        expect(referenced.filter((versionId) => !poolVersionIds.includes(versionId))).toEqual([]);

        // FK integrity across the seam: every ingredient of every planned
        // version still resolves to a catalog food, including the one the load
        // has just retired — retirement is a status, and `recipe_ingredients`
        // holds a RESTRICT reference that a load may never break.
        const ingredientFoodIds = [
            ...new Set(
                (
                    await prisma.recipe_ingredients.findMany({
                        where: { recipe_version_id: { in: referenced } },
                        select: { catalog_food_id: true },
                    })
                ).map((row) => row.catalog_food_id),
            ),
        ];

        expect(ingredientFoodIds).toContain(world.staple.id);
        expect(
            await prisma.catalog_foods.count({ where: { id: { in: ingredientFoodIds } } }),
        ).toBe(ingredientFoodIds.length);

        // The list is derived from exactly those versions — including a line for
        // the withdrawn staple, which the shopper still needs this week.
        const groceryFoodIds = (
            await prisma.grocery_items.findMany({
                where: { meal_plan_id: published.id, user_id: PLANNING_USER_ID },
                select: { catalog_food_id: true },
            })
        ).map((row) => row.catalog_food_id);

        expect([...groceryFoodIds].sort()).toEqual([...ingredientFoodIds].sort());
        expect(groceryFoodIds).toContain(world.staple.id);

        // Every planned version reads back for its owner, and the alternatives
        // sheet still offers current versions only.
        for (const versionId of referenced) {
            expect((await getRecipeVersionForUser(PLANNING_USER_ID, versionId))?.versionId).toBe(
                versionId,
            );
        }

        const currentVersionIds = new Set(
            (
                await prisma.recipe_versions.findMany({
                    where: { status: CURRENT_VERSION },
                    select: { id: true },
                })
            ).map((version) => version.id),
        );

        for (const meal of published.meal_plan_days[0].meal_plan_meals) {
            for (const alternative of await listedAlternatives(
                PLANNING_USER_ID,
                published.id,
                meal.id,
            )) {
                expect(currentVersionIds.has(alternative.recipeVersionId)).toBe(true);
            }
        }

        const actions = await ledgerRows(PLANNING_USER_ID);

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            action_type: 'generate',
            response_status: 201,
            plan_revision_after: 1,
            meal_plan_id: published.id,
        });
    });

    it('leaves a week published before the load untouched by it', async () => {
        const world = await seedPlannableWorld();
        const built = await writeReleaseDroppingFoods([world.staple.id]);

        // Sequential, and in this order, because the subject is what a load does
        // to a week that ALREADY exists: the meal rows freeze their version ids
        // at publication, so a reconciliation that rewrote any of them would be
        // visible here and nowhere else.
        const generated = await generatePlan(PLANNING_USER_ID, generateBody(TODAY), NOW);

        if (generated.kind !== 'ok') {
            throw new Error(`the generation was refused: ${JSON.stringify(generated)}`);
        }

        const before = await theOnlyPlanOf(PLANNING_USER_ID);
        const mealsBefore = mealsOf(before).map((meal) => ({
            id: meal.id,
            recipe_version_id: meal.recipe_version_id,
            revision: meal.revision,
        }));
        const groceriesBefore = await getGroceryList(PLANNING_USER_ID, before.id, NOW);

        const summary = await runLoad(loadDeps(built));

        expect(summary.retiredSourceKeys).toEqual([world.staple.source_key]);
        expect(summary.activated).toBe(true);

        const after = await theOnlyPlanOf(PLANNING_USER_ID);

        // Not one row of the plan moved: a catalog release is not a plan write,
        // so it bumps no revision and re-points no meal.
        expect(after.revision).toBe(before.revision);
        expect(
            mealsOf(after).map((meal) => ({
                id: meal.id,
                recipe_version_id: meal.recipe_version_id,
                revision: meal.revision,
            })),
        ).toEqual(mealsBefore);

        // The list still renders, still holds its line for the withdrawn staple,
        // and holds exactly the items it held before.
        const groceriesAfter = await getGroceryList(PLANNING_USER_ID, after.id, NOW);

        expect(groceriesAfter.totalCount).toBe(groceriesBefore.totalCount);
        expect(
            groceriesAfter.sections.flatMap((section) => section.items).map((item) => item.catalogFoodId),
        ).toContain(world.staple.id);

        // And the day still reads, with its planned recipe on the card.
        const day = await getMealPlanDay(PLANNING_USER_ID, after.id, TODAY, NOW);

        if (day.kind !== 'ok') {
            throw new Error(`the day read was refused: ${JSON.stringify(day)}`);
        }

        expect(day.envelope.day.meals.length).toBeGreaterThan(0);
        expect(day.envelope.day.meals.every((meal) => meal.recipe.versionId.length > 0)).toBe(true);
    });
});

/* ===========================================================================
 * THE SAME RACES AT THE HTTP BOUNDARY
 *
 * Everything above proves the MECHANISM where it lives. This section proves the
 * CONTRACT where the client meets it: two genuine requests into the shipped app
 * (`../setup/testApp` drives `src/app.ts` with its real mount order, and it
 * never calls `listen`), and every refusal asserted as STATUS + MACHINE CODE +
 * PAYLOAD rather than as an error class. The distinction is not ceremony —
 * `mealPlanning.controller.ts` is the only place a `StalePlanError` becomes
 * `409 {error: 'stale_plan', currentRevision}`, and Rule
 * backend-architecture §8 keeps the class itself status-free, so a class
 * assertion says nothing about what any client was told.
 *
 * WHY THE REQUESTS ARE REALLY CONCURRENT. `--runInBand` serialises SUITES, not
 * the requests inside a test: each supertest call opens its own socket into the
 * one in-process app, and `prisma.$transaction` draws its own pooled
 * connection, so two requests fired together are two PostgreSQL sessions
 * contending for one advisory lock. Every sender below returns a promise that
 * has already been dispatched, so `Promise.all([a(), b()])` has both in flight.
 *
 * WHY THIS SECTION HAS ITS OWN WEEK. The controller passes no `now`, so every
 * service defaults it to `new Date()` and an HTTP request resolves "today" from
 * the real clock. The pinned week the service cases sit on would therefore be
 * an ENDED plan — `409 plan_not_active {reason: 'ended'}` — and would prove
 * nothing about a race. {@link seedRequestWeek} builds a current week around
 * the real today instead, for users of its own.
 * ========================================================================= */

/** Owns the current week the swap, log, regenerate and grocery cases act on. */
const REQUEST_PLAN_USER_ID = 'concurrency-suite-request-plan-user';

/** Publishes weeks over HTTP, so it must own no plan of its own. */
const REQUEST_PLANNING_USER_ID = 'concurrency-suite-request-planning-user';

const PLANS_PATH = '/api/meal-planning/plans';
const PREFERENCES_PATH = '/api/meal-planning/preferences';
const TARGETS_PATH = '/api/meal-planning/targets';

/** The untouched, pre-feature writer §0.5.1 calls the one writer outside the lock. */
const LEGACY_TARGETS_PATH = '/api/user/targets';

const planPath = (planId: string, suffix = ''): string => `${PLANS_PATH}/${planId}${suffix}`;

const mealPath = (planId: string, mealId: string, suffix = ''): string =>
    planPath(planId, `/meals/${mealId}${suffix}`);

/**
 * A response reduced to what a contract assertion may read.
 *
 * Narrowed deliberately: a case that could reach the headers or the raw text
 * would be asserting the transport rather than the contract, and `body` is
 * `Record<string, unknown>` so a missing member is `undefined` rather than a
 * type error waiting for a cast.
 */
interface HttpAnswer {
    readonly status: number;
    readonly body: Record<string, unknown>;
}

/**
 * Awaits a dispatched request and reduces it.
 *
 * Typed against `PromiseLike` rather than supertest's `Test` so the helper
 * states exactly what it needs; a `Test` satisfies it, and nothing here can
 * accidentally depend on the rest of that object.
 */
const answerOf = async (sent: PromiseLike<{ status: number; body: unknown }>): Promise<HttpAnswer> => {
    const response = await sent;

    return { status: response.status, body: (response.body ?? {}) as Record<string, unknown> };
};

/* The senders. Each dispatches immediately, which is what makes a race a race. */

const postGenerate = (userId: string, body: Record<string, unknown>): Promise<HttpAnswer> =>
    answerOf(asUser(request.post(PLANS_PATH), { uid: userId }).send(body));

const postRegenerate = (
    userId: string,
    planId: string,
    body: Record<string, unknown>,
): Promise<HttpAnswer> =>
    answerOf(asUser(request.post(planPath(planId, '/regenerate')), { uid: userId }).send(body));

const postSwap = (
    userId: string,
    planId: string,
    mealId: string,
    body: Record<string, unknown>,
): Promise<HttpAnswer> =>
    answerOf(asUser(request.post(mealPath(planId, mealId, '/swap')), { uid: userId }).send(body));

const postLog = (
    userId: string,
    planId: string,
    mealId: string,
    body: Record<string, unknown>,
): Promise<HttpAnswer> =>
    answerOf(asUser(request.post(mealPath(planId, mealId, '/log')), { uid: userId }).send(body));

const putGroceryItem = (
    userId: string,
    planId: string,
    itemId: string,
    body: Record<string, unknown>,
): Promise<HttpAnswer> =>
    answerOf(asUser(request.put(planPath(planId, `/groceries/${itemId}`)), { uid: userId }).send(body));

const postUncheckAll = (userId: string, planId: string): Promise<HttpAnswer> =>
    answerOf(asUser(request.post(planPath(planId, '/groceries/uncheck-all')), { uid: userId }).send({}));

const getGroceries = (userId: string, planId: string): Promise<HttpAnswer> =>
    answerOf(asUser(request.get(planPath(planId, '/groceries')), { uid: userId }));

const getPreview = (
    userId: string,
    planId: string,
    mealId: string,
    recipeVersionId: string,
): Promise<HttpAnswer> =>
    answerOf(
        asUser(request.get(mealPath(planId, mealId, `/alternatives/${recipeVersionId}/preview`)), {
            uid: userId,
        }),
    );

const putPreferences = (userId: string, body: Record<string, unknown>): Promise<HttpAnswer> =>
    answerOf(asUser(request.put(PREFERENCES_PATH), { uid: userId }).send(body));

const putTargets = (userId: string, body: Record<string, unknown>): Promise<HttpAnswer> =>
    answerOf(asUser(request.put(TARGETS_PATH), { uid: userId }).send(body));

const getTargets = (userId: string): Promise<HttpAnswer> =>
    answerOf(asUser(request.get(TARGETS_PATH), { uid: userId }));

const putLegacyTargets = (userId: string, body: Record<string, unknown>): Promise<HttpAnswer> =>
    answerOf(asUser(request.put(LEGACY_TARGETS_PATH), { uid: userId }).send(body));

/* Request bodies, with the key minted per call unless a case holds one. */

const requestGenerateBody = (
    startDate: string,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
    startDate,
    idempotencyKey: randomUUID(),
    expectedPreferencesRevision: 1,
    expectedTargetsRevision: 1,
    ...overrides,
});

const requestRegenerateBody = (
    expectedPlanRevision: number,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
    idempotencyKey: randomUUID(),
    expectedPlanRevision,
    expectedPreferencesRevision: 1,
    expectedTargetsRevision: 1,
    ...overrides,
});

const requestSwapBody = (
    recipeVersionId: string,
    expectedPlanRevision: number,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
    recipeVersionId,
    portionMultiplier: 1,
    expectedPlanRevision,
    idempotencyKey: randomUUID(),
    ...overrides,
});

const requestLogBody = (
    diaryMealId: string,
    date: string,
    expectedPlanRevision: number,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
    servings: 1,
    date,
    diaryMealId,
    expectedPlanRevision,
    idempotencyKey: randomUUID(),
    ...overrides,
});

/**
 * The refusal as the client received it, compared STRICTLY: an extra member is
 * a failure too, because §0.5.2 states each code's payload exactly and a body
 * carrying more than it promises is how an internal detail reaches a client.
 */
const expectRefusal = (answer: HttpAnswer, status: number, body: Record<string, unknown>): void => {
    expect({ status: answer.status, body: answer.body }).toStrictEqual({ status, body });
};

/**
 * A raced set split by what the boundary answered, so a case can assert the
 * outcome SET — "exactly one accepted, the rest refused with this code" —
 * without naming which request won.
 */
const splitAnswers = (
    answers: readonly HttpAnswer[],
    acceptedStatus: number,
): { accepted: HttpAnswer[]; refused: HttpAnswer[] } => ({
    accepted: answers.filter((answer) => answer.status === acceptedStatus),
    refused: answers.filter((answer) => answer.status !== acceptedStatus),
});


/**
 * The diary bucket a log body names, obtained the way the client obtains it:
 * `GET /api/macros/:date` self-heals the four buckets for any date, so this
 * both creates and reads it.
 */
const diaryBucketId = async (userId: string, dayKey: string, name = 'Breakfast'): Promise<string> => {
    const response = await asUser(request.get(`/api/macros/${dayKey}`), { uid: userId }).expect(200);
    const bucket = (response.body as { meals: { id: string; name: string }[] }).meals.find(
        (meal) => meal.name === name,
    );

    if (bucket === undefined) {
        throw new Error(`GET /api/macros/${dayKey} returned no ${name} bucket for ${userId}`);
    }

    return bucket.id;
};

interface RequestWeek {
    /** Today in UTC, read ONCE, so no two assertions in a case straddle midnight. */
    readonly today: string;
    readonly planId: string;
    readonly breakfastMealId: string;
    readonly lunchMealId: string;
    readonly diaryMealId: string;
    readonly groceryItemId: string;
    /** The plannable universe both identities draw on; see {@link seedRecipePool}. */
    readonly pool: readonly PoolRecipe[];
    readonly staple: catalog_foods;
}

/**
 * The boundary section's world: a plannable catalog, one user holding a CURRENT
 * week with its shopping list, and one user holding nothing.
 *
 * TWO IDENTITIES, because the two halves of this section need opposite states —
 * a generation may not overlap an active week, so the user it publishes for
 * owns none; a regeneration, a swap, a log and a grocery write all act on an
 * existing week.
 *
 * THE POOL RATHER THAN THE FIXTURE WEEK'S FIVE RECIPES, because every pool
 * recipe is admissible in all three slots and lands a day on target at ×1: a
 * swap on the LUNCH slot therefore has candidates, which the week fixture's
 * breakfast-only alternatives could never supply, and that is what the
 * different-meals race below needs. Both users dislike the week fixture's food
 * group for the reason {@link WEEK_FOOD_GROUP} gives — `recipe_versions` has no
 * owner, so without it `beforeEach`'s week would widen every alternatives list
 * asserted here.
 */
const seedRequestWeek = async (): Promise<RequestWeek> => {
    const today = utcTodayDayKey();
    const { pool, staple } = await seedRecipePool();

    for (const userId of [REQUEST_PLAN_USER_ID, REQUEST_PLANNING_USER_ID]) {
        await makeUser({ id: userId, ...FIXTURE_USER_TARGET_COLUMNS });
        await makePreferences(userId, {
            time_zone: 'UTC',
            disliked_food_groups: [WEEK_FOOD_GROUP],
        });
    }

    const plan = await makePlan(REQUEST_PLAN_USER_ID, {
        today,
        slots: [
            { slot: 'breakfast', slot_time: '08:00', recipeVersionId: pool[0].version.id },
            { slot: 'lunch', slot_time: '12:30', recipeVersionId: pool[1].version.id },
            { slot: 'dinner', slot_time: '18:30', recipeVersionId: pool[2].version.id },
        ],
    });

    const day = plan.meal_plan_days.find((candidate) => dayKeyOf(candidate.date) === today);

    if (day === undefined) {
        throw new Error(`the request week does not contain today (${today}), so no write could name it`);
    }

    const breakfast = day.meal_plan_meals.find((meal) => meal.slot === 'breakfast');
    const lunch = day.meal_plan_meals.find((meal) => meal.slot === 'lunch');

    if (breakfast === undefined || lunch === undefined) {
        throw new Error('the request week is missing one of the slots its cases act on');
    }

    // The real service under the real lock, at the real clock this section
    // runs on — a hand-built row would not be the list a swap reconciles.
    await buildGroceries(plan.id, REQUEST_PLAN_USER_ID, new Date());

    const groceryItem = await prisma.grocery_items.findFirstOrThrow({
        where: { meal_plan_id: plan.id, user_id: REQUEST_PLAN_USER_ID },
        orderBy: { sort_order: 'asc' },
    });

    return {
        today,
        planId: plan.id,
        breakfastMealId: breakfast.id,
        lunchMealId: lunch.id,
        diaryMealId: await diaryBucketId(REQUEST_PLAN_USER_ID, today),
        groceryItemId: groceryItem.id,
        pool,
        staple,
    };
};

/**
 * A candidate the server itself offers for one slot, with the portion it
 * recomputes — which is what a commit must send back, because the commit binds
 * the PREVIEWED portion (`swap.logic.ts::requireBoundPortion`).
 *
 * Read rather than named: every pool recipe is nutritionally identical, so
 * which one heads the ranked list is `swap.logic.ts`'s decision and not a
 * fixture's to assume.
 */
const offeredAlternative = async (
    userId: string,
    planId: string,
    mealId: string,
): Promise<{ recipeVersionId: string; portionMultiplier: number }> => {
    const [candidate] = await listedAlternatives(userId, planId, mealId);

    if (candidate === undefined) {
        throw new Error(`meal ${mealId} of plan ${planId} has no alternative to swap to`);
    }

    return {
        recipeVersionId: candidate.recipeVersionId,
        portionMultiplier: candidate.portionMultiplier,
    };
};

/** Two distinct candidates for one slot, for the cases that need a losing one. */
const twoOfferedAlternatives = async (
    userId: string,
    planId: string,
    mealId: string,
): Promise<{ first: string; second: string }> => {
    const offers = await listedAlternatives(userId, planId, mealId);

    if (offers.length < 2) {
        throw new Error(
            `meal ${mealId} of plan ${planId} offers ${offers.length} alternatives; this case needs two`,
        );
    }

    return { first: offers[0].recipeVersionId, second: offers[1].recipeVersionId };
};


/* ---------------------------------------------------------------------------
 * One key, two requests actually in flight
 *
 * The service-level pair above proves the reservation; this proves what the two
 * CLIENTS were told. §0.5.1 stores the first response's status rather than
 * inferring it, so the replay carries `201` for a generation, a regeneration
 * and a log and `200` for a swap, and the two callers must be unable to tell
 * which of them did the work.
 *
 * The LOG pair is not repeated here: `api/log.test.ts` asserts the same double
 * tap at this boundary, and the service-level pair above covers it below the
 * controller. Everything else in the four keyed writes is here.
 * ------------------------------------------------------------------------- */

describe('two parallel requests at the boundary carrying the same idempotency key', () => {
    /** Both answers identical, by value and as bytes, at the persisted status. */
    const expectIndistinguishable = (
        first: HttpAnswer,
        second: HttpAnswer,
        status: number,
    ): void => {
        expect([first.status, second.status]).toEqual([status, status]);
        expect(second.body).toEqual(first.body);
        // §0.9.2's "byte-for-byte": one of the two came out of the `jsonb`
        // snapshot column and the other from memory, and the two texts agree
        // because both serialise a canonically ordered value
        // (`mealPlanningAction.logic.ts::canonicalizeResponseBody`).
        expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
    };

    it('publishes one week between them and answers both with the same stored 201', async () => {
        const fixture = await seedRequestWeek();
        const body = requestGenerateBody(fixture.today);

        const [first, second] = await Promise.all([
            postGenerate(REQUEST_PLANNING_USER_ID, body),
            postGenerate(REQUEST_PLANNING_USER_ID, body),
        ]);

        expectIndistinguishable(first, second, 201);

        const published = await theOnlyPlanOf(REQUEST_PLANNING_USER_ID);

        expectWholeWeek(published);
        expect(published.status).toBe(ACTIVE_PLAN);
        expect(published.revision).toBe(1);
        expect(dayKeyOf(published.start_date)).toBe(fixture.today);
        // The column §0.5.1 gives a client for recognising its own committed
        // generation after a lost response, and the second line of defence the
        // unique `(user_id, generation_key)` makes of it.
        expect(published.generation_key).toBe(body.idempotencyKey);
        expect(
            (await plansOf(REQUEST_PLANNING_USER_ID)).filter(
                (plan) => plan.generation_key === body.idempotencyKey,
            ),
        ).toHaveLength(1);

        const actions = await ledgerRows(REQUEST_PLANNING_USER_ID);

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            action_type: 'generate',
            idempotency_key: body.idempotencyKey,
            response_status: 201,
            plan_revision_after: 1,
            meal_plan_id: published.id,
        });
        await expectOneActivePlanPerStartDate(REQUEST_PLANNING_USER_ID);
    });

    it('regenerates once between them and answers both with the same stored 201', async () => {
        const fixture = await seedRequestWeek();
        const body = requestRegenerateBody(1);

        const [first, second] = await Promise.all([
            postRegenerate(REQUEST_PLAN_USER_ID, fixture.planId, body),
            postRegenerate(REQUEST_PLAN_USER_ID, fixture.planId, body),
        ]);

        expectIndistinguishable(first, second, 201);

        const plans = await plansOf(REQUEST_PLAN_USER_ID);
        const replacement = plans.filter((plan) => plan.status === ACTIVE_PLAN);
        const superseded = plans.filter((plan) => plan.status === SUPERSEDED_PLAN);

        // One replacement, not two: the week was rebuilt once however many
        // requests asked for it.
        expect(plans).toHaveLength(2);
        expect(superseded.map((plan) => plan.id)).toEqual([fixture.planId]);
        expect(replacement[0].replaced_plan_id).toBe(fixture.planId);
        expect(replacement[0].generation_attempt).toBe(2);
        expectWholeWeek(replacement[0]);
        await expectIntactReplacementChains(REQUEST_PLAN_USER_ID);
        await expectOneActivePlanPerStartDate(REQUEST_PLAN_USER_ID);

        const actions = await ledgerRows(REQUEST_PLAN_USER_ID);

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            action_type: 'regenerate',
            idempotency_key: body.idempotencyKey,
            response_status: 201,
            meal_plan_id: replacement[0].id,
        });
    });

    it('commits one swap between them and answers both with the same stored 200', async () => {
        const fixture = await seedRequestWeek();
        const offer = await offeredAlternative(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
        );
        const body = requestSwapBody(offer.recipeVersionId, 1, {
            portionMultiplier: offer.portionMultiplier,
        });

        const [first, second] = await Promise.all([
            postSwap(REQUEST_PLAN_USER_ID, fixture.planId, fixture.breakfastMealId, body),
            postSwap(REQUEST_PLAN_USER_ID, fixture.planId, fixture.breakfastMealId, body),
        ]);

        // 200 rather than 201: a swap creates no resource, and §0.5.1 replays
        // the STORED status rather than one inferred from the action type.
        expectIndistinguishable(first, second, 200);

        const meal = await mealRow(fixture.breakfastMealId);

        expect(meal.recipe_version_id).toBe(offer.recipeVersionId);
        expect(meal.revision).toBe(2);
        expect(await planRevision(fixture.planId)).toBe(2);

        const actions = await ledgerRows(REQUEST_PLAN_USER_ID);

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            action_type: 'swap',
            response_status: 200,
            plan_revision_after: 2,
            meal_plan_meal_id: fixture.breakfastMealId,
        });
    });

    it('writes one week for four requests fired at once', async () => {
        const fixture = await seedRequestWeek();
        const body = requestGenerateBody(fixture.today);
        const senders = Array.from({ length: 4 }, () => () =>
            postGenerate(REQUEST_PLANNING_USER_ID, body),
        );

        // A double tap plus the client's own automatic retry of an unconfirmed
        // outcome (§0.2.5) is four requests under one key, and the answer must
        // be one write and four identical responses.
        const answers = await Promise.all(senders.map((send) => send()));

        expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201, 201]);
        for (const answer of answers) {
            expect(answer.body).toEqual(answers[0].body);
        }

        const published = await theOnlyPlanOf(REQUEST_PLANNING_USER_ID);

        expectWholeWeek(published);
        expect(published.revision).toBe(1);
        expect(mealsOf(published)).toHaveLength(PLAN_DAY_COUNT * 3);
        expect(await ledgerRows(REQUEST_PLANNING_USER_ID)).toHaveLength(1);
    });

    it('refuses the one carrying a different body as idempotency_conflict', async () => {
        const fixture = await seedRequestWeek();
        const offers = await twoOfferedAlternatives(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
        );
        const sharedKey = randomUUID();
        const swapTo = (recipeVersionId: string): Record<string, unknown> =>
            requestSwapBody(recipeVersionId, 1, { idempotencyKey: sharedKey });

        const answers = await Promise.all([
            postSwap(REQUEST_PLAN_USER_ID, fixture.planId, fixture.breakfastMealId, swapTo(offers.first)),
            postSwap(REQUEST_PLAN_USER_ID, fixture.planId, fixture.breakfastMealId, swapTo(offers.second)),
        ]);

        const { accepted, refused } = splitAnswers(answers, 200);

        // A different request wearing a used key is never a retry, so it is
        // refused rather than replayed — and the code carries no data, because
        // there is nothing about the first request this caller may learn.
        expect(accepted).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expectRefusal(refused[0], 409, { error: 'idempotency_conflict' });

        const meal = await mealRow(fixture.breakfastMealId);

        expect([offers.first, offers.second]).toContain(meal.recipe_version_id);
        expect(meal.revision).toBe(2);
        expect(await planRevision(fixture.planId)).toBe(2);
        // The refusal wrote nothing: one ledger row, for the winner.
        expect(await ledgerRows(REQUEST_PLAN_USER_ID)).toHaveLength(1);
    });
});

/* ---------------------------------------------------------------------------
 * A reservation that rolled back with its transaction
 *
 * §0.5.1: a reserved row is PENDING until the write completes, and because the
 * reservation and the write share one transaction, a pending row is visible to
 * other sessions only while that transaction is open and disappears with it on
 * rollback. So a same-key request finds either no row (and proceeds) or a
 * completed one (and replays) — never a half-written one.
 *
 * The refusal that proves it has to be raised INSIDE `work`, after the
 * reservation: `plan_overlap` is (`requireNonConflictingWeek` runs under the
 * lock), whereas an injected `MEAL_PLANNING_FAULT` throws in FRONT of the
 * transaction and never reserves at all — which is why this case needs no
 * fault, and why `api/fault.test.ts` keeps the flag mechanism Rule §9's
 * read-once config forces on anything that flips one.
 * ------------------------------------------------------------------------- */

describe('a reservation rolled back inside its own transaction', () => {
    it('leaves no trace, so the same key publishes on the next attempt', async () => {
        const fixture = await seedRequestWeek();

        // A week of the PLANNING user's own, so the generation below overlaps
        // something and is refused after it has reserved.
        const conflicting = await makePlan(REQUEST_PLANNING_USER_ID, {
            today: fixture.today,
            recipeVersionId: fixture.pool[0].version.id,
        });
        const intent = requestGenerateBody(fixture.today);

        const refused = await postGenerate(REQUEST_PLANNING_USER_ID, intent);

        expectRefusal(refused, 409, { error: 'plan_overlap', conflictingPlanId: conflicting.id });
        expect(await ledgerRows(REQUEST_PLANNING_USER_ID)).toEqual([]);

        // The overlap removed. Marked directly because no endpoint retires a
        // week without publishing a replacement, and what this case turns on is
        // the KEY rather than how the conflict went away.
        await prisma.meal_plans.update({
            where: { id: conflicting.id },
            data: { status: SUPERSEDED_PLAN },
        });

        const published = await postGenerate(REQUEST_PLANNING_USER_ID, intent);

        // The same key, accepted: the rolled-back reservation left nothing for
        // the `ON CONFLICT` to find, so this is a first attempt rather than a
        // replay or a conflict.
        expect(published.status).toBe(201);

        const active = (await plansOf(REQUEST_PLANNING_USER_ID)).filter(
            (plan) => plan.status === ACTIVE_PLAN,
        );

        expect(active).toHaveLength(1);
        expectWholeWeek(active[0]);
        expect(active[0].generation_key).toBe(intent.idempotencyKey);

        const actions = await ledgerRows(REQUEST_PLANNING_USER_ID);

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            idempotency_key: intent.idempotencyKey,
            response_status: 201,
            meal_plan_id: active[0].id,
        });
    });
});


/* ---------------------------------------------------------------------------
 * Two generations at the boundary
 *
 * The partial unique index `unique_active_meal_plan_start_date` is a BACKSTOP
 * (§0.5.1): the advisory lock plus `requireNonConflictingWeek` are the
 * mechanism, so the user-visible answer must be the explicit machine code and
 * never a unique-violation message. `expectRefusal` compares the whole body
 * strictly, which is what makes "no constraint name reached the client" an
 * assertion rather than a hope (Rule §4).
 * ------------------------------------------------------------------------- */

describe('two generations raced at the boundary', () => {
    it('refuses the loser as plan_overlap, naming the week that published', async () => {
        const fixture = await seedRequestWeek();
        const secondWeek = addDaysToDayKey(fixture.today, 1);

        const answers = await Promise.all([
            postGenerate(REQUEST_PLANNING_USER_ID, requestGenerateBody(fixture.today)),
            postGenerate(REQUEST_PLANNING_USER_ID, requestGenerateBody(secondWeek)),
        ]);

        const { accepted, refused } = splitAnswers(answers, 201);
        const published = await theOnlyPlanOf(REQUEST_PLANNING_USER_ID);

        // Which start date survives is timing and is deliberately not
        // asserted; that exactly one did, whole, and that the other caller was
        // told which plan it collided with, is the contract.
        expect(accepted).toHaveLength(1);
        expect([fixture.today, secondWeek]).toContain(dayKeyOf(published.start_date));
        expectWholeWeek(published);
        expectRefusal(refused[0], 409, { error: 'plan_overlap', conflictingPlanId: published.id });

        expect(await ledgerRows(REQUEST_PLANNING_USER_ID)).toHaveLength(1);
        await expectOneActivePlanPerStartDate(REQUEST_PLANNING_USER_ID);
    });

    it('refuses a second generation for the very same week the same way', async () => {
        const fixture = await seedRequestWeek();
        const body = requestGenerateBody(fixture.today);

        expect((await postGenerate(REQUEST_PLANNING_USER_ID, body)).status).toBe(201);

        const published = await theOnlyPlanOf(REQUEST_PLANNING_USER_ID);

        // A DIFFERENT key, so this is a second intent rather than a retry — a
        // shared key would be answered by the ledger and no conflict would ever
        // be reached. Identical start dates are the case the partial unique
        // index would catch, and the point is that it never has to: the answer
        // is the same explicit code as any other overlap.
        expectRefusal(await postGenerate(REQUEST_PLANNING_USER_ID, requestGenerateBody(fixture.today)), 409, {
            error: 'plan_overlap',
            conflictingPlanId: published.id,
        });

        expect(await plansOf(REQUEST_PLANNING_USER_ID)).toHaveLength(1);
        expect(await ledgerRows(REQUEST_PLANNING_USER_ID)).toHaveLength(1);
        await expectOneActivePlanPerStartDate(REQUEST_PLANNING_USER_ID);
    });

    it('refuses a second upcoming week as upcoming_exists and leaves the first standing', async () => {
        const fixture = await seedRequestWeek();

        // A current week of this user's own, so the week after it is UPCOMING
        // rather than current.
        const current = await makePlan(REQUEST_PLANNING_USER_ID, {
            today: fixture.today,
            recipeVersionId: fixture.pool[0].version.id,
        });

        const first = await postGenerate(
            REQUEST_PLANNING_USER_ID,
            requestGenerateBody(addDaysToDayKey(fixture.today, 7)),
        );

        expect(first.status).toBe(201);

        const upcoming = (await plansOf(REQUEST_PLANNING_USER_ID)).find(
            (plan) => plan.id !== current.id,
        );

        if (upcoming === undefined) {
            throw new Error('the first upcoming week was not published');
        }

        // A free week beyond it, overlapping nothing, so the only rule left to
        // refuse it is the at-most-one-upcoming rule — and no id travels with
        // that code: §0.5.2 has the client reach the standing plan through the
        // current-plan response instead.
        expectRefusal(
            await postGenerate(
                REQUEST_PLANNING_USER_ID,
                requestGenerateBody(addDaysToDayKey(fixture.today, 14)),
            ),
            409,
            { error: 'upcoming_exists' },
        );

        const plans = await plansOf(REQUEST_PLANNING_USER_ID);

        expect(plans.map((plan) => plan.id)).toEqual([current.id, upcoming.id]);
        expect(plans.map((plan) => plan.revision)).toEqual([1, 1]);
        expect(await ledgerRows(REQUEST_PLANNING_USER_ID)).toHaveLength(1);
    });
});

/* ---------------------------------------------------------------------------
 * A generation pinning inputs that have already moved
 *
 * The two revisions a generation pins are re-read twice — once unlocked before
 * the five-second search, and once under the per-user lock AND the owning user
 * row's lock inside the publication transaction (`requirePinnedInputs`). Either
 * one moving is `409 stale_revision` carrying BOTH counters, so the client can
 * re-prepare from values it has rather than guessing which half moved.
 * ------------------------------------------------------------------------- */

describe('a generation pinning inputs that have moved', () => {
    it('refuses a stale preferences revision and publishes nothing', async () => {
        const fixture = await seedRequestWeek();

        const saved = await putPreferences(REQUEST_PLANNING_USER_ID, {
            cookingTimeLimitMin: 45,
            timeZone: 'UTC',
            expectedRevision: 1,
        });

        expect(saved.status).toBe(200);

        // The body still pins revision 1, which the save has just advanced.
        expectRefusal(
            await postGenerate(REQUEST_PLANNING_USER_ID, requestGenerateBody(fixture.today)),
            409,
            { error: 'stale_revision', preferencesRevision: 2, targetsRevision: 1 },
        );

        expect(await plansOf(REQUEST_PLANNING_USER_ID)).toEqual([]);
        // Refused by the unlocked preflight, in front of the search and in
        // front of the ledger, so there is nothing to roll back.
        expect(await ledgerRows(REQUEST_PLANNING_USER_ID)).toEqual([]);
    });

    it('refuses a stale targets revision and publishes nothing', async () => {
        const fixture = await seedRequestWeek();

        const saved = await putTargets(REQUEST_PLANNING_USER_ID, {
            source: 'manual',
            calories: FIXTURE_TARGETS.calories,
            protein: FIXTURE_TARGETS.protein,
            carbs: FIXTURE_TARGETS.carbs,
            fat: FIXTURE_TARGETS.fat,
            expectedTargetsRevision: 1,
        });

        expect(saved.status).toBe(200);

        // The same four numbers, confirmed again: the VALUES are unchanged and
        // the request is still refused, because what a generation pins is the
        // revision the user confirmed at, not the numbers it happens to see.
        expectRefusal(
            await postGenerate(REQUEST_PLANNING_USER_ID, requestGenerateBody(fixture.today)),
            409,
            { error: 'stale_revision', preferencesRevision: 1, targetsRevision: 2 },
        );

        expect(await plansOf(REQUEST_PLANNING_USER_ID)).toEqual([]);
        expect(await ledgerRows(REQUEST_PLANNING_USER_ID)).toEqual([]);
    });

    /**
     * The other half of the same pinning: what the publication WRITES to the row
     * it pinned.
     *
     * §0.5.2 has `POST /plans` set `setupStatus` to `completed` on success, and
     * §0.5.1 requires every update to a revisioned row to carry the owner AND
     * the expected revision. `markSetupCompleted` therefore predicates on
     * `{user_id, revision}` with the revision `requirePinnedInputs` certified a
     * few statements earlier, and demands one affected row — otherwise a row
     * that had vanished or moved would leave this committed plan and its ledger
     * entry behind a setup that never completed.
     *
     * Two properties are reachable from outside the lock and are asserted here.
     * The FAILURE branch is not: every writer of that row takes the same
     * per-user advisory lock this transaction holds, so nothing can move the
     * revision between the certification and the write — the same reason the
     * supersede compare-and-set in `regeneratePlan` has no failure case either.
     * Both refuse rather than default, and both roll the whole publication back.
     */
    const plannerPreferences = () =>
        prisma.meal_plan_preferences.findUniqueOrThrow({
            where: { user_id: REQUEST_PLANNING_USER_ID },
            select: { setup_status: true, revision: true, targets_revision: true },
        });

    it('completes setup against the revision it certified, without moving that revision', async () => {
        const fixture = await seedRequestWeek();

        // `ready_for_review` so the transition is MEASURABLE: left at the
        // factory's `completed`, the assertion below would hold whether the
        // write matched a row or not.
        await prisma.meal_plan_preferences.update({
            where: { user_id: REQUEST_PLANNING_USER_ID },
            data: { setup_status: 'ready_for_review', setup_step: 'review' },
        });

        const before = await plannerPreferences();

        expect(before).toEqual({ setup_status: 'ready_for_review', revision: 1, targets_revision: 1 });

        const published = await postGenerate(REQUEST_PLANNING_USER_ID, requestGenerateBody(fixture.today));

        expect(published.status).toBe(201);

        // The status moved and NOTHING ELSE did. The revision counts edits to
        // the planning INPUTS, and completing setup edits none of them: bumping
        // it would strand every pinned revision a client or a concurrent save
        // holds, which is why the predicate can safely match on it at all.
        expect(await plannerPreferences()).toEqual({
            setup_status: 'completed',
            revision: before.revision,
            targets_revision: before.targets_revision,
        });
    });

    it('publishes a second week from an already-completed setup, because the pinned write is idempotent', async () => {
        const fixture = await seedRequestWeek();

        expect((await plannerPreferences()).setup_status).toBe('completed');

        const first = await postGenerate(REQUEST_PLANNING_USER_ID, requestGenerateBody(fixture.today));

        expect(first.status).toBe(201);

        // The upcoming week §0.5.1 allows beside the current one. Its
        // publication runs the same revision-pinned status write against a row
        // already reading `completed`, and one row must still match: a
        // predicate that also compared the status, or one that demanded a
        // transition, would fail the second publication outright.
        const second = await postGenerate(
            REQUEST_PLANNING_USER_ID,
            requestGenerateBody(addDaysToDayKey(fixture.today, 7)),
        );

        expect(second.status).toBe(201);

        expect(await plannerPreferences()).toEqual({
            setup_status: 'completed',
            revision: 1,
            targets_revision: 1,
        });
        expect((await plansOf(REQUEST_PLANNING_USER_ID)).map((plan) => plan.revision)).toEqual([1, 1]);
    });
});


/* ---------------------------------------------------------------------------
 * Two swaps on two different meals of one week
 *
 * The lock SERIALISES rather than rejects, and the compare-and-swap that then
 * decides the outcome is the PLAN's (`meal_plans.revision`), not the meal's —
 * §0.5.1 requires `expectedPlanRevision` on every swap, and `swap.service.ts`
 * compares it before touching the meal. So the two orderings answer
 * differently, and both answers are the contract:
 *
 *   DRIVEN IN TURN, each pinning the revision the previous commit returned,
 *   both commit and the counter advances twice.
 *
 *   RACED, both pinning the same revision, exactly one commits and the other
 *   is `409 stale_plan` — a swap on the breakfast slot really does invalidate a
 *   pinned revision for the lunch slot, which is the property a client's
 *   refetch-then-retry exists for.
 * ------------------------------------------------------------------------- */

describe('two swaps on two different meals of one week', () => {
    it('commits both when each pins the revision the previous one returned', async () => {
        const fixture = await seedRequestWeek();
        const breakfastOffer = await offeredAlternative(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
        );

        const firstSwap = await postSwap(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
            requestSwapBody(breakfastOffer.recipeVersionId, 1, {
                portionMultiplier: breakfastOffer.portionMultiplier,
            }),
        );

        expect(firstSwap.status).toBe(200);
        expect(firstSwap.body.planRevision).toBe(2);

        // The lunch candidate is read AFTER the breakfast swap, so the portion
        // it carries is the one the server recomputes against the day as it now
        // stands — which is what the commit binds.
        const lunchOffer = await offeredAlternative(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.lunchMealId,
        );
        const secondSwap = await postSwap(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.lunchMealId,
            requestSwapBody(lunchOffer.recipeVersionId, 2, {
                portionMultiplier: lunchOffer.portionMultiplier,
            }),
        );

        expect(secondSwap.status).toBe(200);
        expect(secondSwap.body.planRevision).toBe(3);

        const breakfast = await mealRow(fixture.breakfastMealId);
        const lunch = await mealRow(fixture.lunchMealId);

        // Both meals moved, each carrying its own revision bump, and the plan's
        // counter advanced exactly twice.
        expect(breakfast.recipe_version_id).toBe(breakfastOffer.recipeVersionId);
        expect(lunch.recipe_version_id).toBe(lunchOffer.recipeVersionId);
        expect([breakfast.revision, lunch.revision]).toEqual([2, 2]);
        expect(await planRevision(fixture.planId)).toBe(3);

        const actions = await ledgerRows(REQUEST_PLAN_USER_ID);

        expect(actions.map((action) => action.action_type)).toEqual(['swap', 'swap']);
        expect(actions.map((action) => action.plan_revision_after)).toEqual([2, 3]);
        expect(actions.map((action) => action.meal_plan_meal_id)).toEqual([
            fixture.breakfastMealId,
            fixture.lunchMealId,
        ]);
    });

    it('lets exactly one commit when both are raced against the same revision', async () => {
        const fixture = await seedRequestWeek();
        const breakfastOffer = await offeredAlternative(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
        );
        const lunchOffer = await offeredAlternative(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.lunchMealId,
        );

        const answers = await Promise.all([
            postSwap(
                REQUEST_PLAN_USER_ID,
                fixture.planId,
                fixture.breakfastMealId,
                requestSwapBody(breakfastOffer.recipeVersionId, 1, {
                    portionMultiplier: breakfastOffer.portionMultiplier,
                }),
            ),
            postSwap(
                REQUEST_PLAN_USER_ID,
                fixture.planId,
                fixture.lunchMealId,
                requestSwapBody(lunchOffer.recipeVersionId, 1, {
                    portionMultiplier: lunchOffer.portionMultiplier,
                }),
            ),
        ]);

        const { accepted, refused } = splitAnswers(answers, 200);

        expect(accepted).toHaveLength(1);
        // The loser is told the revision it must re-pin, which is what makes
        // the client's retry a single round trip rather than a poll.
        expectRefusal(refused[0], 409, { error: 'stale_plan', currentRevision: 2 });

        const breakfast = await mealRow(fixture.breakfastMealId);
        const lunch = await mealRow(fixture.lunchMealId);
        const moved = [breakfast, lunch].filter((meal) => meal.revision === 2);

        // Exactly one slot moved, and the other is untouched — not merely
        // unbumped: its recipe is still the one the week was published with.
        expect(moved).toHaveLength(1);
        expect(await planRevision(fixture.planId)).toBe(2);
        expect(await ledgerRows(REQUEST_PLAN_USER_ID)).toHaveLength(1);
    });
});

/* ---------------------------------------------------------------------------
 * A week no write may reach any more
 *
 * §0.5.1 gives the refusal TWO payloads, and they are not interchangeable: a
 * superseded week names its replacement so a stale screen can follow it, while
 * an ended week — still stored `active`, its last date simply passed — carries
 * `reason: 'ended'` because there is nothing to follow. Both shapes are
 * asserted here for all five write paths, because a single missing branch
 * would leave one client stranded.
 * ------------------------------------------------------------------------- */

describe('a week no write may reach', () => {
    /** The five write paths §0.5.1 names, each against one plan and one meal. */
    const refusedWrites = async (
        plan: { id: string; mealId: string; groceryItemId: string; dayKey: string },
        recipeVersionId: string,
    ): Promise<HttpAnswer[]> => {
        const diaryMealId = await diaryBucketId(REQUEST_PLAN_USER_ID, plan.dayKey);

        return Promise.all([
            postSwap(
                REQUEST_PLAN_USER_ID,
                plan.id,
                plan.mealId,
                requestSwapBody(recipeVersionId, 1),
            ),
            postLog(
                REQUEST_PLAN_USER_ID,
                plan.id,
                plan.mealId,
                requestLogBody(diaryMealId, plan.dayKey, 1),
            ),
            postRegenerate(REQUEST_PLAN_USER_ID, plan.id, requestRegenerateBody(1)),
            putGroceryItem(REQUEST_PLAN_USER_ID, plan.id, plan.groceryItemId, { isChecked: true }),
            postUncheckAll(REQUEST_PLAN_USER_ID, plan.id),
        ]);
    };

    /** A two-day week for one slot, with its shopping list, at a stated start. */
    const seedWeekAt = async (
        startDate: string,
        recipeVersionId: string,
        overrides: Record<string, unknown> = {},
    ) => {
        const plan = await makePlan(REQUEST_PLAN_USER_ID, {
            startDate,
            dayCount: 2,
            slots: [{ slot: 'breakfast', slot_time: '08:00', recipeVersionId }],
            ...overrides,
        });

        await buildGroceries(plan.id, REQUEST_PLAN_USER_ID, new Date());

        const groceryItem = await prisma.grocery_items.findFirstOrThrow({
            where: { meal_plan_id: plan.id, user_id: REQUEST_PLAN_USER_ID },
        });

        return {
            id: plan.id,
            mealId: plan.meal_plan_days[0].meal_plan_meals[0].id,
            groceryItemId: groceryItem.id,
            dayKey: dayKeyOf(plan.meal_plan_days[0].date),
        };
    };

    it('refuses all five writes against an ended week with reason ended', async () => {
        const fixture = await seedRequestWeek();
        const ended = await seedWeekAt(
            FIXTURE_ENDED_PLAN_START_DAY_KEY,
            fixture.pool[0].version.id,
        );
        const entriesBefore = await storedEntries(REQUEST_PLAN_USER_ID);

        for (const answer of await refusedWrites(ended, fixture.pool[4].version.id)) {
            // No replacement id: nothing replaced this week, and inventing one
            // would send the client after a plan that does not exist.
            expectRefusal(answer, 409, { error: 'plan_not_active', reason: 'ended' });
        }

        // Stored `active`, and still refused: the verdict is the date, not the
        // status column (§0.5.1's "ended for every rule").
        const stored = await prisma.meal_plans.findUniqueOrThrow({ where: { id: ended.id } });

        expect(stored.status).toBe(ACTIVE_PLAN);
        expect(stored.revision).toBe(1);
        expect(await storedEntries(REQUEST_PLAN_USER_ID)).toEqual(entriesBefore);
        expect(await ledgerRows(REQUEST_PLAN_USER_ID)).toEqual([]);
        expect(
            await prisma.grocery_items.count({ where: { meal_plan_id: ended.id, is_checked: true } }),
        ).toBe(0);
        // And the user's current week — the one these writes did not name — is
        // exactly as it was.
        expect(await planRevision(fixture.planId)).toBe(1);
    });

    it('refuses all five writes against a superseded week, naming its replacement', async () => {
        const fixture = await seedRequestWeek();
        const successorWeek = addDaysToDayKey(fixture.today, 13);
        const superseded = await seedWeekAt(successorWeek, fixture.pool[0].version.id, {
            status: SUPERSEDED_PLAN,
        });
        const replacement = await makePlan(REQUEST_PLAN_USER_ID, {
            startDate: successorWeek,
            dayCount: 2,
            replaced_plan_id: superseded.id,
            slots: [{ slot: 'breakfast', slot_time: '08:00', recipeVersionId: fixture.pool[1].version.id }],
        });

        for (const answer of await refusedWrites(superseded, fixture.pool[4].version.id)) {
            expectRefusal(answer, 409, {
                error: 'plan_not_active',
                replacementPlanId: replacement.id,
            });
        }

        expect(await planRevision(superseded.id)).toBe(1);
        expect(await planRevision(replacement.id)).toBe(1);
        expect(await ledgerRows(REQUEST_PLAN_USER_ID)).toEqual([]);
        await expectIntactReplacementChains(REQUEST_PLAN_USER_ID);
    });
});

/* ---------------------------------------------------------------------------
 * A replay that arrives after the plan has moved on
 *
 * `runKeyedAction` replays BEFORE every revision and status check, and this is
 * the case that pins that ordering: the key's own body pins a revision two
 * commits old, so a client whose response was lost would be answered
 * `409 stale_plan` forever if the checks ran first — retrying something it had
 * already done.
 * ------------------------------------------------------------------------- */

describe('a replay that arrives after the plan revision has advanced', () => {
    it('returns the stored response rather than refusing the revision it pinned', async () => {
        const fixture = await seedRequestWeek();
        const breakfastOffer = await offeredAlternative(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
        );
        const intent = requestSwapBody(breakfastOffer.recipeVersionId, 1, {
            portionMultiplier: breakfastOffer.portionMultiplier,
        });

        const committed = await postSwap(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
            intent,
        );

        expect(committed.status).toBe(200);

        // A second, unrelated commit moves the plan under the first client.
        const lunchOffer = await offeredAlternative(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.lunchMealId,
        );

        expect(
            (
                await postSwap(
                    REQUEST_PLAN_USER_ID,
                    fixture.planId,
                    fixture.lunchMealId,
                    requestSwapBody(lunchOffer.recipeVersionId, 2, {
                        portionMultiplier: lunchOffer.portionMultiplier,
                    }),
                )
            ).status,
        ).toBe(200);
        expect(await planRevision(fixture.planId)).toBe(3);

        const replayed = await postSwap(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
            intent,
        );

        // The stored answer, verbatim — including the revision it carried when
        // it was first written, which is now two behind the plan.
        expect(replayed.status).toBe(200);
        expect(replayed.body).toEqual(committed.body);
        expect(replayed.body.planRevision).toBe(2);

        // And nothing happened a third time.
        expect(await planRevision(fixture.planId)).toBe(3);
        expect((await mealRow(fixture.breakfastMealId)).revision).toBe(2);
        expect(await ledgerRows(REQUEST_PLAN_USER_ID)).toHaveLength(2);
    });
});

/* ---------------------------------------------------------------------------
 * A commit whose portion the server does not recompute
 *
 * The discriminating pair — targets moved so the portion changes, versus
 * targets moved so it does not — is proved against the service above, where
 * the recomputation is visible. What this adds is the answer the client
 * receives, and the assurance that the refusal cost nothing:
 * `requireBoundPortion` fails closed for ANY value that is not the recomputed
 * portion, and it runs inside `work` after the reservation, so the reservation
 * must roll back with it.
 * ------------------------------------------------------------------------- */

describe('a commit whose portion the server does not recompute', () => {
    it('refuses it as preview_stale and writes nothing at all', async () => {
        const fixture = await seedRequestWeek();
        const offer = await offeredAlternative(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
        );
        const preview = await getPreview(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
            offer.recipeVersionId,
        );

        expect(preview.status).toBe(200);
        expect(preview.body.planRevision).toBe(1);

        const groceriesBefore = await groceryStateOf(fixture.planId, REQUEST_PLAN_USER_ID);
        const unrecomputed = offer.portionMultiplier === 1 ? 1.5 : 1;

        // An admissible multiplier (§0.7.3's set) that is simply not the one
        // the server recomputes for this day — the shape a stale preview takes.
        expectRefusal(
            await postSwap(
                REQUEST_PLAN_USER_ID,
                fixture.planId,
                fixture.breakfastMealId,
                requestSwapBody(offer.recipeVersionId, 1, { portionMultiplier: unrecomputed }),
            ),
            409,
            { error: 'preview_stale' },
        );

        const meal = await mealRow(fixture.breakfastMealId);

        expect(meal.recipe_version_id).toBe(fixture.pool[0].version.id);
        expect(meal.revision).toBe(1);
        expect(meal.previous_recipe_version_id).toBeNull();
        expect(await planRevision(fixture.planId)).toBe(1);
        expect(await groceryStateOf(fixture.planId, REQUEST_PLAN_USER_ID)).toEqual(groceriesBefore);
        expect(await ledgerRows(REQUEST_PLAN_USER_ID)).toEqual([]);
    });
});


/* ---------------------------------------------------------------------------
 * The legacy target writer beside a generation
 *
 * `PUT /api/user/targets` is shipped API surface and stays untouched (§0.1.3),
 * which makes it the one writer that reaches `users.target_*` WITHOUT taking
 * the per-user advisory lock. Generation therefore re-reads those four columns
 * inside its transaction and compares them with
 * `meal_plan_preferences.confirmed_targets`; a mismatch is
 * `409 targets_unconfirmed`, and that check is the only thing standing between
 * a user and a week built on numbers nobody confirmed.
 *
 * Both orderings are driven, and then raced — and the raced case asserts an
 * INVARIANT rather than a winner, because which side lands first is timing.
 * ------------------------------------------------------------------------- */

describe('the legacy target writer beside a generation', () => {
    /** Four numbers that are not the confirmed ones, so a mismatch is visible. */
    const LEGACY_TARGETS = { calories: 2400, protein: 170, carbs: 230, fat: 80 } as const;

    /** `targets_snapshot` as the four wire values a plan stores. */
    const snapshotOf = (plan: { targets_snapshot: unknown }): unknown => plan.targets_snapshot;

    const confirmedTargetsOf = async (userId: string): Promise<unknown> =>
        (
            await prisma.meal_plan_preferences.findUniqueOrThrow({
                where: { user_id: userId },
                select: { confirmed_targets: true },
            })
        ).confirmed_targets;

    it('refuses a generation whose targets the legacy writer has moved', async () => {
        const fixture = await seedRequestWeek();

        const legacy = await putLegacyTargets(REQUEST_PLANNING_USER_ID, LEGACY_TARGETS);

        // The legacy route is untouched, so it answers exactly as it always
        // has: the four columns it just wrote.
        expect(legacy.status).toBe(200);
        expect(legacy.body).toEqual(LEGACY_TARGETS);

        // No id, no numbers: the client is told the targets are unconfirmed and
        // sends the user to review them (§0.5.2).
        expectRefusal(
            await postGenerate(REQUEST_PLANNING_USER_ID, requestGenerateBody(fixture.today)),
            409,
            { error: 'targets_unconfirmed' },
        );

        expect(await plansOf(REQUEST_PLANNING_USER_ID)).toEqual([]);
        expect(await ledgerRows(REQUEST_PLANNING_USER_ID)).toEqual([]);

        // And the canonical read says why, without anything having been
        // cleared: the values are complete, they simply were not confirmed here.
        const read = await getTargets(REQUEST_PLANNING_USER_ID);

        expect(read.status).toBe(200);
        expect(read.body).toMatchObject({ source: 'legacy', complete: true, revision: 1 });
        expect(read.body.targets).toEqual(LEGACY_TARGETS);
    });

    it('keeps the snapshot it committed when the legacy write lands after it', async () => {
        const fixture = await seedRequestWeek();

        expect(
            (await postGenerate(REQUEST_PLANNING_USER_ID, requestGenerateBody(fixture.today))).status,
        ).toBe(201);

        const published = await theOnlyPlanOf(REQUEST_PLANNING_USER_ID);
        const confirmed = await confirmedTargetsOf(REQUEST_PLANNING_USER_ID);

        expect(snapshotOf(published)).toEqual(confirmed);
        expect(snapshotOf(published)).toEqual({ ...FIXTURE_TARGETS });

        expect((await putLegacyTargets(REQUEST_PLANNING_USER_ID, LEGACY_TARGETS)).status).toBe(200);

        // The week is history and stays as it was published: the snapshot is
        // the plan's own record of what it was built from, not a view of the
        // current columns.
        const afterLegacyWrite = await prisma.meal_plans.findUniqueOrThrow({
            where: { id: published.id },
        });

        expect(snapshotOf(afterLegacyWrite)).toEqual(snapshotOf(published));
        expect(afterLegacyWrite.revision).toBe(1);
        expect(await confirmedTargetsOf(REQUEST_PLANNING_USER_ID)).toEqual(confirmed);
        expect((await getTargets(REQUEST_PLANNING_USER_ID)).body).toMatchObject({ source: 'legacy' });
    });

    it('never publishes a week built on unconfirmed numbers when the two are raced', async () => {
        const fixture = await seedRequestWeek();

        const [legacy, generation] = await Promise.all([
            putLegacyTargets(REQUEST_PLANNING_USER_ID, LEGACY_TARGETS),
            postGenerate(REQUEST_PLANNING_USER_ID, requestGenerateBody(fixture.today)),
        ]);

        // The legacy writer takes no lock and pins no revision, so it cannot
        // lose; the only question is which side of it the generation read.
        expect(legacy.status).toBe(200);
        expect([201, 409]).toContain(generation.status);

        const plans = await plansOf(REQUEST_PLANNING_USER_ID);

        if (generation.status === 409) {
            expectRefusal(generation, 409, { error: 'targets_unconfirmed' });
            expect(plans).toEqual([]);
            expect(await ledgerRows(REQUEST_PLANNING_USER_ID)).toEqual([]);

            return;
        }

        // THE INVARIANT, and the reason the locked re-read exists: a week that
        // did publish was built on the values `confirmed_targets` held at its
        // commit — never on the four the legacy writer put there.
        expect(plans).toHaveLength(1);
        expectWholeWeek(plans[0]);
        expect(snapshotOf(plans[0])).toEqual({ ...FIXTURE_TARGETS });
        expect(snapshotOf(plans[0])).not.toEqual(LEGACY_TARGETS);
        expect(await confirmedTargetsOf(REQUEST_PLANNING_USER_ID)).toEqual({ ...FIXTURE_TARGETS });
    });
});

/* ---------------------------------------------------------------------------
 * Two clients saving the same revisioned state, at the boundary
 *
 * A REVISIONED SAVE IS NOT A KEYED WRITE, and the distinction is the point of
 * this describe. `preferences.service.ts` and `targets.service.ts` take
 * `withUserLock` ALONE — no `meal_plan_actions` reservation, no idempotency key
 * in the request — so their conflict signal is the revision comparison and
 * nothing else. Asserting a ledger row for either would be asserting a
 * mechanism they deliberately do not use, so each case asserts the ABSENCE of
 * one instead.
 * ------------------------------------------------------------------------- */

describe('two clients saving the same revisioned state at the boundary', () => {
    it('lets exactly one preference save win and refuses the other as stale', async () => {
        await seedRequestWeek();

        const save = (cookingTimeLimitMin: number): Promise<HttpAnswer> =>
            putPreferences(REQUEST_PLAN_USER_ID, {
                cookingTimeLimitMin,
                timeZone: 'UTC',
                expectedRevision: 1,
            });

        const answers = await Promise.all([save(15), save(45)]);
        const { accepted, refused } = splitAnswers(answers, 200);

        expect(accepted).toHaveLength(1);
        expectRefusal(refused[0], 409, { error: 'stale_revision', currentRevision: 2 });

        const stored = await prisma.meal_plan_preferences.findUniqueOrThrow({
            where: { user_id: REQUEST_PLAN_USER_ID },
            select: { revision: true, cooking_time_limit_min: true },
        });
        const winner = accepted[0].body.preferences as { cookingTimeLimitMin: number };

        // One update landed, and the stored value is the winner's rather than a
        // blend of the two drafts.
        expect(stored.revision).toBe(2);
        expect([15, 45]).toContain(stored.cooking_time_limit_min);
        expect(winner.cookingTimeLimitMin).toBe(stored.cooking_time_limit_min);
        expect(await ledgerRows(REQUEST_PLAN_USER_ID)).toEqual([]);
    });

    it('lets exactly one target save win and refuses the other as stale', async () => {
        await seedRequestWeek();

        const save = (calories: number): Promise<HttpAnswer> =>
            putTargets(REQUEST_PLAN_USER_ID, {
                source: 'manual',
                calories,
                protein: FIXTURE_TARGETS.protein,
                carbs: FIXTURE_TARGETS.carbs,
                fat: FIXTURE_TARGETS.fat,
                expectedTargetsRevision: 1,
            });

        const answers = await Promise.all([save(1900), save(2300)]);
        const { accepted, refused } = splitAnswers(answers, 200);

        expect(accepted).toHaveLength(1);
        // A DIFFERENT code from the preference save's, because the two counters
        // are different: `targets_revision` moves on a target save alone.
        expectRefusal(refused[0], 409, { error: 'stale_targets', currentRevision: 2 });

        const preferences = await prisma.meal_plan_preferences.findUniqueOrThrow({
            where: { user_id: REQUEST_PLAN_USER_ID },
            select: { targets_revision: true, confirmed_targets: true, target_source: true },
        });
        const user = await prisma.users.findUniqueOrThrow({
            where: { id: REQUEST_PLAN_USER_ID },
            select: { target_calories: true },
        });

        expect(preferences.targets_revision).toBe(2);
        expect(preferences.target_source).toBe('manual');
        expect([1900, 2300]).toContain(user.target_calories);
        // The two halves of the write agree, so no client can be shown a
        // confirmed target the `users` row does not hold.
        expect((preferences.confirmed_targets as { calories: number }).calories).toBe(
            user.target_calories,
        );
        expect(await ledgerRows(REQUEST_PLAN_USER_ID)).toEqual([]);
    });
});


/* ---------------------------------------------------------------------------
 * The real publication stage, beside a real generation request
 * ------------------------------------------------------------------------- */

/**
 * WHY THIS BLOCK EXISTS BESIDE THE PROMOTION RACE ABOVE. The earlier race drives
 * the three promotion writes directly, which is enough to prove what a
 * generation must survive; this one drives `scripts/recipes-seed.ts::runSeed` —
 * the stage an operator actually runs, and the entry point §0.9.2 names ("seed
 * and load driven through their exported `run*(deps)` entry points"). What the
 * real stage adds is the transaction boundary IT chooses rather than the one a
 * fixture would: `publishRecipe` decides the promotion, retires the standing
 * version, inserts the successor WITH its ingredient rows and moves
 * `recipes.current_version_id`, all inside one transaction that takes NO
 * advisory lock, because `recipes` and `catalog_foods` are the tenant-less
 * reference tables §0.5.1 describes. A generation running beside it therefore
 * contends with a writer its own lock cannot exclude, and this case is the proof
 * the week still comes out whole.
 *
 * WHERE THE FOOD RETIREMENT IS DRIVEN THROUGH `catalog-load.ts`. In "the
 * catalog release load beside a real generation", earlier in this file: that
 * block writes a real checksummed release holding every published food except
 * the staple and races `runLoad(deps)` against a generation, so the STAGE
 * decides what to withdraw and its verification, its child reconciliation, its
 * run row and the active-release pointer are all asserted. The two rows in the
 * promotion block above additionally flip `publication_status` themselves,
 * because each needs a NAMED food withdrawn at a moment it chooses and a load
 * chooses for itself from the difference between two releases. The loader's own
 * scenarios — the v1 → v2 upgrade, the tampered member, the no-op rerun — stay
 * with `src/__tests__/scripts/catalog-load.test.ts`, which owns them.
 *
 * WHY THE CORPUS IS SYNTHETIC AND TEMPORARY. The committed corpus is 42 recipes
 * against the committed release, and seeding it is `api/seed-rerun.test.ts`'s
 * subject; here one payload in an `os.tmpdir()` directory keeps the case a unit
 * of behaviour and puts the committed corpus and coverage report out of reach.
 * `only: [slug]` narrows the stage to that one file — which also means the stage
 * must write NO coverage report, because a narrowed run's table would replace
 * forty-two recipes' numbers with one's. That is asserted by a `writeReport`
 * that throws if it is ever called.
 *
 * WHY THE DECLARED FIELDS ARE GENERATED. The stage refuses a file whose declared
 * `dietTags`, `allergenTags`, `allergenStatus`, `badges` or `budgetTier` differ
 * from what `recipe.logic.ts::deriveRecipeVersionFields` computes over the
 * resolved ingredients. The payload below declares that derivation's own output
 * over the same rows the stage will resolve, so a fixture cannot fail the
 * declared-versus-derived gate by accident and the only subject left in the case
 * is the race.
 */
describe('the recipe seed stage promoting a version while a week is generated', () => {
    const SEEDED_SLUG = 'concurrency-stage-plate';
    const SEEDED_YIELD = 2;
    const SEEDED_PREP = 5;
    const SEEDED_COOK = 10;

    /**
     * Steps that name no ingredient-vocabulary term.
     *
     * `findUnlistedInstructionTerms` refuses a file whose instructions name a
     * coverage-plan food group, or a published canonical name, that no listed
     * ingredient accounts for — the gate that catches an unlisted oil. None of
     * the 123 groups appears below as a whole token, and the only published
     * canonical names in this fixture are the factory's multi-word
     * `fixture food N`, so the steps clear it without naming the ingredients at
     * all.
     */
    const SEEDED_INSTRUCTIONS: readonly string[] = [
        'Warm a wide pan over a steady flame.',
        'Add both listed amounts and stir until heated through.',
        'Divide between two plates and serve at once.',
    ];

    /**
     * The stage logs structurally; a test has nothing to read it with.
     *
     * Typed through `SeedDeps` rather than by importing the logger's own
     * interface: the only contract this fixture owes is the stage's, and taking
     * it from the stage's own type is one import fewer and one restatement
     * fewer — if `SeedDeps['logger']` grows a method, this fails to compile,
     * which is the point.
     */
    const silentLogger: SeedDeps['logger'] = {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        child: () => silentLogger,
    };

    /**
     * The REAL committed coverage plan, read once.
     *
     * Not synthesized: its 123 food groups are what `runSeed` builds the
     * instruction vocabulary from, so a hand-made plan would leave the
     * unlisted-ingredient gate checking the corpus against a taxonomy this test
     * invented — passing for the wrong reason. Read once because it is a file,
     * and reading it per case is file IO per case.
     */
    const coveragePlan: SeedDeps['coveragePlan'] = loadCoveragePlan();

    /** Directories to remove in `afterAll`, so a failing case still cleans up. */
    const corpusDirectories: string[] = [];

    /** One declared ingredient row, in the payload's wire spelling. */
    interface StageIngredientRow {
        readonly sourceKey: string;
        readonly quantity: number;
        readonly unit: string;
        readonly gramWeight: number;
        readonly displayText: string;
        readonly sortOrder: number;
        readonly isOptional: boolean;
    }

    /**
     * A published, source-backed, allergen-known food whose default portion is
     * stated in GRAMS and whose per-100 g columns are the pool's.
     *
     * The columns matter twice over: the STAGE reads them to build the snapshot
     * it freezes into `recipe_ingredients`, so they decide the seeded recipe's
     * per-serving nutrition, and the values below are {@link POOL_MAIN_PER_100G}
     * and {@link POOL_STAPLE_PER_100G} precisely so the seeded recipe lands on
     * the same 700 kcal / 52 P / 70 C / 23 F per serving as every pool recipe —
     * which is what keeps a week that picks it inside the day tolerance.
     */
    const stageFood = async (
        displayName: string,
        per100g: typeof POOL_MAIN_PER_100G,
    ): Promise<catalog_foods> =>
        makeCatalogFood({
            display_name: displayName,
            food_group: POOL_FOOD_GROUP,
            calories: per100g.calories,
            protein_g: per100g.protein_g,
            carbs_g: per100g.carbs_g,
            fat_g: per100g.fat_g,
            fiber_g: per100g.fiber_g,
            defaultPortion: { description: '100 g', amount: 100, unit: 'g', gram_weight: 100 },
        });

    /** The ingredient the derivation sees, assembled from the row the stage will resolve. */
    const publicationIngredient = (
        food: catalog_foods,
        per100g: typeof POOL_MAIN_PER_100G,
        row: StageIngredientRow,
    ): RecipePublicationIngredient => ({
        catalog_food_id: food.id,
        snapshot_name: food.display_name,
        snapshot_provenance: 'source_backed',
        snapshot_allergen_tags: food.allergen_tags,
        snapshot_diet_tags: food.diet_tags,
        is_optional: row.isOptional,
        food_group: food.food_group,
        allergen_status: 'known',
        cost_class: food.cost_class,
        catalog_nutrition_version: food.nutrition_version,
        catalog_metadata_version: food.metadata_version,
        snapshot_per_100g: { ...per100g },
        quantity: row.quantity,
        unit: row.unit,
        gram_weight: row.gramWeight,
        display_text: row.displayText,
        sort_order: row.sortOrder,
        nutrition_basis: 'per_100g',
        density_g_per_ml: null,
    });

    /** The two foods the seeded recipe is built from, and its declared rows. */
    const stageIngredients = async () => {
        const main = await stageFood('Concurrency Stage Base', POOL_MAIN_PER_100G);
        const staple = await stageFood('Concurrency Stage Staple', POOL_STAPLE_PER_100G);
        const rows: readonly StageIngredientRow[] = [
            {
                sourceKey: main.source_key,
                quantity: POOL_MAIN_GRAMS,
                unit: 'g',
                gramWeight: POOL_MAIN_GRAMS,
                displayText: `${POOL_MAIN_GRAMS} g`,
                sortOrder: 0,
                isOptional: false,
            },
            {
                sourceKey: staple.source_key,
                quantity: POOL_STAPLE_GRAMS,
                unit: 'g',
                gramWeight: POOL_STAPLE_GRAMS,
                displayText: `${POOL_STAPLE_GRAMS} g`,
                sortOrder: 1,
                isOptional: false,
            },
        ];

        return {
            rows,
            derived: deriveRecipeVersionFields(
                [
                    publicationIngredient(main, POOL_MAIN_PER_100G, rows[0]),
                    publicationIngredient(staple, POOL_STAPLE_PER_100G, rows[1]),
                ],
                SEEDED_YIELD,
                SEEDED_PREP,
                SEEDED_COOK,
            ),
        };
    };

    type StageCorpus = Awaited<ReturnType<typeof stageIngredients>>;

    /**
     * The payload, with `description` the only thing a promotion changes.
     *
     * `equivalentContent` compares the stored version's name, description and
     * icon key, so a changed description is the smallest honest content change —
     * the same discriminator `recipes-seed.test.ts` uses for its promotion case.
     */
    const stagePayload = (corpus: StageCorpus, description: string): Record<string, unknown> => ({
        slug: SEEDED_SLUG,
        name: 'Concurrency Stage Plate',
        description,
        iconKey: 'bowl',
        instructions: [...SEEDED_INSTRUCTIONS],
        yieldServings: SEEDED_YIELD,
        servingDescription: '1 plate',
        prepMinutes: SEEDED_PREP,
        cookMinutes: SEEDED_COOK,
        mealSlots: ['breakfast', 'lunch', 'dinner'],
        dietTags: corpus.derived.dietTags,
        allergenTags: corpus.derived.allergenTags,
        allergenStatus: corpus.derived.allergenStatus,
        budgetTier: corpus.derived.budgetTier,
        badges: corpus.derived.badges,
        ingredients: corpus.rows.map((row) => ({ ...row })),
    });

    /** Replaces the corpus with exactly this payload. */
    const writeCorpus = (directory: string, payload: Record<string, unknown>): void => {
        fs.writeFileSync(
            path.join(directory, `${SEEDED_SLUG}.json`),
            `${JSON.stringify(payload, null, 2)}\n`,
            'utf8',
        );
    };

    /**
     * The stage's four seams, and nothing else stubbed.
     *
     * `writeReport` THROWS on purpose: a run narrowed with `only` must not
     * rewrite the whole-corpus coverage report, so the assertion that it did not
     * is that this never fires.
     */
    const stageDeps = (directory: string): SeedDeps => ({
        prisma: prisma as unknown as SeedDeps['prisma'],
        recipesDir: directory,
        now: () => new Date(),
        options: { help: false, only: [SEEDED_SLUG], dryRun: false },
        logger: silentLogger,
        coveragePlan,
        reportPath: path.join(directory, 'coverage-report.json'),
        writeReport: () => {
            throw new Error('a run narrowed to one slug must not rewrite the coverage report');
        },
    });

    afterAll(() => {
        for (const directory of corpusDirectories) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
        corpusDirectories.length = 0;
    });

    it('publishes the successor and the week together, and every version the week holds stays readable', async () => {
        const fixture = await seedRequestWeek();
        const corpus = await stageIngredients();
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrency-stage-'));

        corpusDirectories.push(directory);
        writeCorpus(directory, stagePayload(corpus, 'The standing version of the stage plate.'));

        // The predecessor, published by the stage itself — a promotion can only
        // race a generation if there is something to promote.
        const first = await runSeed(stageDeps(directory));

        expect(first.created).toEqual([SEEDED_SLUG]);
        expect(first.promoted).toEqual([]);
        expect(first.report).toBeNull();

        const standing = await prisma.recipes.findUniqueOrThrow({
            where: { slug: SEEDED_SLUG },
            include: { recipe_versions: true },
        });

        expect(standing.recipe_versions).toHaveLength(1);
        expect(standing.recipe_versions[0].status).toBe(CURRENT_VERSION);

        const predecessorId = standing.recipe_versions[0].id;

        // The content change the second run promotes.
        writeCorpus(directory, stagePayload(corpus, 'The promoted version of the stage plate.'));

        const [generated, promotion] = await Promise.all([
            postGenerate(REQUEST_PLANNING_USER_ID, requestGenerateBody(fixture.today)),
            runSeed(stageDeps(directory)),
        ]);

        // NEITHER SIDE FAILS, in either interleaving. The stage's promotion is
        // one transaction, so the recipe is never without a current version; and
        // the generation inserts against version ids it read before its own
        // transaction opened, which a status flip cannot invalidate — `RESTRICT`
        // bites on a DELETE, and nothing here deletes.
        expect(promotion.promoted).toEqual([SEEDED_SLUG]);
        expect(promotion.created).toEqual([]);
        expect(promotion.report).toBeNull();
        expect(promotion.reportSkippedReason).toContain('narrowed');
        expect(generated.status).toBe(201);

        const published = await theOnlyPlanOf(REQUEST_PLANNING_USER_ID);

        expectWholeWeek(published);
        expect(published.status).toBe(ACTIVE_PLAN);
        expect(published.revision).toBe(1);
        expect(generated.body).toMatchObject({ id: published.id, revision: 1 });

        // The stage did all three of its writes: the successor is current and
        // stamped, the predecessor is retired and stamped, and the recipe points
        // at the successor.
        const afterPromotion = await prisma.recipes.findUniqueOrThrow({
            where: { slug: SEEDED_SLUG },
            include: { recipe_versions: { orderBy: { version: 'asc' } } },
        });
        const [predecessor, successor] = afterPromotion.recipe_versions;

        expect(afterPromotion.recipe_versions).toHaveLength(2);
        expect(predecessor.id).toBe(predecessorId);
        expect(predecessor.status).toBe(RETIRED_VERSION);
        expect(predecessor.retired_at).not.toBeNull();
        expect(successor.status).toBe(CURRENT_VERSION);
        expect(successor.published_at).not.toBeNull();
        expect(successor.description).toBe('The promoted version of the stage plate.');
        expect(afterPromotion.current_version_id).toBe(successor.id);
        // The successor carries its own frozen ingredient rows, written in the
        // same transaction as its status.
        expect(
            await prisma.recipe_ingredients.count({ where: { recipe_version_id: successor.id } }),
        ).toBe(corpus.rows.length);

        // `unique_current_recipe_version` holds for every recipe in the
        // database, at this observation point and at each one below — and the
        // count is read from `recipes` rather than named, so the assertion is
        // "EXACTLY ONE current version per recipe, and none without one"
        // whatever else the fixture has seeded.
        const expectOneCurrentVersionPerRecipe = async (): Promise<void> => {
            const grouped = await prisma.recipe_versions.groupBy({
                by: ['recipe_id'],
                where: { status: CURRENT_VERSION },
                _count: { _all: true },
            });

            expect(grouped.map((row) => row._count._all)).toEqual(grouped.map(() => 1));
            expect(grouped).toHaveLength(await prisma.recipes.count());
        };

        await expectOneCurrentVersionPerRecipe();

        const referenced = [...new Set(mealsOf(published).map((meal) => meal.recipe_version_id))];
        const plannable = [
            ...fixture.pool.map((entry) => entry.version.id),
            predecessorId,
            successor.id,
        ];

        // Nothing invented: every meal points at a version this fixture
        // published, whichever view of the recipe the search read.
        expect(referenced.filter((versionId) => !plannable.includes(versionId))).toEqual([]);

        for (const versionId of referenced) {
            const read = await getRecipeVersionForUser(REQUEST_PLANNING_USER_ID, versionId);

            // Readable whatever its status: if the search read the predecessor
            // before the promotion retired it, the week's own history must still
            // open — the clause a retired version's visibility rests on.
            expect(read?.versionId).toBe(versionId);
        }

        const referencedRows = await prisma.recipe_versions.findMany({
            where: { id: { in: referenced } },
            select: { id: true, recipe_id: true, status: true },
        });

        expect(referencedRows).toHaveLength(referenced.length);
        // ONE version per recipe: the plannable set is read in a single
        // statement, so a week holding both versions of the promoted recipe
        // would have been assembled from two different views of the catalog.
        expect(new Set(referencedRows.map((row) => row.recipe_id)).size).toBe(referencedRows.length);

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
                where: { meal_plan_id: published.id, user_id: REQUEST_PLANNING_USER_ID },
                select: { catalog_food_id: true },
            })
        ).map((row) => row.catalog_food_id);

        // The list is derived from exactly the versions the plan references — no
        // line for a recipe the week does not plan, and none missing, including
        // when one of those versions has since been retired.
        expect([...groceryFoodIds].sort()).toEqual([...ingredientFoodIds].sort());

        const statusById = new Map(
            (
                await prisma.recipe_versions.findMany({ select: { id: true, status: true } })
            ).map((row) => [row.id, row.status]),
        );

        for (const meal of published.meal_plan_days[0].meal_plan_meals) {
            for (const alternative of await listedAlternatives(
                REQUEST_PLANNING_USER_ID,
                published.id,
                meal.id,
            )) {
                // Selection has moved on even where the plan has not: the
                // retired predecessor is gone from the sheet, and the successor
                // is what its recipe is offered as.
                expect(statusById.get(alternative.recipeVersionId)).toBe(CURRENT_VERSION);
            }
        }

        const actions = await ledgerRows(REQUEST_PLANNING_USER_ID);

        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            action_type: 'generate',
            response_status: 201,
            plan_revision_after: 1,
            meal_plan_id: published.id,
        });

        // A third run over the promoted corpus is a no-op, so the race left the
        // stage's own idempotence intact rather than a half-applied promotion it
        // would try to finish.
        const third = await runSeed(stageDeps(directory));

        expect(third.unchanged).toEqual([SEEDED_SLUG]);
        expect(third.created).toEqual([]);
        expect(third.promoted).toEqual([]);
        expect(third.ingredientRows).toBe(0);
        await expectOneCurrentVersionPerRecipe();
    });
});


/* ---------------------------------------------------------------------------
 * What a refusal is allowed to say, and who a write belongs to
 * ------------------------------------------------------------------------- */

/**
 * The two hygiene properties every refusal in this file rests on, asserted once
 * across a spread of them rather than repeated in each case.
 *
 * WHY A CONTENTION SUITE IS WHERE THIS BELONGS. The bodies asserted above are
 * compared strictly, so a case cannot silently accept an extra member — but a
 * strict comparison only catches the shapes a case thought to provoke. A RACE
 * can reach a refusal no case names: the partial unique index on active
 * `(user_id, start_date)` and the `(user_id, idempotency_key)` unique are
 * backstops behind the explicit checks (§0.5.1), and if an interleaving ever
 * got past a check to the index, Prisma's violation would arrive at the
 * controller's fallback. That is the one path in the feature that could put a
 * constraint name, a statement fragment or a stack in front of a client, which
 * Rule backend-architecture §4 forbids — so the sweep asserts every refusal is
 * an EXPLICIT code below 500 whose body says nothing else.
 *
 * AND WHY THE IDENTITY CASE IS HERE. §4's other half is that the caller is the
 * token, never the body. The two parsers treat an extra `userId` differently —
 * the generate parser reads its four fields and ignores the rest, the swap
 * parser names its keys and refuses an unknown one — and both must reach the
 * same place: the write belongs to the authenticated user.
 */
describe('what a refusal is allowed to say', () => {
    /**
     * Substrings no refusal body may contain, lower-cased for the comparison.
     *
     * Each names something only the server should know: an ORM's fingerprint
     * (`prisma`, its `Invalid \`` message prefix), a schema object (`constraint`,
     * the `unique_`/`idx_` index prefixes), a lock or statement fragment
     * (`pg_advisory`, `select `, `insert into`, `on conflict`), or a runtime
     * trace (`stack`, `node_modules`, `at object.`).
     */
    const FORBIDDEN_IN_A_REFUSAL: readonly string[] = [
        'prisma',
        'invalid `',
        'constraint',
        'unique_',
        'idx_',
        'pg_advisory',
        'select ',
        'insert into',
        'on conflict',
        'stack',
        'node_modules',
        'at object.',
    ];

    /** Members no refusal body may carry, whatever their value. */
    const FORBIDDEN_MEMBERS: readonly string[] = ['stack', 'name', 'meta', 'cause', 'clientVersion'];

    interface CollectedRefusal {
        readonly label: string;
        readonly answer: HttpAnswer;
    }

    it('answers every refusal a race can reach with an explicit code and nothing else', async () => {
        const fixture = await seedRequestWeek();
        const offer = await offeredAlternative(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
        );
        const { second: losingAlternative } = await twoOfferedAlternatives(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
        );
        const sharedKey = randomUUID();
        const collected: CollectedRefusal[] = [];
        const collect = async (label: string, send: () => Promise<HttpAnswer>): Promise<void> => {
            collected.push({ label, answer: await send() });
        };

        // Five refusals that write nothing, then one accepted swap, then the
        // refusal that needs its reservation — so the order is the only thing
        // the sequence assumes.
        await collect('plan_overlap', () =>
            postGenerate(REQUEST_PLAN_USER_ID, requestGenerateBody(fixture.today)),
        );
        await collect('invalid_request', () =>
            postSwap(
                REQUEST_PLAN_USER_ID,
                fixture.planId,
                fixture.breakfastMealId,
                requestSwapBody(offer.recipeVersionId, 1, { userId: REQUEST_PLANNING_USER_ID }),
            ),
        );
        await collect('a plan that is nobody’s', () =>
            postSwap(
                REQUEST_PLAN_USER_ID,
                randomUUID(),
                fixture.breakfastMealId,
                requestSwapBody(offer.recipeVersionId, 1),
            ),
        );
        await collect('stale_revision', () =>
            postGenerate(
                REQUEST_PLANNING_USER_ID,
                requestGenerateBody(fixture.today, { expectedPreferencesRevision: 2 }),
            ),
        );
        await collect('stale_plan', () =>
            postSwap(
                REQUEST_PLAN_USER_ID,
                fixture.planId,
                fixture.breakfastMealId,
                requestSwapBody(offer.recipeVersionId, 2),
            ),
        );

        const committed = await postSwap(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
            requestSwapBody(offer.recipeVersionId, 1, {
                portionMultiplier: offer.portionMultiplier,
                idempotencyKey: sharedKey,
            }),
        );

        expect(committed.status).toBe(200);

        await collect('idempotency_conflict', () =>
            postSwap(
                REQUEST_PLAN_USER_ID,
                fixture.planId,
                fixture.breakfastMealId,
                requestSwapBody(losingAlternative, 1, { idempotencyKey: sharedKey }),
            ),
        );

        // The codes, in the order provoked: every refusal is the check's own
        // answer and not a constraint's.
        expect(collected.map(({ answer }) => answer.body.error)).toEqual([
            'plan_overlap',
            'invalid_request',
            'Plan not found',
            'stale_revision',
            'stale_plan',
            'idempotency_conflict',
        ]);

        for (const { label, answer } of collected) {
            const serialised = JSON.stringify(answer.body).toLowerCase();
            const failure = `the ${label} refusal`;

            // 4xx only. A 403 is never right here — an unowned resource is a
            // 404 (Rule §1.5) — and a 5xx would mean a check was missed and the
            // fallback answered instead.
            expect({ [failure]: answer.status >= 400 && answer.status < 500 }).toEqual({
                [failure]: true,
            });
            expect({ [failure]: answer.status }).not.toEqual({ [failure]: 403 });
            expect({ [failure]: typeof answer.body.error }).toEqual({ [failure]: 'string' });

            for (const needle of FORBIDDEN_IN_A_REFUSAL) {
                expect({ [`${failure} names "${needle}"`]: serialised.includes(needle) }).toEqual({
                    [`${failure} names "${needle}"`]: false,
                });
            }
            for (const member of FORBIDDEN_MEMBERS) {
                expect({ [`${failure} carries "${member}"`]: member in answer.body }).toEqual({
                    [`${failure} carries "${member}"`]: false,
                });
            }
        }

        // And the sweep really did refuse rather than write: one swap, one
        // ledger row, one plan each, and nothing at all for the identity whose
        // generation was refused as stale.
        expect((await mealRow(fixture.breakfastMealId)).revision).toBe(2);
        expect(await planRevision(fixture.planId)).toBe(2);
        expect((await ledgerRows(REQUEST_PLAN_USER_ID)).map((row) => row.idempotency_key)).toEqual([
            sharedKey,
        ]);
        expect(await prisma.meal_plans.count({ where: { user_id: REQUEST_PLAN_USER_ID } })).toBe(1);
        expect(await prisma.meal_plans.count({ where: { user_id: REQUEST_PLANNING_USER_ID } })).toBe(0);
        expect(await ledgerRows(REQUEST_PLANNING_USER_ID)).toEqual([]);
    });

    it('decides who a write belongs to from the token and never from the body', async () => {
        const fixture = await seedRequestWeek();

        // The generate parser reads its four fields and ignores every other
        // key, so an extra `userId` is not even a syntax error here — which is
        // what makes this the honest test of the boundary rather than of the
        // parser: the published week must belong to the AUTHENTICATED identity.
        const generated = await postGenerate(
            REQUEST_PLANNING_USER_ID,
            requestGenerateBody(fixture.today, { userId: REQUEST_PLAN_USER_ID }),
        );

        expect(generated.status).toBe(201);

        const published = await theOnlyPlanOf(REQUEST_PLANNING_USER_ID);

        expect(generated.body).toMatchObject({ id: published.id });
        expectWholeWeek(published);
        // The identity the body named gained nothing: it still holds exactly the
        // week the fixture gave it.
        expect(
            (
                await prisma.meal_plans.findMany({
                    where: { user_id: REQUEST_PLAN_USER_ID },
                    select: { id: true },
                })
            ).map((plan) => plan.id),
        ).toEqual([fixture.planId]);
        expect(await ledgerRows(REQUEST_PLAN_USER_ID)).toEqual([]);
        expect((await ledgerRows(REQUEST_PLANNING_USER_ID)).map((row) => row.user_id)).toEqual([
            REQUEST_PLANNING_USER_ID,
        ]);

        const offer = await offeredAlternative(
            REQUEST_PLAN_USER_ID,
            fixture.planId,
            fixture.breakfastMealId,
        );

        // Where a parser DOES name its keys, the same body key is refused
        // outright — one field code, no hint that the value was an id at all.
        expectRefusal(
            await postSwap(
                REQUEST_PLAN_USER_ID,
                fixture.planId,
                fixture.breakfastMealId,
                requestSwapBody(offer.recipeVersionId, 1, {
                    portionMultiplier: offer.portionMultiplier,
                    userId: REQUEST_PLANNING_USER_ID,
                }),
            ),
            400,
            { error: 'invalid_request', details: [{ field: 'userId', code: 'unknown_field' }] },
        );
        expect((await mealRow(fixture.breakfastMealId)).revision).toBe(1);
        expect(await ledgerRows(REQUEST_PLAN_USER_ID)).toEqual([]);
    });
});

