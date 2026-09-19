// One state, every meal-planning route: an authenticated identity that has no
// `users` row.
//
// WHY THIS STATE HAS ITS OWN SUITE. Firebase authentication and the `users`
// table are two separate records, and only `POST /api/user` creates the second
// one. A token minted for a sign-up that never completed that call — or for an
// account since deleted — is a real, permanent, reachable state, and every table
// a meal-planning write touches carries a foreign key to `users`. So the first
// INSERT for such a caller used to raise PostgreSQL 23503, surface as Prisma
// P2003 (P2010 from the raw ledger reservation), reach the controller's residual
// arm and answer `500 {"error":"internal_error"}` — on the two preference saves,
// the target save, generate, regenerate, swap, log and both grocery writes.
//
// Two things made that answer worse than untidy, and both are what this suite
// pins:
//
//   * THE API CONTRADICTED ITSELF. The shipped, untouched `PUT /api/user/targets`
//     has always answered `404 {"error":"User not found"}` for exactly this
//     caller. Two neighbouring routes gave two different answers to one
//     condition.
//   * THE CLIENT MISREAD IT. `internal_error` is not one of the five recognised
//     5xx machine codes (AAP §0.2.5), so `ApiErrorUtility.classifyOutcome` reads
//     a 5xx carrying it as an UNKNOWN outcome: the four keyed mutations burn
//     their single automatic same-key retry (§0.7.2) and then draw the
//     unconfirmed-outcome state — "We couldn't confirm that / Check your
//     connection and try again." — over a condition that is permanent and wrote
//     nothing. A `404` with a machine code the client declares
//     (`API_ERROR_CODES.userNotFound`) classifies as CONFIRMED, so both the
//     retry and that screen stop.
//
// WHY IT IS ONE SUITE AND NOT A CASE IN EACH ROUTE'S FILE. The guarantee is
// CROSS-ROUTE: what matters is that every mutating route answers the SAME thing,
// that every read still answers 200, and that the shipped sibling route's answer
// did not move. Split across `preferences.test.ts`, `targets.test.ts`,
// `plans.test.ts`, `swaps.test.ts`, `grocery.test.ts` and `log.test.ts` the
// invariant would exist nowhere and could rot one route at a time.
//
// WHERE THE GUARD LIVES, because it is why this suite can be short.
// `mealPlanningAction.service.ts::withUserLock` takes the per-user advisory lock
// as the first statement of every mutating meal-planning transaction, and the
// owner-existence check (`user.service.ts::assertUserProvisioned`) runs there —
// after the lock, so no concurrent write can overtake it, and before the
// caller's own work, which is where the first FK-bound statement lives. All nine
// mutating routes reach that one function. The reads take no lock and are
// deliberately untouched: reading must neither provision nor refuse.
//
// ASSERTED IN BOTH DIRECTIONS. Every case below is followed by the same request
// after `POST /api/user` has provisioned the caller, so a guard that refused
// everyone would fail here rather than pass by being constant.
//
// NOTHING IS WRITTEN, and that is asserted rather than assumed: every case
// re-reads the user-keyed tables and the `users` table itself. A guard that
// answered 404 while a row survived would be worse than the 500 it replaced, and
// auto-provisioning on a write would be a silent account creation.
//
// DETERMINISM. No fixture is seeded at all — the absence of rows IS the fixture —
// and the only clock reading is `utcTodayDayKey()`, used for the two bodies that
// carry a date. Every path id is a fresh v4 UUID: the guard is reached before any
// plan is read, so no id in this file needs to exist.

import { randomUUID } from 'node:crypto';

import { prisma } from '../../prisma/client';
import { withUserLock } from '../../services/mealPlanningAction.service';
import { UserNotProvisionedError } from '../../services/user.service';
import { utcTodayDayKey } from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

/** The identity that authenticates but owns no `users` row. */
const ORPHAN_USER_ID = 'orphan-principal-user';

/** The email `POST /api/user` provisions the same identity with. */
const ORPHAN_EMAIL = 'orphan-principal@fixture.test';

