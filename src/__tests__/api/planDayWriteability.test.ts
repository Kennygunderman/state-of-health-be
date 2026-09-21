// The database-backed proof that the single-day envelope tells the truth about
// whether its plan may still be WRITTEN to (Agent Action Plan §0.5.1
// "Superseded and ended plans", §0.5.2's `GET /plans/:planId/days/:date` row,
// §0.7.4's client rule that the day answer is what disables Swap and Log).
//
// WHAT WENT WRONG, AND WHY A COLUMN COULD NOT CATCH IT. §0.5.1 leaves a plan
// whose last date has passed stored `status = 'active'`: no job rewrites it,
// because its rows must stay readable for history. The day read reported that
// column verbatim, so a plan from last month answered `planStatus: 'active'`
// and the screens built on it offered Swap and Log — which every write path
// then refused with `409 plan_not_active {reason: 'ended'}`. Nothing failed
// loudly: two correct halves disagreed, and the disagreement was only visible
// to a user pressing a button. The envelope now carries `planLifecycle` and
// `isWritable`, computed from the same `mealPlan.logic.ts::isPlanEnded`
// predicate the writers use, and the cases below are what hold them together.
//
// WHY ITS OWN FILE. The claim is about one route's answer across the three
// lifecycle states, and proving it needs real rows: a plan, its days, its
// meals, and a second plan to supersede the first. `api/requestParserWiring.
// test.ts` — where the injected clock's ORDERING is proven — replaces the Prisma
// singleton module-wide with a recording stub and therefore cannot hold a
// row-backed case at all, and `api/ownership.test.ts` next door is the
// cross-user matrix, where a lifecycle case would be a second subject.
// `api/plans.test.ts` owns the plan routes' full HTTP coverage and declares
// the same split from its own side: it asserts the route-level contract of
// this envelope, and the lifecycle × zone matrix inside it is this file's.
//
// WHICH LAYER IT DRIVES. `mealPlan.service.ts::getMealPlanDay` directly, as the
// neighbouring suites do: the verdict is the service's own, computed from ONE
// stored week read at three instants in two zones, so driving it here pins the
// verdict itself rather than the status code that carries it. The route-level
// contract over the same envelope — its status codes and the `isWritable` a
// request reports — belongs to `api/plans.test.ts`, and the tenancy matrix
// over it to `api/ownership.test.ts`.
//
// THE CLOCK IS PINNED AND THE STORED WEEK IS NEVER EDITED. Every case reaches a
// lifecycle by judging the SAME plan at a different instant, which is how a
// reader can see that nothing but the calendar day moved. That is also what
// makes the zone case below meaningful: one instant, two stored zones, two
// verdicts.

import { prisma } from '../../prisma/client';
import { uncheckAllGroceries } from '../../services/grocery.service';
import { getMealPlanDay } from '../../services/mealPlan.service';
import { FIXTURE_USER_TARGET_COLUMNS, makePlan, makePreferences, makeUser } from '../setup/factories';
import { truncateFeatureTables } from '../setup/testDb';

const USER_ID = 'plan-day-writeability-user';

/** The plan's week, stated absolutely so every instant below is readable against it. */
const PLAN_START_DAY_KEY = '2026-06-08';
const PLAN_END_DAY_KEY = '2026-06-14';

/** The zone `makePreferences` stores, and the one every default instant is read in. */
const STORED_TIME_ZONE = 'America/New_York';

/** 11:00 on Wednesday the 10th in that zone: inside the plan's week. */
const INSIDE_THE_WEEK = new Date('2026-06-10T15:00:00.000Z');

/** Monday the 15th there: the day after the week finished. */
const AFTER_THE_WEEK = new Date('2026-06-15T15:00:00.000Z');

/**
 * 02:00 UTC on the 15th — which is 22:00 on the 14th in `America/New_York`.
 *
 * The one instant that separates "the user's calendar" from "the server's": the
 * plan's last day is over in UTC and in every zone east of it, and has four
 * hours left in the zone this user stored.
 */
const LAST_EVENING_IN_STORED_ZONE = new Date('2026-06-15T02:00:00.000Z');

