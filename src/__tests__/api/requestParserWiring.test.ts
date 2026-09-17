// The request-parser wiring suite: every user-scoped meal-planning entry point
// answers a MALFORMED request before it reaches Prisma.
//
// WHY IT IS ITS OWN FILE, BESIDE `ownership.test.ts` RATHER THAN INSIDE IT.
// The malformed-id class of AAP §0.9.2's ownership matrix is proven here, while
// the foreign-id and nonexistent-id classes — which need real rows to
// distinguish — are proven against a real PostgreSQL in `ownership.test.ts` in
// this same directory. The two cannot share a module: this one replaces the
// Prisma singleton for the whole file with a recording stub (below), which is
// exactly what makes "no call was made" observable, and exactly what a
// row-backed case cannot work against.
//
// THIS FILE INSTALLS A MODULE-LEVEL PRISMA RECORDING STUB, WHICH CONSTRAINS
// WHAT MAY BE ADDED TO IT. The `jest.mock('../../prisma/client')` below replaces
// the singleton EVERY service imports, for the whole file, with a proxy that
// records each call and throws; there is no live database connection anywhere in
// this module. A case added here that needs real rows — a foreign-user `404`,
// say — therefore cannot use the stubbed singleton or the shared
// `../setup/factories` helpers that sit on it. It has to bring its own client:
// `new PrismaClient()` from `../../generated/prisma`, or the real module through
// `jest.requireActual('../../prisma/client')`, kept in its own `describe` with
// its own setup and teardown. Reaching for the stubbed singleton instead does
// not fail loudly; it records a call path and throws the sentinel, which reads
// like an unrelated assertion failure.
//
// WHAT IS BEING PROVEN. AAP §0.5.2 requires "server-side validation applied
// before any Prisma or planning work (`*.logic.ts` parsers, 400 with field
// codes)". Every parser in this feature is pure and separately unit-tested in
// its own `*.logic.test.ts`, so those suites establish that the RULES are
// right. They cannot establish that anything calls them, and a correct parser
// no entry point invokes leaves a malformed request travelling exactly as far
// as it did before it was written:
//
//   * a non-UUID `planId` reaches a `where: { id, user_id }` predicate, where
//     PostgreSQL rejects the uuid cast and the client is told `500`;
//   * `2026-02-30` reaches `new Date('2026-02-30T00:00:00.000Z')` and becomes
//     an Invalid Date that queries as `NULL`, so a real calendar error looks
//     like an empty day;
//   * `expectedPlanRevision: 1e30` passes `Number.isInteger` and reaches
//     `buildRequestFingerprint`'s canonicaliser or the `Int` column, again a
//     `500`;
//   * `portionMultiplier: 2.5` reaches `requireBoundPortion`, which answers
//     `409 preview_stale` — telling the user their preview went stale when the
//     request was never well formed in the first place.
//
// Each of those four failure modes is impossible while this suite is green, and
// this file is the only place that is visible, because it is the only place that
// exercises the entry points rather than the parsers.
//
// HOW IT PROVES IT. The Prisma singleton every service imports is replaced by a
// recording stub whose properties are all reachable and whose every CALL
// records its path and throws. Property access has to keep working — modules
// destructure and pass the client around — while a call is the thing that would
// talk to the database. So a refused request must RETURN a verdict carrying
// `code: 'invalid_request'` and record NO call, which is what "before any
// Prisma or planning work" means and what makes the POSITION of each parse
// (first statement, before any `await`) load-bearing rather than tidy.
//
// `loadSwapContext` (module-private to `swap.service.ts`) and `runKeyedAction`
// (reachable only inside `prisma.$transaction`) are both unreachable without a
// recorded call, so "no call" is the strongest available statement that neither
// was entered — asserted on the commit and log routes, where the idempotency
// ledger lives and where a premature reservation would burn the client's key.
//
// AND THE CONVERSE. Every route also has a well-formed case asserting the call
// IS recorded. Without it the whole suite would pass against an entry point
// that refused everything, which is the one way a validation gate can be wrong
// in the opposite direction.
//
// FOR THREE ROUTES THAT RECORDED CALL IS `$transaction`, AND THAT IS ITSELF THE
// CLAIM. The swap commit opens one because it reserves an idempotency key; the
// current-plan and day reads open one because each RESOLVES a plan's lifecycle
// and then describes it, and only a single `RepeatableRead` snapshot keeps the
// two halves of such an answer describing the same instant
// (`mealPlan.service.ts::readInPlanSnapshot`, `F01`/`F02`). Asserting the first
// recorded call is that transaction pins "one consistent snapshot" with no race
// to stage, and the refusal cases directly above prove the path parse still runs
// in front of it.
//
// TWO PROOFS ARE MADE AT THE CONTROLLER, NOT THE SERVICE, because that is
// where those two parses live. `GET /catalog/foods/suggestions` and
// `GET /recipes/:recipeVersionId` are parsed by
// `catalog.controller.ts::getCatalogSuggestionsController` and
// `::getRecipeVersionController` before either calls its service
// (§0.7.2: `getUserId` → parse → one service call), and the services behind
// them take already-validated values and answer with a DTO or `null` rather
// than a verdict — so a "the service returns the refusal" assertion would now
// assert an arrangement the Rule forbids. The claim is unchanged and so is the
// instrument: the handler is driven with a minimal request/response pair, and a
// refusal must be the 400 body naming the field with NO recorded database call.
//
// EVERY USER-SCOPED ENTRY POINT IS HERE, `generatePlan` INCLUDED. Its parse is
// in two halves, because the range of its start date is a property of the clock
// in the user's stored zone rather than of the request: `parseGeneratePlanSyntax`
// judges the request against itself with no I/O, and `checkStartDateWindow`
// judges it against the window afterwards. Only the SYNTAX half can be proven
// here, and it is the half that matters for this file's claim — a body with no
// idempotency key, a malformed key or an unusable revision is refused before
// Prisma is touched and before the idempotency ledger reserves anything. The
// window half deliberately runs LATER than the ledger's replay gate (§0.5.1, so
// that a same-key retry sent after the user's local midnight replays its stored
// `201` instead of being refused for a start date that has fallen behind
// `window.earliest`), which means a SYNTACTICALLY VALID generate request does
// reach the database by design; `api/concurrency.test.ts` owns that ordering,
// and the positive case below asserts only that such a request gets that far.
// `regeneratePlan` needs no database state to parse at all and remains the
// anchor case for the ordering the rest of the routes follow.

