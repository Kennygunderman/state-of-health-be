// The enforcing proof for the three properties of a preference SAVE that only
// a real PostgreSQL can establish, all of them about columns the client never
// sends and therefore about what the server derives on its own.
//
// WHAT IS BEING PROVEN, AND WHY THE PURE TESTS CANNOT DO IT.
// `preferences.logic.test.ts` pins each rule in isolation — which route a body
// answer implies, which setup state a route change reconciles to, which bodies
// the envelope refuses. None of that says the SAVE applies them: a derivation
// that is computed and then left out of the `data` object, or a zone parsed and
// then not written, is invisible to a unit test of the rule and visible in one
// read of the stored row.
//
//   1. `target_route` FOLLOWS THE BODY ANSWER THROUGH THE FULL SAVE. `age`,
//      `heightCm`, `weightKg` and `sexForEstimate` are members of this
//      endpoint's closed editable DTO (0.5.2), while `target_route` is
//      server-owned and absent from it — a client key for it is
//      `read_only_field` — so re-deriving the route when a body answer moves
//      through `PUT /meal-planning/preferences` is the endpoint's obligation to
//      whatever calls it, not a screen's. A save that changed the sex answer
//      without re-deriving left the row claiming a route its own answers
//      contradict — an estimated route for a user who now declines to state a
//      sex (whose target would then be calculated from an assumed one), or a
//      manual route for a user whose measurements are now complete. The cases
//      below therefore drive `savePreferences` with the bodies the contract
//      accepts rather than the body of any one caller: the full save's only
//      client today sends the envelope alone, for the zone refresh of 2.
//   2. THE STORED ZONE IS THE ONE THIS REQUEST CARRIED. The contract requires
//      the zone on every full save and resolves the user's "today" from it, so
//      a save that accepted its omission left every date rule reading a zone
//      the user may have left.
//   3. THE WRITE CARRIES THE PINNED REVISION. The optimistic check belongs in
//      the mutation, not only in the comparison the parser made.
//
// Everything here runs against the ambient test database and truncates only the
// feature tables through the shared guard, exactly as the other service suites
// do.

import { prisma } from '../../prisma/client';
import { makePlan, makePreferences, makeRecipeVersion, makeUser } from '../../__tests__/setup/factories';
import { truncateFeatureTables } from '../../__tests__/setup/testDb';
import { StaleRevisionError } from '../mealPlanning.errors';
import {
    dayKeyInTimeZone,
    savePreferences,
    saveSetupStep,
    SavePreferencesResult,
} from '../preferences.service';

const USER_ID = 'preferences-service-suite-user';
const TIME_ZONE = 'America/New_York';
const MOVED_TIME_ZONE = 'Europe/Lisbon';

/** The stored columns every assertion below reads. */
const storedRow = async (): Promise<{
    target_route: string | null;
    setup_status: string | null;
    setup_step: string | null;
    time_zone: string | null;
    revision: number;
    sex_for_estimate: string | null;
    age: number | null;
    weight_kg: number | null;
}> =>
    prisma.meal_plan_preferences.findUniqueOrThrow({
        where: { user_id: USER_ID },
        select: {
            target_route: true,
            setup_status: true,
            setup_step: true,
            time_zone: true,
            revision: true,
            sex_for_estimate: true,
            age: true,
            weight_kg: true,
        },
    });

/** `savePreferences`, with a refusal verdict turned into a failure. */
const saveFull = async (body: Record<string, unknown>): Promise<SavePreferencesResult> => {
    const result = await savePreferences(USER_ID, body);

    if (result.kind !== 'ok') {
        throw new Error(`full save was refused: ${JSON.stringify(result)}`);
    }

    return result;
};

/** The one accepted shape a case needs, without repeating the envelope. */
const fullBody = (
    edits: Record<string, unknown>,
    expectedRevision: number,
    timeZone: string = TIME_ZONE,
): Record<string, unknown> => ({ ...edits, timeZone, expectedRevision });

/** The four measurements a measured body answer carries. */
const MEASUREMENTS = { age: 34, heightCm: 177.8, weightKg: 82.6 } as const;