/** `makePlan` publishes at revision 1. */
const PLAN_REVISION = 1;

interface Fixture {
    readonly planId: string;
    readonly dayKey: string;
}

/**
 * One user, one published week, and nothing else. No grocery rows are needed:
 * the write below is refused on the plan's lifecycle, before any row of the
 * list is read, which is precisely the comparison this suite is making.
 */
const seedFixture = async (): Promise<Fixture> => {
    await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(USER_ID, { time_zone: STORED_TIME_ZONE });

    const plan = await makePlan(USER_ID, { startDate: PLAN_START_DAY_KEY });

    return { planId: plan.id, dayKey: PLAN_START_DAY_KEY };
};

/** The envelope, with the result union already narrowed for the assertions. */
const readEnvelope = async (planId: string, dayKey: string, now: Date) => {
    const result = await getMealPlanDay(USER_ID, planId, dayKey, now);

    if (result.kind !== 'ok') {
        throw new Error(`Expected a day envelope, received ${JSON.stringify(result)}`);
    }

    return result.envelope;
};

let fixture: Fixture;

beforeEach(async () => {
    await truncateFeatureTables();
    fixture = await seedFixture();
});

afterAll(async () => {
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * The three lifecycles
 * ------------------------------------------------------------------------- */

describe('the day envelope reports the plan lifecycle it is read on', () => {
    // WHAT IS CONTRACT AND WHAT IS EXTRA. §0.5.2 declares this envelope as
    // exactly `{planId, planRevision, planStatus, day}`. The two lifecycle
    // members every case below is about are ADDITIVE: the DTO types them
    // optional and the client requires neither — it falls back to `planStatus`
    // and recovers from `409 plan_not_active` when they are absent — because a
    // required non-contract member is a response a conforming server cannot
    // produce. So the guarantee that this server nevertheless sends them is a
    // claim about this mapper rather than about the type, and this is where it
    // is pinned.
    it('answers the four contract members, and the two lifecycle extras beside them', async () => {
        const envelope = await readEnvelope(fixture.planId, fixture.dayKey, INSIDE_THE_WEEK);

        expect(Object.keys(envelope).sort()).toEqual(
            ['day', 'isWritable', 'planId', 'planLifecycle', 'planRevision', 'planStatus'].sort(),
        );
    });

    it('reports a live week as writable', async () => {
        const envelope = await readEnvelope(fixture.planId, fixture.dayKey, INSIDE_THE_WEEK);

        expect(envelope).toMatchObject({
            planId: fixture.planId,
            planRevision: PLAN_REVISION,
            planStatus: 'active',
            planLifecycle: 'active',
            isWritable: true,
        });
        expect(envelope.day.date).toBe(fixture.dayKey);
    });

    it('reports a finished week as ended while its stored status stays active', async () => {
        const envelope = await readEnvelope(fixture.planId, fixture.dayKey, AFTER_THE_WEEK);

        expect(envelope.planLifecycle).toBe('ended');
        expect(envelope.isWritable).toBe(false);

        // The column is deliberately untouched — the point of the two new
        // members. A test that asserted the status had changed would be
        // asserting the opposite of §0.5.1.
        expect(envelope.planStatus).toBe('active');
        expect((await prisma.meal_plans.findUniqueOrThrow({ where: { id: fixture.planId } })).status).toBe(
            'active',
        );
    });

    it('reports a replaced plan as superseded whatever its dates say', async () => {
        // In this order, because the partial unique index on
        // `(user_id, start_date) WHERE status = 'active'` allows exactly one
        // active plan per week — which is what a regeneration relies on and
        // what makes the successor unambiguous.
        await prisma.meal_plans.update({
            where: { id: fixture.planId },
            data: { status: 'superseded' },
        });

        const replacement = await makePlan(USER_ID, { startDate: PLAN_START_DAY_KEY, sequence: 2 });

        await prisma.meal_plans.update({
            where: { id: replacement.id },
            data: { replaced_plan_id: fixture.planId },
        });

        const envelope = await readEnvelope(fixture.planId, fixture.dayKey, INSIDE_THE_WEEK);

        expect(envelope.planStatus).toBe('superseded');
        expect(envelope.planLifecycle).toBe('superseded');
        expect(envelope.isWritable).toBe(false);
    });

    it('keeps a finished and a replaced week fully readable, so history still works', async () => {
        // §0.5.2 declares no `plan_not_active` for this route: the diary still
        // shows what was eaten from last week's plan, so the day payload has to
        // arrive intact even though nothing may be written to it.
        const ended = await readEnvelope(fixture.planId, fixture.dayKey, AFTER_THE_WEEK);

        expect(ended.day.meals).toHaveLength(3);
        expect(ended.day.plannedTotals.calories).toBeGreaterThan(0);

        await prisma.meal_plans.update({ where: { id: fixture.planId }, data: { status: 'superseded' } });

        const superseded = await readEnvelope(fixture.planId, fixture.dayKey, INSIDE_THE_WEEK);

        expect(superseded.day.meals).toHaveLength(3);
        expect(superseded.day.id).toBe(ended.day.id);
    });
});

/* ---------------------------------------------------------------------------
 * Whose calendar decides
 * ------------------------------------------------------------------------- */

describe('the verdict is computed in the zone the user stored', () => {
    it('still reports the last evening of the week as writable in the user’s zone', async () => {
        // 02:00 UTC on the 15th. In UTC the week is over; in `America/New_York`
        // it is 22:00 on the 14th and the plan has four hours left. Reading the
        // server's day here is exactly how a user in the Americas loses the
        // last evening of every plan.
        const envelope = await readEnvelope(fixture.planId, fixture.dayKey, LAST_EVENING_IN_STORED_ZONE);

        expect(envelope.planLifecycle).toBe('active');
        expect(envelope.isWritable).toBe(true);
    });

    it('reports the same instant as ended for a user whose stored zone is ahead', async () => {
        await prisma.meal_plan_preferences.update({
            where: { user_id: USER_ID },
            data: { time_zone: 'Pacific/Auckland' },
        });

        const envelope = await readEnvelope(fixture.planId, fixture.dayKey, LAST_EVENING_IN_STORED_ZONE);

        expect(envelope.planLifecycle).toBe('ended');
        expect(envelope.isWritable).toBe(false);
    });
});

/* ---------------------------------------------------------------------------
 * The envelope and the writers cannot disagree
 * ------------------------------------------------------------------------- */

describe('the envelope agrees with what a write against the same plan does', () => {
    it('offers writes exactly while a write is accepted', async () => {
        const envelope = await readEnvelope(fixture.planId, fixture.dayKey, INSIDE_THE_WEEK);

        expect(envelope.isWritable).toBe(true);
        // The cheapest real write path: `uncheckAllGroceries` takes the per-user
        // lock and applies `requireWritablePlan` before it reads a single
        // grocery row, so an empty list is enough to establish the verdict.
        await expect(uncheckAllGroceries(USER_ID, fixture.planId, INSIDE_THE_WEEK)).resolves.toEqual({
            checkedCount: 0,
        });
    });

    it('refuses writes exactly while it reports the plan unwritable', async () => {
        const envelope = await readEnvelope(fixture.planId, fixture.dayKey, AFTER_THE_WEEK);

        expect(envelope.isWritable).toBe(false);
        await expect(uncheckAllGroceries(USER_ID, fixture.planId, AFTER_THE_WEEK)).rejects.toMatchObject({
            name: 'PlanNotActiveError',
            data: { reason: 'ended' },
        });
    });

    it('agrees with the writers on the boundary instant too', async () => {
        // The case that would have caught the defect: one instant, one plan, and
        // the read and the write must reach the same conclusion in the user's
        // own calendar rather than the server's.
        const envelope = await readEnvelope(fixture.planId, fixture.dayKey, LAST_EVENING_IN_STORED_ZONE);

        expect(envelope.isWritable).toBe(true);
        await expect(
            uncheckAllGroceries(USER_ID, fixture.planId, LAST_EVENING_IN_STORED_ZONE),
        ).resolves.toEqual({ checkedCount: 0 });
    });
});