/**
 * The recording stub, built entirely inside the factory.
 *
 * Nothing here may reference a module-scope binding: `jest.mock` is hoisted
 * above the imports, so anything declared below would still be in its temporal
 * dead zone when a service first requires the client. The recorded calls and
 * the throw sentinel therefore leave through the mocked module itself, which
 * the test reads back with `jest.requireMock`.
 */
jest.mock('../../prisma/client', () => {
    const calls: string[] = [];
    const sentinel = 'PRISMA_CALL_RECORDED';

    const node = (path: string): unknown =>
        new Proxy(function stub() {} as unknown as object, {
            get: (_target, property) =>
                typeof property === 'string' ? node(path === '' ? property : `${path}.${property}`) : undefined,
            apply: () => {
                calls.push(path);
                throw new Error(`${sentinel}: ${path}`);
            },
        });

    return { prisma: node(''), __prismaCalls: calls, __sentinel: sentinel };
});

import type { Request, Response } from 'express';

import {
    getCatalogSuggestionsController,
    getRecipeVersionController,
} from '../../controllers/catalog.controller';
import {
    generatePlan,
    getAffectedMeals,
    getCurrentMealPlan,
    getMealPlanDay,
    regeneratePlan,
} from '../../services/mealPlan.service';
import { ReadOnlyFieldError } from '../../services/mealPlanning.errors';
import { logPlannedMeal } from '../../services/plannedMealLog.service';
import { savePreferences, saveSetupStep } from '../../services/preferences.service';
import { commitSwap, getSwapAlternatives, getSwapPreview } from '../../services/swap.service';
import { saveTargets } from '../../services/targets.service';

/** The live recorder and stub, read back from the module the services imported. */
const mockedClient = jest.requireMock('../../prisma/client') as {
    prisma: { meal_plans: { findFirst: (arg: unknown) => unknown } };
    __prismaCalls: string[];
    __sentinel: string;
};
const prismaCalls = mockedClient.__prismaCalls;

const USER_ID = 'test-user-wiring';
const PLAN_ID = 'b3c9f2e1-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const MEAL_ID = 'c4daf3e2-5e6b-4c7d-9e8f-0a1b2c3d4e5f';
const RECIPE_VERSION_ID = 'd5ebf4f3-6f7c-4d8e-8f9a-1b2c3d4e5f60';
const DIARY_MEAL_ID = 'e6fca504-7a8d-4e9f-9a0b-2c3d4e5f6071';
const IDEMPOTENCY_KEY = 'f70db615-8b9e-4fa0-ab1c-3d4e5f607182';
const DAY_KEY = '2026-07-05';
const TIME_ZONE = 'America/New_York';

/**
 * The clock the day read accepts, fixed. Its value is irrelevant to every
 * assertion below — what matters is that supplying one changes neither the
 * position of the parse nor the order of the reads.
 */
const INJECTED_NOW = new Date('2026-07-05T12:00:00.000Z');

/** A well-formed `goal` step body, with the one override each case needs. */
const stepBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    goal: 'lose',
    paceLbPerWeek: 1,
    timeZone: TIME_ZONE,
    expectedRevision: 1,
    ...overrides,
});

/** A well-formed full-save body, likewise. */
const updateBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    diet: 'vegan',
    timeZone: TIME_ZONE,
    expectedRevision: 1,
    ...overrides,
});

/** A well-formed swap commit body, with the one override each case needs. */
const commitBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    recipeVersionId: RECIPE_VERSION_ID,
    portionMultiplier: 1,
    expectedPlanRevision: 1,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
});

/** A well-formed planned-log body, likewise. */
const logBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    servings: 1,
    date: DAY_KEY,
    diaryMealId: DIARY_MEAL_ID,
    expectedPlanRevision: 1,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
});

