// The targets area's database-backed suite: the planned home for every proof
// about the canonical target path — `GET /meal-planning/targets`,
// `PUT /meal-planning/targets` and the publication gate the planner reads
// through — that needs a real PostgreSQL to make. AAP §0.9.2's "Targets truth"
// row names this file for exactly these properties, and §0.3.3 lists it in the
// suite inventory. The pure halves of the same subject — the estimate equation,
// the factors, the clamps and the `deriveTargetsResponse` comparison — are
// unit-tested with no database in `src/services/__tests__/targets.logic.test.ts`.
//
// It is the enforcing proof for the properties of the canonical target path
// that only a real PostgreSQL can establish.
//
// WHAT IS BEING PROVEN, AND WHY A UNIT TEST CANNOT DO IT.
//
// 1. STALENESS IS ANCESTRY AGAINST THE PREFERENCES REVISION.
//    `targets.logic.test.ts` pins the pure half — the comparison
//    `deriveTargetsResponse` makes — but the user-visible claim is a property of
//    that comparison TOGETHER with the writers that advance the counter. Only a
//    real save can show that `PUT /meal-planning/preferences/steps/:step` and
//    `PUT /meal-planning/preferences` bump the all-purpose `revision`, so a
//    confirmed estimate whose `targets_input_revision` was recorded at an
//    earlier revision reads stale after ANY preference save — a diet or schedule
//    edit as much as an activity one (AAP 0.5.2) — and reads fresh again only
//    once the user reconfirms at the current revision. A manual target is never
//    stale, whatever the revision does.
//
// 2. A PERSISTED MANUAL ROUTE REFUSES AN ESTIMATE. Skip writes
//    `target_route = 'manual'` while deliberately RETAINING the measurements it
//    was answered over, so the refusal cannot be demonstrated from the
//    measurement columns: it needs the real step writer to produce a row that
//    is complete and manual at the same time, and then both estimate paths to
//    refuse it and persist nothing.
//
// 3. THE PINNED TARGETS REVISION TRAVELS IN THE WRITE. An application-level
//    check cannot be distinguished from a database predicate in TypeScript —
//    both refuse the same request in isolation. The difference only appears in
//    an interleaving, so the proof holds the row in a second session with
//    `SELECT … FOR UPDATE`, lets the save block at its own UPDATE, bumps
//    `targets_revision` from the holder, and requires the save to be refused.
//
// 4. THE CANONICAL TARGET READ IS COHERENT, AND THE PUBLICATION GATE HOLDS ITS
//    ROW. The hazard is a race between two sessions, so it does not exist in
//    TypeScript at all: it is the difference between one statement and two under
//    READ COMMITTED, and between a row lock held to COMMIT and no lock. The
//    untouched legacy writer `PUT /api/user/targets` takes no meal-planning
//    advisory lock by design, so nothing but the row lock stands between it and
//    a week published against values it has already replaced.
//
// Every property is asserted in both directions, which is what makes the
// assertions load-bearing rather than decorative:
//   * a save must make a confirmed estimate stale, and a reconfirmation must
//     make it fresh again — otherwise "stale" could pass by being constant;
//   * the manual route must refuse the estimate, and re-answering the body step
//     must restore it, so the refusal is a route decision and not a dead end;
//   * the revision predicate must refuse the save when the holder bumps the
//     revision, and must NOT refuse it when the holder merely locks and
//     releases the row — without the second case the first would also pass for
//     a save that refuses whenever it ever had to wait;
//   * the read must issue exactly ONE statement — and that statement must
//     mention both tables, so the count cannot pass by reading one of them;
//   * the locked gate must BLOCK a concurrent legacy write until COMMIT, and
//     the unlocked read must NOT block it. Without the second assertion the
//     first could pass because of something incidental to the transaction.
//
// HOW AN ORDERING IS ESTABLISHED HERE. Every interleaving below is driven from a
// signal and never from elapsed time, because a wall-clock window proves nothing
// on a loaded host: it can close before the other session has started, and "it
// has not answered yet" is as true of slow work as of blocked work. So a
// BLOCKED claim waits until PostgreSQL itself reports the contending session as
// waiting for a lock (`pg_locks.granted = false`) and only then asserts that the
// contender has not settled; a NOT-BLOCKED claim awaits the contender to
// COMPLETION while the transaction that must not block it is still open; and
// entry into a transaction is signalled by the code that is inside it rather
// than inferred from a delay. The deadlines that remain are hang guards — they
// turn a synchronisation mistake into a named failure instead of a silent pass
// or a suite timeout — and no assertion rests on one.
//
// Everything here runs against the ambient test database and truncates only the
// feature tables through the shared guard, exactly as the other suites in this
// directory do. The three extra Prisma clients are a genuine requirement rather
// than a convenience: a lock test needs a session that is not the one holding
// the lock, a statement count needs a client whose query events are observable,
// and reading `pg_locks` needs a session that is neither party to the
// contention it is reporting on.
//
// ---------------------------------------------------------------------------
// THE SECOND HALF: THE HTTP BOUNDARY (from "the three target routes over HTTP"
// onwards)
// ---------------------------------------------------------------------------
//
// The four properties above are session-level: each one is the difference
// between one statement and two, or between a row lock held to COMMIT and none,
// so each is driven through the service entry point where the lock and the
// statement actually live. None of them can be observed from outside a request
// at all.
//
// Everything a REQUEST can be wrong about is a different set of properties, and
// they are proven in the second half of this file by driving the shipped app
// through `request` from `../setup/testApp` — the real `src/app.ts`, with its
// real mount order and its real auth boundary, never a hand-assembled router.
// What only the boundary can establish:
//
// 5. THE THREE TARGET ROUTES ARE THE ROUTER'S ONLY UNGATED MEMBERS.
//    `mealPlanning.controller.ts` calls `assertMealPlanningEnabled()` in
//    fifteen handlers and deliberately not in these three (AAP §0.5.2, §0.7.5),
//    and `mealPlanning.routes.ts` registers all eighteen on one router. A unit
//    test of `isMealPlanningEnabled` proves what the flag reads, never which
//    handlers consult it; only a request against a module graph built with the
//    flag off can show that Account's read and write still answer while
//    `GET /meal-planning/preferences` on the SAME router answers 503. The
//    contrast is the assertion: either half alone would pass for a gate applied
//    to everything or to nothing.
//
// 6. THE CANONICAL WRITE AGREES WITH THE DIARY'S OWN READ. `saveTargets` writes
//    `users.target_*` through the untouched `nutrition.service.ts::updateTargets`,
//    and `GET /api/macros/:date` reads those same four columns through the
//    untouched `getTargetsForUser`. Asserting the two responses against each
//    other after ONE save is what shows the canonical writer wrote the SHARED
//    columns rather than a parallel store of its own — the prompt's "the
//    planner and diary must display the same confirmed values", and AAP §0.9.3's
//    named evidence. Neither service can make that claim about the other.
//
// 7. THE REQUEST CARRIES NO IDENTITY AND NO INPUTS. `getUserId(req)` reads the
//    verified token, the estimate is recomputed from stored preferences, and
//    both arms of the save envelope are closed sets. So a `userId` in the body,
//    a calorie figure on the estimated arm and an input in the query string are
//    all things the boundary must refuse or ignore, and there is no layer below
//    it where "the body could not express an identity" is even a statement.
//
// 8. THE STATUS, CODE AND PAYLOAD OF EVERY REFUSAL. `mealPlanning.errors.ts` is
//    deliberately status-free (Rule `backend-architecture` §8) and the parsers
//    return verdicts rather than throwing, so the mapping from a refusal to
//    `409 stale_targets {currentRevision}`, `422 targets_missing {missing}` or
//    `400 invalid_request {details}` exists only in the controller. A service
//    test that asserts an error CLASS pins the opposite of what the client
//    depends on.
//
// The second half is asserted in both directions for the same reason the first
// is: the ungated routes answer normally AND the gated sibling refuses; a
// pinned revision is refused when it is wrong AND accepted when it is right; a
// bound rejects 0 and 1001 AND accepts 1 and 1000; an infeasible save WARNS and
// still stores, while a coherent one warns about nothing.
//
// The two halves share this file because they are one subject, and a helper
// that crossed between suites would have to live somewhere this directory does
// not allow (Rule §7.1). They share the outer `beforeEach` too: it truncates
// and seeds ONE confirmed-estimate user, and every HTTP case below creates the
// identities it needs for itself, so the seeded user is never the subject of a
// request and no case inherits another's state.

import { randomUUID } from 'node:crypto';

import supertest from 'supertest';

import { PrismaClient } from '../../generated/prisma';
import type { meal_plan_preferences } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import {
    FIXTURE_TARGETS,
    FIXTURE_USER_TARGET_COLUMNS,
    FixtureMacros,
    addDaysToDayKey,
    makeCatalogFood,
    makePreferences,
    makeRecipeVersion,
    makeUser,
    utcTodayDayKey,
} from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';
import { generatePlan, regeneratePlan } from '../../services/mealPlan.service';
import { PlanGenerationError, TargetsUnconfirmedError } from '../../services/mealPlanning.errors';
import { withMealPlanningTransaction, withUserLock } from '../../services/mealPlanningAction.service';
import { updateTargets } from '../../services/nutrition.service';
import { savePreferences, saveSetupStep } from '../../services/preferences.service';
import { PlanningPreferences, evaluatePlanningEligibility } from '../../services/recipe.logic';
import * as groceryService from '../../services/grocery.service';
// The namespace beside the named import, and not instead of it: the legacy-writer
// cases above call `updateTargets` directly, while the atomicity proofs below
// have to reach the module's own exported binding — the property
// `targets.service.ts` resolves at call time — to fail the save between its two
// halves. Removing either import would cost one of those two things.
import * as nutritionService from '../../services/nutrition.service';
import * as recipeService from '../../services/recipe.service';
import { UnitConversionError, unitFamily } from '../../utils/units';
import type { DailyMacrosResponse, MacroTargetsResponse } from '../../types/nutrition';
import type {
    InvalidRequestDetail,
    SaveTargetsResponse,
    TargetEstimateResponse,
    TargetsResponse,
} from '../../types/mealPlanning';
import {
    getTargetEstimate,
    getTargets,
    previewConfirmedTargets,
    requireConfirmedTargets,
    saveTargets,
} from '../../services/targets.service';

const USER_ID = 'targets-service-suite-user';
const TIME_ZONE = 'America/New_York';

/** A second session, so a lock can be observed from outside the one holding it. */
const legacyWriterClient = new PrismaClient();

/**
 * A third session whose queries are observable, for counting the statements one
 * read issues. Query logging is per client, so this cannot be done on the
 * singleton without changing what every other suite's client does.
 */
const observedClient = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });

/**
 * A fourth session, which is never a party to the contention it reports on.
 *
 * Neither side of a lock can report the lock: the blocked session is stuck
 * inside its own statement, and a statement issued from the holder would join
 * the contention it was meant to describe. So the `pg_locks` observation below
 * runs on a session that holds nothing and waits for nothing. `observedClient`
 * cannot double as it either — its query log is what the single-statement read
 * is counted from, and a poll would fill that log with statements the read never
 * issued.
 */
const lockObserverClient = new PrismaClient();