/** The machine code every mutating meal-planning route answers this state with. */
const USER_NOT_FOUND_BODY = { error: 'user_not_found' };

/**
 * The shipped diary route's answer for the same caller — a HUMAN SENTENCE, and
 * it stays one.
 *
 * `PUT /api/user/targets` predates meal planning and its body is part of the
 * contract older clients read; the new routes carry a machine code because
 * §0.5.2 requires one of every meal-planning body. The two are asserted side by
 * side so the difference stays deliberate rather than becoming drift.
 */
const LEGACY_USER_NOT_FOUND_BODY = { error: 'User not found' };

/** What each case reads off a response, declared structurally so this file imports no supertest types. */
interface HttpResponse {
    status: number;
    body: unknown;
}

const MEAL_PLANNING = '/api/meal-planning';

/**
 * One mutating route, as the request a client would actually send.
 *
 * Every body here is WELL FORMED: each route parses its request at the
 * controller edge before any I/O, so a body with a malformed field would be
 * answered `400 invalid_request` and would prove nothing about the guard. The
 * path ids are fresh UUIDs because the guard is reached before a plan, meal,
 * item or bucket is read.
 */
interface MutatingRoute {
    /** How the case names it, and how a failure reads. */
    label: string;
    send: (uid: string) => Promise<HttpResponse>;
}

const MUTATING_ROUTES: readonly MutatingRoute[] = [
    {
        label: 'PUT /meal-planning/preferences/steps/goal',
        send: (uid) =>
            asUser(request.put(`${MEAL_PLANNING}/preferences/steps/goal`), { uid }).send({
                goal: 'maintain',
                timeZone: 'UTC',
            }),
    },
    {
        label: 'PUT /meal-planning/targets',
        send: (uid) =>
            asUser(request.put(`${MEAL_PLANNING}/targets`), { uid }).send({
                source: 'manual',
                calories: 2000,
                protein: 150,
                carbs: 200,
                fat: 60,
                expectedTargetsRevision: 0,
            }),
    },
    {
        label: 'POST /meal-planning/plans',
        send: (uid) =>
            asUser(request.post(`${MEAL_PLANNING}/plans`), { uid }).send({
                startDate: utcTodayDayKey(),
                idempotencyKey: randomUUID(),
                expectedPreferencesRevision: 0,
                expectedTargetsRevision: 0,
            }),
    },
    {
        label: 'POST /meal-planning/plans/:planId/regenerate',
        send: (uid) =>
            asUser(request.post(`${MEAL_PLANNING}/plans/${randomUUID()}/regenerate`), { uid }).send({
                idempotencyKey: randomUUID(),
                expectedPlanRevision: 1,
                expectedPreferencesRevision: 0,
                expectedTargetsRevision: 0,
            }),
    },
    {
        label: 'POST /meal-planning/plans/:planId/meals/:mealId/swap',
        send: (uid) =>
            asUser(
                request.post(`${MEAL_PLANNING}/plans/${randomUUID()}/meals/${randomUUID()}/swap`),
                { uid },
            ).send({
                recipeVersionId: randomUUID(),
                portionMultiplier: 1,
                expectedPlanRevision: 1,
                idempotencyKey: randomUUID(),
            }),
    },
    {
        label: 'POST /meal-planning/plans/:planId/meals/:mealId/log',
        send: (uid) =>
            asUser(request.post(`${MEAL_PLANNING}/plans/${randomUUID()}/meals/${randomUUID()}/log`), {
                uid,
            }).send({
                servings: 1,
                date: utcTodayDayKey(),
                diaryMealId: randomUUID(),
                expectedPlanRevision: 1,
                idempotencyKey: randomUUID(),
            }),
    },
    {
        label: 'PUT /meal-planning/plans/:planId/groceries/:itemId',
        send: (uid) =>
            asUser(
                request.put(`${MEAL_PLANNING}/plans/${randomUUID()}/groceries/${randomUUID()}`),
                { uid },
            ).send({ isChecked: true }),
    },
    {
        label: 'POST /meal-planning/plans/:planId/groceries/uncheck-all',
        send: (uid) =>
            asUser(request.post(`${MEAL_PLANNING}/plans/${randomUUID()}/groceries/uncheck-all`), {
                uid,
            }).send({}),
    },
];

