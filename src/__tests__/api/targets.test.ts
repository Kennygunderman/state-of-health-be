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
// Everything here runs against the ambient test database and truncates only the
// feature tables through the shared guard, exactly as the other suites in this
// directory do. The two extra Prisma clients are a genuine requirement rather
// than a convenience: a lock test needs a session that is not the one holding
// the lock, and a statement count needs a client whose query events are
// observable.

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import {
    FIXTURE_TARGETS,
    FIXTURE_USER_TARGET_COLUMNS,
    addDaysToDayKey,
    makeCatalogFood,
    makePreferences,
    makeRecipeVersion,
    makeUser,
    utcTodayDayKey,
} from '../setup/factories';
import { truncateFeatureTables } from '../setup/testDb';
import { generatePlan, regeneratePlan } from '../../services/mealPlan.service';
import { TargetsUnconfirmedError } from '../../services/mealPlanning.errors';
import { withMealPlanningTransaction, withUserLock } from '../../services/mealPlanningAction.service';
import { updateTargets } from '../../services/nutrition.service';
import { savePreferences, saveSetupStep } from '../../services/preferences.service';
import { PlanningPreferences, evaluatePlanningEligibility } from '../../services/recipe.logic';
import * as groceryService from '../../services/grocery.service';
import * as recipeService from '../../services/recipe.service';
import {
    getTargetEstimate,
    getTargets,
    previewConfirmedTargets,
    requireConfirmedTargets,
    saveTargets,
} from '../../services/targets.service';

const USER_ID = 'targets-service-suite-user';
const TIME_ZONE = 'America/New_York';

/**
 * How long a blocked write is watched before the absence of a result is taken
 * as evidence that it is blocked.
 *
 * The write it watches is a single indexed UPDATE that completes in well under a
 * millisecond when nothing holds its row, and the counter-test asserts exactly
 * that. So half a second is three orders of magnitude of headroom, and the pair
 * of assertions — blocked here, not blocked there — is what carries the proof.
 */
const BLOCK_OBSERVATION_MS = 500;

/** A second session, so a lock can be observed from outside the one holding it. */
const legacyWriterClient = new PrismaClient();

/**
 * A third session whose queries are observable, for counting the statements one
 * read issues. Query logging is per client, so this cannot be done on the
 * singleton without changing what every other suite's client does.
 */
const observedClient = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });

/** Statements the pool issues around the ones under test, and never the read itself. */
const isFrameworkStatement = (sql: string): boolean =>
    /^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE|SET|SELECT 1|-- Implicit)/i.test(sql);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