/** Statements the pool issues around the ones under test, and never the read itself. */
const isFrameworkStatement = (sql: string): boolean =>
    /^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE|SET|SELECT 1|-- Implicit)/i.test(sql);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The longest any wait below is given before the suite fails with a message
 * naming what it was waiting for.
 *
 * A HANG GUARD and never evidence. Every wait it bounds is one PostgreSQL
 * satisfies within milliseconds when the code under test behaves — a lock wait
 * appears as soon as the contending statement is parked, and an unblocked write
 * of one indexed row returns immediately — so reaching this deadline means the
 * ordering never happened, which is a failure to report rather than a timing
 * margin to tune. Generous on purpose: the number is never compared against
 * anything, and a tighter one would only trade a real failure for a flake on a
 * loaded host. It sits inside {@link LOCK_CASE_TIMEOUT_MS}, so the guard's own
 * message is what a stuck ordering is reported as; where the stuck party is a
 * transaction the CODE opened (a publication runs on Prisma's 5 s default), that
 * transaction aborts first and the guard then reports the wait that never
 * arrived, with the holder released by its `finally` either way.
 */
const LOCK_WAIT_HANG_GUARD_MS = 15_000;

/** How often `pg_locks` is consulted while a wait is expected to appear. */
const LOCK_WAIT_POLL_INTERVAL_MS = 25;

/**
 * The `locktype` a session waits under while it queues for a row another
 * transaction has locked: PostgreSQL parks the waiter on the holder's
 * transaction id, behind a short-lived `tuple` lock when more than one writer is
 * queued for the same row. Both spellings mean "waiting for that row".
 */
const ROW_LOCK_WAIT: readonly string[] = ['transactionid', 'tuple'];

/**
 * The per-case timeout for the cases below that synchronise two sessions.
 *
 * Jest's default is 5 s, which is SHORTER than {@link LOCK_WAIT_HANG_GUARD_MS} —
 * so a synchronisation mistake would be reported as Jest's own generic
 * "Exceeded timeout of 5000 ms" instead of as the named wait that never
 * happened, and it would then CASCADE: the timeout does not abort the
 * transaction the case is still holding, so the truncating `beforeEach` of the
 * next case and the suite's `afterAll` both queue behind the abandoned lock and
 * time out in turn, burying the one real failure. Sitting comfortably above the
 * hang guard puts the guard first, which lets its `finally` release every holder
 * and leaves the run with exactly one readable failure.
 */
const LOCK_CASE_TIMEOUT_MS = 30_000;

/**
 * Every session in THIS database that is waiting for a lock right now, by the
 * kind of lock it waits for.
 *
 * `granted = false` is PostgreSQL's own statement that a session is blocked, and
 * it is the only thing that turns "the promise has not settled" into evidence:
 * unfinished work is otherwise indistinguishable from slow work. The
 * `current_database()` predicate is load-bearing rather than tidy — this server
 * is shared by every checkout of this repository, and without it a neighbouring
 * database's contention would be read as this suite's.
 */
const observedLockWaits = async (): Promise<string[]> => {
    const waiting = await lockObserverClient.$queryRaw<{ locktype: string }[]>`
        SELECT l.locktype
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted
          AND a.datname = current_database()
    `;

    return waiting.map((row) => row.locktype);
};

/**
 * Blocks until PostgreSQL reports a session in this database waiting for one of
 * `expected`, and answers with the kind of wait it found.
 *
 * This is what a BLOCKING claim is asserted against. `what` describes the wait
 * in the language of the test, so a failure says which ordering never happened
 * and which ungranted locks were seen instead, rather than leaving a timed-out
 * suite to be re-run under a debugger.
 */
const awaitLockWait = async (expected: readonly string[], what: string): Promise<string> => {
    const deadline = Date.now() + LOCK_WAIT_HANG_GUARD_MS;
    const seen = new Set<string>();

    for (;;) {
        const waits = await observedLockWaits();

        waits.forEach((locktype) => seen.add(locktype));

        const found = waits.find((locktype) => expected.includes(locktype));

        if (found !== undefined) {
            return found;
        }

        if (Date.now() >= deadline) {
            throw new Error(
                `no ${expected.join('/')} lock wait appeared within ${LOCK_WAIT_HANG_GUARD_MS} ms: ${what}. ` +
                    `Ungranted locks seen while waiting: ${
                        seen.size > 0 ? [...seen].sort().join(', ') : 'none'
                    }.`,
            );
        }

        await sleep(LOCK_WAIT_POLL_INTERVAL_MS);
    }
};

/**
 * Awaits `work`, failing with a message built from `what` if it never settles.
 *
 * Used wherever a promise must be awaited to completion for the proof to mean
 * anything — the unblocked counterexamples, and every contending write after its
 * holder releases. Without the guard a synchronisation mistake would present as
 * a bare suite timeout naming no ordering at all.
 */
const withHangGuard = async <T>(work: Promise<T>, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${what} did not finish within ${LOCK_WAIT_HANG_GUARD_MS} ms`)),
                    LOCK_WAIT_HANG_GUARD_MS,
                );
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
};

/**
 * Runs `work` to completion while polling `pg_locks`, and reports every kind of
 * wait that appeared while it ran.
 *
 * This is the shape a NOT-BLOCKED claim needs. Timing such a claim measures the
 * host: "it finished inside half a second" is a statement about load, and the
 * same assertion passes for a write that was never started. Finishing AT ALL
 * while the transaction that must not block it is still open is the property
 * itself, and an empty wait list is the same absence seen from the database's
 * side.
 */
const runWatchingForLockWaits = async (work: Promise<unknown>, what: string): Promise<string[]> => {
    const observed = new Set<string>();
    let polling = true;
    const watcher = (async () => {
        while (polling) {
            (await observedLockWaits()).forEach((locktype) => observed.add(locktype));
            await sleep(LOCK_WAIT_POLL_INTERVAL_MS);
        }
    })();

    try {
        await withHangGuard(work, what);

        return [...observed].sort();
    } finally {
        polling = false;
        await watcher;
    }
};

/** The confirmed-estimate starting state: four stored targets that match the snapshot. */
const seedConfirmedEstimate = async (): Promise<void> => {
    await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(USER_ID);
};

/** `saveSetupStep`, with the refusal verdicts turned into failures. */
const saveStep = async (step: string, body: Record<string, unknown>): Promise<void> => {
    const result = await saveSetupStep(USER_ID, step, body);

    if (result.kind !== 'ok') {
        throw new Error(`step ${step} was refused: ${JSON.stringify(result)}`);
    }
};

/**
 * `savePreferences`, likewise.
 *
 * Every body passed here carries `timeZone`: it is a REQUIRED field of the
 * full-save envelope, because the server resolves the user's "today" from the
 * zone the request carried rather than from the stored one.
 */
const saveFull = async (body: Record<string, unknown>): Promise<void> => {
    const result = await savePreferences(USER_ID, body);

    if (result.kind !== 'ok') {
        throw new Error(`full save was refused: ${JSON.stringify(result)}`);
    }
};

const storedRevisions = async (): Promise<{ revision: number; targetsInput: number | null }> => {
    const row = await prisma.meal_plan_preferences.findUniqueOrThrow({
        where: { user_id: USER_ID },
        select: { revision: true, targets_input_revision: true },
    });

    return {
        revision: row.revision,
        targetsInput: row.targets_input_revision,
    };
};

beforeEach(async () => {
    await truncateFeatureTables();
    await seedConfirmedEstimate();
});

afterAll(async () => {
    await truncateFeatureTables();
    await legacyWriterClient.$disconnect();
    await observedClient.$disconnect();
    await lockObserverClient.$disconnect();
});

/* ---------------------------------------------------------------------------
 * Staleness is an ancestry check on the preferences revision
 *
 * AAP §0.5.2: a confirmed estimate is stale when `targets_input_revision`
 * differs from `preferences.revision`. Every preference save advances that
 * revision, so the claim under test is that a confirmed figure is reported as
 * behind the answers on file the moment those answers are saved again — and
 * that only a reconfirmation brings it back, never a silent recalculation.
 * ------------------------------------------------------------------------- */

describe('a confirmed estimate across real preference saves', () => {
    it('starts complete, attributed and fresh', async () => {
        expect(await getTargets(USER_ID)).toEqual({
            targets: { ...FIXTURE_TARGETS },
            complete: true,
            source: 'estimated',
            stale: false,
            revision: 1,
        });

        // Fresh BECAUSE the two revisions agree, which is the rule rather than
        // an accident of the fixture.
        expect(await storedRevisions()).toMatchObject({ revision: 1, targetsInput: 1 });
    });

    it('goes stale on a diet edit, because that save advances the revision it was confirmed at', async () => {
        await saveStep('diet', {
            diet: 'vegan',
            allergens: ['milk'],
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        const revisions = await storedRevisions();

        // The client's own counter advanced — a concurrent save must still be
        // detected — and the confirmed figure was derived from revision 1, so
        // it no longer describes the answers on file.
        expect(revisions.revision).toBe(2);
        expect(revisions.targetsInput).toBe(1);
        expect(await getTargets(USER_ID)).toMatchObject({ source: 'estimated', stale: true, revision: 1 });
    });

    it('goes stale through schedule, cooking, dislike and time-zone edits', async () => {
        await saveStep('schedule', {
            mealSchedule: 'three_plus_snack',
            mealTimes: [
                { slot: 'breakfast', time: '08:00' },
                { slot: 'lunch', time: '12:30' },
                { slot: 'dinner', time: '18:30' },
                { slot: 'snack', time: '15:30' },
            ],
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });
        await saveStep('cooking', {
            cookingTimeLimitMin: 15,
            budget: null,
            noBudgetPreference: true,
            timeZone: TIME_ZONE,
            expectedRevision: 2,
        });
        await saveStep('dislikes', { dislikedFoodIds: [], timeZone: TIME_ZONE, expectedRevision: 3 });
        await saveFull({ timeZone: 'Europe/London', allergens: ['eggs'], expectedRevision: 4 });

        const revisions = await storedRevisions();

        expect(revisions.revision).toBe(5);
        expect(revisions.targetsInput).toBe(1);
        expect(await getTargets(USER_ID)).toMatchObject({ stale: true });
    });

    it('goes stale when the body step is re-saved with the same measurements, which is still a save', async () => {
        await saveStep('body', {
            age: 34,
            heightCm: 178,
            weightKg: 79,
            sexForEstimate: 'male',
            heightUnitPref: 'ft_in',
            weightUnitPref: 'lb',
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        const revisions = await storedRevisions();

        // Nothing the equation reads moved, and the revision advanced all the
        // same, so the ancestry no longer holds.
        expect(revisions.revision).toBe(2);
        expect(revisions.targetsInput).toBe(1);
        expect(await getTargets(USER_ID)).toMatchObject({ stale: true });
    });

    it('goes stale on an activity change, and keeps the confirmed numbers', async () => {
        await saveStep('activity', { activityLevel: 'active', timeZone: TIME_ZONE, expectedRevision: 1 });

        const revisions = await storedRevisions();

        expect(revisions.revision).toBe(2);
        expect(revisions.targetsInput).toBe(1);
        expect(await getTargets(USER_ID)).toEqual({
            // Nothing is recomputed or rewritten: the review screen offers a
            // recalculation, and generation keeps using these values until the
            // user takes it.
            targets: { ...FIXTURE_TARGETS },
            complete: true,
            source: 'estimated',
            stale: true,
            revision: 1,
        });
    });

    it('goes stale on a body change made through the full save', async () => {
        await saveFull({ weightKg: 82, timeZone: TIME_ZONE, expectedRevision: 1 });

        expect(await getTargets(USER_ID)).toMatchObject({ stale: true });
    });

    it('is still planned from while stale: the gate admits it', async () => {
        await saveStep('activity', { activityLevel: 'active', timeZone: TIME_ZONE, expectedRevision: 1 });

        await expect(previewConfirmedTargets(USER_ID)).resolves.toEqual({
            targets: { ...FIXTURE_TARGETS },
            targetsRevision: 1,
        });
    });

    it('is fresh again once the user reconfirms, and behind again on the next save', async () => {
        await saveStep('activity', { activityLevel: 'active', timeZone: TIME_ZONE, expectedRevision: 1 });
        expect(await getTargets(USER_ID)).toMatchObject({ stale: true });

        // The recalculation the review screen offers, taken: the server
        // recomputes from the stored answers and records the revision it
        // computed them at.
        const estimate = await getTargetEstimate(USER_ID);
        const saved = await saveTargets(USER_ID, {
            source: 'estimated',
            estimateRevision: estimate.estimateRevision,
            expectedTargetsRevision: 1,
        });

        expect(saved.kind).toBe('ok');
        expect(estimate.estimateRevision).toBe(2);
        expect(await getTargets(USER_ID)).toEqual({
            targets: {
                calories: estimate.calories,
                protein: estimate.protein,
                carbs: estimate.carbs,
                fat: estimate.fat,
            },
            complete: true,
            source: 'estimated',
            stale: false,
            revision: 2,
        });
        expect(await storedRevisions()).toMatchObject({ revision: 2, targetsInput: 2 });

        // And the next unrelated save puts it behind again, which is what makes
        // the flag a live statement about the row rather than a one-off.
        await saveStep('diet', { diet: 'vegan', allergens: ['none'], timeZone: TIME_ZONE, expectedRevision: 2 });

        expect(await getTargets(USER_ID)).toMatchObject({ stale: true, revision: 2 });
    });

    it('never reports manual targets as stale, however many saves follow', async () => {
        const saved = await saveTargets(USER_ID, {
            source: 'manual',
            calories: 1800,
            protein: 140,
            carbs: 180,
            fat: 60,
            expectedTargetsRevision: 1,
        });

        expect(saved.kind).toBe('ok');

        await saveStep('activity', { activityLevel: 'active', timeZone: TIME_ZONE, expectedRevision: 1 });
        await saveFull({ weightKg: 82, timeZone: TIME_ZONE, expectedRevision: 2 });

        // The user typed these numbers, so a change of inputs says nothing
        // about them — and no ancestry was recorded to compare against.
        expect(await storedRevisions()).toMatchObject({ revision: 3, targetsInput: null });
        expect(await getTargets(USER_ID)).toEqual({
            targets: { calories: 1800, protein: 140, carbs: 180, fat: 60 },
            complete: true,
            source: 'manual',
            stale: false,
            revision: 2,
        });
    });
});

/* ---------------------------------------------------------------------------
 * The stored estimate a confirmation leaves behind
 *
 * AAP §0.5.1 defines `meal_plan_preferences.estimated_targets` as the "last
 * estimate with input revision": the estimate the server last computed for this
 * user and the user confirmed, together with the preferences revision its
 * inputs came from. `targets.logic.test.ts` pins the SHAPE of that record
 * without a database; what only a real save can establish is that the record
 * reaches the column at all, that it lands in the same transaction as the four
 * confirmed values, and what each route does to it.
 *
 * Four properties, each asserted in both directions so none of them can pass by
 * being constant:
 *
 *  1. The column is NULL before any confirmation and holds the estimate after
 *     one — so the assertions are about this write rather than about a fixture.
 *  2. The record explains the figure that was confirmed: its four values are
 *     the four the canonical read reports, and its derivation is the one the
 *     estimate GET returned.
 *  3. It is the LAST estimate: a second confirmation, after an answer changed,
 *     replaces it and records the revision that one was derived from.
 *  4. A manual save RETAINS it rather than clearing it (§0.5.1 defines the
 *     column as the last estimate computed for the user, not as the estimate
 *     behind the current targets), while a user whose first confirmation is
 *     manual stores NULL — no estimate was ever computed for them.
 *
 * And the refusal case, which is the atomicity claim: a save the revision
 * predicate rejects leaves the column exactly as it was.
 * ------------------------------------------------------------------------- */

describe('the stored estimate a confirmation leaves behind', () => {
    /** `meal_plan_preferences.estimated_targets`, as the column holds it. */
    const storedEstimate = async (): Promise<unknown> => {
        const row = await prisma.meal_plan_preferences.findUniqueOrThrow({
            where: { user_id: USER_ID },
            select: { estimated_targets: true },
        });

        return row.estimated_targets;
    };

    /**
     * The fixture user's estimate, written out rather than computed: male, 34,
     * 178 cm, 79 kg, lightly active, maintaining. A record derived here from the
     * same function under test would assert nothing about the numbers, so these
     * are the Mifflin–St Jeor figures for that row — basal 1737.5 → 1738,
     * maintenance 1737.5 × 1.375 = 2388.9 → 2389, no adjustment, nothing
     * clamped, and 30/40/30 of 2389 kcal at 4/4/9 kcal per gram.
     */
    const FIXTURE_ESTIMATE = {
        inputRevision: 1,
        inputs: {
            age: 34,
            heightCm: 178,
            weightKg: 79,
            sexForEstimate: 'male',
            activityLevel: 'lightly_active',
            goal: 'maintain',
            paceLbPerWeek: null,
        },
        bmr: 1738,
        tdee: 2389,
        adjustment: 0,
        calories: 2389,
        protein: 179,
        carbs: 239,
        fat: 80,
        clamped: false,
        clampReason: null,
    };

    /** Confirm the current estimate, refusing to continue if the save is rejected. */
    const confirmEstimate = async (expectedTargetsRevision: number): Promise<void> => {
        const estimate = await getTargetEstimate(USER_ID);
        const saved = await saveTargets(USER_ID, {
            source: 'estimated',
            estimateRevision: estimate.estimateRevision,
            expectedTargetsRevision,
        });

        if (saved.kind !== 'ok') {
            throw new Error(`estimated save was refused: ${JSON.stringify(saved)}`);
        }
    };

    it('is null before any confirmation, so what follows is this write and not the fixture', async () => {
        expect(await storedEstimate()).toBeNull();
    });

    it('records the whole recomputed estimate, not only the four values it confirmed', async () => {
        await confirmEstimate(1);

        expect(await storedEstimate()).toEqual(FIXTURE_ESTIMATE);
    });

    it('records the estimate the review screen was shown, derivation included', async () => {
        const estimate = await getTargetEstimate(USER_ID);

        await confirmEstimate(1);

        // Every member of the figure the user reviewed is in the record, and
        // the revision it was derived from is stored under the name it means at
        // rest. This is the claim the finding was about: before the fix the
        // column was always empty, so none of this was recoverable.
        expect(await storedEstimate()).toMatchObject({
            inputRevision: estimate.estimateRevision,
            bmr: estimate.bmr,
            tdee: estimate.tdee,
            adjustment: estimate.adjustment,
            calories: estimate.calories,
            protein: estimate.protein,
            carbs: estimate.carbs,
            fat: estimate.fat,
            clamped: estimate.clamped,
            clampReason: estimate.clampReason,
        });
    });

    it('explains the figure the canonical read reports, value for value', async () => {
        await confirmEstimate(1);

        const targets = await getTargets(USER_ID);

        expect(await storedEstimate()).toMatchObject({
            calories: targets.targets?.calories,
            protein: targets.targets?.protein,
            carbs: targets.targets?.carbs,
            fat: targets.targets?.fat,
        });
        expect(await storedRevisions()).toMatchObject({ revision: 1, targetsInput: 1 });
    });

    it('is the LAST estimate: a later confirmation replaces it at its own input revision', async () => {
        await confirmEstimate(1);
        await saveStep('activity', { activityLevel: 'active', timeZone: TIME_ZONE, expectedRevision: 1 });

        // Stale now, and the recalculation the review screen offers is taken.
        expect(await getTargets(USER_ID)).toMatchObject({ stale: true });
        await confirmEstimate(2);

        const stored = await storedEstimate();

        // The new answer, the new maintenance rate (1737.5 × 1.55 = 2693.1),
        // and the PREFERENCES revision the new figure was derived from — so the
        // record tracks the latest confirmation rather than accumulating
        // history. `revision: 3` is the TARGETS counter, which each of the two
        // confirmations advanced by one from the fixture's 1; `inputRevision`
        // is the preferences counter, which the single activity save moved to
        // 2. The two are different numbers on purpose.
        expect(stored).toMatchObject({
            inputRevision: 2,
            inputs: { ...FIXTURE_ESTIMATE.inputs, activityLevel: 'active' },
            tdee: 2693,
            calories: 2693,
        });
        expect(await getTargets(USER_ID)).toMatchObject({ stale: false, revision: 3 });
    });

    it('survives a manual save rather than being cleared by it', async () => {
        await confirmEstimate(1);

        const saved = await saveTargets(USER_ID, {
            source: 'manual',
            calories: 1800,
            protein: 140,
            carbs: 180,
            fat: 60,
            // The confirmation above consumed the fixture's revision 1, so the
            // manual save pins the 2 it left behind.
            expectedTargetsRevision: 2,
        });

        expect(saved.kind).toBe('ok');

        // The confirmed figure is now the typed one and the ancestry is gone,
        // because the user typed these numbers — but the account of the
        // calculation that really happened is retained (AAP §0.5.1: the LAST
        // ESTIMATE computed for the user, not the estimate behind the current
        // targets). Nothing can misread it as the confirmed figure: the source
        // says `manual` and the snapshot carries its own input revision.
        expect(await getTargets(USER_ID)).toMatchObject({ source: 'manual', stale: false });
        expect(await storedRevisions()).toMatchObject({ targetsInput: null });
        expect(await storedEstimate()).toEqual(FIXTURE_ESTIMATE);
    });

    it('stays null when the first confirmation a user ever makes is manual', async () => {
        // The create arm: a legacy user editing targets from Account before any
        // onboarding. No estimate was ever computed for them, and NULL is the
        // honest record of that — the column is not given a fabricated one.
        await prisma.meal_plan_preferences.delete({ where: { user_id: USER_ID } });

        const saved = await saveTargets(USER_ID, {
            source: 'manual',
            calories: 1800,
            protein: 140,
            carbs: 180,
            fat: 60,
            expectedTargetsRevision: null,
        });

        expect(saved.kind).toBe('ok');
        expect(await storedEstimate()).toBeNull();
    });

    it('is left untouched by a save the revision predicate refuses', async () => {
        await confirmEstimate(1);

        // A second confirmation pinning the revision the first one consumed:
        // refused, and the record must not be half-written. The estimate is
        // recomputed from the same unchanged answers, so only the pin is wrong.
        const estimate = await getTargetEstimate(USER_ID);

        await expect(
            saveTargets(USER_ID, {
                source: 'estimated',
                estimateRevision: estimate.estimateRevision,
                expectedTargetsRevision: 1,
            }),
        ).rejects.toMatchObject({ name: 'StaleTargetsError', currentRevision: 2 });

        expect(await storedEstimate()).toEqual(FIXTURE_ESTIMATE);
        expect(await storedRevisions()).toMatchObject({ revision: 1, targetsInput: 1 });
    });
});

/* ---------------------------------------------------------------------------
 * The manual route refuses an estimate, whatever the row still holds
 *
 * The Skip branch of the body step is the case only a real save can produce:
 * it sends no measurements and CLEARS NOTHING, so the row keeps a complete set
 * of them while `target_route` records that the user asked to type their own
 * numbers. A route-blind availability rule reads that row as estimable, and
 * then both the estimate GET and the estimated confirmation answer a question
 * the user declined to ask.
 * ------------------------------------------------------------------------- */

describe('the estimate paths against a persisted manual route', () => {
    /** The stored preferences row, read whole. */
    const storedRow = async () =>
        prisma.meal_plan_preferences.findUniqueOrThrow({ where: { user_id: USER_ID } });

    /** Skip, as frame 03's tertiary action saves it. */
    const skipBodyStep = async (expectedRevision: number): Promise<void> =>
        saveStep('body', { skipped: true, timeZone: TIME_ZONE, expectedRevision });

    it('records the route and keeps every measurement, which is why the route is the only signal', async () => {
        await skipBodyStep(1);

        const row = await storedRow();

        expect(row.target_route).toBe('manual');
        expect([row.age, row.height_cm, row.weight_kg, row.sex_for_estimate]).toEqual([
            34,
            178,
            79,
            'male',
        ]);
    });

    it('refuses to calculate an estimate after Skip', async () => {
        await skipBodyStep(1);

        await expect(getTargetEstimate(USER_ID)).rejects.toMatchObject({
            name: 'EstimateUnavailableError',
            reason: 'missing_inputs',
        });
    });

    it('refuses to confirm an estimated target after Skip, and stores nothing', async () => {
        await skipBodyStep(1);

        const { revision } = await storedRevisions();

        await expect(
            saveTargets(USER_ID, {
                source: 'estimated',
                estimateRevision: revision,
                expectedTargetsRevision: 1,
            }),
        ).rejects.toMatchObject({ name: 'EstimateUnavailableError', reason: 'missing_inputs' });

        // Neither half of the canonical write landed, so the previously
        // confirmed values stand exactly as they were.
        expect(await getTargets(USER_ID)).toEqual({
            targets: { ...FIXTURE_TARGETS },
            complete: true,
            source: 'estimated',
            stale: true,
            revision: 1,
        });
        expect(await storedRevisions()).toMatchObject({ revision: 2, targetsInput: 1 });
    });

    it("reports prefer-not-to-say as itself, not as the route it set", async () => {
        await saveStep('body', {
            age: 34,
            heightCm: 178,
            weightKg: 79,
            sexForEstimate: 'prefer_not_to_say',
            heightUnitPref: 'ft_in',
            weightUnitPref: 'lb',
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        const row = await storedRow();

        expect(row.target_route).toBe('manual');
        await expect(getTargetEstimate(USER_ID)).rejects.toMatchObject({
            name: 'EstimateUnavailableError',
            reason: 'prefer_not_to_say',
        });
    });

    it('still accepts the manual save the route sends the user to', async () => {
        await skipBodyStep(1);

        const saved = await saveTargets(USER_ID, {
            source: 'manual',
            calories: 1800,
            protein: 140,
            carbs: 180,
            fat: 60,
            expectedTargetsRevision: 1,
        });

        expect(saved.kind).toBe('ok');
        expect(await getTargets(USER_ID)).toMatchObject({
            targets: { calories: 1800, protein: 140, carbs: 180, fat: 60 },
            source: 'manual',
            stale: false,
        });
    });

    it('lets the user back onto the estimated route by answering the body step again', async () => {
        await skipBodyStep(1);
        await saveStep('body', {
            age: 35,
            heightCm: 178,
            weightKg: 79,
            sexForEstimate: 'male',
            heightUnitPref: 'ft_in',
            weightUnitPref: 'lb',
            timeZone: TIME_ZONE,
            expectedRevision: 2,
        });

        const row = await storedRow();

        // The refusal is the route, so it lifts the moment the route changes —
        // a user who pressed Skip is not locked out of the calculation.
        expect(row.target_route).toBe('estimated');
        await expect(getTargetEstimate(USER_ID)).resolves.toMatchObject({
            source: 'estimated',
            estimateRevision: 3,
        });
    });
});

/* ---------------------------------------------------------------------------
 * The pinned targets revision travels in the UPDATE's own predicate
 *
 * `saveTargets` checks `expectedTargetsRevision` against the row it read under
 * the per-user advisory lock. That check is correct and it is not sufficient:
 * it is an application-level comparison, so a write that reached the row
 * without taking the lock would leave it looking exactly as safe while the
 * pinned revision decided nothing at all.
 *
 * These two tests drive that state deterministically rather than racing for it.
 * A second session holds a ROW LOCK (no advisory lock, which is what makes it
 * possible), so the save reads the row, reaches its UPDATE and blocks; the
 * second session then commits, and PostgreSQL re-evaluates the waiting UPDATE's
 * predicate against the row as it now is. The pair is the proof: with the
 * revision changed the write must be refused, and with the row merely locked
 * and released it must succeed — without the second assertion the first could
 * pass because of the blocking rather than because of the predicate.
 * ------------------------------------------------------------------------- */

describe('the pinned targets revision as a write predicate', () => {
    const MANUAL_SAVE = {
        source: 'manual',
        calories: 1800,
        protein: 140,
        carbs: 180,
        fat: 60,
        expectedTargetsRevision: 1,
    } as const;

    /**
     * Hold the preferences row locked on another session until `release` is
     * called, then optionally move `targets_revision` before committing.
     */
    const holdRowLock = (
        bumpRevisionBeforeCommit: boolean,
    ): { locked: Promise<void>; release: () => void; committed: Promise<void> } => {
        let markLocked = (): void => {};
        let release = (): void => {};
        const locked = new Promise<void>((resolve) => {
            markLocked = () => resolve();
        });
        const gate = new Promise<void>((resolve) => {
            release = () => resolve();
        });

        const committed = legacyWriterClient
            .$transaction(
                async (tx) => {
                    await tx.$queryRaw`SELECT targets_revision FROM meal_plan_preferences WHERE user_id = ${USER_ID} FOR UPDATE`;
                    markLocked();
                    await gate;

                    if (bumpRevisionBeforeCommit) {
                        await tx.$executeRaw`UPDATE meal_plan_preferences SET targets_revision = targets_revision + 1 WHERE user_id = ${USER_ID}`;
                    }
                },
                { timeout: 20_000 },
            )
            .then(() => undefined);

        return { locked, release, committed };
    };

    it('refuses the save when the revision it pinned no longer matches at the write', async () => {
        const holder = holdRowLock(true);
        await holder.locked;

        // Started, not awaited: it takes the advisory lock, reads revision 1,
        // and then waits on the row lock the holder is sitting on. The outcome
        // is captured so a rejection is never unhandled while we drive the
        // holder.
        const outcome = saveTargets(USER_ID, { ...MANUAL_SAVE }).then(
            (response) => ({ response }),
            (error: unknown) => ({ error }),
        );

        // The interleaving the predicate exists for, established from
        // PostgreSQL rather than from a delay: the save is PARKED on the row the
        // holder is sitting on, so the bump that follows provably lands after
        // the save read revision 1 and before its own UPDATE is re-evaluated.
        // An elapsed window would also "pass" for a save that never got as far
        // as its UPDATE, which is the ordering this test is not about.
        await awaitLockWait(
            ROW_LOCK_WAIT,
            "the save queued behind the holder's lock on the preferences row",
        );
        holder.release();
        await withHangGuard(holder.committed, "the holder's revision bump");

        expect(await withHangGuard(outcome, 'the save released by the holder')).toEqual({
            error: expect.objectContaining({ name: 'StaleTargetsError', currentRevision: 2 }),
        });

        // Refused, and refused BEFORE anything was written: the other write
        // survives, the confirmed snapshot and the four user columns are
        // untouched, and the manual values never reached the row. The read is
        // still `estimated` and fresh, because the other session moved only the
        // targets counter — which is precisely what the pin exists to notice.
        expect(await getTargets(USER_ID)).toEqual({
            targets: { ...FIXTURE_TARGETS },
            complete: true,
            source: 'estimated',
            stale: false,
            revision: 2,
        });
        expect(
            await prisma.meal_plan_preferences.findUniqueOrThrow({
                where: { user_id: USER_ID },
                select: { target_source: true, confirmed_targets: true, targets_revision: true },
            }),
        ).toEqual({
            target_source: 'estimated',
            confirmed_targets: { ...FIXTURE_TARGETS },
            targets_revision: 2,
        });
    }, LOCK_CASE_TIMEOUT_MS);

    it('completes the save when the row is merely locked and released', async () => {
        // The counter-proof. The save waits on exactly the same row lock, is
        // observed waiting the same way and is released the same way; only the
        // revision the holder leaves behind differs, so the refusal above is the
        // predicate and nothing else.
        const holder = holdRowLock(false);
        await holder.locked;

        const outcome = saveTargets(USER_ID, { ...MANUAL_SAVE }).then(
            (response) => ({ response }),
            (error: unknown) => ({ error }),
        );

        await awaitLockWait(
            ROW_LOCK_WAIT,
            "the save queued behind the holder's lock on the preferences row",
        );
        holder.release();
        await withHangGuard(holder.committed, 'the holder that only locked and released');

        expect(await withHangGuard(outcome, 'the save released by the holder')).toMatchObject({
            response: { kind: 'ok' },
        });
        expect(await getTargets(USER_ID)).toEqual({
            targets: { calories: 1800, protein: 140, carbs: 180, fat: 60 },
            complete: true,
            source: 'manual',
            stale: false,
            revision: 2,
        });
    }, LOCK_CASE_TIMEOUT_MS);

    it('creates the row, rather than pinning a revision that cannot exist, for a legacy user', async () => {
        // The other arm of the same write. A user editing targets from Account
        // before any onboarding has no row to pin, so the save creates one —
        // with `not_started` status, because a target is not onboarding
        // progress — and a client that pins a revision anyway is refused.
        await prisma.meal_plan_preferences.delete({ where: { user_id: USER_ID } });

        await expect(saveTargets(USER_ID, { ...MANUAL_SAVE })).rejects.toMatchObject({
            name: 'StaleTargetsError',
            currentRevision: 0,
        });

        const saved = await saveTargets(USER_ID, {
            source: 'manual',
            calories: 1800,
            protein: 140,
            carbs: 180,
            fat: 60,
            expectedTargetsRevision: null,
        });

        expect(saved.kind).toBe('ok');
        expect(
            await prisma.meal_plan_preferences.findUniqueOrThrow({
                where: { user_id: USER_ID },
                select: { setup_status: true, revision: true, targets_revision: true },
            }),
        ).toEqual({ setup_status: 'not_started', revision: 1, targets_revision: 1 });
        expect(await getTargets(USER_ID)).toMatchObject({ source: 'manual', revision: 1 });
    });
});

/* ---------------------------------------------------------------------------
 * The canonical read is one statement
 * ------------------------------------------------------------------------- */

describe('the canonical target read', () => {
    const statementsDuring = async (work: (db: PrismaClient) => Promise<unknown>): Promise<string[]> => {
        const statements: string[] = [];
        const record = (event: { query: string }): void => {
            if (!isFrameworkStatement(event.query)) {
                statements.push(event.query);
            }
        };

        observedClient.$on('query', record);
        await work(observedClient);
        // Prisma has no `$off`, so the listener is quietened instead of removed:
        // every assertion reads the array it filled during its own call.
        await sleep(50);

        return statements;
    };

    it('reads both rows in a single statement, so the pair is one snapshot', async () => {
        const statements = await statementsDuring((db) => getTargets(USER_ID, db));

        expect(statements).toHaveLength(1);
        // Named tables, so a single statement that read only one of them could
        // not satisfy this test.
        expect(statements[0]).toMatch(/FROM\s+users/i);
        expect(statements[0]).toMatch(/join\s+meal_plan_preferences/i);
        expect(statements[0]).not.toMatch(/FOR UPDATE/i);
    });

    it('takes no row lock, because a display read must not queue behind a target write', async () => {
        const statements = await statementsDuring((db) => previewConfirmedTargets(USER_ID, db));

        expect(statements).toHaveLength(1);
        expect(statements[0]).not.toMatch(/FOR UPDATE/i);
    });

    it('answers a user with no stored targets without inventing any', async () => {
        await truncateFeatureTables();
        await makeUser({ id: USER_ID });

        expect(await getTargets(USER_ID)).toEqual({
            targets: null,
            complete: false,
            source: null,
            stale: false,
            revision: 0,
        });
    });

    it('reports legacy the moment the untouched writer moves a value', async () => {
        await updateTargets(USER_ID, { calories: FIXTURE_TARGETS.calories + 100 });

        expect(await getTargets(USER_ID)).toMatchObject({
            complete: true,
            source: 'legacy',
            // The legacy route never bumps the targets revision — that asymmetry
            // is what makes the mismatch detectable at all.
            revision: 1,
        });
    });
});

/* ---------------------------------------------------------------------------
 * The publication gate holds the owning row
 * ------------------------------------------------------------------------- */

describe('the publication gate against the untouched legacy writer', () => {
    /** The legacy `PUT /api/user/targets` write, on its own session. */
    const startLegacyWrite = (calories: number): { settled: () => boolean; done: Promise<void> } => {
        let finished = false;
        const done = updateTargets(USER_ID, { calories }, legacyWriterClient).then(() => {
            finished = true;
        });

        return { settled: () => finished, done };
    };

    it('refuses to publish when a legacy write landed before the gate ran', async () => {
        await updateTargets(USER_ID, { calories: FIXTURE_TARGETS.calories + 100 });

        await expect(
            withMealPlanningTransaction((tx) =>
                withUserLock(tx, USER_ID, (locked) => requireConfirmedTargets(locked, USER_ID)),
            ),
        ).rejects.toThrow(TargetsUnconfirmedError);
    });

    it('blocks a legacy write from the moment it judges the targets until it commits', async () => {
        const observed = await withMealPlanningTransaction(
            (tx) =>
                withUserLock(tx, USER_ID, async (locked) => {
                    const gate = await requireConfirmedTargets(locked, USER_ID);
                    const legacy = startLegacyWrite(FIXTURE_TARGETS.calories + 100);

                    // BLOCKED IS THE DATABASE'S VERDICT, NOT A STOPWATCH'S.
                    // PostgreSQL lists the legacy write as an ungranted wait for
                    // this transaction's row lock, and only that makes
                    // "unsettled" mean "blocked" — an elapsed window says the
                    // same thing about a write that is merely slow, or that the
                    // event loop has not started yet. The wait it matches is for
                    // the ROW — the lock the legacy writer was always going to
                    // have to take — and not for this feature's advisory lock,
                    // which `PUT /api/user/targets` never asks for.
                    await awaitLockWait(
                        ROW_LOCK_WAIT,
                        "the legacy write behind the gate's lock on the user row",
                    );

                    // THE INVARIANT THE LOCK EXISTS FOR. A plan is inserted
                    // after this point in the same transaction, and its
                    // `targets_snapshot` is this value; the legacy write cannot
                    // commit until that insert has, so the snapshot cannot
                    // differ from the confirmed targets at the moment it lands.
                    const stillConfirmed = await getTargets(USER_ID, locked);

                    return { gate, legacy, blockedWhileOpen: !legacy.settled(), stillConfirmed };
                }),
            { timeout: 20_000 },
        );

        expect(observed.blockedWhileOpen).toBe(true);
        expect(observed.gate).toEqual({ targets: { ...FIXTURE_TARGETS }, targetsRevision: 1 });
        expect(observed.stillConfirmed).toMatchObject({
            targets: { ...FIXTURE_TARGETS },
            source: 'estimated',
        });

        await withHangGuard(observed.legacy.done, 'the legacy write released at COMMIT');

        // Released at COMMIT, so the legacy write is not lost — it applies to a
        // plan that was built, and published, on values that were confirmed at
        // the time. Afterwards the canonical read says so plainly.
        expect(observed.legacy.settled()).toBe(true);
        expect(await getTargets(USER_ID)).toMatchObject({
            targets: { ...FIXTURE_TARGETS, calories: FIXTURE_TARGETS.calories + 100 },
            source: 'legacy',
        });
    }, LOCK_CASE_TIMEOUT_MS);

    it('leaves that write unblocked when the read is the unlocked one', async () => {
        // The counter-proof. Without it, the test above could pass because of
        // something incidental to the transaction rather than because of the
        // row lock — and a gate that had lost its `FOR UPDATE` would look
        // exactly as correct.
        //
        // NOT BLOCKED IS PROVEN BY COMPLETION, NOT BY A DEADLINE. The legacy
        // write is awaited to the end while the unlocked read's transaction is
        // STILL OPEN — the strongest form of the claim, and one that cannot be
        // satisfied by a slow host the way "unfinished after half a second"
        // could be inverted by one. The watch over `pg_locks` is the same
        // absence from the database's side: nothing ever queued.
        const observed = await withMealPlanningTransaction(
            (tx) =>
                withUserLock(tx, USER_ID, async (locked) => {
                    await previewConfirmedTargets(USER_ID, locked);

                    const legacy = startLegacyWrite(FIXTURE_TARGETS.calories + 100);
                    const lockWaitsObserved = await runWatchingForLockWaits(
                        legacy.done,
                        'the legacy write behind an unlocked read',
                    );

                    return { settledWhileOpen: legacy.settled(), lockWaitsObserved };
                }),
            { timeout: 20_000 },
        );

        expect(observed.settledWhileOpen).toBe(true);
        expect(observed.lockWaitsObserved).toEqual([]);
    }, LOCK_CASE_TIMEOUT_MS);

    it('sees a legacy write that commits while it waits, and refuses on the next attempt', async () => {
        // The two orderings the AAP requires, driven in sequence: the write
        // that could not interleave becomes the write that precedes the next
        // attempt, and that attempt is refused rather than silently planned.
        //
        // The contending write is handed OUT of the transaction and awaited
        // below rather than dropped. Dropping it left the second attempt racing
        // a commit nobody was waiting for — the refusal then depended on which
        // of the two won — and a rejection from an abandoned promise would
        // surface as an unhandled rejection in whichever test happened to be
        // running.
        const legacy = await withMealPlanningTransaction(
            (tx) =>
                withUserLock(tx, USER_ID, async (locked) => {
                    await requireConfirmedTargets(locked, USER_ID);
                    const contending = startLegacyWrite(FIXTURE_TARGETS.calories + 250);

                    // "While it waits" as a fact: the write is parked on this
                    // transaction's row lock at the moment the gate's read has
                    // already judged the targets.
                    await awaitLockWait(
                        ROW_LOCK_WAIT,
                        "the legacy write behind the gate's lock on the user row",
                    );

                    return contending;
                }),
            { timeout: 20_000 },
        );

        // Released at COMMIT and awaited to completion, so the next attempt
        // begins after the legacy value is COMMITTED — which is the ordering the
        // refusal below is about.
        await withHangGuard(legacy.done, 'the legacy write released at COMMIT');
        expect(legacy.settled()).toBe(true);

        await expect(
            withMealPlanningTransaction((tx) =>
                withUserLock(tx, USER_ID, (locked) => requireConfirmedTargets(locked, USER_ID)),
            ),
        ).rejects.toThrow(TargetsUnconfirmedError);
    }, LOCK_CASE_TIMEOUT_MS);
});

/* ---------------------------------------------------------------------------
 * The REAL publication path, not the gate helper
 * ------------------------------------------------------------------------- */

/**
 * The three slot shares §0.7.3 guides a three-meal day by (25/35/40 % of a
 * 2,100 kcal target), one recipe size per slot, so a day built from one of each
 * lands exactly on {@link FIXTURE_TARGETS} and the day tolerance is satisfied
 * without relying on portion multipliers.
 */
const SLOT_RECIPE_SHARES = [
    { slot: 'breakfast', perServing: { calories: 525, protein: 40, carbs: 52, fat: 18 } },
    { slot: 'lunch', perServing: { calories: 735, protein: 55, carbs: 74, fat: 24 } },
    { slot: 'dinner', perServing: { calories: 840, protein: 63, carbs: 84, fat: 28 } },
] as const;

/**
 * Four per slot, which is what the repetition rule needs for a seven-day week:
 * at most two uses of a recipe and never on consecutive days leaves 7 = 2+2+2+1.
 */
const RECIPES_PER_SLOT = 4;

/** The preferences `makePreferences` stores, in the shape the eligibility rules read. */
const FIXTURE_PLANNING_PREFERENCES: PlanningPreferences = {
    diet: 'none',
    allergens: [],
    disliked_food_ids: [],
    disliked_food_groups: [],
    cooking_time_limit_min: 30,
};

/** A promise plus its resolver, for sequencing two sessions deterministically. */
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

const generateRequest = (): Record<string, unknown> => ({
    // Tomorrow, the product default, and inside the start-date window whichever
    // day the suite runs on.
    startDate: addDaysToDayKey(utcTodayDayKey(), 1),
    idempotencyKey: randomUUID(),
    expectedPreferencesRevision: 1,
    expectedTargetsRevision: 1,
});

/**
 * The real planning read's eligibility verdict over the seeded catalog, judged
 * against {@link FIXTURE_PLANNING_PREFERENCES}: how many candidates a week can
 * be built from, and the distinct refusal codes the rest carry.
 */
const planningEligibility = async (): Promise<{ eligible: number; refusalCodes: string[] }> => {
    const candidates = await recipeService.getRecipeVersionsForPlanning(prisma);
    const verdicts = candidates.map((candidate) =>
        evaluatePlanningEligibility(candidate, FIXTURE_PLANNING_PREFERENCES),
    );

    return {
        eligible: verdicts.filter((verdict) => verdict.eligible).length,
        refusalCodes: [
            ...new Set(verdicts.flatMap((verdict) => verdict.reasons.map((reason) => reason.code))),
        ].sort(),
    };
};

/** A publication held open at its grocery write, with the two signals that bound it. */
interface HeldPublication {
    /** Resolves once the request is provably inside the publication transaction. */
    entered: Promise<void>;
    /** Lets the held step return, so the transaction can commit. */
    release: () => void;
}

/**
 * Holds the publication transaction open at a step that runs AFTER the gate, and
 * SIGNALS the moment it gets there.
 *
 * Firing the legacy writer DURING a publication — rather than before or after
 * one — is what AAP §0.9.2's second ordering is about, and it needs two facts
 * that a delay cannot supply. The first is entry: `entered` resolves only once
 * the REAL `writePlanGroceryRows` has returned, so when the test proceeds the
 * request has passed the gate's `SELECT … FOR UPDATE OF u`, inserted its plan
 * and reached the last substantial step of the same transaction. That is a fact
 * about where the request is, whereas an elapsed few hundred milliseconds is a
 * guess that a loaded host can make wrong in either direction — reaching the
 * grocery write after the window has closed, or finishing the whole publication
 * before the legacy writer has even started, which would silently test the
 * opposite ordering. The second is the moment of COMMIT: the spy waits on
 * `release`, so the test chooses it instead of racing a timer that may expire
 * while the legacy write is still being set up.
 *
 * Nothing about the gate, the lock, the plan insert or the snapshot is stubbed —
 * the real write runs first and its result is returned unchanged.
 */
const holdPublicationOpen = (): HeldPublication => {
    const writeRows = groceryService.writePlanGroceryRows;
    const entered = deferred();
    const held = deferred();

    jest.spyOn(groceryService, 'writePlanGroceryRows').mockImplementation(async (tx, params) => {
        const written = await writeRows(tx, params);

        entered.release();
        await held.promise;

        return written;
    });

    return { entered: entered.promise, release: held.release };
};

/**
 * Fires the legacy writer inside a held publication and hands back its handle,
 * once PostgreSQL reports it queued behind the publication's row lock.
 *
 * Shared by the generation and the regeneration case because the choreography is
 * the property, not the endpoint: enter the transaction, contend for the row,
 * establish from `pg_locks` that the contender is waiting rather than merely
 * unfinished, and only then release. The release is in `finally` — a failed
 * expectation must not leave the transaction pinned on the user row, because
 * every later case in this suite writes that row through the same gate and would
 * fail as a timeout sourced nowhere near the real defect.
 *
 * The caller owns both promises afterwards: the publication's own result, and
 * the legacy write that commits behind it.
 */
const raceLegacyWriteIntoPublication = async <T>(
    publication: HeldPublication,
    publishing: { settled: () => boolean; done: Promise<T> },
): Promise<{ settled: () => boolean; done: Promise<unknown> }> => {
    try {
        await withHangGuard(publication.entered, 'the publication never reached its grocery write');

        // Inside the transaction because the code inside the transaction said
        // so, rather than because a chosen number of milliseconds has passed.
        expect(publishing.settled()).toBe(false);

        const legacy = watch(
            updateTargets(USER_ID, { calories: FIXTURE_TARGETS.calories + 100 }, legacyWriterClient),
        );

        await awaitLockWait(
            ROW_LOCK_WAIT,
            "the legacy write queued behind the publication's lock on the user row",
        );

        // PostgreSQL has parked the write, so this is the lock and not latency.
        expect(legacy.settled()).toBe(false);

        return legacy;
    } finally {
        publication.release();
    }
};

const countPersisted = async (): Promise<{ plans: number; ledger: number }> => ({
    plans: await prisma.meal_plans.count({ where: { user_id: USER_ID } }),
    ledger: await prisma.meal_plan_actions.count({ where: { user_id: USER_ID } }),
});

describe('the real generation path against the untouched legacy writer', () => {
    beforeEach(async () => {
        // The outer hook already seeded the confirmed-estimate state. Generation
        // additionally needs a zone whose "today" this suite can name without
        // re-deriving it, and a catalog it can build a week from.
        await prisma.meal_plan_preferences.update({
            where: { user_id: USER_ID },
            data: { time_zone: 'UTC' },
        });

        // ONE food, and the factory's own default portion — `1 cup / 200 g`
        // against a null `density_g_per_ml`, the shape every volume-portion food
        // of the catalog release has. The grocery write that follows publication
        // converts the planned gram weight into the contributors' own unit
        // family, and for this portion it does so through the density the
        // portion itself states (§0.1.4's stored-portion conversion), so the
        // publication reaches its grocery rows with nothing stated here to
        // accommodate it. Overriding the portion to grams would only hide
        // whether that still holds.
        const food = await makeCatalogFood();

        for (const { slot, perServing } of SLOT_RECIPE_SHARES) {
            for (let index = 0; index < RECIPES_PER_SLOT; index += 1) {
                await makeRecipeVersion({
                    slug: `targets-race-${slot}-${index}`,
                    catalogFoodId: food.id,
                    meal_slots: [slot],
                    perServing,
                });
            }
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('refuses through generatePlan itself when a legacy write won, and persists nothing', async () => {
        // The ordering AAP §0.9.2 names first, driven through the real entry
        // point rather than the gate helper: the legacy writer moves the
        // canonical value, and the request that follows must not produce a week.
        await updateTargets(USER_ID, { calories: FIXTURE_TARGETS.calories + 100 });

        await expect(generatePlan(USER_ID, generateRequest(), new Date())).rejects.toThrow(
            TargetsUnconfirmedError,
        );

        // Refused before the search, so nothing was written and no ledger row
        // was left reserved — a retry is free rather than a replay of a failure.
        expect(await countPersisted()).toEqual({ plans: 0, ledger: 0 });
        expect(await getTargets(USER_ID)).toMatchObject({ source: 'legacy' });
    });

    it('reads a live allergen review for every candidate ingredient, which is what the published weeks below rest on', async () => {
        // WHAT THE PUBLICATION TESTS BELOW REST ON. The candidate read and the
        // search run before the publication transaction opens (§0.5.1), so a
        // candidate set the eligibility rules refuse ends the request as
        // `NoMatchingMealsError` with nothing locked and no week to hold open.
        // `recipe.logic.ts::evaluatePlanningEligibility` admits a recipe only
        // when EVERY ingredient carries an explicit `'known'` review, and
        // `recipe_ingredients` does not snapshot that review — so
        // `recipe.service.ts::PLANNING_INGREDIENT_SELECT` joins it live from
        // each ingredient's own `catalog_foods` row. Asserted here off the
        // unspied loader, so a projection that stopped supplying it fails as
        // itself rather than as a refusal sourced two files away.
        const expectedCandidates = SLOT_RECIPE_SHARES.length * RECIPES_PER_SLOT;

        const candidates = await recipeService.getRecipeVersionsForPlanning(prisma);
        const ingredientReviews = candidates.map((candidate) =>
            candidate.ingredients.map((ingredient) => ingredient.allergen_status),
        );

        // One ingredient per fixture recipe — `perServing` synthesises exactly
        // one — so an absent review reads as `undefined` here and fails.
        expect(ingredientReviews).toEqual(
            Array.from({ length: expectedCandidates }, () => ['known']),
        );

        expect(await planningEligibility()).toEqual({
            eligible: expectedCandidates,
            refusalCodes: [],
        });
    });

    it('waits, and then refuses, when a legacy write holds the user row first', async () => {
        // ORDERING ONE, from inside. A second session holds the user row before
        // the request starts, so generation reaches `requirePinnedInputs` and
        // stops there — which is the assertion that the gate is on the
        // PUBLICATION path and not merely present in the module. A build that
        // dropped it from the generation callback would sail past this wait.
        const holdTaken = deferred();
        const releaseHold = deferred();

        const holder = legacyWriterClient.$transaction(
            async (tx) => {
                await tx.$queryRaw`SELECT id FROM users WHERE id = ${USER_ID} FOR UPDATE`;
                holdTaken.release();
                await releaseHold.promise;
                await tx.$executeRaw`UPDATE users SET target_calories = ${
                    FIXTURE_TARGETS.calories + 100
                } WHERE id = ${USER_ID}`;
            },
            { timeout: 20_000 },
        );

        await holdTaken.promise;

        const generation = watch(generatePlan(USER_ID, generateRequest(), new Date()));

        try {
            // The wait is PostgreSQL's own: the request is listed as queued for
            // the row this second session is holding. "Has not answered yet"
            // would be equally true of a request still searching the catalog,
            // and on a loaded host that is exactly what a fixed window would
            // catch instead.
            await awaitLockWait(
                ROW_LOCK_WAIT,
                "generation behind the holder's lock on the user row",
            );
            expect(generation.settled()).toBe(false);
        } finally {
            // Released whatever the expectation did: a holder left open would
            // pin the user row for every case after this one, and the failure
            // would be reported far away from its cause.
            releaseHold.release();
        }

        await withHangGuard(holder, 'the holder that moves the legacy value');

        await expect(generation.done).rejects.toThrow(TargetsUnconfirmedError);
        expect(await countPersisted()).toEqual({ plans: 0, ledger: 0 });

        expect(await getTargets(USER_ID)).toMatchObject({ source: 'legacy' });
    }, LOCK_CASE_TIMEOUT_MS);

    /**
     * §0.5.2's two outcomes for `POST /meal-planning/plans`, at the grocery
     * write: a published week whose list is rendered from the catalog's own
     * volume portions, or the typed `502 plan_generation_failed`.
     *
     * Both are asserted here because the publication's grocery step used to have
     * a third outcome — an untyped fault escaping as a generic 500 — which made
     * the first unreachable for EVERY user and the second unrecognisable to the
     * client. The fixture food's portion is `1 cup / 200 g` with no stored
     * density, so the successful case really does render a volume line.
     */
    describe('the grocery step of a publication', () => {
        /** Where setup stands before a first publication, which is what advances it. */
        const BEFORE_PUBLICATION_SETUP_STATUS = 'ready_for_review';

        beforeEach(async () => {
            // `makePreferences` seeds `completed`, which would make the
            // transition below unobservable: a status that was already the
            // expected value proves nothing about the publication that was
            // supposed to write it. So the row is wound back to the state a user
            // reaches by finishing setup, which `GENERATABLE_SETUP_STATUSES`
            // admits.
            await prisma.meal_plan_preferences.update({
                where: { user_id: USER_ID },
                data: { setup_status: BEFORE_PUBLICATION_SETUP_STATUS },
            });
        });

        it('publishes a week whose volume line renders, and completes setup', async () => {
            const published = await generatePlan(USER_ID, generateRequest(), new Date());

            expect(published.kind).toBe('ok');

            // One food across every recipe, so one shopping identity — and its
            // family is the one its portion states rather than the grams that
            // were measured.
            const rows = await prisma.grocery_items.findMany({ where: { user_id: USER_ID } });

            expect(rows).toHaveLength(1);
            expect(unitFamily(rows[0].display_unit)).toBe('volume');

            // §0.5.2's "Sets setupStatus to completed on success", which is only
            // reachable at all because the grocery write inside the same
            // transaction now finishes.
            expect(
                await prisma.meal_plan_preferences.findUniqueOrThrow({
                    where: { user_id: USER_ID },
                    select: { setup_status: true },
                }),
            ).toEqual({ setup_status: 'completed' });
        });

        it('answers the typed generation refusal when a line cannot be rendered', async () => {
            // The genuinely unrenderable case, forced at the step that renders:
            // `utils/units.ts` raises this when a volume row's food can state no
            // density at all, and the class belongs to no vocabulary a
            // controller maps — so escaping raw it would be a 500 where §0.5.2
            // promises `502 plan_generation_failed` as this endpoint's only 5xx.
            const fault = new UnitConversionError(
                'A positive density_g_per_ml is required to convert grams to millilitres, received null',
            );

            jest.spyOn(groceryService, 'buildPlanGroceryDrafts').mockRejectedValue(fault);

            const thrown = await generatePlan(USER_ID, generateRequest(), new Date()).then(
                () => null,
                (error: unknown) => error,
            );

            expect(thrown).toBeInstanceOf(PlanGenerationError);
            // The original fault is kept for the log rather than parsed out of a
            // message.
            expect((thrown as PlanGenerationError).cause).toBe(fault);

            // "Nothing was persisted" is what PlanGenerationError promises: the
            // week, its ledger reservation and its grocery rows all went with
            // the rollback, and setup did not advance.
            expect(await countPersisted()).toEqual({ plans: 0, ledger: 0 });
            expect(await prisma.grocery_items.count({ where: { user_id: USER_ID } })).toBe(0);
            expect(
                await prisma.meal_plan_preferences.findUniqueOrThrow({
                    where: { user_id: USER_ID },
                    select: { setup_status: true },
                }),
            ).toEqual({ setup_status: BEFORE_PUBLICATION_SETUP_STATUS });
        });
    });

    it('makes the legacy writer wait until the published week has committed', async () => {
        // ORDERING TWO, and the assertion the whole row lock exists for. The
        // request wins the row, so a legacy write fired while it is publishing
        // CANNOT commit until the week has — which is what makes
        // `meal_plans.targets_snapshot` provably equal to the confirmed pair at
        // the moment it lands rather than merely equal to it when it was read.
        //
        // THIS IS ALSO THE TEST THAT NOTICES IF THE GATE LEAVES THE PUBLICATION
        // PATH. Without `requirePinnedInputs` in the callback the only lock the
        // transaction holds on the user row is the ledger reservation's FK
        // check, which is a KEY SHARE lock and does not conflict with a plain
        // column update — so the legacy write would sail through mid-publication
        // and this expectation would fail. The refusal-shaped tests above cannot
        // see that, because a reader later in the same transaction raises the
        // same error once the legacy value commits.
        const publication = holdPublicationOpen();
        const generation = watch(generatePlan(USER_ID, generateRequest(), new Date()));
        const legacy = await raceLegacyWriteIntoPublication(publication, generation);

        const published = await withHangGuard(generation.done, 'the published week');

        expect(published.kind).toBe('ok');

        const plan = await prisma.meal_plans.findFirstOrThrow({
            where: { user_id: USER_ID, status: 'active' },
            select: { id: true, targets_snapshot: true },
        });

        expect(plan.targets_snapshot).toEqual({ ...FIXTURE_TARGETS });

        await withHangGuard(legacy.done, 'the legacy write the published week was holding');

        // Released at COMMIT, so the write is not lost, the published week keeps
        // the values it was built on, and the canonical read now reports the
        // divergence plainly.
        expect(legacy.settled()).toBe(true);
        expect(await getTargets(USER_ID)).toMatchObject({ source: 'legacy' });
        expect(
            (
                await prisma.meal_plans.findUniqueOrThrow({
                    where: { id: plan.id },
                    select: { targets_snapshot: true },
                })
            ).targets_snapshot,
        ).toEqual({ ...FIXTURE_TARGETS });
    }, LOCK_CASE_TIMEOUT_MS);

    it('makes the legacy writer wait on a REGENERATION too, which shares the gate', async () => {
        // The regeneration callback runs the same gate over a plan that already
        // exists, and it replaces a week rather than adding one — so a legacy
        // write slipping in mid-publication would leave the REPLACEMENT week
        // attributed to values nobody confirmed. Asserted separately because it
        // is a separate call site: dropping the gate from one callback and not
        // the other is exactly the sort of edit a single test would miss.
        const first = await generatePlan(USER_ID, generateRequest(), new Date());

        expect(first.kind).toBe('ok');

        const original = await prisma.meal_plans.findFirstOrThrow({
            where: { user_id: USER_ID, status: 'active' },
            select: { id: true, revision: true },
        });
        // Read rather than assumed: publication also advances the setup state,
        // and the pins have to match whatever the row says at this point.
        const preferences = await prisma.meal_plan_preferences.findUniqueOrThrow({
            where: { user_id: USER_ID },
            select: { revision: true },
        });
        const { revision: targetsRevision } = await getTargets(USER_ID);

        const publication = holdPublicationOpen();

        const regeneration = watch(
            regeneratePlan(
                USER_ID,
                original.id,
                {
                    idempotencyKey: randomUUID(),
                    expectedPlanRevision: original.revision,
                    expectedPreferencesRevision: preferences.revision,
                    expectedTargetsRevision: targetsRevision,
                },
                new Date(),
            ),
        );

        const legacy = await raceLegacyWriteIntoPublication(publication, regeneration);

        expect((await withHangGuard(regeneration.done, 'the replacement week')).kind).toBe('ok');
        await withHangGuard(legacy.done, 'the legacy write the replacement week was holding');

        // One active week, built on the confirmed pair, and the week it replaced
        // is superseded rather than rewritten.
        const plans = await prisma.meal_plans.findMany({
            where: { user_id: USER_ID },
            select: { id: true, status: true, targets_snapshot: true },
            orderBy: { generation_attempt: 'asc' },
        });

        expect(plans.map((plan) => plan.status)).toEqual(['superseded', 'active']);
        expect(plans.map((plan) => plan.targets_snapshot)).toEqual([
            { ...FIXTURE_TARGETS },
            { ...FIXTURE_TARGETS },
        ]);
        expect(await getTargets(USER_ID)).toMatchObject({ source: 'legacy' });
    }, LOCK_CASE_TIMEOUT_MS);

    it('leaves only a safe outcome when the two are raced', async () => {
        // AAP §0.9.2's third clause. Which side wins is timing, so the assertion
        // is the DISJUNCTION the contract allows — and never a published week
        // whose snapshot disagreed with the confirmed targets at its commit.
        const [generation] = await Promise.allSettled([
            generatePlan(USER_ID, generateRequest(), new Date()),
            updateTargets(USER_ID, { calories: FIXTURE_TARGETS.calories + 100 }),
        ]);

        const plans = await prisma.meal_plans.findMany({
            where: { user_id: USER_ID },
            select: { targets_snapshot: true },
        });

        if (generation.status === 'rejected') {
            expect(generation.reason).toBeInstanceOf(TargetsUnconfirmedError);
            expect(plans).toEqual([]);
            return;
        }

        expect(plans).toHaveLength(1);
        expect(plans[0].targets_snapshot).toEqual({ ...FIXTURE_TARGETS });
    });
});

/* ===========================================================================
 * THE THREE TARGET ROUTES OVER HTTP
 *
 * Everything below drives the shipped `src/app.ts` through `request`, so every
 * assertion is about the boundary: the mount, the auth middleware, the
 * controller's status mapping and the wire shape the mobile codecs decode. The
 * identity arrives only in the header, which is what makes "user A cannot reach
 * user B's row" mean anything (see `setup/jestSetup.ts`).
 * ========================================================================= */

const ESTIMATE_PATH = '/api/meal-planning/targets/estimate';
const TARGETS_PATH = '/api/meal-planning/targets';
const PREFERENCES_PATH = '/api/meal-planning/preferences';
const PLANS_PATH = '/api/meal-planning/plans';
const LEGACY_TARGETS_PATH = '/api/user/targets';

/**
 * The two identities the HTTP cases use.
 *
 * Fixed strings rather than generated ones: the outer `beforeEach` truncates
 * before every case, so reuse is always a fresh row, and a named id makes the
 * ownership assertions readable. Neither is the seeded `USER_ID`, so no HTTP
 * case is affected by the confirmed-estimate state the outer hook leaves.
 */
const HTTP_USER = 'targets-http-user';
const OTHER_HTTP_USER = 'targets-http-other-user';

/** A day key the diary read can be asked for without depending on when the suite runs. */
const DIARY_DAY_KEY = '2026-07-05';

const getEstimate = (uid: string) => asUser(request.get(ESTIMATE_PATH), { uid });

const getTargetsOverHttp = (uid: string) => asUser(request.get(TARGETS_PATH), { uid });

/**
 * `PUT /api/meal-planning/targets`.
 *
 * `body` is `unknown` because half the cases below send something the envelope
 * must refuse — an array, a mixed body, a key the arm does not accept — and
 * typing it as the DTO would make those cases uncompilable rather than
 * assertable.
 */
const saveTargetsOverHttp = (uid: string, body: unknown) =>
    asUser(request.put(TARGETS_PATH), { uid }).send(body as object);

/** The confirmed-estimate state, for the user an HTTP case addresses. */
const seedHttpConfirmedEstimate = async (
    uid: string = HTTP_USER,
    preferences: Parameters<typeof makePreferences>[1] = {},
): Promise<void> => {
    await makeUser({ id: uid, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(uid, preferences);
};

/** The four stored columns, read directly — the canonical values every surface must agree with. */
const storedUserTargets = async (uid: string) =>
    prisma.users.findUniqueOrThrow({
        where: { id: uid },
        select: {
            target_calories: true,
            target_protein_g: true,
            target_carbs_g: true,
            target_fat_g: true,
        },
    });

/** The attribution record the canonical read compares those columns against. */
const storedTargetRecord = async (uid: string) =>
    prisma.meal_plan_preferences.findUniqueOrThrow({
        where: { user_id: uid },
        select: {
            setup_status: true,
            setup_step: true,
            target_source: true,
            confirmed_targets: true,
            targets_revision: true,
            targets_input_revision: true,
            revision: true,
        },
    });

/** The `{field, code}` pairs of a `400 invalid_request` body. */
const refusalDetails = (body: unknown): InvalidRequestDetail[] =>
    (body as { details?: InvalidRequestDetail[] }).details ?? [];

/* ---------------------------------------------------------------------------
 * GET /api/meal-planning/targets/estimate
 *
 * The calculated figure the review screen shows, recomputed on every read. The
 * equation, the factors, the clamps and every envelope corner are
 * `targets.logic.test.ts`'s; what the boundary owns is that this path reaches
 * that computation at all, that the number it returns was derived from the
 * STORED answers rather than from the request, and that the two unavailable
 * reasons arrive as the machine-readable codes the client routes on.
 * ------------------------------------------------------------------------- */

describe('GET /api/meal-planning/targets/estimate', () => {
    it('refuses a request that carries no identity', async () => {
        // The auth boundary, not this handler: `app.ts` mounts
        // `authenticateFirebaseToken` before the meal-planning router, so a
        // request with no token never reaches `getUserId`.
        const response = await request.get(ESTIMATE_PATH).expect(401);

        expect(response.body).toEqual({ error: 'No token provided' });
    });

    it('is answered by its own handler rather than captured by the /targets sibling', async () => {
        // `/meal-planning/targets/estimate` and `/meal-planning/targets` are
        // siblings on one router (Rule §3.1). The proof that the literal one is
        // reached is that the body is the ESTIMATE shape — a derivation with
        // `bmr` and `inputs` — and carries none of the canonical read's own
        // members, which is what a capture by the other handler would return.
        await seedHttpConfirmedEstimate();

        const response = await getEstimate(HTTP_USER).expect(200);
        const body = response.body as TargetEstimateResponse & Partial<TargetsResponse>;

        expect(body.source).toBe('estimated');
        expect(typeof body.bmr).toBe('number');
        expect(body.inputs).toBeDefined();
        expect(body).not.toHaveProperty('complete');
        expect(body).not.toHaveProperty('stale');
    });

    it('answers the whole estimate shape, derivation included', async () => {
        await seedHttpConfirmedEstimate();

        const response = await getEstimate(HTTP_USER).expect(200);

        // Asserted whole rather than field by field: the review screen renders
        // every member, so an extra or missing one is a contract change.
        expect(Object.keys(response.body as object).sort()).toEqual([
            'adjustment',
            'bmr',
            'calories',
            'carbs',
            'clampReason',
            'clamped',
            'estimateRevision',
            'fat',
            'inputs',
            'protein',
            'source',
            'tdee',
        ]);
        expect((response.body as TargetEstimateResponse).inputs).toEqual({
            // The stored answers `makePreferences` holds, echoed so the screen
            // can show what produced the numbers.
            age: 34,
            heightCm: 178,
            weightKg: 79,
            sexForEstimate: 'male',
            activityLevel: 'lightly_active',
            goal: 'maintain',
            paceLbPerWeek: null,
        });
    });

    it('reaches the real computation: the audited fixture arrives value for value', async () => {
        // AAP §0.9.3's named inputs, and the ONE arithmetic case at this layer.
        // Its job is to prove the request path ends in `computeTargetEstimate`
        // rather than in something that merely answers plausibly; the equation
        // itself is pinned at every envelope corner, with every clamp branch, in
        // `targets.logic.test.ts`.
        await seedHttpConfirmedEstimate(HTTP_USER, {
            sex_for_estimate: 'female',
            age: 34,
            height_cm: 177.8,
            weight_kg: 82.6,
            activity_level: 'lightly_active',
            goal: 'lose',
            pace_lb_per_week: 1,
        });

        const response = await getEstimate(HTTP_USER).expect(200);

        expect(response.body).toMatchObject({
            bmr: 1606,
            tdee: 2209,
            adjustment: -500,
            calories: 1709,
            protein: 128,
            carbs: 171,
            fat: 57,
            clamped: false,
            clampReason: null,
        });
    });

    it('carries a clamp to the wire as the bound that decided the number', async () => {
        // The lowest corner of the supported envelope: the calculated figure is
        // below the female floor, so the floor is what the user is shown and
        // `clampReason` says which bound it was. The other two branches belong
        // to the pure suite; what this asserts is that neither flag is dropped
        // between the computation and the response.
        await seedHttpConfirmedEstimate(HTTP_USER, {
            sex_for_estimate: 'female',
            age: 100,
            height_cm: 120,
            weight_kg: 30,
            activity_level: 'not_very_active',
            goal: 'maintain',
            pace_lb_per_week: null,
        });

        expect((await getEstimate(HTTP_USER).expect(200)).body).toMatchObject({
            bmr: 389,
            calories: 1200,
            clamped: true,
            clampReason: 'floor',
        });
    });

    describe('estimateRevision', () => {
        it('echoes the preferences revision the inputs came from', async () => {
            // This number is the whole reason the save can refuse an estimate
            // computed from answers that have since moved: it is the preferences
            // `revision`, not a counter of its own.
            await seedHttpConfirmedEstimate();

            expect((await getEstimate(HTTP_USER).expect(200)).body).toMatchObject({
                estimateRevision: 1,
            });
            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({ revision: 1 });
        });

        it('moves when a real preference save advances that revision', async () => {
            await seedHttpConfirmedEstimate();

            await asUser(request.put(`${PREFERENCES_PATH}/steps/diet`), { uid: HTTP_USER })
                .send({
                    diet: 'vegan',
                    allergens: ['milk'],
                    timeZone: TIME_ZONE,
                    expectedRevision: 1,
                })
                .expect(200);

            // A diet is not a term in the energy equation, so the four numbers
            // are unchanged — and the revision they are attributed to is not.
            // That is what makes the pin an ancestry claim rather than a
            // checksum of the arithmetic.
            const refreshed = (await getEstimate(HTTP_USER).expect(200))
                .body as TargetEstimateResponse;

            expect(refreshed.estimateRevision).toBe(2);
            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({ revision: 2 });
        });
    });

    describe('the inputs come from storage and nowhere else', () => {
        it('ignores query parameters that name an input', async () => {
            await seedHttpConfirmedEstimate();

            const stored = (await getEstimate(HTTP_USER).expect(200)).body;
            const withQuery = await asUser(request.get(ESTIMATE_PATH), { uid: HTTP_USER })
                .query({
                    age: 99,
                    weightKg: 200,
                    activityLevel: 'very_active',
                    goal: 'gain',
                    sexForEstimate: 'female',
                })
                .expect(200);

            // Compared whole: any input the handler had taken from the query
            // would change `inputs` and the four figures derived from them.
            expect(withQuery.body).toEqual(stored);
        });

        it('ignores a request body that names an input', async () => {
            await seedHttpConfirmedEstimate();

            const stored = (await getEstimate(HTTP_USER).expect(200)).body;
            const withBody = await asUser(request.get(ESTIMATE_PATH), { uid: HTTP_USER })
                .send({ age: 99, weightKg: 200, activityLevel: 'very_active' })
                .expect(200);

            expect(withBody.body).toEqual(stored);
        });

        it('persists nothing by being read', async () => {
            await seedHttpConfirmedEstimate();

            const before = await storedTargetRecord(HTTP_USER);

            await getEstimate(HTTP_USER).expect(200);
            await getEstimate(HTTP_USER).expect(200);

            // The estimate is a derivation, not a record. A second source for
            // it could disagree with the inputs it claims to come from, so
            // reading it must leave `estimated_targets`, the revisions and the
            // confirmed figure exactly where they stood.
            expect(await storedTargetRecord(HTTP_USER)).toEqual(before);
        });
    });

    describe('409 estimate_unavailable', () => {
        it('reports the user\'s own answer as prefer_not_to_say', async () => {
            // An answer, not a gap: the client routes it to manual entry and
            // says so, which it can only do from the `reason` payload.
            await seedHttpConfirmedEstimate(HTTP_USER, { sex_for_estimate: 'prefer_not_to_say' });

            const response = await getEstimate(HTTP_USER).expect(409);

            expect(response.body).toEqual({
                error: 'estimate_unavailable',
                reason: 'prefer_not_to_say',
            });
        });

        it('reports an unanswered input as missing_inputs', async () => {
            await seedHttpConfirmedEstimate(HTTP_USER, { activity_level: null });

            expect((await getEstimate(HTTP_USER).expect(409)).body).toEqual({
                error: 'estimate_unavailable',
                reason: 'missing_inputs',
            });
        });

        it('reports a user with no preferences row as missing_inputs', async () => {
            // The same reason a row with gaps gets, because both lead the client
            // to the same manual-entry screen.
            await makeUser({ id: HTTP_USER });

            expect((await getEstimate(HTTP_USER).expect(409)).body).toEqual({
                error: 'estimate_unavailable',
                reason: 'missing_inputs',
            });
        });

        it('never leaks an error object, a stack or Prisma text', async () => {
            await seedHttpConfirmedEstimate(HTTP_USER, { sex_for_estimate: 'prefer_not_to_say' });

            const response = await getEstimate(HTTP_USER).expect(409);

            // Rule §4: the refusal body is a code and the data the client acts
            // on. `{error: err}` is the pattern that rule names as the one to
            // fix, so the assertion is on the body's WHOLE key set.
            expect(Object.keys(response.body as object).sort()).toEqual(['error', 'reason']);
            expect(JSON.stringify(response.body)).not.toMatch(
                /stack|prisma|Invocation|node_modules/i,
            );
        });
    });
});

/* ---------------------------------------------------------------------------
 * GET /api/meal-planning/targets — the canonical read
 *
 * Five surfaces act on this one verdict: Review, plan settings, Account,
 * Progress and the planner. `deriveTargetsResponse` decides what `complete`,
 * `source` and `stale` mean and is unit-tested on its two row shapes; every arm
 * below is instead a distinct PERSISTED state, reached through the writers that
 * really produce it — the canonical save, a real preference save, and the
 * untouched legacy route — and read back over the wire the client decodes.
 * ------------------------------------------------------------------------- */

describe('GET /api/meal-planning/targets', () => {
    it('refuses a request that carries no identity', async () => {
        expect((await request.get(TARGETS_PATH).expect(401)).body).toEqual({
            error: 'No token provided',
        });
    });

    it('answers 200 with a null target set for a user who never set one, and never 404', async () => {
        // THE ASSERTION THAT PROTECTS THE CLIENT'S UNAVAILABILITY DETECTION.
        // AAP §0.2.5 makes a 404 WITHOUT a decodable code from this
        // resource-less GET the client's signal that the meal-planning routes
        // are not mounted at all — a rolled-back backend. So "this user has no
        // targets" must never be spelled as a 404: it is a 200 whose `targets`
        // is null, and the client then falls back to its local value instead of
        // hiding the feature.
        await makeUser({ id: HTTP_USER });

        const response = await getTargetsOverHttp(HTTP_USER).expect(200);

        expect(response.body).toEqual({
            targets: null,
            complete: false,
            source: null,
            stale: false,
            revision: 0,
        });
    });

    it('keeps per-field nullability for a calories-only legacy account', async () => {
        // `users.target_*` are four independently nullable columns, and the
        // diary's own `resolveMacroTargets` resolves them FIELD BY FIELD. So a
        // partially set account must arrive as an OBJECT WITH NULLS INSIDE and
        // not as `targets: null` — the difference decides whether the diary
        // shows the user's real calorie target or falls back for all four.
        await makeUser({ id: HTTP_USER, target_calories: 1900 });

        const response = await getTargetsOverHttp(HTTP_USER).expect(200);

        expect(response.body).toEqual({
            targets: { calories: 1900, protein: null, carbs: null, fat: null },
            complete: false,
            // No preferences row, so the values cannot be attributed to a route
            // this feature ran.
            source: 'legacy',
            stale: false,
            revision: 0,
        });
    });

    it('reports revision 0 without a preferences row and the targets counter with one', async () => {
        await makeUser({ id: HTTP_USER, target_calories: 1900 });

        expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toMatchObject({
            revision: 0,
        });

        await prisma.users.delete({ where: { id: HTTP_USER } });
        await seedHttpConfirmedEstimate(HTTP_USER, { targets_revision: 4 });

        expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toMatchObject({
            revision: 4,
        });
    });

    describe('the route the values are attributed to', () => {
        it('reports a confirmed estimate as estimated, with the snapshot matching the columns', async () => {
            // Written by the canonical route rather than seeded, so the
            // attribution is a property of that write.
            await makeUser({ id: HTTP_USER });
            await makePreferences(HTTP_USER, {
                target_source: null,
                confirmed_targets: undefined,
                targets_revision: 0,
                targets_input_revision: null,
            });

            const estimate = (await getEstimate(HTTP_USER).expect(200))
                .body as TargetEstimateResponse;

            await saveTargetsOverHttp(HTTP_USER, {
                source: 'estimated',
                estimateRevision: estimate.estimateRevision,
            }).expect(200);

            expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toEqual({
                targets: {
                    calories: estimate.calories,
                    protein: estimate.protein,
                    carbs: estimate.carbs,
                    fat: estimate.fat,
                },
                complete: true,
                source: 'estimated',
                stale: false,
                revision: 1,
            });

            // The attribution is exactly this agreement: the snapshot the save
            // recorded equals the four columns it wrote. Asserted directly,
            // because it is the comparison `source` is derived from.
            const record = await storedTargetRecord(HTTP_USER);

            expect(record.confirmed_targets).toEqual({
                calories: estimate.calories,
                protein: estimate.protein,
                carbs: estimate.carbs,
                fat: estimate.fat,
            });
            expect(await storedUserTargets(HTTP_USER)).toEqual({
                target_calories: estimate.calories,
                target_protein_g: estimate.protein,
                target_carbs_g: estimate.carbs,
                target_fat_g: estimate.fat,
            });
        });

        it('reports hand-entered values as manual', async () => {
            await makeUser({ id: HTTP_USER });

            await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                calories: 1940,
                protein: 146,
                carbs: 194,
                fat: 65,
            }).expect(200);

            expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toEqual({
                targets: { calories: 1940, protein: 146, carbs: 194, fat: 65 },
                complete: true,
                source: 'manual',
                // Manual targets never go stale: the user typed them, so a
                // change of inputs says nothing about them.
                stale: false,
                revision: 1,
            });
        });

        describe('legacy', () => {
            it('is the verdict when values are set and no preferences row exists', async () => {
                // The first of the two causes: nobody confirmed these HERE, so
                // the planner must refuse to present a week built on them as
                // reviewed.
                await makeUser({ id: HTTP_USER, ...FIXTURE_USER_TARGET_COLUMNS });

                expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toEqual({
                    targets: { ...FIXTURE_TARGETS },
                    complete: true,
                    source: 'legacy',
                    stale: false,
                    revision: 0,
                });
            });

            it('is the verdict once the untouched legacy route moves a value after a confirmation', async () => {
                // The second cause, and the reason the attribution exists at
                // all: `PUT /api/user/targets` stays untouched for API
                // compatibility, never bumps the targets revision and leaves no
                // other trace, so comparing the columns with the snapshot is the
                // ONLY way this read stays truthful for an older client.
                await seedHttpConfirmedEstimate();

                expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toMatchObject({
                    source: 'estimated',
                });

                await asUser(request.put(LEGACY_TARGETS_PATH), { uid: HTTP_USER })
                    .send({ calories: FIXTURE_TARGETS.calories + 100 })
                    .expect(200);

                const response = await getTargetsOverHttp(HTTP_USER).expect(200);

                expect(response.body).toEqual({
                    targets: {
                        calories: FIXTURE_TARGETS.calories + 100,
                        protein: FIXTURE_TARGETS.protein,
                        carbs: FIXTURE_TARGETS.carbs,
                        fat: FIXTURE_TARGETS.fat,
                    },
                    complete: true,
                    source: 'legacy',
                    // Staleness is only ever claimed about a confirmed
                    // ESTIMATE; a legacy verdict already sends both surfaces to
                    // "review your targets".
                    stale: false,
                    // Untouched by the legacy writer, which is what makes the
                    // mismatch — rather than the counter — the signal.
                    revision: 1,
                });
                expect(await storedTargetRecord(HTTP_USER)).toMatchObject({
                    targets_revision: 1,
                    confirmed_targets: { ...FIXTURE_TARGETS },
                });
            });
        });
    });

    describe('stale', () => {
        it('becomes true when a preference save advances the revision, and the confirmed values stand', async () => {
            await seedHttpConfirmedEstimate();

            await asUser(request.put(`${PREFERENCES_PATH}/steps/activity`), { uid: HTTP_USER })
                .send({ activityLevel: 'very_active', timeZone: TIME_ZONE, expectedRevision: 1 })
                .expect(200);

            const response = await getTargetsOverHttp(HTTP_USER).expect(200);

            // BOTH halves matter. `stale` is how Review and plan settings come
            // to OFFER a recalculation — and the four values are untouched,
            // because a confirmed estimate is fixed once confirmed and nothing
            // recalculates on its own.
            expect(response.body).toEqual({
                targets: { ...FIXTURE_TARGETS },
                complete: true,
                source: 'estimated',
                stale: true,
                revision: 1,
            });

            // The fresh estimate really has moved, so the case is not passing
            // because the recalculation would be a no-op.
            expect((await getEstimate(HTTP_USER).expect(200)).body).toMatchObject({
                estimateRevision: 2,
            });
            expect(
                ((await getEstimate(HTTP_USER).expect(200)).body as TargetEstimateResponse).calories,
            ).not.toBe(FIXTURE_TARGETS.calories);
        });

        it('is false again once the user reconfirms at the current revision', async () => {
            await seedHttpConfirmedEstimate();

            await asUser(request.put(`${PREFERENCES_PATH}/steps/activity`), { uid: HTTP_USER })
                .send({ activityLevel: 'very_active', timeZone: TIME_ZONE, expectedRevision: 1 })
                .expect(200);

            const fresh = (await getEstimate(HTTP_USER).expect(200)).body as TargetEstimateResponse;

            await saveTargetsOverHttp(HTTP_USER, {
                source: 'estimated',
                estimateRevision: fresh.estimateRevision,
                expectedTargetsRevision: 1,
            }).expect(200);

            expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toEqual({
                targets: {
                    calories: fresh.calories,
                    protein: fresh.protein,
                    carbs: fresh.carbs,
                    fat: fresh.fat,
                },
                complete: true,
                source: 'estimated',
                stale: false,
                revision: 2,
            });
        });

        it('stays false for hand-entered values however many preference saves follow', async () => {
            await makeUser({ id: HTTP_USER });
            await makePreferences(HTTP_USER, {
                target_source: null,
                confirmed_targets: undefined,
                targets_revision: 0,
                targets_input_revision: null,
            });

            await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                calories: 1940,
                protein: 146,
                carbs: 194,
                fat: 65,
            }).expect(200);

            await asUser(request.put(`${PREFERENCES_PATH}/steps/activity`), { uid: HTTP_USER })
                .send({ activityLevel: 'very_active', timeZone: TIME_ZONE, expectedRevision: 1 })
                .expect(200);

            expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toMatchObject({
                source: 'manual',
                stale: false,
            });
        });
    });

    it('agrees with the stored columns and the diary response after one save', async () => {
        // THE PROMPT'S SYNCHRONISATION DIRECTIVE, and AAP §0.9.3's named
        // evidence: "the planner and diary must display the same confirmed
        // values".
        //
        // The third read is the load-bearing one. `GET /api/macros/:date`
        // resolves its `targets` block through the UNTOUCHED
        // `nutrition.service.ts::getTargetsForUser`, which reads the four
        // `users.target_*` columns and knows nothing about this feature. So its
        // agreement with the canonical read is what shows the canonical WRITER
        // wrote those shared columns — through the equally untouched
        // `updateTargets` — rather than a parallel store of its own that only
        // its own reader can see.
        await makeUser({ id: HTTP_USER });

        const values = { calories: 1940, protein: 146, carbs: 194, fat: 65 };

        await saveTargetsOverHttp(HTTP_USER, { source: 'manual', ...values }).expect(200);

        const canonical = (await getTargetsOverHttp(HTTP_USER).expect(200)).body as TargetsResponse;
        const diary = await asUser(request.get(`/api/macros/${DIARY_DAY_KEY}`), { uid: HTTP_USER })
            .expect(200);

        expect(canonical.targets).toEqual(values);
        expect((diary.body as DailyMacrosResponse).targets).toEqual(values);
        expect(await storedUserTargets(HTTP_USER)).toEqual({
            target_calories: values.calories,
            target_protein_g: values.protein,
            target_carbs_g: values.carbs,
            target_fat_g: values.fat,
        });
    });
});

/* ---------------------------------------------------------------------------
 * PUT /api/meal-planning/targets — the canonical writer
 *
 * The single path that writes `users.target_*` for an opted-in user, and the
 * only one that records what was confirmed. Two things are asserted here that
 * exist nowhere else: that ONE transaction carries both halves of the write, and
 * that the pinned revision is enforced rather than merely checked. The envelope
 * parser and the bound arithmetic are `targets.logic.test.ts`'s; what the
 * boundary owns is which status, code and payload each refusal becomes, and what
 * the database holds afterwards.
 * ------------------------------------------------------------------------- */

/** Four coherent values: the macros' energy is within a rounding of the calories. */
const COHERENT_TARGETS = { calories: 2000, protein: 150, carbs: 200, fat: 67 } as const;

/** A row that has never confirmed anything, so the first save is the first save. */
const seedUnconfirmedPreferences = async (
    uid: string = HTTP_USER,
    overrides: Parameters<typeof makePreferences>[1] = {},
): Promise<void> => {
    await makeUser({ id: uid });
    await makePreferences(uid, {
        target_source: null,
        confirmed_targets: undefined,
        targets_revision: 0,
        targets_input_revision: null,
        ...overrides,
    });
};

describe('PUT /api/meal-planning/targets', () => {
    it('refuses a request that carries no identity', async () => {
        const response = await request
            .put(TARGETS_PATH)
            .send({ source: 'manual', ...COHERENT_TARGETS })
            .expect(401);

        expect(response.body).toEqual({ error: 'No token provided' });
    });

    describe('the envelope', () => {
        it('refuses a body that is not an object', async () => {
            await seedUnconfirmedPreferences();

            const response = await saveTargetsOverHttp(HTTP_USER, []).expect(400);

            expect(response.body).toMatchObject({ error: 'invalid_request' });
            expect(refusalDetails(response.body)).toEqual([
                { field: 'body', code: 'invalid_type' },
            ]);
        });

        it('refuses a body that declares no source', async () => {
            await seedUnconfirmedPreferences();

            const response = await saveTargetsOverHttp(HTTP_USER, {}).expect(400);

            expect(refusalDetails(response.body)).toEqual([
                { field: 'source', code: 'required' },
            ]);
        });

        it('refuses a source outside the two the envelope accepts', async () => {
            await seedUnconfirmedPreferences();

            const response = await saveTargetsOverHttp(HTTP_USER, {
                source: 'calculated',
                ...COHERENT_TARGETS,
            }).expect(400);

            expect(refusalDetails(response.body)).toEqual([
                { field: 'source', code: 'unknown_value' },
            ]);
        });

        it('refuses an estimated body that also carries manual values', async () => {
            // The two arms are CLOSED key sets, so a mixed body is refused
            // rather than half-read. That is what makes "the client never sends
            // the numbers" enforceable on the estimated arm.
            await seedUnconfirmedPreferences();

            const response = await saveTargetsOverHttp(HTTP_USER, {
                source: 'estimated',
                estimateRevision: 1,
                ...COHERENT_TARGETS,
            }).expect(400);

            expect(refusalDetails(response.body).map((detail) => detail.field).sort()).toEqual([
                'calories',
                'carbs',
                'fat',
                'protein',
            ]);
            expect(
                refusalDetails(response.body).every((detail) => detail.code === 'unknown_field'),
            ).toBe(true);
        });

        it('refuses a manual body that also pins an estimate revision', async () => {
            // The other direction: nothing was recomputed, so there are no
            // inputs to pin, and a body that pins some is describing the other
            // shape.
            await seedUnconfirmedPreferences();

            const response = await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
                estimateRevision: 1,
            }).expect(400);

            expect(refusalDetails(response.body)).toEqual([
                { field: 'estimateRevision', code: 'unknown_field' },
            ]);
        });

        it('refuses an estimated body that pins no estimate revision', async () => {
            await seedUnconfirmedPreferences();

            const response = await saveTargetsOverHttp(HTTP_USER, { source: 'estimated' }).expect(
                400,
            );

            expect(refusalDetails(response.body)).toEqual([
                { field: 'estimateRevision', code: 'required' },
            ]);
        });

        it('reports every offending field in one answer, so the screen can show them at once', async () => {
            await seedUnconfirmedPreferences();

            const response = await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                calories: 2000,
                protein: 0,
                carbs: 0,
                fat: 65,
                userId: OTHER_HTTP_USER,
            }).expect(400);

            expect(refusalDetails(response.body)).toEqual([
                { field: 'protein', code: 'below_minimum' },
                { field: 'carbs', code: 'below_minimum' },
                { field: 'userId', code: 'unknown_field' },
            ]);
        });

        it('writes nothing when the envelope is refused', async () => {
            await seedUnconfirmedPreferences();

            const before = await storedTargetRecord(HTTP_USER);

            await saveTargetsOverHttp(HTTP_USER, { source: 'manual', calories: 2000 }).expect(400);

            expect(await storedTargetRecord(HTTP_USER)).toEqual(before);
            expect(await storedUserTargets(HTTP_USER)).toEqual({
                target_calories: null,
                target_protein_g: null,
                target_carbs_g: null,
                target_fat_g: null,
            });
        });
    });

    describe('the estimated arm', () => {
        it('stores the server recomputation, which a client cannot offer for itself', async () => {
            // Two halves, and both are needed. The case above shows a body
            // carrying numbers is REFUSED — the client cannot even offer them —
            // and this one shows what is stored when it does not: the figure
            // this server recomputes from the stored answers, value for value
            // with what the estimate route returns.
            await seedUnconfirmedPreferences();

            const estimate = (await getEstimate(HTTP_USER).expect(200))
                .body as TargetEstimateResponse;
            const saved = await saveTargetsOverHttp(HTTP_USER, {
                source: 'estimated',
                estimateRevision: estimate.estimateRevision,
            }).expect(200);

            expect((saved.body as SaveTargetsResponse).targets.targets).toEqual({
                calories: estimate.calories,
                protein: estimate.protein,
                carbs: estimate.carbs,
                fat: estimate.fat,
            });
            expect(await storedUserTargets(HTTP_USER)).toEqual({
                target_calories: estimate.calories,
                target_protein_g: estimate.protein,
                target_carbs_g: estimate.carbs,
                target_fat_g: estimate.fat,
            });
        });

        it('records the pinned input revision as the confirmed figure\'s ancestry', async () => {
            await seedUnconfirmedPreferences();

            await saveTargetsOverHttp(HTTP_USER, {
                source: 'estimated',
                estimateRevision: 1,
            }).expect(200);

            // This is the number `stale` is later compared against, so the save
            // recording it is what makes staleness answerable at all.
            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({
                target_source: 'estimated',
                targets_input_revision: 1,
                revision: 1,
            });
        });

        it('refuses an estimate pinned to answers the row has moved past', async () => {
            await seedUnconfirmedPreferences();

            const response = await saveTargetsOverHttp(HTTP_USER, {
                source: 'estimated',
                estimateRevision: 99,
            }).expect(409);

            expect(response.body).toEqual({ error: 'estimate_stale' });
            expect(await storedUserTargets(HTTP_USER)).toMatchObject({ target_calories: null });
        });

        it('refuses to confirm a calculated figure for a user with no answers on file', async () => {
            // No preferences row at all: there is nothing to recompute from, so
            // the save cannot be turned into a confirmation of anything.
            await makeUser({ id: HTTP_USER });

            const response = await saveTargetsOverHttp(HTTP_USER, {
                source: 'estimated',
                estimateRevision: 0,
            }).expect(409);

            expect(response.body).toEqual({
                error: 'estimate_unavailable',
                reason: 'missing_inputs',
            });
            expect(await prisma.meal_plan_preferences.count({ where: { user_id: HTTP_USER } })).toBe(
                0,
            );
        });
    });

    describe('the two revisions are distinct tokens', () => {
        /**
         * A row whose two counters differ, which is the only state that can
         * tell them apart: `estimateRevision` pins the ANSWERS (`revision` 1)
         * and `expectedTargetsRevision` pins the TARGET RECORD
         * (`targets_revision` 3). Conflating them is the obvious implementation
         * slip, and swapping the two values is what surfaces it.
         */
        const seedDivergedRevisions = () =>
            seedHttpConfirmedEstimate(HTTP_USER, {
                targets_revision: 3,
                revision: 1,
                targets_input_revision: 1,
            });

        it('accepts the save when each token pins its own counter', async () => {
            await seedDivergedRevisions();

            await saveTargetsOverHttp(HTTP_USER, {
                source: 'estimated',
                estimateRevision: 1,
                expectedTargetsRevision: 3,
            }).expect(200);

            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({
                targets_revision: 4,
                targets_input_revision: 1,
                revision: 1,
            });
        });

        it('refuses the estimate when the answers token carries the target record\'s value', async () => {
            await seedDivergedRevisions();

            expect(
                (
                    await saveTargetsOverHttp(HTTP_USER, {
                        source: 'estimated',
                        estimateRevision: 3,
                        expectedTargetsRevision: 3,
                    }).expect(409)
                ).body,
            ).toEqual({ error: 'estimate_stale' });
        });

        it('refuses the record when the target token carries the answers\' value', async () => {
            await seedDivergedRevisions();

            expect(
                (
                    await saveTargetsOverHttp(HTTP_USER, {
                        source: 'estimated',
                        estimateRevision: 1,
                        expectedTargetsRevision: 1,
                    }).expect(409)
                ).body,
            ).toEqual({ error: 'stale_targets', currentRevision: 3 });
        });
    });

    describe('expectedTargetsRevision', () => {
        it('may be omitted on the very first save, when there is no revision to pin', async () => {
            await seedUnconfirmedPreferences();

            await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
            }).expect(200);

            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({ targets_revision: 1 });
        });

        it('is required once a revision exists, and its absence is a stale pin', async () => {
            // Not a 400: the omission means the client is acting on a target
            // record it has not seen, which is the same situation as pinning the
            // wrong one. The authoritative revision comes back either way, so
            // one recovery path serves both.
            await seedHttpConfirmedEstimate();

            const response = await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
            }).expect(409);

            expect(response.body).toEqual({ error: 'stale_targets', currentRevision: 1 });
        });

        it('refuses a mismatch and names the authoritative revision', async () => {
            await seedHttpConfirmedEstimate(HTTP_USER, { targets_revision: 7 });

            const response = await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
                expectedTargetsRevision: 6,
            }).expect(409);

            // `currentRevision` is what lets the client re-read, compare with
            // its draft and resolve silently when the two already agree.
            expect(response.body).toEqual({ error: 'stale_targets', currentRevision: 7 });
        });

        it('refuses a pinned revision against a stored zero', async () => {
            // The client pinned a revision that never existed, which is as much
            // a lost update as pinning the wrong one.
            await seedUnconfirmedPreferences();

            expect(
                (
                    await saveTargetsOverHttp(HTTP_USER, {
                        source: 'manual',
                        ...COHERENT_TARGETS,
                        expectedTargetsRevision: 1,
                    }).expect(409)
                ).body,
            ).toEqual({ error: 'stale_targets', currentRevision: 0 });
        });

        it('increments the stored revision by exactly one per accepted save', async () => {
            await seedUnconfirmedPreferences();

            for (const expectedTargetsRevision of [null, 1, 2]) {
                const body =
                    expectedTargetsRevision === null
                        ? { source: 'manual', ...COHERENT_TARGETS }
                        : { source: 'manual', ...COHERENT_TARGETS, expectedTargetsRevision };
                const saved = await saveTargetsOverHttp(HTTP_USER, body).expect(200);

                expect((saved.body as SaveTargetsResponse).targets.revision).toBe(
                    (expectedTargetsRevision ?? 0) + 1,
                );
            }

            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({ targets_revision: 3 });
        });
    });

    describe('one transaction, both halves', () => {
        /**
         * The injected failure's message.
         *
         * It carries no code the controller maps, deliberately: an untyped
         * failure is what a genuine mid-transaction fault looks like, and the
         * 500 it becomes is the honest answer the route already gives for one
         * (see the "no `users` row" throw in `targets.service.ts`).
         */
        const POST_WRITE_FAULT_MESSAGE =
            'injected fault: the save failed after both halves had written';

        /**
         * Every column of the preferences row, for a comparison an atomicity
         * proof cannot afford to make narrower.
         *
         * `storedTargetRecord` projects the seven columns the attribution is
         * made of, which is what every other case here needs. A half-committed
         * save is a different question: ANY column left behind is the defect,
         * including one nobody thought to select, so this reads the row whole.
         * The table carries no timestamps, so comparing two reads of it is
         * stable.
         */
        const storedPreferencesRow = (uid: string): Promise<meal_plan_preferences> =>
            prisma.meal_plan_preferences.findUniqueOrThrow({ where: { user_id: uid } });

        /** What the injected failure saw of the two halves, from inside the transaction. */
        interface PostWriteObservation {
            /** The four values the `users` half was asked to write. */
            requested: Partial<MacroTargetsResponse>;
            /**
             * Whether that half was handed the save's own transaction client.
             * False would mean it wrote on the autocommit client, which no
             * rollback can reach — the defect this describe exists to detect,
             * and one that would otherwise be invisible.
             */
            transactional: boolean;
            /** `users.target_*` as that half left them, read back before the failure. */
            columns: MacroTargetsResponse | null;
            /** The preferences half's row, read through the same client the save is using. */
            record: meal_plan_preferences | null;
        }

        /**
         * Runs `assertions` with the save rigged to fail AFTER both halves have
         * written, reporting what each of them wrote on the way.
         *
         * WHY A SPY ON `updateTargets` IS THE SEAM. `saveTargets` records the
         * preferences half first and then calls
         * `updateTargets(userId, values, tx)` for `users.target_*`. A spy that
         * awaits the real function and only then throws therefore raises its
         * failure at the one instant when BOTH halves are written and neither is
         * committed — which is the only state in which a save built as one
         * transaction is distinguishable from one that writes twice and hopes.
         * Nothing is stubbed out: the production writes really happen, and what
         * is injected is the failure that has to take them back.
         *
         * The observation is taken through the client the save handed the
         * writer, so `record` is the uncommitted preferences half as that
         * transaction sees it. That is what makes the assertions after the
         * request a ROLLBACK proof rather than another refusal: the same facts
         * are asserted PRESENT inside the transaction and ABSENT once it has
         * gone.
         *
         * The error log is silenced because the 500 is deliberate, and asserted
         * because a failure the controller swallowed would otherwise read like a
         * clean rollback. Both spies are restored in the `finally`:
         * `clearMocks` clears calls and leaves implementations standing.
         */
        const withFailureAfterBothHalves = async (
            assertions: (observed: PostWriteObservation[]) => Promise<void>,
        ): Promise<void> => {
            const write = nutritionService.updateTargets;
            const observed: PostWriteObservation[] = [];
            const fault = jest
                .spyOn(nutritionService, 'updateTargets')
                .mockImplementation(async (userId, targets, db) => {
                    const columns = await write(userId, targets, db);
                    const client = db ?? prisma;
                    const record = await client.meal_plan_preferences.findUnique({
                        where: { user_id: userId },
                    });

                    observed.push({
                        requested: targets,
                        transactional: db !== undefined,
                        columns,
                        record,
                    });

                    throw new Error(POST_WRITE_FAULT_MESSAGE);
                });
            const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                await assertions(observed);

                expect(fault).toHaveBeenCalledTimes(1);
                // THE INJECTED FAILURE IS THE ONE THAT ENDED THE REQUEST, read
                // off the single server event the residual 500 emits. Asserting
                // only that something was logged would let an unrelated error —
                // a typo in the request body reaching a different branch, say —
                // stand in for the fault and make every "nothing moved"
                // assertion below vacuous.
                //
                // The attribution is no longer the fault's MESSAGE, because
                // `failRequest` describes a throw by name and machine code
                // alone: the route it answered, the status, the one stable code
                // and `errorName: 'Error'` — this fault is deliberately untyped,
                // so no mapped error class answered it — are what identify it.
                // The message's ABSENCE is asserted beside them rather than
                // assumed, because redacting it is the point of that shape and
                // not a side effect of it.
                expect(errorLog).toHaveBeenCalledTimes(1);
                // ONE argument, and a string: the second argument that used to
                // carry the error object is exactly where a fault's message, its
                // stack and a Prisma `meta` reached the log.
                expect(errorLog.mock.calls[0]).toHaveLength(1);

                const [failureLine] = errorLog.mock.calls[0];

                expect(failureLine).toContain('[meal-planning] request_failed');
                expect(failureLine).toContain('"action":"targets.save"');
                expect(failureLine).toContain(`"userId":"${HTTP_USER}"`);
                expect(failureLine).toContain('"status":500');
                expect(failureLine).toContain('"code":"internal_error"');
                expect(failureLine).toContain('"errorName":"Error"');
                expect(failureLine).not.toContain(POST_WRITE_FAULT_MESSAGE);
            } finally {
                fault.mockRestore();
                errorLog.mockRestore();
            }
        };

        it('writes the columns, the snapshot, the source, the revision and the ancestry together', async () => {
            await seedUnconfirmedPreferences();

            const estimate = (await getEstimate(HTTP_USER).expect(200))
                .body as TargetEstimateResponse;
            const values = {
                calories: estimate.calories,
                protein: estimate.protein,
                carbs: estimate.carbs,
                fat: estimate.fat,
            };

            await saveTargetsOverHttp(HTTP_USER, {
                source: 'estimated',
                estimateRevision: estimate.estimateRevision,
            }).expect(200);

            // All five facts, because the write is only canonical if every one
            // of them landed: the columns every surface reads, the snapshot the
            // attribution compares against, the route, the bumped token, and
            // the ancestry staleness is judged by.
            expect(await storedUserTargets(HTTP_USER)).toEqual({
                target_calories: values.calories,
                target_protein_g: values.protein,
                target_carbs_g: values.carbs,
                target_fat_g: values.fat,
            });
            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({
                target_source: 'estimated',
                confirmed_targets: values,
                targets_revision: 1,
                targets_input_revision: estimate.estimateRevision,
            });
        });

        it('moves neither half when the pinned revision is refused', async () => {
            // THE ATOMICITY ASSERTION. A `users` write without the preferences
            // write would leave a confirmed target recorded against preferences
            // that never got it — the canonical read would then report `legacy`
            // for a figure this feature had just written. The refusal is raised
            // inside the transaction, so both halves must be exactly where they
            // stood.
            await seedHttpConfirmedEstimate();

            const columnsBefore = await storedUserTargets(HTTP_USER);
            const recordBefore = await storedTargetRecord(HTTP_USER);

            await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                calories: 1234,
                protein: 123,
                carbs: 123,
                fat: 12,
                expectedTargetsRevision: 99,
            }).expect(409);

            expect(await storedUserTargets(HTTP_USER)).toEqual(columnsBefore);
            expect(await storedTargetRecord(HTTP_USER)).toEqual(recordBefore);
            expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toMatchObject({
                targets: { ...FIXTURE_TARGETS },
                source: 'estimated',
            });
        });

        it('takes the users columns back when the failure lands after both halves have written', async () => {
            // THE POST-WRITE ATOMICITY PROOF, and the one the case above cannot
            // make: a refusal raised before either half runs passes just as
            // happily for a save that writes `users.target_*`, commits it, and
            // only then fails while recording the snapshot. What that would cost
            // is specific — a confirmed target the preferences row never got, so
            // the canonical read's attribution is derived from a DISAGREEMENT
            // and reports `legacy` for a figure this feature had just written,
            // after which the planner refuses to build a week on the user's own
            // targets (§0.5.2). Nothing but a failure injected between the two
            // writes can tell the two implementations apart, so that is what is
            // injected here, against a save with nothing refusable about it.
            await seedHttpConfirmedEstimate();

            const columnsBefore = await storedUserTargets(HTTP_USER);
            const rowBefore = await storedPreferencesRow(HTTP_USER);

            await withFailureAfterBothHalves(async (observed) => {
                const response = await saveTargetsOverHttp(HTTP_USER, {
                    source: 'manual',
                    ...COHERENT_TARGETS,
                    expectedTargetsRevision: 1,
                }).expect(500);

                expect(response.body).toEqual({ error: 'internal_error' });

                // WHAT MAKES THIS A POST-WRITE CASE rather than a fourth
                // refusal: the values the failing half had already written,
                // observed inside the transaction and different from the
                // fixture's in all four fields, beside the preferences half that
                // had already recorded them at the bumped revision.
                expect(observed).toHaveLength(1);
                expect(observed[0].transactional).toBe(true);
                expect(observed[0].requested).toEqual({ ...COHERENT_TARGETS });
                expect(observed[0].columns).toEqual({ ...COHERENT_TARGETS });
                expect(observed[0].record).toMatchObject({
                    target_source: 'manual',
                    confirmed_targets: { ...COHERENT_TARGETS },
                    targets_revision: 2,
                    targets_input_revision: null,
                });
            });

            // Both halves, byte for byte — and the preferences half as a WHOLE
            // ROW, so a column outside the attribution projection cannot survive
            // the failure unnoticed either.
            expect(await storedUserTargets(HTTP_USER)).toEqual(columnsBefore);
            expect(await storedPreferencesRow(HTTP_USER)).toEqual(rowBefore);

            // The user-visible statement of the two assertions above: the
            // canonical read still reports the pre-call figure on every term it
            // answers, attribution and staleness included.
            expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toEqual({
                targets: { ...FIXTURE_TARGETS },
                complete: true,
                source: 'estimated',
                stale: false,
                revision: 1,
            });
        });

        it('takes the ancestry the estimated route writes back with it', async () => {
            // The other arm, because it writes three things the manual arm does
            // not: `targets_input_revision` — the number `stale` is judged
            // against — `estimated_targets`, the only surviving account of the
            // calculation, and `target_source: 'estimated'`. A rollback that
            // missed any of them would leave the row claiming a calculated
            // ancestry for a figure it does not hold, which is the same
            // disagreement as above wearing the other route's name.
            await seedUnconfirmedPreferences();

            const estimate = (await getEstimate(HTTP_USER).expect(200))
                .body as TargetEstimateResponse;
            const values = {
                calories: estimate.calories,
                protein: estimate.protein,
                carbs: estimate.carbs,
                fat: estimate.fat,
            };
            const rowBefore = await storedPreferencesRow(HTTP_USER);

            // The starting state stated rather than assumed: nothing here has
            // been confirmed, so every column the save is about to write is
            // unset, and the comparison after the failure has something to mean.
            expect(rowBefore).toMatchObject({
                target_source: null,
                confirmed_targets: null,
                targets_revision: 0,
                targets_input_revision: null,
                estimated_targets: null,
            });

            await withFailureAfterBothHalves(async (observed) => {
                const response = await saveTargetsOverHttp(HTTP_USER, {
                    source: 'estimated',
                    estimateRevision: estimate.estimateRevision,
                }).expect(500);

                expect(response.body).toEqual({ error: 'internal_error' });

                expect(observed).toHaveLength(1);
                expect(observed[0].transactional).toBe(true);
                expect(observed[0].columns).toEqual(values);
                // Every column this arm writes, present inside the transaction —
                // so their absence afterwards is a rollback and not a save that
                // never reached them.
                expect(observed[0].record).toMatchObject({
                    target_source: 'estimated',
                    confirmed_targets: values,
                    targets_revision: 1,
                    targets_input_revision: estimate.estimateRevision,
                    estimated_targets: {
                        inputRevision: estimate.estimateRevision,
                        calories: estimate.calories,
                        protein: estimate.protein,
                        carbs: estimate.carbs,
                        fat: estimate.fat,
                    },
                });
            });

            expect(await storedUserTargets(HTTP_USER)).toEqual({
                target_calories: null,
                target_protein_g: null,
                target_carbs_g: null,
                target_fat_g: null,
            });
            expect(await storedPreferencesRow(HTTP_USER)).toEqual(rowBefore);

            // Still a user who has confirmed nothing, which is the honest
            // reading of a save that failed: no values, no attribution, and the
            // revision a first save will pin.
            expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toEqual({
                targets: null,
                complete: false,
                source: null,
                stale: false,
                revision: 0,
            });
        });

        it('leaves no preferences row behind when the row it created cannot commit', async () => {
            // THE CREATE ARM, which is the half an upsert committed outside the
            // transaction would strand. A legacy user editing targets from
            // Account has no preferences row at all, so this save creates one
            // (§0.5.2, and the section below on what that row looks like). A
            // create that survived the failure would leave a user who never ran
            // the wizard holding a row claiming a confirmed target nobody holds,
            // and a `targets_revision` their next save would have to pin against
            // it.
            await makeUser({ id: HTTP_USER });

            await withFailureAfterBothHalves(async (observed) => {
                const response = await saveTargetsOverHttp(HTTP_USER, {
                    source: 'manual',
                    ...COHERENT_TARGETS,
                }).expect(500);

                expect(response.body).toEqual({ error: 'internal_error' });

                expect(observed).toHaveLength(1);
                expect(observed[0].transactional).toBe(true);
                expect(observed[0].columns).toEqual({ ...COHERENT_TARGETS });
                // The row really was created, inside the transaction and in the
                // shape the section below pins — so its absence afterwards is
                // that create being rolled back rather than never attempted.
                expect(observed[0].record).toMatchObject({
                    setup_status: 'not_started',
                    setup_step: null,
                    target_source: 'manual',
                    confirmed_targets: { ...COHERENT_TARGETS },
                    targets_revision: 1,
                    targets_input_revision: null,
                    revision: 1,
                });
            });

            expect(await prisma.meal_plan_preferences.count({ where: { user_id: HTTP_USER } })).toBe(
                0,
            );
            expect(await storedUserTargets(HTTP_USER)).toEqual({
                target_calories: null,
                target_protein_g: null,
                target_carbs_g: null,
                target_fat_g: null,
            });
            expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toEqual({
                targets: null,
                complete: false,
                source: null,
                stale: false,
                revision: 0,
            });
        });

        it('leaves the route usable: the identical save then commits and moves the revision one step', async () => {
            // What the three cases above cannot show on their own. A rollback
            // that wedged the user — a leaked lock, or a revision consumed by
            // the attempt — would satisfy every "nothing moved" assertion and
            // still have broken the route. So the same body, pinned at the same
            // revision, is re-sent once the injected failure is gone: it must
            // succeed, and the revision must move exactly ONE step from where
            // the fixture stood, which is only true if the failed attempt
            // stranded nothing. (The lock is `pg_advisory_xact_lock`, released
            // at ROLLBACK as well as COMMIT, and this is the assertion that
            // holds that choice in place.)
            await seedHttpConfirmedEstimate();

            const save = () =>
                saveTargetsOverHttp(HTTP_USER, {
                    source: 'manual',
                    ...COHERENT_TARGETS,
                    expectedTargetsRevision: 1,
                });

            await withFailureAfterBothHalves(async (observed) => {
                await save().expect(500);

                expect(observed).toHaveLength(1);
            });

            const saved = (await save().expect(200)).body as SaveTargetsResponse;

            expect(saved.targets).toEqual({
                targets: { ...COHERENT_TARGETS },
                complete: true,
                source: 'manual',
                stale: false,
                revision: 2,
            });
            expect(await storedUserTargets(HTTP_USER)).toEqual({
                target_calories: COHERENT_TARGETS.calories,
                target_protein_g: COHERENT_TARGETS.protein,
                target_carbs_g: COHERENT_TARGETS.carbs,
                target_fat_g: COHERENT_TARGETS.fat,
            });
            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({
                target_source: 'manual',
                confirmed_targets: { ...COHERENT_TARGETS },
                targets_revision: 2,
                targets_input_revision: null,
            });
        });
    });

    describe('a legacy user saving targets before any onboarding', () => {
        /** The Account-screen case: targets edited by a user who has never run the wizard. */
        const saveFromAccount = async (): Promise<void> => {
            await makeUser({ id: HTTP_USER });
            await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
            }).expect(200);
        };

        it('creates the row it needs, at revision 1 and not_started', async () => {
            await saveFromAccount();

            expect(await storedTargetRecord(HTTP_USER)).toEqual({
                setup_status: 'not_started',
                setup_step: null,
                target_source: 'manual',
                confirmed_targets: { ...COHERENT_TARGETS },
                targets_revision: 1,
                // Manual values have no calculated ancestry.
                targets_input_revision: null,
                // AAP §0.5.2: the revision the client then pins on its first
                // preference save.
                revision: 1,
            });
        });

        it('sets nothing else, because a target is not an answer to the wizard', async () => {
            await saveFromAccount();

            const row = await prisma.meal_plan_preferences.findUniqueOrThrow({
                where: { user_id: HTTP_USER },
            });

            // A naive upsert that filled in defaults here would put a legacy
            // user halfway through an onboarding they never started.
            expect({
                goal: row.goal,
                age: row.age,
                height_cm: row.height_cm,
                weight_kg: row.weight_kg,
                sex_for_estimate: row.sex_for_estimate,
                activity_level: row.activity_level,
                diet: row.diet,
                meal_schedule: row.meal_schedule,
                meal_times: row.meal_times,
                cooking_time_limit_min: row.cooking_time_limit_min,
                target_route: row.target_route,
                time_zone: row.time_zone,
                review_start_date: row.review_start_date,
                allergens: row.allergens,
                disliked_food_ids: row.disliked_food_ids,
                disliked_food_groups: row.disliked_food_groups,
            }).toEqual({
                goal: null,
                age: null,
                height_cm: null,
                weight_kg: null,
                sex_for_estimate: null,
                activity_level: null,
                diet: null,
                meal_schedule: null,
                meal_times: null,
                cooking_time_limit_min: null,
                target_route: null,
                time_zone: null,
                review_start_date: null,
                allergens: [],
                disliked_food_ids: [],
                disliked_food_groups: [],
            });
        });

        it('is not onboarding progress: the preferences read still says not_started', async () => {
            await saveFromAccount();

            const response = await asUser(request.get(PREFERENCES_PATH), { uid: HTTP_USER }).expect(
                200,
            );

            expect(response.body).toMatchObject({ setupStatus: 'not_started', setupStep: null });
        });

        it('still invents no progress when the same user saves targets again', async () => {
            // The second save takes the UPDATE arm rather than the create arm,
            // which is where the conditional setup advance lives. A row that
            // never started the wizard has no stop to answer, so the marker
            // must stay absent however many times targets are edited from
            // Account.
            await saveFromAccount();
            await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
                expectedTargetsRevision: 1,
            }).expect(200);

            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({
                setup_status: 'not_started',
                setup_step: null,
                targets_revision: 2,
            });
        });
    });

    /* -----------------------------------------------------------------------
     * The manual route's own stop
     *
     * `targets_manual` is a stop on the manual route's wizard that saves
     * through THIS endpoint rather than as a setup step (AAP §0.7.4), so no
     * `PUT /preferences/steps/:step` request can answer it and nothing but the
     * target save can move the marker off it. Only a real walk through the
     * wizard produces that state: the marker is written by the body step's
     * Skip branch, and the advance is judged against the row that branch left
     * behind.
     * --------------------------------------------------------------------- */

    describe('the manual route, resuming after its targets are confirmed', () => {
        /** Frame 02, as the client saves it — the save that creates the row. */
        const GOAL_STEP_BODY = {
            goal: 'lose',
            goalWeightKg: 70,
            paceLbPerWeek: 1,
            timeZone: TIME_ZONE,
        } as const;

        const saveStepOverHttp = (step: string, body: Record<string, unknown>) =>
            asUser(request.put(`${PREFERENCES_PATH}/steps/${step}`), { uid: HTTP_USER }).send(body);

        const readPreferencesOverHttp = async (): Promise<Record<string, unknown>> =>
            (await asUser(request.get(PREFERENCES_PATH), { uid: HTTP_USER }).expect(200)).body as Record<
                string,
                unknown
            >;

        /**
         * Walks the wizard to the manual target screen the way the client
         * does: the goal step creates the row, and Skip on the body step is
         * one of the two answers that select the manual route (it sends no
         * measurements at all, so the stored route is the only record of the
         * choice).
         */
        const walkToTheTargetStop = async (): Promise<void> => {
            await makeUser({ id: HTTP_USER });
            await saveStepOverHttp('goal', { ...GOAL_STEP_BODY }).expect(200);
            await saveStepOverHttp('body', {
                skipped: true,
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            }).expect(200);
        };

        const confirmManualTargets = () =>
            saveTargetsOverHttp(HTTP_USER, { source: 'manual', ...COHERENT_TARGETS });

        it('reaches that stop through the wizard, with no targets confirmed yet', async () => {
            // The starting state the rest of this group depends on. Without it
            // the advance below could pass by moving a marker that was never
            // on the target screen.
            await walkToTheTargetStop();

            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({
                setup_status: 'in_progress',
                setup_step: 'targets_manual',
                target_source: null,
                targets_revision: 0,
                revision: 2,
            });
        });

        it('advances the resume marker to Diet, so a force-quit does not reopen the editor', async () => {
            await walkToTheTargetStop();
            await confirmManualTargets().expect(200);

            // The whole finding: before this, the marker stayed on
            // `targets_manual` and "Continue setup" reopened the target screen
            // the user had just completed.
            expect(await readPreferencesOverHttp()).toMatchObject({
                setupStatus: 'in_progress',
                setupStep: 'diet',
                targetRoute: 'manual',
            });
        });

        it('leaves the preferences revision exactly where it stood', async () => {
            await walkToTheTargetStop();
            await confirmManualTargets().expect(200);

            // `revision` is what a client pins when it writes preference
            // ANSWERS, and this save changed no answer. The client still sees
            // the new marker, because a target save invalidates the
            // preferences query (AAP §0.7.2).
            expect(await readPreferencesOverHttp()).toMatchObject({ revision: 2 });
            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({ revision: 2 });
        });

        it('accepts the very next step save, which a revision bump would have refused', async () => {
            // The consequence of the line above, stated as behaviour: Diet is
            // the stop the marker now names, and the client pins the revision
            // it last read. A bump here would answer that save with a
            // spurious `409 stale_revision` on the one route where it always
            // follows.
            await walkToTheTargetStop();
            await confirmManualTargets().expect(200);

            await saveStepOverHttp('diet', {
                diet: 'vegetarian',
                allergens: ['milk'],
                timeZone: TIME_ZONE,
                expectedRevision: 2,
            }).expect(200);

            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({
                setup_status: 'in_progress',
                setup_step: 'dislikes',
                revision: 3,
            });
        });

        it('stores and reports the confirmed targets exactly as it does on any other route', async () => {
            await walkToTheTargetStop();

            const response = await confirmManualTargets().expect(200);

            // The advance rides along with the target write; it changes
            // nothing about what that write stores or answers.
            expect((response.body as SaveTargetsResponse).targets).toEqual({
                targets: { ...COHERENT_TARGETS },
                complete: true,
                source: 'manual',
                stale: false,
                revision: 1,
            });
            expect(await storedUserTargets(HTTP_USER)).toEqual({
                target_calories: COHERENT_TARGETS.calories,
                target_protein_g: COHERENT_TARGETS.protein,
                target_carbs_g: COHERENT_TARGETS.carbs,
                target_fat_g: COHERENT_TARGETS.fat,
            });
            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({
                target_source: 'manual',
                confirmed_targets: { ...COHERENT_TARGETS },
                // The one counter this save does advance.
                targets_revision: 1,
                // Hand-entered values have no calculated ancestry.
                targets_input_revision: null,
            });
        });

        it('moves the marker no further when the same targets are saved again', async () => {
            // An edit-mode re-save from later in the wizard, or a user
            // returning to the target screen: the stop has been answered, and
            // progress is not earned a second time.
            await walkToTheTargetStop();
            await confirmManualTargets().expect(200);
            await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
                expectedTargetsRevision: 1,
            }).expect(200);

            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({
                setup_status: 'in_progress',
                setup_step: 'diet',
                targets_revision: 2,
                revision: 2,
            });
        });

        it('leaves setup where it stood when the save is refused', async () => {
            // The advance is in the same statement as the values, under the
            // same pinned-revision predicate, so a refused save cannot resume
            // the user past a target write that never landed.
            await walkToTheTargetStop();

            await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
                expectedTargetsRevision: 4,
            }).expect(409);

            expect(await storedTargetRecord(HTTP_USER)).toMatchObject({
                setup_status: 'in_progress',
                setup_step: 'targets_manual',
                target_source: null,
                targets_revision: 0,
                revision: 2,
            });
        });
    });

    describe('feasibility is advisory and never blocking', () => {
        /** Saves `values` as the first manual confirmation and returns the advisory verdict. */
        const saveAndAssess = async (values: {
            calories: number;
            protein: number;
            carbs: number;
            fat: number;
        }): Promise<{ body: SaveTargetsResponse; status: number }> => {
            await makeUser({ id: HTTP_USER });

            const response = await saveTargetsOverHttp(HTTP_USER, { source: 'manual', ...values });

            return { body: response.body as SaveTargetsResponse, status: response.status };
        };

        it('reports ok with no warnings for coherent values', async () => {
            const { body, status } = await saveAndAssess(COHERENT_TARGETS);

            expect(status).toBe(200);
            expect(body.feasibility).toEqual({ ok: true, warnings: [] });
        });

        it('warns that the macros do not account for the calories, and stores them anyway', async () => {
            // AAP §0.5.2: "Infeasible-but-valid targets return 200 with
            // warnings; there is no 422 on this route." The edit screen promises
            // in so many words that the macros need not add up, so refusing
            // them would break a stated promise and rebalancing them would break
            // it worse.
            const { body, status } = await saveAndAssess({
                calories: 2000,
                protein: 1,
                carbs: 1,
                fat: 1,
            });

            expect(status).toBe(200);
            expect(body.feasibility).toEqual({ ok: false, warnings: ['macro_energy_mismatch'] });
            expect(await storedUserTargets(HTTP_USER)).toEqual({
                target_calories: 2000,
                target_protein_g: 1,
                target_carbs_g: 1,
                target_fat_g: 1,
            });
        });

        it('warns that the calorie figure is below what the catalog can build a week within', async () => {
            const { body, status } = await saveAndAssess({
                calories: 900,
                protein: 68,
                carbs: 90,
                fat: 30,
            });

            expect(status).toBe(200);
            expect(body.feasibility).toEqual({ ok: false, warnings: ['below_catalog_min'] });
            expect(body.targets.targets).toMatchObject({ calories: 900 });
        });

        it('warns that it is above that range', async () => {
            const { body, status } = await saveAndAssess({
                calories: 5000,
                protein: 375,
                carbs: 500,
                fat: 167,
            });

            expect(status).toBe(200);
            expect(body.feasibility).toEqual({ ok: false, warnings: ['above_catalog_max'] });
            expect(body.targets.targets).toMatchObject({ calories: 5000 });
        });
    });

    describe('the hand-entered bounds', () => {
        const acceptedFields: readonly ('protein' | 'carbs' | 'fat')[] = [
            'protein',
            'carbs',
            'fat',
        ];

        it.each(acceptedFields)('accepts a %s target of 1 gram', async (field) => {
            // ONE gram is the minimum, not zero — see the rejection below.
            await makeUser({ id: HTTP_USER });

            const saved = await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
                [field]: 1,
            }).expect(200);

            expect((saved.body as SaveTargetsResponse).targets.targets).toMatchObject({
                [field]: 1,
            });
        });

        it.each(acceptedFields)('accepts a %s target of 1,000 grams', async (field) => {
            await makeUser({ id: HTTP_USER });

            const saved = await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
                [field]: 1000,
            }).expect(200);

            expect((saved.body as SaveTargetsResponse).targets.targets).toMatchObject({
                [field]: 1000,
            });
        });

        it.each(acceptedFields)('refuses a %s target of 0, naming the field', async (field) => {
            // THE ERROR FRAME 09b RENDERS: "Enter a carb target above 0 g". A
            // zero must fail validation rather than save as a real target of
            // nothing, and the refusal has to name the field so the screen can
            // put the message under the right input.
            await makeUser({ id: HTTP_USER });

            const response = await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
                [field]: 0,
            }).expect(400);

            expect(response.body).toMatchObject({ error: 'invalid_request' });
            expect(refusalDetails(response.body)).toEqual([{ field, code: 'below_minimum' }]);
            expect(await storedUserTargets(HTTP_USER)).toMatchObject({ target_calories: null });
        });

        it.each([
            ['a macro above the maximum', { protein: 1001 }, { field: 'protein', code: 'above_maximum' }],
            ['a negative macro', { fat: -1 }, { field: 'fat', code: 'below_minimum' }],
            ['a fractional macro', { carbs: 194.5 }, { field: 'carbs', code: 'not_an_integer' }],
            ['a numeric string', { protein: '146' }, { field: 'protein', code: 'invalid_type' }],
            ['a null macro', { fat: null }, { field: 'fat', code: 'required' }],
            ['calories below the minimum', { calories: 799 }, { field: 'calories', code: 'below_minimum' }],
            ['calories above the maximum', { calories: 6001 }, { field: 'calories', code: 'above_maximum' }],
            ['fractional calories', { calories: 1940.5 }, { field: 'calories', code: 'not_an_integer' }],
        ] as const)('refuses %s', async (_label, override, expected) => {
            await makeUser({ id: HTTP_USER });

            const response = await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
                ...override,
            }).expect(400);

            expect(refusalDetails(response.body)).toEqual([expected]);
        });

        it.each([800, 6000])('accepts a calorie target of %s', async (calories) => {
            await makeUser({ id: HTTP_USER });

            const saved = await saveTargetsOverHttp(HTTP_USER, {
                source: 'manual',
                ...COHERENT_TARGETS,
                calories,
            }).expect(200);

            expect((saved.body as SaveTargetsResponse).targets.targets).toMatchObject({ calories });
        });
    });

    it('stores hand-entered values exactly, with no rebalancing to match the calories', async () => {
        // The four numbers the user typed, and not the 4/4/9 split of the
        // calorie figure — which for 1,940 kcal would be 146 / 194 / 65 and is
        // deliberately NOT what these values are.
        await makeUser({ id: HTTP_USER });

        const typed = { calories: 1940, protein: 200, carbs: 100, fat: 40 };
        const saved = await saveTargetsOverHttp(HTTP_USER, {
            source: 'manual',
            ...typed,
        }).expect(200);

        expect((saved.body as SaveTargetsResponse).targets.targets).toEqual(typed);
        expect(await storedUserTargets(HTTP_USER)).toEqual({
            target_calories: 1940,
            target_protein_g: 200,
            target_carbs_g: 100,
            target_fat_g: 40,
        });
        expect(await storedTargetRecord(HTTP_USER)).toMatchObject({ confirmed_targets: typed });
    });
});

/* ---------------------------------------------------------------------------
 * The flag that gates the rest of the router and not these three
 *
 * THIS SUITE'S UNIQUE CHARTER. `mealPlanning.controller.ts` calls
 * `assertMealPlanningEnabled()` in fifteen handlers and deliberately not in the
 * three target ones, because Account, Progress and the diary's target editor
 * read and write targets through them (AAP §0.3.1, §0.5.2, §0.7.5). All
 * eighteen are registered on ONE router, so the gate is per-handler and there is
 * no mount-level evidence for it.
 *
 * `src/utils/__tests__/featureFlags.test.ts` owns what the flag READS. What it
 * cannot show — and what nothing else in the repository shows — is WHICH
 * handlers consult it. Only a request does, and only against a module graph
 * built while the variable is off.
 * ------------------------------------------------------------------------- */

type AppModule = typeof import('../../app');
type PrismaClientModule = typeof import('../../prisma/client');
type FeatureFlagsModule = typeof import('../../utils/featureFlags');

/** The one gated route the contrast is drawn against, plus a second so "the rest" is not one example. */
const GATED_PATHS = [PREFERENCES_PATH, PLANS_PATH] as const;

/**
 * Runs `work` against an app graph imported with `MEAL_PLANNING_ENABLED` unset.
 *
 * WHY THE GRAPH IS REBUILT RATHER THAN THE FLAG MOCKED. `utils/featureFlags.ts`
 * resolves the variable ONCE at import and exposes it only through an accessor
 * — which is the contract Rule `backend-architecture` §9 requires of it, and
 * the contract this window has to respect rather than bypass. Assigning to
 * `process.env` mid-suite is therefore inert, and stubbing the accessor would
 * assert against a mock of the very thing under test. Re-evaluating the graph
 * is what `src/__tests__/api/fault.test.ts` and
 * `src/utils/__tests__/featureFlags.test.ts` already do for the same reason.
 *
 * `jest.isolateModules` keeps that second graph in a registry of its own, so the
 * functions captured out of it — here, the express app — stay bound to it after
 * the callback returns while this file's own top-level `prisma` import still
 * observes the same database for the assertions. The module mocks registered in
 * `setup/jestSetup.ts` survive `resetModules`, so the isolated app keeps the
 * stubbed Firebase Admin and the header-based identity.
 *
 * The isolated graph constructs its own `PrismaClient`; it is disconnected in
 * the `finally`, where the variable is also restored — DELETED rather than
 * assigned when it was previously unset, since assigning `undefined` would
 * store the string "undefined" and the flag's own `=== 'true'` test would then
 * be reading a value nobody set.
 */
const withPlanningDisabled = async <TResult>(
    work: (context: { agent: supertest.Agent; enabled: boolean }) => Promise<TResult>,
): Promise<TResult> => {
    const previous = process.env.MEAL_PLANNING_ENABLED;

    delete process.env.MEAL_PLANNING_ENABLED;
    jest.resetModules();

    // Held on an object rather than in locals: the assignments happen inside
    // `isolateModules`' synchronous callback, and a property stays typed as
    // possibly absent afterwards where a captured local would need a cast.
    const isolated: { client?: PrismaClientModule; context?: { agent: supertest.Agent; enabled: boolean } } =
        {};

    try {
        jest.isolateModules(() => {
            const flags = require('../../utils/featureFlags') as FeatureFlagsModule;
            const appModule = require('../../app') as AppModule;

            isolated.client = require('../../prisma/client') as PrismaClientModule;
            isolated.context = {
                agent: supertest(appModule.default),
                enabled: flags.isMealPlanningEnabled(),
            };
        });

        const context = isolated.context;

        if (context === undefined) {
            throw new Error('The disabled module graph was not built, so no case can run against it.');
        }

        return await work(context);
    } finally {
        if (isolated.client !== undefined) {
            await isolated.client.prisma.$disconnect();
        }

        if (previous === undefined) {
            delete process.env.MEAL_PLANNING_ENABLED;
        } else {
            process.env.MEAL_PLANNING_ENABLED = previous;
        }

        jest.resetModules();
    }
};

describe('with MEAL_PLANNING_ENABLED off', () => {
    it('really did build the graph with the flag off', async () => {
        // The premise of every case below. Without it they would all pass
        // unchanged against a graph whose flag was still on, and the exemption
        // would be untested.
        await withPlanningDisabled(async ({ enabled }) => {
            expect(enabled).toBe(false);
        });
    });

    it('still answers the canonical target read', async () => {
        await seedHttpConfirmedEstimate();

        await withPlanningDisabled(async ({ agent }) => {
            const response = await asUser(agent.get(TARGETS_PATH), { uid: HTTP_USER }).expect(200);

            // The real verdict, not merely a 200: Account and Progress render
            // these values while planning is off.
            expect(response.body).toEqual({
                targets: { ...FIXTURE_TARGETS },
                complete: true,
                source: 'estimated',
                stale: false,
                revision: 1,
            });
        });
    });

    it('still answers the calculated estimate', async () => {
        await seedHttpConfirmedEstimate();

        await withPlanningDisabled(async ({ agent }) => {
            const response = await asUser(agent.get(ESTIMATE_PATH), { uid: HTTP_USER }).expect(200);

            expect(response.body).toMatchObject({ source: 'estimated', estimateRevision: 1 });
        });
    });

    it('still accepts the canonical write, and it persists', async () => {
        await makeUser({ id: HTTP_USER });

        await withPlanningDisabled(async ({ agent }) => {
            await asUser(agent.put(TARGETS_PATH), { uid: HTTP_USER })
                .send({ source: 'manual', ...COHERENT_TARGETS })
                .expect(200);
        });

        // Read back through this file's own client, after the window closed: the
        // write was real, not something the isolated graph held privately. This
        // is the diary's target editor working with planning off.
        expect(await storedUserTargets(HTTP_USER)).toEqual({
            target_calories: COHERENT_TARGETS.calories,
            target_protein_g: COHERENT_TARGETS.protein,
            target_carbs_g: COHERENT_TARGETS.carbs,
            target_fat_g: COHERENT_TARGETS.fat,
        });
        expect(await storedTargetRecord(HTTP_USER)).toMatchObject({
            target_source: 'manual',
            targets_revision: 1,
        });
    });

    it('answers 200 with a null target set rather than 404, even with the feature off', async () => {
        // The client reads a bare 404 from this route as "the routes are not
        // mounted" — a rolled-back backend — and degrades the whole segment. A
        // flag that is merely OFF must not produce that signal, or turning
        // planning off would look like a rollback to every device.
        await makeUser({ id: HTTP_USER });

        await withPlanningDisabled(async ({ agent }) => {
            const response = await asUser(agent.get(TARGETS_PATH), { uid: HTTP_USER }).expect(200);

            expect(response.body).toMatchObject({ targets: null, source: null, revision: 0 });
        });
    });

    it.each(GATED_PATHS)('refuses %s with 503 feature_disabled', async (path) => {
        // THE CONTRAST THAT MAKES THE EXEMPTION AN ASSERTION. These routes are
        // registered on the SAME router as the three above and handled in the
        // same controller file, so this is the only evidence that the gate is
        // per-handler rather than applied to the whole router — or to nothing.
        await seedHttpConfirmedEstimate();

        await withPlanningDisabled(async ({ agent }) => {
            const response =
                path === PLANS_PATH
                    ? await asUser(agent.post(path), { uid: HTTP_USER })
                          .send({
                              startDate: addDaysToDayKey(utcTodayDayKey(), 1),
                              idempotencyKey: randomUUID(),
                              expectedPreferencesRevision: 1,
                              expectedTargetsRevision: 1,
                          })
                          .expect(503)
                    : await asUser(agent.get(path), { uid: HTTP_USER }).expect(503);

            expect(response.body).toEqual({ error: 'feature_disabled' });
        });
    });

    it('leaves the ambient graph enabled, so a neighbouring suite is unaffected', async () => {
        // `--runInBand` shares this process with every other suite, so a window
        // that leaked its environment would disable meal planning for whichever
        // file ran next. Asserted through the ambient app — the one imported at
        // the top of this file — after a window has opened and closed.
        await seedHttpConfirmedEstimate();

        await withPlanningDisabled(async ({ agent }) => {
            await asUser(agent.get(PREFERENCES_PATH), { uid: HTTP_USER }).expect(503);
        });

        expect(process.env.MEAL_PLANNING_ENABLED).toBe('true');
        await asUser(request.get(PREFERENCES_PATH), { uid: HTTP_USER }).expect(200);
    });
});

/* ---------------------------------------------------------------------------
 * Two clients, and a response nobody received
 *
 * The pinned revision travels in the UPDATE's own predicate, which the first
 * half of this file proves against a held row lock. What the boundary adds is
 * the CLIENT-VISIBLE outcome of the same rule: exactly one of two competing
 * saves is accepted, and the loser is told which revision is authoritative so
 * the mobile `resolveStaleRevision` helper can re-read, compare with its draft
 * and resolve silently when the two already agree.
 * ------------------------------------------------------------------------- */

describe('two clients saving the same targets revision', () => {
    /** Two drafts that differ, so which one won is visible in the stored values. */
    const FIRST_DRAFT = { calories: 1800, protein: 135, carbs: 180, fat: 60 } as const;
    const SECOND_DRAFT = { calories: 2200, protein: 165, carbs: 220, fat: 73 } as const;

    const saveDraft = (draft: { calories: number; protein: number; carbs: number; fat: number }) =>
        saveTargetsOverHttp(HTTP_USER, {
            source: 'manual',
            ...draft,
            expectedTargetsRevision: 1,
        });

    it('accepts one and refuses the other when they arrive in sequence', async () => {
        await seedHttpConfirmedEstimate();

        await saveDraft(FIRST_DRAFT).expect(200);

        const second = await saveDraft(SECOND_DRAFT).expect(409);

        // Exactly one update survives, and the loser learns where the record
        // now stands rather than being told only that it failed.
        expect(second.body).toEqual({ error: 'stale_targets', currentRevision: 2 });
        expect(
            ((await getTargetsOverHttp(HTTP_USER).expect(200)).body as TargetsResponse).targets,
        ).toEqual(FIRST_DRAFT);
    });

    it('accepts exactly one when the two are raced', async () => {
        await seedHttpConfirmedEstimate();

        const [first, second] = await Promise.all([
            saveDraft(FIRST_DRAFT),
            saveDraft(SECOND_DRAFT),
        ]);

        const statuses = [first.status, second.status].sort();

        // Which one wins is timing, so the assertion is the contract: one
        // acceptance and one refusal, never two of either. Two acceptances
        // would be the lost update the pin exists to prevent; two refusals
        // would mean a client had to retry a save nobody made.
        expect(statuses).toEqual([200, 409]);

        const winner = first.status === 200 ? FIRST_DRAFT : SECOND_DRAFT;
        const loser = first.status === 200 ? second : first;

        expect(loser.body).toEqual({ error: 'stale_targets', currentRevision: 2 });
        expect(
            ((await getTargetsOverHttp(HTTP_USER).expect(200)).body as TargetsResponse).targets,
        ).toEqual(winner);
        expect(await storedTargetRecord(HTTP_USER)).toMatchObject({ targets_revision: 2 });
    });

    it('answers an identical re-send with the authoritative revision, and the values already agree', async () => {
        // THE RESPONSE-LOSS CASE. A save whose response never arrived is
        // indistinguishable, from the client, from one that never committed —
        // so the client re-sends the SAME draft with the SAME pin. The server
        // refuses it, because the record has moved; what makes that harmless is
        // the second half of this assertion: the stored values are already the
        // ones the draft carried. `resolveStaleRevision` re-reads, finds the
        // two equal and resolves without a dialog, so a lost response never
        // produces a duplicate write or a question the user has to answer.
        await seedHttpConfirmedEstimate();

        await saveDraft(FIRST_DRAFT).expect(200);

        const resent = await saveDraft(FIRST_DRAFT).expect(409);

        expect(resent.body).toEqual({ error: 'stale_targets', currentRevision: 2 });
        expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toEqual({
            targets: { ...FIRST_DRAFT },
            complete: true,
            source: 'manual',
            stale: false,
            revision: 2,
        });

        // And exactly one write happened: the counter moved once.
        expect(await storedTargetRecord(HTTP_USER)).toMatchObject({ targets_revision: 2 });
    });

    it('carries no idempotency key, because a target save is revisioned rather than keyed', async () => {
        // The four keyed writes reserve a `meal_plan_actions` row and replay
        // their stored response. A target save does neither: it is protected by
        // the pinned revision instead, so a key would be a second mechanism
        // with nothing to do — and the envelope refuses one outright.
        await seedHttpConfirmedEstimate();

        const response = await saveTargetsOverHttp(HTTP_USER, {
            source: 'manual',
            ...FIRST_DRAFT,
            expectedTargetsRevision: 1,
            idempotencyKey: randomUUID(),
        }).expect(400);

        expect(refusalDetails(response.body)).toEqual([
            { field: 'idempotencyKey', code: 'unknown_field' },
        ]);

        await saveDraft(FIRST_DRAFT).expect(200);

        expect(await prisma.meal_plan_actions.count({ where: { user_id: HTTP_USER } })).toBe(0);
    });
});

/* ---------------------------------------------------------------------------
 * The planner's precondition
 *
 * `POST /meal-planning/plans` has its own suite; what belongs here is the
 * LINKAGE — that the two verdicts this file's read produces are the two a week
 * is refused for, with the payload the client acts on. The ordering races
 * between a generation and a target write belong to `concurrency.test.ts` and
 * to this file's own publication-gate section, which drives them through the
 * gate itself.
 * ------------------------------------------------------------------------- */

/** The three slot shares §0.7.3 guides a three-meal day by. */
const SLOT_SHARES = [
    { slot: 'breakfast', share: 0.25 },
    { slot: 'lunch', share: 0.35 },
    { slot: 'dinner', share: 0.4 },
] as const;

/**
 * A catalog and twelve recipes sized to `targets`, so a day built from one
 * recipe per slot lands on that target and the day tolerance is satisfied
 * without relying on portion multipliers.
 *
 * Derived from the target rather than fixed, because the two cases below
 * publish against DIFFERENT confirmed figures and the whole point of them is
 * which figure the week was built on.
 */
const seedPlannableWeek = async (targets: FixtureMacros): Promise<void> => {
    const food = await makeCatalogFood();

    for (const { slot, share } of SLOT_SHARES) {
        const perServing: FixtureMacros = {
            calories: Math.round(targets.calories * share),
            protein: Math.round(targets.protein * share),
            carbs: Math.round(targets.carbs * share),
            fat: Math.round(targets.fat * share),
        };

        for (let index = 0; index < RECIPES_PER_SLOT; index += 1) {
            await makeRecipeVersion({
                slug: `targets-http-${slot}-${index}`,
                catalogFoodId: food.id,
                meal_slots: [slot],
                perServing,
            });
        }
    }
};

/** A generation request for tomorrow, inside the start-date window on any day the suite runs. */
const generatePlanOverHttp = (
    uid: string,
    revisions: { preferences: number; targets: number },
) =>
    asUser(request.post(PLANS_PATH), { uid }).send({
        startDate: addDaysToDayKey(utcTodayDayKey(), 1),
        idempotencyKey: randomUUID(),
        expectedPreferencesRevision: revisions.preferences,
        expectedTargetsRevision: revisions.targets,
    });

/** The snapshot every published week records the targets it was built against in. */
const publishedTargetsSnapshots = async (uid: string): Promise<unknown[]> =>
    (
        await prisma.meal_plans.findMany({
            where: { user_id: uid },
            orderBy: { start_date: 'asc' },
            select: { targets_snapshot: true },
        })
    ).map((plan) => plan.targets_snapshot);

describe('the week a target set does or does not admit', () => {
    it('refuses an incomplete target set and names the fields that are unset', async () => {
        // The planner needs all four; a calories-only account cannot be planned
        // for, and the `missing` array is what sends the user to the fields
        // rather than to a dead end.
        await makeUser({ id: HTTP_USER, target_calories: 1900 });
        await makePreferences(HTTP_USER, { time_zone: 'UTC' });

        const response = await generatePlanOverHttp(HTTP_USER, {
            preferences: 1,
            targets: 1,
        }).expect(422);

        expect(response.body).toEqual({
            error: 'targets_missing',
            missing: ['protein', 'carbs', 'fat'],
        });
        expect(await publishedTargetsSnapshots(HTTP_USER)).toEqual([]);
    });

    it('names all four when nothing was ever set', async () => {
        await makeUser({ id: HTTP_USER });
        await makePreferences(HTTP_USER, { time_zone: 'UTC' });

        expect(
            (await generatePlanOverHttp(HTTP_USER, { preferences: 1, targets: 1 }).expect(422)).body,
        ).toEqual({
            error: 'targets_missing',
            missing: ['calories', 'protein', 'carbs', 'fat'],
        });
    });

    it('refuses a complete set that nobody confirmed here', async () => {
        // `legacy` means the values were last written from outside this feature,
        // so presenting the resulting week as reviewed would be untrue. The
        // user reconfirms, and the same request then succeeds.
        await seedHttpConfirmedEstimate(HTTP_USER, { time_zone: 'UTC' });
        await asUser(request.put(LEGACY_TARGETS_PATH), { uid: HTTP_USER })
            .send({ calories: FIXTURE_TARGETS.calories + 100 })
            .expect(200);

        const response = await generatePlanOverHttp(HTTP_USER, {
            preferences: 1,
            targets: 1,
        }).expect(409);

        expect(response.body).toEqual({ error: 'targets_unconfirmed' });
        expect(await publishedTargetsSnapshots(HTTP_USER)).toEqual([]);
    });
});

describe('a stale confirmed estimate, through to a published week', () => {
    it('builds the week on the confirmed figure, not on the recalculation on offer', async () => {
        // AAP §0.7.3's first half. A confirmed estimate is FIXED once
        // confirmed: the review screen offers a recalculation and generation
        // keeps using what the user actually confirmed until they take it.
        await seedHttpConfirmedEstimate(HTTP_USER, { time_zone: 'UTC' });
        await seedPlannableWeek(FIXTURE_TARGETS);

        await asUser(request.put(`${PREFERENCES_PATH}/steps/activity`), { uid: HTTP_USER })
            .send({ activityLevel: 'very_active', timeZone: 'UTC', expectedRevision: 1 })
            .expect(200);

        const onOffer = (await getEstimate(HTTP_USER).expect(200)).body as TargetEstimateResponse;

        // The recalculation really differs, so the case cannot pass by the two
        // figures happening to agree.
        expect(onOffer.calories).not.toBe(FIXTURE_TARGETS.calories);
        expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toMatchObject({
            targets: { ...FIXTURE_TARGETS },
            stale: true,
        });

        // The targets revision did NOT move — only the answers did — so the
        // week is pinned to the confirmed record.
        const published = await generatePlanOverHttp(HTTP_USER, {
            preferences: 2,
            targets: 1,
        }).expect(201);

        expect(await publishedTargetsSnapshots(HTTP_USER)).toEqual([{ ...FIXTURE_TARGETS }]);
        expect(published.body).toMatchObject({
            generationTargets: { ...FIXTURE_TARGETS },
            targets: { ...FIXTURE_TARGETS },
            targetsStale: false,
        });
    });

    it('builds it on the new figure once the user takes the recalculation', async () => {
        // The second half, and what makes the first an assertion rather than an
        // accident: the same sequence with one extra step — the user confirming
        // the fresh estimate — publishes a week against the NEW numbers.
        await seedHttpConfirmedEstimate(HTTP_USER, { time_zone: 'UTC' });

        await asUser(request.put(`${PREFERENCES_PATH}/steps/activity`), { uid: HTTP_USER })
            .send({ activityLevel: 'very_active', timeZone: 'UTC', expectedRevision: 1 })
            .expect(200);

        const fresh = (await getEstimate(HTTP_USER).expect(200)).body as TargetEstimateResponse;
        const reconfirmed: FixtureMacros = {
            calories: fresh.calories,
            protein: fresh.protein,
            carbs: fresh.carbs,
            fat: fresh.fat,
        };

        await saveTargetsOverHttp(HTTP_USER, {
            source: 'estimated',
            estimateRevision: fresh.estimateRevision,
            expectedTargetsRevision: 1,
        }).expect(200);

        expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toMatchObject({
            targets: reconfirmed,
            stale: false,
        });

        await seedPlannableWeek(reconfirmed);

        const published = await generatePlanOverHttp(HTTP_USER, {
            preferences: 2,
            targets: 2,
        }).expect(201);

        expect(await publishedTargetsSnapshots(HTTP_USER)).toEqual([reconfirmed]);
        expect(published.body).toMatchObject({
            generationTargets: reconfirmed,
            targets: reconfirmed,
            targetsStale: false,
        });
        expect(reconfirmed.calories).not.toBe(FIXTURE_TARGETS.calories);
    });
});

/* ---------------------------------------------------------------------------
 * Tenancy and the shape of a refusal
 *
 * Rule `backend-architecture` §1.5, §4, §5.1 and §8. The identity is the
 * verified token's and nothing else; a write reaches exactly one owner's rows;
 * and every refusal is a status, a machine-readable code and the data the client
 * acts on — never a class name, a stack or a vendor's error text.
 * ------------------------------------------------------------------------- */

describe('the caller these routes act for', () => {
    /** Two confirmed users, so a write that crossed between them would be visible. */
    const seedBothUsers = async (): Promise<void> => {
        await seedHttpConfirmedEstimate(HTTP_USER);
        await seedHttpConfirmedEstimate(OTHER_HTTP_USER);
    };

    it('writes only the rows of the user the header names', async () => {
        await seedBothUsers();

        const draft = { calories: 1800, protein: 135, carbs: 180, fat: 60 };

        await saveTargetsOverHttp(HTTP_USER, {
            source: 'manual',
            ...draft,
            expectedTargetsRevision: 1,
        }).expect(200);

        // The other user's four columns and their whole target record are
        // exactly as seeded — §5.1's "every `where` includes the owner key,
        // including on updates".
        expect(await storedUserTargets(OTHER_HTTP_USER)).toEqual({
            target_calories: FIXTURE_TARGETS.calories,
            target_protein_g: FIXTURE_TARGETS.protein,
            target_carbs_g: FIXTURE_TARGETS.carbs,
            target_fat_g: FIXTURE_TARGETS.fat,
        });
        expect(await storedTargetRecord(OTHER_HTTP_USER)).toMatchObject({
            target_source: 'estimated',
            confirmed_targets: { ...FIXTURE_TARGETS },
            targets_revision: 1,
        });
        expect(await storedUserTargets(HTTP_USER)).toEqual({
            target_calories: draft.calories,
            target_protein_g: draft.protein,
            target_carbs_g: draft.carbs,
            target_fat_g: draft.fat,
        });
    });

    it('reads only the rows of the user the header names', async () => {
        await seedHttpConfirmedEstimate(HTTP_USER);
        await makeUser({ id: OTHER_HTTP_USER });

        // Same request, two identities, two different answers — and the second
        // is the honest "nothing set" rather than a neighbour's figures.
        expect((await getTargetsOverHttp(HTTP_USER).expect(200)).body).toMatchObject({
            targets: { ...FIXTURE_TARGETS },
        });
        expect((await getTargetsOverHttp(OTHER_HTTP_USER).expect(200)).body).toMatchObject({
            targets: null,
        });
    });

    it('sends the same body to two owners when two headers send it', async () => {
        await makeUser({ id: HTTP_USER });
        await makeUser({ id: OTHER_HTTP_USER });

        const body = { source: 'manual', ...COHERENT_TARGETS };

        await saveTargetsOverHttp(HTTP_USER, body).expect(200);
        await saveTargetsOverHttp(OTHER_HTTP_USER, body).expect(200);

        // Two rows, each at its own first revision: the subject of the write is
        // the header's, so an identical body is not an identical write.
        expect(await storedTargetRecord(HTTP_USER)).toMatchObject({ targets_revision: 1 });
        expect(await storedTargetRecord(OTHER_HTTP_USER)).toMatchObject({ targets_revision: 1 });
    });

    it('refuses a body that names a user, because identity is not request data', async () => {
        // §4: the caller is read from the verified token through `getUserId`,
        // never from the body. On this route the envelope is a closed key set,
        // so the body cannot even EXPRESS an identity — a stronger outcome than
        // ignoring one, and the one that cannot silently become a
        // cross-user write later.
        await seedHttpConfirmedEstimate(HTTP_USER);
        await seedHttpConfirmedEstimate(OTHER_HTTP_USER);

        const response = await saveTargetsOverHttp(HTTP_USER, {
            source: 'manual',
            ...COHERENT_TARGETS,
            expectedTargetsRevision: 1,
            userId: OTHER_HTTP_USER,
        }).expect(400);

        expect(refusalDetails(response.body)).toEqual([
            { field: 'userId', code: 'unknown_field' },
        ]);
        expect(await storedUserTargets(OTHER_HTTP_USER)).toMatchObject({
            target_calories: FIXTURE_TARGETS.calories,
        });
    });
});

/**
 * One refusal per branch these three routes can take, each with the world that
 * produces it. Driven as a table because the assertions below are the same for
 * every one of them: a refusal's SHAPE is a property of the route family, not
 * of the branch.
 */
interface RefusalCase {
    readonly label: string;
    readonly status: number;
    readonly keys: readonly string[];
    readonly run: () => Promise<supertest.Response>;
}

const REFUSAL_CASES: readonly RefusalCase[] = [
    {
        label: 'no identity on the read',
        status: 401,
        keys: ['error'],
        run: () => request.get(TARGETS_PATH),
    },
    {
        label: 'no identity on the estimate',
        status: 401,
        keys: ['error'],
        run: () => request.get(ESTIMATE_PATH),
    },
    {
        label: 'no identity on the save',
        status: 401,
        keys: ['error'],
        run: () => request.put(TARGETS_PATH).send({ source: 'manual', ...COHERENT_TARGETS }),
    },
    {
        label: 'an estimate the answers do not support',
        status: 409,
        keys: ['error', 'reason'],
        run: async () => {
            await seedHttpConfirmedEstimate(HTTP_USER, { sex_for_estimate: 'prefer_not_to_say' });

            return getEstimate(HTTP_USER);
        },
    },
    {
        label: 'an estimate pinned to answers that moved',
        status: 409,
        keys: ['error'],
        run: async () => {
            await seedUnconfirmedPreferences();

            return saveTargetsOverHttp(HTTP_USER, { source: 'estimated', estimateRevision: 99 });
        },
    },
    {
        label: 'a target record someone else advanced',
        status: 409,
        keys: ['error', 'currentRevision'],
        run: async () => {
            await seedHttpConfirmedEstimate();

            return saveTargetsOverHttp(HTTP_USER, { source: 'manual', ...COHERENT_TARGETS });
        },
    },
    {
        label: 'a malformed envelope',
        status: 400,
        keys: ['error', 'details'],
        run: async () => {
            await seedUnconfirmedPreferences();

            return saveTargetsOverHttp(HTTP_USER, { source: 'manual', calories: 0 });
        },
    },
    {
        label: 'a week asked for on an incomplete target set',
        status: 422,
        keys: ['error', 'missing'],
        run: async () => {
            await makeUser({ id: HTTP_USER, target_calories: 1900 });
            await makePreferences(HTTP_USER, { time_zone: 'UTC' });

            return generatePlanOverHttp(HTTP_USER, { preferences: 1, targets: 1 });
        },
    },
    {
        label: 'a week asked for on targets nobody confirmed here',
        status: 409,
        keys: ['error'],
        run: async () => {
            await seedHttpConfirmedEstimate(HTTP_USER, { time_zone: 'UTC' });
            await asUser(request.put(LEGACY_TARGETS_PATH), { uid: HTTP_USER })
                .send({ calories: FIXTURE_TARGETS.calories + 100 })
                .expect(200);

            return generatePlanOverHttp(HTTP_USER, { preferences: 1, targets: 1 });
        },
    },
];

describe('the shape of every refusal', () => {
    it.each(REFUSAL_CASES.map((refusal) => [refusal.label, refusal] as const))(
        'answers %s with a status, a code and nothing else',
        async (_label, refusal) => {
            const response = await refusal.run();

            expect(response.status).toBe(refusal.status);

            // THE WHOLE KEY SET, so an added member — a stack, a `name`, a
            // vendor payload — fails rather than passing unnoticed.
            expect(Object.keys(response.body as object).sort()).toEqual([...refusal.keys].sort());

            const serialised = JSON.stringify(response.body);

            // §4's named anti-pattern is `{error: err}`: an Error serialises to
            // `{}` or carries its own members, so `error` must be a STRING code.
            expect(typeof (response.body as { error: unknown }).error).toBe('string');
            expect(serialised).not.toMatch(/stack|node_modules|prisma|Invocation|PrismaClient/i);
            // §8: the client acts on the code, so the class name must never
            // reach it. `mealPlanning.errors.ts` is deliberately status-free for
            // the same reason.
            expect(serialised).not.toMatch(/Error"|StaleTargets|EstimateStale|TargetsMissing/);
        },
    );

    it('never answers 403, for any of them', async () => {
        // §1.5: cross-user and missing resources are 404 and an unauthenticated
        // request is 401 — a 403 would confirm that something exists and that
        // the caller is simply not allowed it.
        for (const refusal of REFUSAL_CASES) {
            await truncateFeatureTables();

            const response = await refusal.run();

            expect(response.status).not.toBe(403);
        }
    });
});

describe('the closed sets these routes emit', () => {
    it('only ever emits a source and a clamp reason the client maps', async () => {
        // `target_source`, `clampReason` and the feasibility codes are plain
        // TEXT columns and plain string literals — the schema carries no enum
        // and no CHECK — so nothing but the code keeps an unmapped value off
        // the wire. Proven through the API across the four states this route
        // family can be in, never by writing a bad value into the column.
        await seedHttpConfirmedEstimate();

        const confirmed = (await getTargetsOverHttp(HTTP_USER).expect(200)).body as TargetsResponse;
        const estimate = (await getEstimate(HTTP_USER).expect(200)).body as TargetEstimateResponse;

        await asUser(request.put(LEGACY_TARGETS_PATH), { uid: HTTP_USER })
            .send({ calories: FIXTURE_TARGETS.calories + 100 })
            .expect(200);

        const legacy = (await getTargetsOverHttp(HTTP_USER).expect(200)).body as TargetsResponse;

        await prisma.users.update({
            where: { id: HTTP_USER },
            data: {
                target_calories: null,
                target_protein_g: null,
                target_carbs_g: null,
                target_fat_g: null,
            },
        });

        const unset = (await getTargetsOverHttp(HTTP_USER).expect(200)).body as TargetsResponse;

        expect([confirmed.source, legacy.source, unset.source]).toEqual([
            'estimated',
            'legacy',
            null,
        ]);
        expect([null, 'floor', 'below_bmr', 'ceiling']).toContain(estimate.clampReason);
    });

    it('refuses a source outside that set rather than storing it', async () => {
        await seedUnconfirmedPreferences();

        await saveTargetsOverHttp(HTTP_USER, {
            source: 'imported',
            ...COHERENT_TARGETS,
        }).expect(400);

        // Refused by the parser, so the column never receives the value — the
        // only place that refusal can live, since the column would accept it.
        expect(await storedTargetRecord(HTTP_USER)).toMatchObject({ target_source: null });
    });
});