/** Provisions the caller the way a correct client does — through the shipped route. */
const provisionUser = async (uid: string, email: string): Promise<void> => {
    const response = await request.post('/api/user').send({ userId: uid, email });

    if (response.status !== 201) {
        throw new Error(
            `POST /api/user did not provision ${uid}: ${String(response.status)} ` +
                `${JSON.stringify(response.body as unknown)}`,
        );
    }
};

/**
 * Every row this identity could own, across the diary and the whole
 * meal-planning schema — including `users` itself, because a write that
 * auto-provisioned would be a silent account creation.
 */
const rowCounts = async (userId: string) => ({
    users: await prisma.users.count({ where: { id: userId } }),
    preferences: await prisma.meal_plan_preferences.count({ where: { user_id: userId } }),
    plans: await prisma.meal_plans.count({ where: { user_id: userId } }),
    planDays: await prisma.meal_plan_days.count({ where: { user_id: userId } }),
    planMeals: await prisma.meal_plan_meals.count({ where: { user_id: userId } }),
    actions: await prisma.meal_plan_actions.count({ where: { user_id: userId } }),
    groceryItems: await prisma.grocery_items.count({ where: { user_id: userId } }),
    meals: await prisma.meals.count({ where: { user_id: userId } }),
    entries: await prisma.meal_entries.count({ where: { user_id: userId } }),
});

const NOTHING_WRITTEN = {
    users: 0,
    preferences: 0,
    plans: 0,
    planDays: 0,
    planMeals: 0,
    actions: 0,
    groceryItems: 0,
    meals: 0,
    entries: 0,
};