/** The returned refusal shape these entry points share. */
interface Refusal {
    kind: string;
    code?: string;
    message?: string;
    details?: { field: string; code: string }[];
}

const fieldsOf = (verdict: Refusal): string[] => (verdict.details ?? []).map((detail) => detail.field);

/**
 * Asserts an entry point refused a request as a RETURNED `invalid_request`
 * verdict naming `field`, and that it did so without a single database call.
 *
 * The no-call assertion is the wiring proof. The field assertion is what makes
 * each case a proof about a SPECIFIC parser rather than about any refusal at
 * all, and the `expect(...).resolves` framing is itself load-bearing on the
 * swap cases: a returned verdict is not a thrown `PreviewStaleError`.
 */
const expectRefusedBeforeIo = async (
    call: () => Promise<unknown>,
    field: string,
    code?: string,
): Promise<Refusal> => {
    prismaCalls.length = 0;

    const verdict = (await call()) as Refusal;

    expect(verdict.kind).toBe('error');
    expect(verdict.code).toBe('invalid_request');
    expect(fieldsOf(verdict)).toContain(field);

    if (code !== undefined) {
        expect(verdict.details?.find((detail) => detail.field === field)?.code).toBe(code);
    }

    expect(prismaCalls).toEqual([]);

    return verdict;
};

/**
 * Asserts an entry point refused a request by THROWING `ReadOnlyFieldError`
 * naming `field`, and that it did so without a single database call.
 *
 * The sibling of `expectRefusedBeforeIo` for the one refusal this feature
 * raises rather than returns: a body whose only problem is server-owned keys is
 * a typed error the controller maps to the same `400 invalid_request` body,
 * carrying every offending key. The claim this file makes is unchanged — the
 * request is answered before any read — and only the shape of the answer
 * differs, so the no-call assertion is the same one.
 */
const expectReadOnlyThrowBeforeIo = async (
    call: () => Promise<unknown>,
    field: string,
): Promise<void> => {
    prismaCalls.length = 0;

    const outcome = await call().then(
        (value) => value,
        (thrown: unknown) => thrown,
    );

    expect(outcome).toBeInstanceOf(ReadOnlyFieldError);

    const { details } = outcome as ReadOnlyFieldError;

    expect(details.map((detail) => detail.field)).toContain(field);
    expect(details.every((detail) => detail.code === 'read_only_field')).toBe(true);
    expect(prismaCalls).toEqual([]);
};

/**
 * Asserts a WELL-FORMED request does reach the database, and returns the path
 * of the first call it made.
 *
 * Whatever error the stub's throw is ultimately surfaced as is irrelevant — the
 * claim is only that I/O was attempted, so the rejection is swallowed and the
 * recorder is the evidence.
 */
const expectReachesDatabase = async (call: () => Promise<unknown>): Promise<string> => {
    prismaCalls.length = 0;

    await call().then(
        () => undefined,
        () => undefined,
    );

    expect(prismaCalls.length).toBeGreaterThan(0);

    return prismaCalls[0];
};

/* ---------------------------------------------------------------------------
 * The two entry points whose parse lives in the controller
 * ------------------------------------------------------------------------- */

/** What a handler answered with, recorded off the response double. */
interface RecordedResponse {
    statusCode: number | null;
    body: unknown;
}

/** The chainable half of `Response` these handlers use: `status().json()`. */
interface ResponseDouble {
    status: (code: number) => ResponseDouble;
    json: (body: unknown) => ResponseDouble;
}

/**
 * The minimal Express pair the two catalog handlers actually touch: `req.user`
 * (all `getUserId` reads), the `params`/`query` the parser is handed, and a
 * `status().json()` recorder.
 *
 * Built and cast rather than constructed for real, because what is being proven
 * is the ORDER of a handler's first statements — resolve the caller, parse,
 * then call the service — and a real `Request` would add a socket and a router
 * without adding anything to that claim. `user` is set directly for the same
 * reason `jestSetup.ts` has the auth mock write it: the handler must learn the
 * caller only through `getUserId(req)`.
 */
const handlerDoubles = (
    request: { params?: Record<string, unknown>; query?: Record<string, unknown> } = {},
): { req: Request; res: Response; recorded: RecordedResponse } => {
    const recorded: RecordedResponse = { statusCode: null, body: null };
    const res: ResponseDouble = {
        status: (code: number) => {
            recorded.statusCode = code;

            return res;
        },
        json: (body: unknown) => {
            recorded.body = body;

            return res;
        },
    };

    return {
        req: {
            user: { uid: USER_ID },
            params: request.params ?? {},
            query: request.query ?? {},
        } as unknown as Request,
        res: res as unknown as Response,
        recorded,
    };
};

/**
 * Asserts a handler refused the request with `400 invalid_request` naming
 * `field`, and did so without a single database call.
 *
 * The service-level sibling of this helper reads a RETURNED verdict; here the
 * verdict has already been mapped, so the proof is the wire body itself — which
 * is the stronger statement for a route whose parse is the controller's job.
 */