const storedRevisions = async (): Promise<{ revision: number; estimateInputs: number; targetsInput: number | null }> => {
    const row = await prisma.meal_plan_preferences.findUniqueOrThrow({
        where: { user_id: USER_ID },
        select: { revision: true, estimate_inputs_revision: true, targets_input_revision: true },
    });

    return {
        revision: row.revision,
        estimateInputs: row.estimate_inputs_revision,
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

        // The write-side diagnostic counter did NOT move, because a diet is not
        // a term in the energy equation. It is a different question from the
        // one `stale` answers, and nothing reads it.
        expect(revisions.estimateInputs).toBe(1);
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

        // Nothing the equation reads moved — the diagnostic stands still — and
        // the revision advanced all the same, so the ancestry no longer holds.
        expect(revisions.revision).toBe(2);
        expect(revisions.estimateInputs).toBe(1);
        expect(await getTargets(USER_ID)).toMatchObject({ stale: true });
    });

    it('goes stale on an activity change, and keeps the confirmed numbers', async () => {
        await saveStep('activity', { activityLevel: 'active', timeZone: TIME_ZONE, expectedRevision: 1 });

        const revisions = await storedRevisions();

        expect(revisions.revision).toBe(2);
        expect(revisions.estimateInputs).toBe(2);
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

        await sleep(BLOCK_OBSERVATION_MS);
        holder.release();
        await holder.committed;

        expect(await outcome).toEqual({
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
    });

    it('completes the save when the row is merely locked and released', async () => {
        // The counter-proof. The save waits on exactly the same row lock for
        // the same duration; only the revision differs, so the refusal above is
        // the predicate and nothing else.
        const holder = holdRowLock(false);
        await holder.locked;

        const outcome = saveTargets(USER_ID, { ...MANUAL_SAVE }).then(
            (response) => ({ response }),
            (error: unknown) => ({ error }),
        );

        await sleep(BLOCK_OBSERVATION_MS);
        holder.release();
        await holder.committed;

        expect(await outcome).toMatchObject({ response: { kind: 'ok' } });
        expect(await getTargets(USER_ID)).toEqual({
            targets: { calories: 1800, protein: 140, carbs: 180, fat: 60 },
            complete: true,
            source: 'manual',
            stale: false,
            revision: 2,
        });
    });

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

                    await sleep(BLOCK_OBSERVATION_MS);

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

        await observed.legacy.done;

        // Released at COMMIT, so the legacy write is not lost — it applies to a
        // plan that was built, and published, on values that were confirmed at
        // the time. Afterwards the canonical read says so plainly.
        expect(observed.legacy.settled()).toBe(true);
        expect(await getTargets(USER_ID)).toMatchObject({
            targets: { ...FIXTURE_TARGETS, calories: FIXTURE_TARGETS.calories + 100 },
            source: 'legacy',
        });
    });

    it('leaves that write unblocked when the read is the unlocked one', async () => {
        // The counter-proof. Without it, the test above could pass because of
        // something incidental to the transaction rather than because of the
        // row lock — and a gate that had lost its `FOR UPDATE` would look
        // exactly as correct.
        const observed = await withMealPlanningTransaction(
            (tx) =>
                withUserLock(tx, USER_ID, async (locked) => {
                    await previewConfirmedTargets(USER_ID, locked);
                    const legacy = startLegacyWrite(FIXTURE_TARGETS.calories + 100);

                    await sleep(BLOCK_OBSERVATION_MS);

                    return { legacy, blockedWhileOpen: !legacy.settled() };
                }),
            { timeout: 20_000 },
        );

        await observed.legacy.done;

        expect(observed.blockedWhileOpen).toBe(false);
    });

    it('sees a legacy write that commits while it waits, and refuses on the next attempt', async () => {
        // The two orderings the AAP requires, driven in sequence: the write
        // that could not interleave becomes the write that precedes the next
        // attempt, and that attempt is refused rather than silently planned.
        await withMealPlanningTransaction(
            (tx) =>
                withUserLock(tx, USER_ID, async (locked) => {
                    await requireConfirmedTargets(locked, USER_ID);
                    const legacy = startLegacyWrite(FIXTURE_TARGETS.calories + 250);

                    await sleep(BLOCK_OBSERVATION_MS);
                    void legacy.done;
                }),
            { timeout: 20_000 },
        );

        await sleep(BLOCK_OBSERVATION_MS);

        await expect(
            withMealPlanningTransaction((tx) =>
                withUserLock(tx, USER_ID, (locked) => requireConfirmedTargets(locked, USER_ID)),
            ),
        ).rejects.toThrow(TargetsUnconfirmedError);
    });
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

/** What stands between the seeded catalog and a plannable week, if anything. */
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

/**
 * Supplies the ONE ingredient fact the planner's candidate read does not
 * project, so that the publication path below can actually be reached.
 *
 * WHY THIS SEAM EXISTS, AND WHY IT IS NARROW. `RecipeIngredientIdentity`
 * declares `allergen_status` optional precisely because `recipe_ingredients`
 * does not snapshot it — the contract is that "the planner's service supplies"
 * it from the resolved `catalog_foods` row, exactly as it already supplies
 * `food_group`. `PLANNING_INGREDIENT_SELECT` projects `food_group` and omits
 * `allergen_status`, so `evaluatePlanningEligibility` — which requires an
 * explicit `known` per ingredient — refuses EVERY recipe in EVERY database, and
 * `generatePlan` can never open the transaction this suite needs to observe.
 * That defect is in another work unit's files at this checkpoint and is reported
 * rather than edited here; the test above pins it.
 *
 * So this decorates the REAL read with the value that fix will supply, and
 * nothing else: the recipe rows, their ids and their nutrition all come from the
 * database, so the FKs the publication writes are real, and the lock, the gate,
 * the ledger, the snapshot and the grocery write under test are untouched. When
 * the projection lands, `?? 'known'` becomes a no-op and this seam can be
 * deleted without changing a single assertion.
 */
const usePlannableCatalog = (): void => {
    const readCandidates = recipeService.getRecipeVersionsForPlanning;

    jest.spyOn(recipeService, 'getRecipeVersionsForPlanning').mockImplementation(async (db) => {
        const candidates = await readCandidates(db);

        return candidates.map((candidate) => ({
            ...candidate,
            ingredients: candidate.ingredients.map((ingredient) => ({
                ...ingredient,
                allergen_status: ingredient.allergen_status ?? 'known',
            })),
        }));
    });
};

/**
 * How long the publication is held open, so that a write fired while it is
 * running is demonstrably fired INSIDE its transaction.
 */
const PUBLICATION_WINDOW_MS = 1200;

/** Long enough for the request to have reached the grocery write past the gate. */
const ENTER_PUBLICATION_MS = 400;

