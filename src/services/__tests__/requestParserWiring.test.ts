// The enforcing proof that the meal-planning request parsers are WIRED, not
// merely written.
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
// Those four are the four findings this unit was assigned. Each is now
// impossible, and this file is the only place that is visible, because it is
// the only place that exercises the entry points rather than the parsers.
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
// ONE ENTRY POINT IS DELIBERATELY ABSENT. `mealPlan.service.ts::generatePlan`
// reads the preferences row BEFORE it parses, because its parse needs a
// `StartDateWindow` derived from today in the user's stored zone — §0.5.1
// ordering, stated in that function's own docblock. A "no database call"
// assertion there would assert a bug, so it is excluded and said so here.
// `regeneratePlan` needs no database state to parse and is included, as the
// anchor showing this arrangement predates this work.

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

import { getAffectedMeals, getMealPlanDay, regeneratePlan } from '../mealPlan.service';
import { logPlannedMeal } from '../plannedMealLog.service';
import { getRecipeVersionForUser } from '../recipe.service';
import { commitSwap, getSwapAlternatives, getSwapPreview } from '../swap.service';
import { saveTargets } from '../targets.service';

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

    it('lets a well-formed day read reach the database', async () => {
        expect(await expectReachesDatabase(() => getMealPlanDay(USER_ID, PLAN_ID, DAY_KEY))).toBe(
            'meal_plans.findFirst',
        );
    });

    it('lets a well-formed affected-meals read reach the database', async () => {
        expect(await expectReachesDatabase(() => getAffectedMeals(USER_ID, PLAN_ID))).toBe(
            'meal_plans.findFirst',
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

describe('recipe read entry point parses before any I/O (F22)', () => {
    it('refuses a malformed recipeVersionId', async () => {
        await expectRefusedBeforeIo(
            () => getRecipeVersionForUser(USER_ID, 'recipe-1'),
            'recipeVersionId',
            'invalid_id',
        );
    });

    it('lets a well-formed read reach the database', async () => {
        expect(
            await expectReachesDatabase(() => getRecipeVersionForUser(USER_ID, RECIPE_VERSION_ID)),
        ).toMatch(/^recipe_versions\./);
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