beforeEach(async () => {
    await truncateFeatureTables();
    await makeUser({ id: USER_ID });
});

afterAll(async () => {
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * 1. The server-owned target route
 * ------------------------------------------------------------------------- */

describe('the target route a full save leaves behind', () => {
    it('moves an estimated user to the manual route when they decline to state a sex', async () => {
        await makePreferences(USER_ID, { setup_status: 'in_progress', setup_step: 'diet' });

        const result = await saveFull(fullBody({ sexForEstimate: 'prefer_not_to_say' }, 1));

        expect((await storedRow()).target_route).toBe('manual');
        expect(result.kind === 'ok' && result.response.preferences.targetRoute).toBe('manual');
    });

    it('moves a skipped-body user to the estimated route once the answer is complete', async () => {
        // Skip stores no measurements at all, so this save is the first complete
        // body answer the row has ever held.
        await makePreferences(USER_ID, {
            setup_status: 'in_progress',
            setup_step: 'diet',
            target_route: 'manual',
            age: null,
            height_cm: null,
            weight_kg: null,
            sex_for_estimate: null,
        });

        await saveFull(fullBody({ ...MEASUREMENTS, sexForEstimate: 'female' }, 1));

        expect(await storedRow()).toMatchObject({ target_route: 'estimated', sex_for_estimate: 'female' });
    });

    it('keeps the manual route while a measured answer is still incomplete', async () => {
        await makePreferences(USER_ID, {
            setup_status: 'in_progress',
            setup_step: 'diet',
            target_route: 'manual',
            age: null,
            height_cm: null,
            weight_kg: null,
            sex_for_estimate: null,
        });

        await saveFull(fullBody({ sexForEstimate: 'male' }, 1));

        expect(await storedRow()).toMatchObject({ target_route: 'manual', sex_for_estimate: 'male' });
    });

    it('leaves the route alone on a save that does not touch the body answer', async () => {
        await makePreferences(USER_ID);

        await saveFull(fullBody({ diet: 'vegan' }, 1));

        expect((await storedRow()).target_route).toBe('estimated');
    });

    it('never sends a completed user back into onboarding to satisfy the new route', async () => {
        // A completed row belongs to a user who already has a plan, and the
        // contract keeps the save open to it, so regressing their setup state is
        // the failure the monotonic status rule exists to prevent — even though
        // the estimated route they are moving onto requires an activity level
        // this row does not hold.
        await makePreferences(USER_ID, { target_route: 'manual', activity_level: null });

        await saveFull(fullBody({ ...MEASUREMENTS, sexForEstimate: 'male' }, 1));

        expect(await storedRow()).toMatchObject({
            target_route: 'estimated',
            setup_status: 'completed',
            setup_step: null,
        });
    });

    it('pulls a ready-for-review user back to the answer their new route requires', async () => {
        // The manual route never asks for an activity level, so this user became
        // an estimated-route user with a required answer missing. Leaving them
        // `ready_for_review` would promise a plan could be generated from a row
        // whose activity level was never given.
        await makePreferences(USER_ID, {
            setup_status: 'ready_for_review',
            setup_step: 'review',
            target_route: 'manual',
            activity_level: null,
        });

        await saveFull(fullBody({ ...MEASUREMENTS, sexForEstimate: 'male' }, 1));

        expect(await storedRow()).toMatchObject({
            target_route: 'estimated',
            setup_status: 'in_progress',
            setup_step: 'activity',
        });
    });

    it('leaves setup untouched when the new route needs nothing the row lacks', async () => {
        await makePreferences(USER_ID, {
            setup_status: 'ready_for_review',
            setup_step: 'review',
            target_route: 'estimated',
        });

        await saveFull(fullBody({ sexForEstimate: 'prefer_not_to_say' }, 1));

        expect(await storedRow()).toMatchObject({
            target_route: 'manual',
            setup_status: 'ready_for_review',
            setup_step: 'review',
        });
    });
});

/* ---------------------------------------------------------------------------
 * 2. The zone this request carried
 * ------------------------------------------------------------------------- */

describe('the time zone a full save refreshes', () => {
    it('stores the zone the request carried', async () => {
        await makePreferences(USER_ID);

        await saveFull(fullBody({ diet: 'vegan' }, 1, MOVED_TIME_ZONE));

        expect((await storedRow()).time_zone).toBe(MOVED_TIME_ZONE);
    });

    it('canonicalises an alias rather than storing it as sent', async () => {
        await makePreferences(USER_ID);

        await saveFull(fullBody({ diet: 'vegan' }, 1, 'Etc/UTC'));

        expect((await storedRow()).time_zone).toBe(
            new Intl.DateTimeFormat('en-US', { timeZone: 'Etc/UTC' }).resolvedOptions().timeZone,
        );
    });

    it('refuses a save that carries no zone, and writes nothing', async () => {
        await makePreferences(USER_ID);

        const result = await savePreferences(USER_ID, { diet: 'vegan', expectedRevision: 1 });

        expect(result).toMatchObject({
            kind: 'error',
            code: 'invalid_request',
            details: [{ field: 'timeZone', code: 'required' }],
        });
        expect(await storedRow()).toMatchObject({ revision: 1, time_zone: TIME_ZONE });
        expect(await prisma.meal_plan_preferences.findUniqueOrThrow({ where: { user_id: USER_ID } })).toMatchObject(
            { diet: 'none' },
        );
    });

    it('refuses a zone this runtime does not know', async () => {
        await makePreferences(USER_ID);

        expect(await savePreferences(USER_ID, fullBody({ diet: 'vegan' }, 1, 'Mars/Phobos'))).toMatchObject({
            kind: 'error',
            details: [{ field: 'timeZone', code: 'invalid_time_zone' }],
        });
        expect((await storedRow()).time_zone).toBe(TIME_ZONE);
    });

    it('accepts a body that carries the envelope and nothing else, when the zone is what moved', async () => {
        // The zone is an envelope field AND a stored column, and this is the one
        // body where those facts diverge. A user who travels without editing any
        // answer sends exactly `{timeZone, expectedRevision}`, and that is a real
        // edit of `time_zone` — the only channel the contract gives a client for
        // the refresh this whole section is about. Refusing it as `body:
        // required` left the stored calendar unreachable, and with it every
        // "today" the cases below derive.
        await makePreferences(USER_ID);

        expect(
            await savePreferences(USER_ID, { timeZone: MOVED_TIME_ZONE, expectedRevision: 1 }),
        ).toMatchObject({ kind: 'ok' });
        expect(await storedRow()).toMatchObject({ revision: 2, time_zone: MOVED_TIME_ZONE });
    });

    it('refuses an envelope-only body whose zone the row already holds, which edits nothing', async () => {
        // The invariant the acceptance above must not cost: a save that changes
        // nothing would still bump the revision and invalidate every other
        // client's pinned value.
        await makePreferences(USER_ID);

        expect(await savePreferences(USER_ID, { timeZone: TIME_ZONE, expectedRevision: 1 })).toMatchObject({
            kind: 'error',
            details: [{ field: 'body', code: 'required' }],
        });
        expect(await storedRow()).toMatchObject({ revision: 1, time_zone: TIME_ZONE });
    });
});

/* ---------------------------------------------------------------------------
 * 2b. WHAT THE REFRESHED ZONE DECIDES
 *
 * Storing the zone is only half the finding. The zone is required on every save
 * because the save derives the user's "today" FROM IT, and that day key decides
 * which plans count as still running: `hasActivePlanOn` and the flag
 * recomputation both select `end_date >= today`. A save that kept the stored
 * zone would answer both questions in a calendar the user has left.
 *
 * The two cases below are the same fixture read from opposite sides of a local
 * midnight. One fixed UTC instant, two zones that never observe DST, and a plan
 * whose last day is the earlier of the two dates — so the plan is still running
 * in one zone and over in the other, and each case asserts the answer that only
 * the SUBMITTED zone produces. Were the stored zone used, each expectation
 * would invert, which is what makes them a test of the refresh rather than of
 * the arithmetic.
 * ------------------------------------------------------------------------- */

describe('the today a full save derives from that zone', () => {
    // 12:00Z on the 15th is the 15th in Honolulu (UTC-10) and already the 16th
    // in Kiritimati (UTC+14). Neither zone observes DST, so this holds whatever
    // the date the suite runs on.
    const INSTANT = new Date('2026-06-15T12:00:00Z');
    const EARLIER_DAY_ZONE = 'Pacific/Honolulu';
    const LATER_DAY_ZONE = 'Pacific/Kiritimati';
    /**
     * The plan's only day, and therefore its last: the 15th — today in
     * Honolulu, yesterday in Kiritimati. One day and one slot make the meal
     * count exactly one, so `affectedMealCount` reads as the presence or
     * absence of the recomputation rather than as an arithmetic coincidence.
     */
    const PLAN_END = '2026-06-15';

    /** One active plan with exactly one planned meal, which a 30-minute limit flags. */
    const seedPlanWithOneFlaggableMeal = async (storedZone: string): Promise<void> => {
        await makePreferences(USER_ID, { time_zone: storedZone });

        const recipe = await makeRecipeVersion({ prep_minutes: 15, cook_minutes: 30 });

        await makePlan(USER_ID, {
            startDate: PLAN_END,
            dayCount: 1,
            recipeVersionId: recipe.id,
            slots: [{ slot: 'dinner', slot_time: '18:30' }],
        });
    };

    /** Narrowed to the accepted member, because these cases read the response. */
    const saveAt = async (timeZone: string): Promise<Extract<SavePreferencesResult, { kind: 'ok' }>> => {
        const result = await savePreferences(
            USER_ID,
            // A real edit that leaves the 45-minute recipe over the limit, so
            // the meal is flagged whenever the flags are recomputed at all.
            { cookingTimeLimitMin: 15, timeZone, expectedRevision: 1 },
            INSTANT,
        );

        if (result.kind !== 'ok') {
            throw new Error(`full save was refused: ${JSON.stringify(result)}`);
        }

        return result;
    };

    it('is the day the two zones disagree about', () => {
        // The fixture's premise, asserted rather than assumed: if a future
        // tzdata moved either zone, every expectation below would silently
        // become vacuous.
        expect(dayKeyInTimeZone(INSTANT, EARLIER_DAY_ZONE)).toBe(PLAN_END);
        expect(dayKeyInTimeZone(INSTANT, LATER_DAY_ZONE)).toBe('2026-06-16');
    });

    it('treats the plan as still running when the submitted zone is behind the stored one', async () => {
        await seedPlanWithOneFlaggableMeal(LATER_DAY_ZONE);

        const result = await saveAt(EARLIER_DAY_ZONE);

        // Today is the plan's last day in the SUBMITTED zone, so the plan is
        // live: its meal is flagged and the response says a plan is active.
        // Under the stored zone today would be the 16th and both would be
        // absent — which is the state this finding was about.
        expect(result.response.affectedMealCount).toBe(1);
        expect(result.response.preferences.hasActivePlan).toBe(true);
        expect(
            await prisma.meal_plan_meals.count({ where: { user_id: USER_ID, flags: { not: [] } } }),
        ).toBe(1);
    });

    it('treats the same plan as over when the submitted zone is ahead of the stored one', async () => {
        await seedPlanWithOneFlaggableMeal(EARLIER_DAY_ZONE);

        const result = await saveAt(LATER_DAY_ZONE);

        // The inverse, and the direction that cannot be reached by accident:
        // today is the day AFTER the plan's last, so the ended plan is excluded
        // from the recomputation and from `hasActivePlan`. Under the stored zone
        // both would report the plan as live.
        expect(result.response.affectedMealCount).toBe(0);
        expect(result.response.preferences.hasActivePlan).toBe(false);
        expect(
            await prisma.meal_plan_meals.count({ where: { user_id: USER_ID, flags: { not: [] } } }),
        ).toBe(0);
        // And the zone that decided it is the one now stored, so the next read
        // agrees with this answer.
        expect((await storedRow()).time_zone).toBe(LATER_DAY_ZONE);
    });
});

/* ---------------------------------------------------------------------------
 * 3. The pinned revision, in the mutation
 *
 * A successful save is itself the exercise of the new predicate: the statement
 * is `updateMany({where: {user_id, revision: <pinned>}})` and the service
 * raises `StaleRevisionError` unless exactly one row matched, so a predicate
 * that named the wrong revision would fail every save rather than none. The
 * unreachable half — a revision that moves BETWEEN the locked read and the
 * update — cannot be staged from outside the transaction, because every writer
 * of this row takes the same per-user advisory lock first; that is why it is a
 * guard against a future writer rather than a branch with behaviour of its own.
 * ------------------------------------------------------------------------- */

describe('the revision a save pins', () => {
    it('advances the revision by exactly one when the pinned value still holds', async () => {
        await makePreferences(USER_ID);

        await saveFull(fullBody({ diet: 'vegan' }, 1));

        expect((await storedRow()).revision).toBe(2);
    });

    it('advances it once more on the next save, so each save pins the value it read', async () => {
        await makePreferences(USER_ID);

        await saveFull(fullBody({ diet: 'vegan' }, 1));
        await saveFull(fullBody({ cookingTimeLimitMin: 45 }, 2));

        expect((await storedRow()).revision).toBe(3);
    });

    it('refuses a stale pinned revision and writes nothing', async () => {
        await makePreferences(USER_ID);
        await saveFull(fullBody({ diet: 'vegan' }, 1));

        await expect(savePreferences(USER_ID, fullBody({ diet: 'pescatarian' }, 1))).rejects.toBeInstanceOf(
            StaleRevisionError,
        );

        const row = await prisma.meal_plan_preferences.findUniqueOrThrow({ where: { user_id: USER_ID } });

        expect(row).toMatchObject({ revision: 2, diet: 'vegan' });
    });

    it('reports the authoritative revision with the refusal', async () => {
        await makePreferences(USER_ID);
        await saveFull(fullBody({ diet: 'vegan' }, 1));

        await expect(savePreferences(USER_ID, fullBody({ diet: 'pescatarian' }, 1))).rejects.toMatchObject({
            data: { currentRevision: 2 },
        });
    });

    it('lets exactly one of two concurrent saves win', async () => {
        await makePreferences(USER_ID);

        const outcomes = await Promise.allSettled([
            savePreferences(USER_ID, fullBody({ diet: 'vegan' }, 1)),
            savePreferences(USER_ID, fullBody({ diet: 'pescatarian' }, 1)),
        ]);

        const accepted = outcomes.filter(
            (outcome) => outcome.status === 'fulfilled' && outcome.value.kind === 'ok',
        );
        const rejected = outcomes.filter(
            (outcome) => outcome.status === 'rejected' && outcome.reason instanceof StaleRevisionError,
        );

        expect(accepted).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((await storedRow()).revision).toBe(2);
    });

    it('applies the same predicate to a step save', async () => {
        await makePreferences(USER_ID, { setup_status: 'in_progress', setup_step: 'diet' });

        const accepted = await saveSetupStep(USER_ID, 'diet', {
            diet: 'vegan',
            allergens: ['milk'],
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        expect(accepted.kind).toBe('ok');
        expect((await storedRow()).revision).toBe(2);

        await expect(
            saveSetupStep(USER_ID, 'diet', {
                diet: 'pescatarian',
                allergens: ['none'],
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            }),
        ).rejects.toBeInstanceOf(StaleRevisionError);

        expect(await storedRow()).toMatchObject({ revision: 2 });
    });

    it('creates the first row through the goal step, which has no revision to pin', async () => {
        const created = await saveSetupStep(USER_ID, 'goal', {
            goal: 'lose',
            paceLbPerWeek: 1,
            timeZone: MOVED_TIME_ZONE,
        });

        expect(created.kind).toBe('ok');
        expect(await storedRow()).toMatchObject({
            revision: 1,
            time_zone: MOVED_TIME_ZONE,
            setup_status: 'in_progress',
        });
    });
});