describe('an authenticated principal with no users row', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    afterAll(async () => {
        await truncateFeatureTables();
    });

    describe('every mutating meal-planning route', () => {
        it.each(MUTATING_ROUTES.map((route) => [route.label, route] as const))(
            'answers 404 user_not_found from %s',
            async (_label, route) => {
                const response = await route.send(ORPHAN_USER_ID);

                expect(response.status).toBe(404);
                // Byte-exact: no extra member, and in particular not the user id
                // the error class carries for the server log.
                expect(response.body).toStrictEqual(USER_NOT_FOUND_BODY);
                // Never the 5xx it used to be, and never a body naming the
                // driver, the constraint or the statement that would have
                // produced one.
                expect(JSON.stringify(response.body)).not.toMatch(
                    /PrismaClient|internal_error|P200[0-9]|foreign key|users_/i,
                );

                expect(await rowCounts(ORPHAN_USER_ID)).toStrictEqual(NOTHING_WRITTEN);
            },
        );

        it('answers all of them identically, so the condition has one answer', async () => {
            // Asserted together because the risk is that one route drifts on its
            // own: the guard is shared, and a local `catch` added to any one
            // service would show up here and nowhere else.
            //
            // SEQUENTIALLY, and deliberately not through `Promise.all`. Every one
            // of these requests opens a transaction and contends for the SAME
            // per-user advisory lock, so eight in flight hold eight connections
            // while seven of them wait — which exhausted the pool under a full
            // suite run and answered `500` (Prisma P2037, "too many database
            // connections") for the last five. That is a property of the harness
            // and not of the contract, and the contract is what this case is
            // about: `api/concurrency.test.ts` owns what the lock does under
            // contention.
            const answers: { label: string; status: number; body: unknown }[] = [];

            for (const route of MUTATING_ROUTES) {
                const response = await route.send(ORPHAN_USER_ID);

                answers.push({ label: route.label, status: response.status, body: response.body });
            }

            expect(answers).toStrictEqual(
                MUTATING_ROUTES.map((route) => ({
                    label: route.label,
                    status: 404,
                    body: USER_NOT_FOUND_BODY,
                })),
            );

            expect(await rowCounts(ORPHAN_USER_ID)).toStrictEqual(NOTHING_WRITTEN);
        });

        it('accepts the same requests once the caller is provisioned', async () => {
            // The other direction, and the reason the refusal above is a guard
            // rather than an outage: after the one call a correct client makes at
            // sign-up, the step save that answered 404 writes its row and the
            // generate that answered 404 reaches its own documented refusal
            // (`preferences_incomplete`) instead of the owner check.
            await provisionUser(ORPHAN_USER_ID, ORPHAN_EMAIL);

            const stepSave = await MUTATING_ROUTES[0].send(ORPHAN_USER_ID);
            const generate = await MUTATING_ROUTES[2].send(ORPHAN_USER_ID);

            expect(stepSave.status).toBe(200);
            expect(generate.status).not.toBe(404);
            expect(generate.body).not.toStrictEqual(USER_NOT_FOUND_BODY);

            // The step save is a real write, so the row it creates is the proof
            // the guard let it through.
            expect(await prisma.meal_plan_preferences.count({ where: { user_id: ORPHAN_USER_ID } })).toBe(1);
        });
    });

    describe('the full preferences save', () => {
        it('keeps answering 409 stale_revision, because its refusal precedes the lock', async () => {
            // NOT `user_not_found`, and deliberately not changed to it.
            // `PUT /meal-planning/preferences` edits an existing row and pins
            // `expectedRevision`, so `preferences.logic.ts` refuses a body from a
            // caller with no row before `savePreferences` opens its transaction —
            // the owner guard inside the lock is never reached. That refusal is
            // already deterministic, already documented (§0.5.2's
            // `409 stale_revision {currentRevision}`), and already classifies as
            // a CONFIRMED outcome, which is the whole point of the 404 elsewhere.
            // It is asserted here so the difference is a recorded fact rather
            // than a gap in this suite.
            const response = await asUser(request.put(`${MEAL_PLANNING}/preferences`), {
                uid: ORPHAN_USER_ID,
            }).send({ timeZone: 'UTC', expectedRevision: 0 });

            expect(response.status).toBe(409);
            expect(response.body).toStrictEqual({ error: 'stale_revision', currentRevision: 0 });

            expect(await rowCounts(ORPHAN_USER_ID)).toStrictEqual(NOTHING_WRITTEN);
        });
    });

    describe('the reads', () => {
        it('answers GET /meal-planning/preferences with the not_started empty state', async () => {
            const response = await asUser(request.get(`${MEAL_PLANNING}/preferences`), {
                uid: ORPHAN_USER_ID,
            });

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ setupStatus: 'not_started', revision: 0 });

            expect(await rowCounts(ORPHAN_USER_ID)).toStrictEqual(NOTHING_WRITTEN);
        });

        it('answers GET /meal-planning/targets with null targets', async () => {
            const response = await asUser(request.get(`${MEAL_PLANNING}/targets`), {
                uid: ORPHAN_USER_ID,
            });

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ targets: null, complete: false, source: null, revision: 0 });

            expect(await rowCounts(ORPHAN_USER_ID)).toStrictEqual(NOTHING_WRITTEN);
        });

        it('answers GET /meal-planning/plans/current with two nulls', async () => {
            const response = await asUser(request.get(`${MEAL_PLANNING}/plans/current`), {
                uid: ORPHAN_USER_ID,
            });

            expect(response.status).toBe(200);
            expect(response.body).toStrictEqual({ current: null, upcoming: null });

            expect(await rowCounts(ORPHAN_USER_ID)).toStrictEqual(NOTHING_WRITTEN);
        });

        it('keeps the estimate route on its own documented refusal', async () => {
            // `409 estimate_unavailable {reason: 'missing_inputs'}` is a verdict
            // about the ANSWERS, not about the account, and the guard must not
            // have replaced it: this route reads and takes no lock.
            const response = await asUser(request.get(`${MEAL_PLANNING}/targets/estimate`), {
                uid: ORPHAN_USER_ID,
            });

            expect(response.status).toBe(409);
            expect(response.body).toStrictEqual({
                error: 'estimate_unavailable',
                reason: 'missing_inputs',
            });

            expect(await rowCounts(ORPHAN_USER_ID)).toStrictEqual(NOTHING_WRITTEN);
        });
    });

    describe('the shipped diary route beside them', () => {
        it('still answers PUT /api/user/targets with its human sentence', async () => {
            // The control, and the reason this suite exists at all: this route
            // was already graceful for this caller, and nothing here may move it.
            // The status now agrees with the meal-planning routes while the BODY
            // stays the sentence older clients read.
            const response = await asUser(request.put('/api/user/targets'), {
                uid: ORPHAN_USER_ID,
            }).send({ calories: 2000, protein: 150, carbs: 200, fat: 60 });

            expect(response.status).toBe(404);
            expect(response.body).toStrictEqual(LEGACY_USER_NOT_FOUND_BODY);

            expect(await rowCounts(ORPHAN_USER_ID)).toStrictEqual(NOTHING_WRITTEN);
        });
    });

    describe('the auth boundary', () => {
        it('refuses an unauthenticated write before any of this is reached', async () => {
            // The guard is about an authenticated identity; a request with no
            // identity at all must still die at the middleware, so the 404 above
            // can never be read as "the token was fine".
            const response = await request.put(`${MEAL_PLANNING}/preferences/steps/goal`).send({
                goal: 'maintain',
                timeZone: 'UTC',
            });

            expect(response.status).toBe(401);

            expect(await rowCounts(ORPHAN_USER_ID)).toStrictEqual(NOTHING_WRITTEN);
        });
    });

    describe('the guard at the lock, and the one caller that must opt out', () => {
        // The routes above exercise the guard through HTTP, which is the contract.
        // These two cases exercise `withUserLock` DIRECTLY, because it carries one
        // option no route uses and a route test therefore cannot reach.
        //
        // A transaction whose PURPOSE is to create the `users` row is provisioning
        // rather than writing on behalf of an existing account, and for it the
        // absent row is the starting state. The development seed
        // (`scripts/seed-dev.ts`) is the only such caller: it takes this very lock
        // so that a developer seeding cannot interleave with the app writing for
        // the same user, and inside the lock it deletes, reads and upserts `users`
        // itself. It passes `{ requireProvisionedUser: false }`.
        //
        // Both directions are pinned here because each protects the other. Without
        // the first, the option could silently become the default and every route
        // above would go back to answering 500. Without the second, the guard could
        // be made unconditional and the seed would be unable to provision anyone.
        it('refuses an unprovisioned user by default, without running the work', async () => {
            let workRan = false;

            await expect(
                prisma.$transaction((tx) =>
                    withUserLock(tx, ORPHAN_USER_ID, async () => {
                        workRan = true;

                        return null;
                    }),
                ),
            ).rejects.toBeInstanceOf(UserNotProvisionedError);

            // The point of the guard's POSITION: the caller's first FK-bound
            // statement is never reached, so there is no vendor error to map and
            // no half-written transaction to roll back.
            expect(workRan).toBe(false);
            expect(await rowCounts(ORPHAN_USER_ID)).toStrictEqual(NOTHING_WRITTEN);
        });

        it('runs the work for an unprovisioned user when the caller declares it provisions one', async () => {
            const created = await prisma.$transaction((tx) =>
                withUserLock(
                    tx,
                    ORPHAN_USER_ID,
                    async (locked) => {
                        // What a provisioner sees, and why it needs the lock: the
                        // row is genuinely absent at this point, and the lock is
                        // what stops a concurrent request from deciding otherwise
                        // between this read and the write below.
                        expect(await locked.users.findUnique({ where: { id: ORPHAN_USER_ID } })).toBeNull();

                        return locked.users.create({
                            data: { id: ORPHAN_USER_ID, email: ORPHAN_EMAIL },
                        });
                    },
                    { requireProvisionedUser: false },
                ),
            );

            expect(created.id).toBe(ORPHAN_USER_ID);
            // Committed, not merely returned — the opt-out suppresses the guard
            // and nothing else about the transaction.
            expect(await prisma.users.count({ where: { id: ORPHAN_USER_ID } })).toBe(1);
        });
    });
});