const expectHandlerRefusedBeforeIo = async (
    handler: (req: Request, res: Response) => Promise<unknown>,
    request: { params?: Record<string, unknown>; query?: Record<string, unknown> },
    field: string,
    code: string,
): Promise<void> => {
    prismaCalls.length = 0;

    const { req, res, recorded } = handlerDoubles(request);

    await handler(req, res);

    expect(recorded.statusCode).toBe(400);
    expect(recorded.body).toEqual({ error: 'invalid_request', details: [{ field, code }] });
    expect(prismaCalls).toEqual([]);
};

/**
 * The converse for a handler: a WELL-FORMED request does reach the database.
 *
 * The stub's throw lands in the handler's own `catch`, which logs before
 * answering 500, so `console.error` is silenced for the duration — a passing
 * run stays readable and the recorder, not the log, is the evidence.
 */
const expectHandlerReachesDatabase = async (
    handler: (req: Request, res: Response) => Promise<unknown>,
    request: { params?: Record<string, unknown>; query?: Record<string, unknown> },
): Promise<string> => {
    prismaCalls.length = 0;

    const { req, res } = handlerDoubles(request);
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
        await handler(req, res);
    } finally {
        logged.mockRestore();
    }

    expect(prismaCalls.length).toBeGreaterThan(0);

    return prismaCalls[0];
};

beforeEach(() => {
    prismaCalls.length = 0;
});

describe('swap entry points parse before any I/O (F21)', () => {
    it('refuses a malformed planId on the alternatives read', async () => {
        await expectRefusedBeforeIo(
            () => getSwapAlternatives(USER_ID, 'plan-1', MEAL_ID),
            'planId',
            'invalid_id',
        );
    });

    it('refuses a malformed mealId on the alternatives read', async () => {
        await expectRefusedBeforeIo(
            () => getSwapAlternatives(USER_ID, PLAN_ID, 'meal-1'),
            'mealId',
            'invalid_id',
        );
    });

    it('refuses a malformed recipeVersionId on the preview read', async () => {
        // Unparsed, this value reached `selectSwapCandidate` and came back as
        // `422 recipe_ineligible` — "that meal no longer fits" — for a caller
        // who in fact requested `alternatives/undefined/preview`.
        await expectRefusedBeforeIo(
            () => getSwapPreview(USER_ID, PLAN_ID, MEAL_ID, 'recipe-1'),
            'recipeVersionId',
            'invalid_id',
        );
    });

    it('refuses a portion outside the offered set instead of calling it preview_stale', async () => {
        // 2.5 belongs to `EXTENDED_PORTION_POLICY`, the counterfactual set used
        // only to diagnose `portion_limits`, and NOT to the offered
        // `DEFAULT_PORTION_POLICY`. Before the wiring it reached
        // `requireBoundPortion` and was answered `409 preview_stale`. That it
        // now RESOLVES to a verdict rather than throwing is the disproof of the
        // mislabelling the finding named.
        await expectRefusedBeforeIo(
            () => commitSwap(USER_ID, PLAN_ID, MEAL_ID, commitBody({ portionMultiplier: 2.5 })),
            'portionMultiplier',
            'unknown_value',
        );
    });

    it('refuses a non-numeric portion, which requireBoundPortion would also have called stale', async () => {
        await expectRefusedBeforeIo(
            () => commitSwap(USER_ID, PLAN_ID, MEAL_ID, commitBody({ portionMultiplier: 'half' })),
            'portionMultiplier',
            'invalid_type',
        );
    });

    it('refuses a revision no Int column can hold before the ledger reserves the key', async () => {
        // `Number.isInteger(1e30)` is true, so without the bound this value
        // reached `buildRequestFingerprint` inside the transaction and threw a
        // TypeError the client saw as `500`. No recorded call means
        // `$transaction` never opened, so `runKeyedAction` never reserved the
        // idempotency key either — a reservation the client could not reuse.
        await expectRefusedBeforeIo(
            () => commitSwap(USER_ID, PLAN_ID, MEAL_ID, commitBody({ expectedPlanRevision: 1e30 })),
            'expectedPlanRevision',
            'above_maximum',
        );
    });

    it('refuses an unknown commit body key', async () => {
        await expectRefusedBeforeIo(
            () => commitSwap(USER_ID, PLAN_ID, MEAL_ID, commitBody({ portionMultipler: 1 })),
            'portionMultipler',
            'unknown_field',
        );
    });

    it('refuses an absent commit body, naming every field it should have carried', async () => {
        const verdict = await expectRefusedBeforeIo(
            () => commitSwap(USER_ID, PLAN_ID, MEAL_ID, undefined),
            'recipeVersionId',
            'required',
        );

        expect(fieldsOf(verdict)).toEqual([
            'recipeVersionId',
            'portionMultiplier',
            'expectedPlanRevision',
            'idempotencyKey',
        ]);
    });

    it('reports a malformed path id and a malformed body field in one verdict', async () => {
        const verdict = await expectRefusedBeforeIo(
            () => commitSwap(USER_ID, 'plan-1', MEAL_ID, commitBody({ portionMultiplier: 2.5 })),
            'planId',
            'invalid_id',
        );

        expect(fieldsOf(verdict)).toEqual(['planId', 'portionMultiplier']);
    });

    it('lets a well-formed alternatives read reach the database', async () => {
        expect(await expectReachesDatabase(() => getSwapAlternatives(USER_ID, PLAN_ID, MEAL_ID))).toBe(
            'meal_plans.findFirst',
        );
    });

    it('lets a well-formed preview read reach the database', async () => {
        expect(
            await expectReachesDatabase(() => getSwapPreview(USER_ID, PLAN_ID, MEAL_ID, RECIPE_VERSION_ID)),
        ).toBe('meal_plans.findFirst');
    });

    it('lets a well-formed commit open its transaction', async () => {
        expect(await expectReachesDatabase(() => commitSwap(USER_ID, PLAN_ID, MEAL_ID, commitBody()))).toBe(
            '$transaction',
        );
    });
});