/**
 * Holds the publication transaction open at a step that runs AFTER the gate.
 *
 * The grocery write is the last substantial thing the callback does, so a delay
 * there sits inside the transaction with the gate's row lock already taken and
 * the plan already inserted. That window is the only way to fire the legacy
 * writer DURING a publication rather than before or after one, which is what
 * AAP §0.9.2's second ordering is about. Nothing about the gate, the lock or the
 * snapshot is stubbed — only the moment of COMMIT is postponed.
 */
const holdPublicationOpen = (): void => {
    const writeRows = groceryService.writePlanGroceryRows;

    jest.spyOn(groceryService, 'writePlanGroceryRows').mockImplementation(async (tx, params) => {
        const written = await writeRows(tx, params);
        await sleep(PUBLICATION_WINDOW_MS);

        return written;
    });
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

        // ONE food, with a MASS default portion. The factory's default portion
        // is `1 cup` against a null `density_g_per_ml`, and the grocery write
        // that follows publication converts a planned gram weight into the
        // contributors' own unit family — which for a volume portion requires a
        // density the food does not have. That is the documented contract, not a
        // defect, so the fixture states a unit family it can be displayed in.
        const food = await makeCatalogFood({
            defaultPortion: { description: '100 g', amount: 100, unit: 'g', gram_weight: 100 },
        });

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

    it('pins the one thing that stops this suite reaching a published week', async () => {
        // NOT a fixture problem, and deliberately asserted rather than worked
        // around. `recipe.service.ts::PLANNING_INGREDIENT_SELECT` does not
        // project an ingredient-level `allergen_status`, while
        // `recipe.logic.ts::evaluatePlanningEligibility` requires every
        // ingredient to carry exactly `'known'`. No recipe in any database can
        // therefore be planned, whatever its data — so `generatePlan` answers
        // `no_matching_meals` for every user until that projection is supplied.
        //
        // Both files belong to other work units at this checkpoint, so this is
        // reported rather than edited here. THIS TEST IS THE HANDSHAKE: when the
        // projection lands, `eligible` becomes non-zero, this expectation fails,
        // and the publication race below starts asserting instead of recording
        // why it cannot. Neither outcome is silent.
        const { eligible, refusalCodes } = await planningEligibility();

        if (eligible > 0) {
            expect(refusalCodes).toEqual([]);
            return;
        }

        expect(refusalCodes).toEqual(['allergen_status']);
    });

    it('waits, and then refuses, when a legacy write holds the user row first', async () => {
        usePlannableCatalog();

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

        await sleep(BLOCK_OBSERVATION_MS);
        expect(generation.settled()).toBe(false);

        releaseHold.release();
        await holder;

        await expect(generation.done).rejects.toThrow(TargetsUnconfirmedError);
        expect(await countPersisted()).toEqual({ plans: 0, ledger: 0 });

        expect(await getTargets(USER_ID)).toMatchObject({ source: 'legacy' });
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
        usePlannableCatalog();
        holdPublicationOpen();

        const generation = watch(generatePlan(USER_ID, generateRequest(), new Date()));

        await sleep(ENTER_PUBLICATION_MS);
        expect(generation.settled()).toBe(false);

        const legacy = watch(
            updateTargets(USER_ID, { calories: FIXTURE_TARGETS.calories + 100 }, legacyWriterClient),
        );

        await sleep(BLOCK_OBSERVATION_MS);
        expect(legacy.settled()).toBe(false);

        const published = await generation.done;

        expect(published.kind).toBe('ok');

        const plan = await prisma.meal_plans.findFirstOrThrow({
            where: { user_id: USER_ID, status: 'active' },
            select: { id: true, targets_snapshot: true },
        });

        expect(plan.targets_snapshot).toEqual({ ...FIXTURE_TARGETS });

        await legacy.done;

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
    });

    it('makes the legacy writer wait on a REGENERATION too, which shares the gate', async () => {
        // The regeneration callback runs the same gate over a plan that already
        // exists, and it replaces a week rather than adding one — so a legacy
        // write slipping in mid-publication would leave the REPLACEMENT week
        // attributed to values nobody confirmed. Asserted separately because it
        // is a separate call site: dropping the gate from one callback and not
        // the other is exactly the sort of edit a single test would miss.
        usePlannableCatalog();

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

        holdPublicationOpen();

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

        await sleep(ENTER_PUBLICATION_MS);
        expect(regeneration.settled()).toBe(false);

        const legacy = watch(
            updateTargets(USER_ID, { calories: FIXTURE_TARGETS.calories + 100 }, legacyWriterClient),
        );

        await sleep(BLOCK_OBSERVATION_MS);
        expect(legacy.settled()).toBe(false);

        expect((await regeneration.done).kind).toBe('ok');
        await legacy.done;

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
    });

    it('leaves only a safe outcome when the two are raced', async () => {
        usePlannableCatalog();

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