describe('plan read entry points parse before any I/O (F22)', () => {
    it('refuses a malformed planId on the day read', async () => {
        await expectRefusedBeforeIo(() => getMealPlanDay(USER_ID, 'plan-1', DAY_KEY), 'planId', 'invalid_id');
    });

    it('refuses a day that is not a real calendar date before it can become an Invalid Date', async () => {
        await expectRefusedBeforeIo(
            () => getMealPlanDay(USER_ID, PLAN_ID, '2026-02-30'),
            'date',
            'invalid_date',
        );
    });

    it('refuses a free-text day key', async () => {
        await expectRefusedBeforeIo(
            () => getMealPlanDay(USER_ID, PLAN_ID, 'yesterday'),
            'date',
            'invalid_date',
        );
    });

    it('reports both malformed path segments in one verdict', async () => {
        const verdict = await expectRefusedBeforeIo(
            () => getMealPlanDay(USER_ID, 'plan-1', 'yesterday'),
            'planId',
            'invalid_id',
        );

        expect(fieldsOf(verdict)).toEqual(['planId', 'date']);
    });

    it('refuses a malformed planId on the affected-meals read', async () => {
        await expectRefusedBeforeIo(() => getAffectedMeals(USER_ID, 'plan-1'), 'planId', 'invalid_id');
    });

    it('lets a well-formed day read open its transaction', async () => {
        expect(await expectReachesDatabase(() => getMealPlanDay(USER_ID, PLAN_ID, DAY_KEY))).toBe('$transaction');
    });

    it('lets a well-formed current-plan read open its transaction', async () => {
        expect(await expectReachesDatabase(() => getCurrentMealPlan(USER_ID))).toBe('$transaction');
    });

    it('lets a well-formed affected-meals read reach the database', async () => {
        expect(await expectReachesDatabase(() => getAffectedMeals(USER_ID, PLAN_ID))).toBe(
            'meal_plans.findFirst',
        );
    });

    /**
     * The day read reports whether the plan may still be written to, which is a
     * comparison against the caller's calendar day, so it takes a clock
     * (`F14`). These two cases hold that clock to the same ordering the rest of
     * this suite proves of the path parse.
     *
     * An injected date must not pull any read forward: the parse still comes
     * first, so a malformed path is refused with no database call even though
     * "today" was supplied. And on the well-formed side the first recorded call
     * must be `$transaction` — the read's own snapshot (`F01`/`F02`), which the
     * parse still precedes. The ordering INSIDE that transaction (the
     * owner-scoped plan row, then the day, then the zone `resolveUserToday`
     * reads) is stated and reasoned in `mealPlan.service.ts` and is no longer
     * observable through this stub, because opening the transaction is the only
     * call it records; what `api/ownership.test.ts` proves against real rows is
     * the REFUSAL that ordering exists for — a foreign plan answers exactly as
     * an absent one does.
     */
    it('refuses a malformed day read before any I/O even with a clock supplied', async () => {
        await expectRefusedBeforeIo(
            () => getMealPlanDay(USER_ID, 'plan-1', 'yesterday', INJECTED_NOW),
            'planId',
            'invalid_id',
        );
    });

    it('opens the day read’s snapshot only after the path has been judged, clock or no clock', async () => {
        expect(await expectReachesDatabase(() => getMealPlanDay(USER_ID, PLAN_ID, DAY_KEY, INJECTED_NOW))).toBe(
            '$transaction',
        );
    });
});

describe('planned-meal logging parses path and body before the ledger (F22, F09)', () => {
    it('refuses a malformed mealId', async () => {
        await expectRefusedBeforeIo(
            () => logPlannedMeal(USER_ID, PLAN_ID, 'meal-1', logBody()),
            'mealId',
            'invalid_id',
        );
    });

    it('refuses servings outside the contract', async () => {
        await expectRefusedBeforeIo(
            () => logPlannedMeal(USER_ID, PLAN_ID, MEAL_ID, logBody({ servings: 99 })),
            'servings',
            'invalid_servings',
        );
    });

    it('refuses a revision no Int column can hold before the reservation', async () => {
        await expectRefusedBeforeIo(
            () => logPlannedMeal(USER_ID, PLAN_ID, MEAL_ID, logBody({ expectedPlanRevision: 1e30 })),
            'expectedPlanRevision',
            'above_maximum',
        );
    });

    it('refuses an absent body', async () => {
        await expectRefusedBeforeIo(() => logPlannedMeal(USER_ID, PLAN_ID, MEAL_ID, undefined), 'body');
    });

    it('reports a malformed path id and a malformed body date in one verdict, path first', async () => {
        const verdict = await expectRefusedBeforeIo(
            () => logPlannedMeal(USER_ID, 'plan-1', MEAL_ID, logBody({ date: '2026-02-30' })),
            'planId',
            'invalid_id',
        );

        expect(fieldsOf(verdict)).toEqual(['planId', 'date']);
    });

    it('lets a well-formed log open its transaction', async () => {
        expect(await expectReachesDatabase(() => logPlannedMeal(USER_ID, PLAN_ID, MEAL_ID, logBody()))).toBe(
            '$transaction',
        );
    });
});

describe('the recipe read parses in its controller, before any I/O (F22)', () => {
    // `jestSetup.ts` sets MEAL_PLANNING_ENABLED=true, so the handler's feature
    // gate passes and the parse is what these two cases are about.
    it('refuses a malformed recipeVersionId with no database call', async () => {
        await expectHandlerRefusedBeforeIo(
            getRecipeVersionController,
            { params: { recipeVersionId: 'recipe-1' } },
            'recipeVersionId',
            'invalid_id',
        );
    });

    it('lets a well-formed read reach the database', async () => {
        expect(
            await expectHandlerReachesDatabase(getRecipeVersionController, {
                params: { recipeVersionId: RECIPE_VERSION_ID },
            }),
        ).toMatch(/^recipe_versions\./);
    });
});

describe('the suggestions read parses in its controller, before any I/O (F22)', () => {
    // The kind used to be coerced and checked inline in the handler, which left
    // the allowed-value rule untestable without HTTP. Both cases below are
    // refused by the same `unsupported` detail, because the contract defines
    // one kind and sending none is sending the wrong one.
    it('refuses an absent kind with no database call', async () => {
        await expectHandlerRefusedBeforeIo(
            getCatalogSuggestionsController,
            { query: {} },
            'kind',
            'unsupported',
        );
    });

    it('refuses a kind this endpoint does not answer with no database call', async () => {
        await expectHandlerRefusedBeforeIo(
            getCatalogSuggestionsController,
            { query: { kind: 'favourite' } },
            'kind',
            'unsupported',
        );
    });

    // The converse. `getSuggestions` reads through `prisma.$queryRaw`, which the
    // stub records like any other call.
    it('lets kind=dislike reach the database', async () => {
        expect(
            await expectHandlerReachesDatabase(getCatalogSuggestionsController, {
                query: { kind: 'dislike' },
            }),
        ).toBe('$queryRaw');
    });
});

describe('preference saves parse their envelope before any I/O (SVC-09)', () => {
    // Both saves used to read the preferences row INSIDE the argument list of
    // their own parser — `parseSetupStep(step, body, stepContext(await
    // loadPreferencesRow(userId)))` — so the read was awaited first and an
    // unknown step, a non-object body, an unknown zone or a server-owned key
    // reached Prisma before its deterministic 400. The context-free envelope
    // parse is now the first statement of each, and "no recorded call" is the
    // only way to see the difference.
    //
    // The well-formed cases below record `meal_plan_preferences.findUnique`
    // rather than `$transaction`: the unlocked preflight parse against the
    // stored row is retained deliberately, so a body whose FIELDS are wrong
    // still never takes the user's advisory lock.

    it('refuses a step segment that names no payload-bearing step', async () => {
        await expectRefusedBeforeIo(
            () => saveSetupStep(USER_ID, 'goals', stepBody()),
            'step',
            'unknown_step',
        );
    });

    it('refuses a step body that is not an object', async () => {
        await expectRefusedBeforeIo(() => saveSetupStep(USER_ID, 'goal', undefined), 'body', 'invalid_type');
    });

    it('refuses a step save with no time zone', async () => {
        await expectRefusedBeforeIo(
            () => saveSetupStep(USER_ID, 'goal', stepBody({ timeZone: undefined })),
            'timeZone',
            'required',
        );
    });

    it('refuses a step save whose zone this runtime does not know', async () => {
        await expectRefusedBeforeIo(
            () => saveSetupStep(USER_ID, 'goal', stepBody({ timeZone: 'Mars/Phobos' })),
            'timeZone',
            'invalid_time_zone',
        );
    });

    it('refuses a server-owned key in a step body', async () => {
        await expectReadOnlyThrowBeforeIo(
            () => saveSetupStep(USER_ID, 'goal', stepBody({ setupStatus: 'completed' })),
            'setupStatus',
        );
    });

    it('refuses a step revision no Int column can hold', async () => {
        await expectRefusedBeforeIo(
            () => saveSetupStep(USER_ID, 'goal', stepBody({ expectedRevision: 1e30 })),
            'expectedRevision',
            'above_maximum',
        );
    });

    it('refuses a full save body that is not an object', async () => {
        await expectRefusedBeforeIo(() => savePreferences(USER_ID, undefined), 'body', 'invalid_type');
    });

    it('refuses a full save with no time zone (SVC-05)', async () => {
        // The zone is a required envelope field on this endpoint, so its absence
        // is settled here rather than silently resolved to the stored zone.
        await expectRefusedBeforeIo(
            () => savePreferences(USER_ID, updateBody({ timeZone: undefined })),
            'timeZone',
            'required',
        );
    });

    it('refuses a server-owned key in a full save body', async () => {
        await expectReadOnlyThrowBeforeIo(
            () => savePreferences(USER_ID, updateBody({ targetRoute: 'manual' })),
            'targetRoute',
        );
    });

    it('refuses a full save that edits nothing but its envelope', async () => {
        await expectRefusedBeforeIo(
            () => savePreferences(USER_ID, { timeZone: TIME_ZONE, expectedRevision: 1 }),
            'body',
            'required',
        );
    });

    it('reports every envelope problem of one request in a single verdict', async () => {
        const verdict = await expectRefusedBeforeIo(
            () => savePreferences(USER_ID, { nickname: 'x', expectedRevision: 4.5 }),
            'nickname',
            'read_only_field',
        );

        expect(fieldsOf(verdict).sort()).toEqual(['expectedRevision', 'nickname', 'timeZone']);
    });

    // AAP 0.5.2 puts FIELD validation before any Prisma work too, not only the
    // envelope's. These are the cases that distinguish a preflight that checks
    // the wrapper from one that checks the request: every value below is
    // refusable from the request alone, so none of them may reach the database.

    it('refuses an unknown goal and an out-of-range pace with no database call', async () => {
        const verdict = await expectRefusedBeforeIo(
            () => saveSetupStep(USER_ID, 'goal', stepBody({ goal: 'shrink', paceLbPerWeek: 9 })),
            'goal',
            'unknown_value',
        );

        // Both controls in one answer, which is what the screen shows at once.
        expect(fieldsOf(verdict)).toEqual(['goal', 'paceLbPerWeek']);
    });

    it.each([
        ['activity', { activityLevel: 'sprinting' }, 'activityLevel', 'unknown_value'],
        ['diet', { diet: 'carnivore', allergens: [] }, 'diet', 'unknown_value'],
        ['diet', { diet: 'none', allergens: ['none', 'milk'] }, 'allergens', 'mutually_exclusive'],
        ['cooking', { cookingTimeLimitMin: 37, noBudgetPreference: true }, 'cookingTimeLimitMin', 'unknown_value'],
    ])('refuses the %s step field %s before any I/O', async (step, body, field, code) => {
        await expectRefusedBeforeIo(
            () => saveSetupStep(USER_ID, step, { ...body, timeZone: TIME_ZONE, expectedRevision: 1 }),
            field,
            code,
        );
    });

    it.each([
        [{ diet: 'carnivore' }, 'diet', 'unknown_value'],
        [{ age: 7 }, 'age', 'below_minimum'],
        [{ activityLevel: 'sprinting' }, 'activityLevel', 'unknown_value'],
        [{ cookingTimeLimitMin: 37 }, 'cookingTimeLimitMin', 'unknown_value'],
    ])('refuses the full-save value %p before any I/O', async (edit, field, code) => {
        await expectRefusedBeforeIo(() => savePreferences(USER_ID, updateBody(edit)), field, code);
    });

    it('answers an envelope problem and a field problem together, before any I/O', async () => {
        // The mixed case. A verdict naming only the zone here would send the
        // screen back for the diet on a second round trip.
        const verdict = await expectRefusedBeforeIo(
            () => savePreferences(USER_ID, { diet: 'carnivore', expectedRevision: 1 }),
            'diet',
            'unknown_value',
        );

        expect(fieldsOf(verdict)).toEqual(['diet', 'timeZone']);
    });

    it('reads the row for a body whose other half is stored, rather than answer short', async () => {
        // `goal: 'lose'` with no pace is judged against the STORED pace, so the
        // request stage cannot settle it and yields `needs_context`; the
        // row-backed parse answers. The body carries no request-only error of
        // its own, which is what makes the read here the deferral rather than an
        // amplified refusal: a body that IS malformed is now answered before any
        // read, whichever coherence rule was also applicable.
        expect(
            await expectReachesDatabase(() => savePreferences(USER_ID, updateBody({ goal: 'lose' }))),
        ).toBe('meal_plan_preferences.findUnique');
    });

    it('lets a well-formed step save reach the database', async () => {
        expect(await expectReachesDatabase(() => saveSetupStep(USER_ID, 'goal', stepBody()))).toBe(
            'meal_plan_preferences.findUnique',
        );
    });

    it('lets a well-formed full save reach the database', async () => {
        expect(await expectReachesDatabase(() => savePreferences(USER_ID, updateBody()))).toBe(
            'meal_plan_preferences.findUnique',
        );
    });
});

describe('generatePlan parses its request’s own syntax before any I/O (DB-F03)', () => {
    /** A well-formed generate body, with the one override each case needs. */
    const generateBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        startDate: DAY_KEY,
        idempotencyKey: IDEMPOTENCY_KEY,
        expectedPreferencesRevision: 1,
        expectedTargetsRevision: 1,
        ...overrides,
    });

    it('refuses a body with no idempotency key, so the ledger is never asked about a key it has not got', async () => {
        // The order this pins: syntax parse, then the replay preflight, then
        // every stateful check. A body with nothing to fingerprint must not
        // reach the preflight's transaction at all.
        await expectRefusedBeforeIo(
            () => generatePlan(USER_ID, generateBody({ idempotencyKey: undefined })),
            'idempotencyKey',
            'required',
        );
    });

    it('refuses a malformed idempotency key with no database call', async () => {
        await expectRefusedBeforeIo(
            () => generatePlan(USER_ID, generateBody({ idempotencyKey: 'plan-please' })),
            'idempotencyKey',
            'invalid_id',
        );
    });

    it('refuses a start date that is not a real calendar day with no database call', async () => {
        // `2026-02-30` would otherwise become an Invalid Date that queries as
        // NULL. This is the SHAPE half of the start-date rule, which is exactly
        // the half that belongs before any I/O.
        await expectRefusedBeforeIo(
            () => generatePlan(USER_ID, generateBody({ startDate: '2026-02-30' })),
            'startDate',
            'invalid_date',
        );
    });

    it('refuses a revision no Int column can hold before the reservation', async () => {
        await expectRefusedBeforeIo(
            () => generatePlan(USER_ID, generateBody({ expectedPreferencesRevision: 1e30 })),
            'expectedPreferencesRevision',
        );
    });

    it('refuses an absent body, naming both fields it should have carried', async () => {
        const verdict = await expectRefusedBeforeIo(
            () => generatePlan(USER_ID, undefined),
            'idempotencyKey',
            'required',
        );

        expect(fieldsOf(verdict)).toEqual(['startDate', 'idempotencyKey']);
    });

    it('lets a well-formed request reach the ledger preflight, which is where its I/O starts', async () => {
        // The converse, and the reason the window is NOT asserted here: a
        // syntactically valid generate request is supposed to reach the
        // database, and the FIRST thing it reaches is the idempotency ledger's
        // preflight transaction — not the preferences row the stateful half
        // needs. That ordering is §0.5.1's and is what DB-F03 changed.
        expect(await expectReachesDatabase(() => generatePlan(USER_ID, generateBody()))).toBe(
            '$transaction',
        );
    });
});

describe('the entry points that already parsed first still do', () => {
    // The anchors: these establish that "parse, then I/O" is this tree's
    // existing arrangement rather than something this work invented, so a
    // future change that moves a parse after a read is visibly inconsistent
    // with them instead of merely different.
    it('regeneratePlan refuses a malformed planId with no database call', async () => {
        await expectRefusedBeforeIo(
            () =>
                regeneratePlan(USER_ID, 'plan-1', {
                    idempotencyKey: IDEMPOTENCY_KEY,
                    expectedPlanRevision: 1,
                    expectedPreferencesRevision: 1,
                    expectedTargetsRevision: 1,
                }),
            'planId',
            'invalid_id',
        );
    });

    it('regeneratePlan refuses a revision no Int column can hold (F09)', async () => {
        await expectRefusedBeforeIo(
            () =>
                regeneratePlan(USER_ID, PLAN_ID, {
                    idempotencyKey: IDEMPOTENCY_KEY,
                    expectedPlanRevision: 1e30,
                    expectedPreferencesRevision: 1,
                    expectedTargetsRevision: 1,
                }),
            'expectedPlanRevision',
        );
    });

    it('saveTargets refuses an unusable source with no database call (F11)', async () => {
        await expectRefusedBeforeIo(() => saveTargets(USER_ID, { source: 'guess' }), 'source');
    });

    it('saveTargets refuses a key outside the declared arm with no database call (F11)', async () => {
        // The estimated arm carries no numbers by contract: a client sending
        // `calories` believes it is confirming values the server never reads,
        // and silence there is the server agreeing to a request it did not
        // honour.
        await expectRefusedBeforeIo(
            () => saveTargets(USER_ID, { source: 'estimated', estimateRevision: 1, calories: 1940 }),
            'calories',
            'unknown_field',
        );
    });

    it('saveTargets refuses a revision no Int column can hold (F09)', async () => {
        await expectRefusedBeforeIo(
            () => saveTargets(USER_ID, { source: 'estimated', estimateRevision: 1e30 }),
            'estimateRevision',
        );
    });
});

describe('the recording stub itself', () => {
    // Guards the instrument. If the mock stopped recording, or stopped being
    // the module the services import, every "no database call" assertion above
    // would pass unconditionally and this file would prove nothing.
    it('records the call path and throws its sentinel', () => {
        prismaCalls.length = 0;

        expect(() => mockedClient.prisma.meal_plans.findFirst({})).toThrow(
            new RegExp(mockedClient.__sentinel),
        );
        expect(prismaCalls).toEqual(['meal_plans.findFirst']);
    });

    it('tolerates property access without recording anything', () => {
        prismaCalls.length = 0;

        expect(mockedClient.prisma.meal_plans.findFirst).toBeDefined();
        expect(prismaCalls).toEqual([]);
    });
});
