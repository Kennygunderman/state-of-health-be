// The meal-planning controller's own boundary: what it parses, what it calls,
// and what it records.
//
// WHY IT IS NOT `requestParserWiring.test.ts`. That suite proves the SERVICES
// refuse a malformed request before touching Prisma, by replacing the Prisma
// singleton and asserting no call was recorded. It cannot prove where the parse
// happened, because a refusal returned by a service and a refusal returned by a
// controller look identical from outside. This suite proves the position: the
// SERVICE ITSELF is replaced by a mock, so "the service was never called" is
// the statement, and a handler that forwarded a raw request would fail every
// case below (Rule backend-architecture §§4-5, AAP §0.7.2 —
// `getUserId` → `parse*` → one service call → error mapping).
//
// It also pins the four server events the edge emits, because an event is only
// evidence if its name and its fields are stable: an operator's query is a
// literal. And it pins the two guarantees a log line must keep — no stack, no
// credential — on the path where the temptation is greatest, the unmapped 500.
//
// NO DATABASE. Every service module the controller imports is mocked, the
// request and response are doubles, and the parsers, the typed errors, the
// feature flags and the logger are the real ones. Nothing here reads, writes or
// truncates a table, which is also what makes the suite immune to whatever else
// is running against the test database.

jest.mock('../../services/preferences.service', () => ({
    getPreferences: jest.fn(),
    savePreferences: jest.fn(),
    saveSetupStep: jest.fn(),
}));

jest.mock('../../services/targets.service', () => ({
    getTargetEstimate: jest.fn(),
    getTargets: jest.fn(),
    saveTargets: jest.fn(),
}));

jest.mock('../../services/mealPlan.service', () => ({
    generatePlan: jest.fn(),
    getAffectedMeals: jest.fn(),
    getCurrentMealPlan: jest.fn(),
    getMealPlanDay: jest.fn(),
    regeneratePlan: jest.fn(),
}));

jest.mock('../../services/swap.service', () => ({
    commitSwap: jest.fn(),
    getSwapAlternatives: jest.fn(),
    getSwapPreview: jest.fn(),
}));

jest.mock('../../services/plannedMealLog.service', () => ({
    logPlannedMeal: jest.fn(),
}));

jest.mock('../../services/grocery.service', () => ({
    getGroceryList: jest.fn(),
    toggleGroceryItem: jest.fn(),
    uncheckAllGroceries: jest.fn(),
}));

import type { Request, Response } from 'express';

import {
    generatePlanController,
    getAffectedMealsController,
    getCurrentPlansController,
    getPlanDayController,
    getSwapAlternativesController,
    getSwapPreviewController,
    logPlannedMealController,
    regeneratePlanController,
    saveNutritionTargetsController,
    savePreferencesController,
    saveSetupStepController,
    swapMealController,
} from '../../controllers/mealPlanning.controller';
import {
    parseAffectedMealsPath,
    parseGeneratePlanSyntax,
    parseMealPlanDayPath,
    parseRegeneratePlanRequest,
} from '../../services/mealPlan.logic';
import { StaleRevisionError } from '../../services/mealPlanning.errors';
import { generatePlan, getAffectedMeals, getCurrentMealPlan, getMealPlanDay, regeneratePlan } from '../../services/mealPlan.service';
import { parseLogPlannedMealCall } from '../../services/plannedMealLog.logic';
import { logPlannedMeal } from '../../services/plannedMealLog.service';
import { parsePreferencesUpdateRequest, parseSetupStepRequest } from '../../services/preferences.logic';
import { savePreferences, saveSetupStep } from '../../services/preferences.service';
import { parseSwapAlternativesPath, parseSwapCommitRequest, parseSwapPreviewPath } from '../../services/swap.logic';
import { commitSwap, getSwapAlternatives, getSwapPreview } from '../../services/swap.service';
import { parseSaveTargetsRequest } from '../../services/targets.logic';
import { saveTargets } from '../../services/targets.service';
import * as featureFlags from '../../utils/featureFlags';
import { POST_COMMIT_ABORT_HEADER } from '../../utils/featureFlags';

const USER_ID = 'boundary-suite-user';
const PLAN_ID = 'b3c9f2e1-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const MEAL_ID = 'c4daf3e2-5e6b-4c7d-9e8f-0a1b2c3d4e5f';
const RECIPE_VERSION_ID = 'd5ebf4f3-6f7c-4d8e-8f9a-1b2c3d4e5f60';
const DIARY_MEAL_ID = 'e6fca504-7a8d-4e9f-9a0b-2c3d4e5f6071';
const IDEMPOTENCY_KEY = 'f70db615-8b9e-4fa0-ab1c-3d4e5f607182';
const DAY_KEY = '2026-07-05';
const TIME_ZONE = 'America/New_York';

/** The 400 envelope every parser refusal serializes into. */
interface Verdict {
    kind: string;
    code?: string;
    details?: { field: string; code: string }[];
}

/** What the response double recorded. */
interface RecordedResponse {
    statusCode: number | null;
    body: unknown;
    socketDestroyed: boolean;
}

/** One emitted server event, read back off the console spy that captured it. */
interface CapturedEvent {
    level: 'info' | 'warn' | 'error';
    line: string;
    event: string;
    fields: Record<string, unknown>;
}

const EVENT_LINE = /^\[meal-planning] (\S+) (\{.*\})$/;

let consoleSpies: jest.SpyInstance[] = [];
let captured: CapturedEvent[] = [];

beforeEach(() => {
    captured = [];
    consoleSpies = (['info', 'warn', 'error'] as const).map((level) =>
        jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
            const line = String(args[0]);
            const match = EVENT_LINE.exec(line);

            if (match !== null) {
                captured.push({
                    level,
                    line,
                    event: match[1],
                    fields: JSON.parse(match[2]) as Record<string, unknown>,
                });
            }
        }),
    );
});

afterEach(() => {
    for (const spy of consoleSpies) {
        spy.mockRestore();
    }
});

/**
 * The minimal Express pair these handlers touch.
 *
 * `user` is set directly, the way the auth middleware sets it, so the handler
 * can only learn the caller through `getUserId(req)`. `socket` is a stub whose
 * `destroy` is recorded rather than performed — the post-commit abort branch is
 * the one place a handler answers by destroying the connection, and recording
 * it is how a test observes a response that was never sent.
 */
const doubles = (
    request: { params?: Record<string, unknown>; body?: unknown; headers?: Record<string, string> } = {},
): { req: Request; res: Response; recorded: RecordedResponse } => {
    const recorded: RecordedResponse = { statusCode: null, body: null, socketDestroyed: false };
    const res = {
        status: (code: number) => {
            recorded.statusCode = code;

            return res;
        },
        json: (body: unknown) => {
            recorded.body = body;

            return res;
        },
        socket: {
            destroy: () => {
                recorded.socketDestroyed = true;
            },
        },
    };
    const headers = request.headers ?? {};

    return {
        req: {
            user: { uid: USER_ID },
            params: request.params ?? {},
            body: request.body,
            header: (name: string) => headers[name.toLowerCase()],
        } as unknown as Request,
        res: res as unknown as Response,
        recorded,
    };
};

/** The events of one name, so "exactly one" is assertable rather than implied. */
const eventsNamed = (name: string): CapturedEvent[] => captured.filter((event) => event.event === name);

/**
 * Asserts a handler answered a malformed request with the PARSER'S OWN verdict
 * and never reached its service.
 *
 * The expected body is derived by calling the same pure parser in the test, not
 * transcribed: that is what makes each case a statement about which parser the
 * handler invokes, and it is why the refusal is byte-identical to the one the
 * service used to return.
 */
const expectRefusedAtBoundary = async (
    handler: (req: Request, res: Response) => Promise<unknown>,
    request: { params?: Record<string, unknown>; body?: unknown },
    verdict: Verdict,
    services: jest.Mock[],
): Promise<RecordedResponse> => {
    expect(verdict.kind).toBe('error');

    const { req, res, recorded } = doubles(request);

    await handler(req, res);

    expect(recorded.statusCode).toBe(400);
    expect(recorded.body).toEqual({ error: verdict.code, details: verdict.details });

    for (const service of services) {
        expect(service).not.toHaveBeenCalled();
    }

    const refusals = eventsNamed('request_refused');

    expect(refusals).toHaveLength(1);
    expect(refusals[0].level).toBe('warn');
    expect(refusals[0].fields.status).toBe(400);
    expect(refusals[0].fields.code).toBe(verdict.code);
    expect(refusals[0].fields.detailCount).toBe(verdict.details?.length);
    expect(refusals[0].fields.userId).toBe(USER_ID);

    return recorded;
};

/** A well-formed `goal` step body. */
const stepBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    goal: 'lose',
    paceLbPerWeek: 1,
    timeZone: TIME_ZONE,
    expectedRevision: 1,
    ...overrides,
});

/** A well-formed full-save body. */
const updateBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    diet: 'vegan',
    timeZone: TIME_ZONE,
    expectedRevision: 1,
    ...overrides,
});

/** A well-formed manual targets body. */
const targetsBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    source: 'manual',
    calories: 2100,
    protein: 160,
    carbs: 210,
    fat: 70,
    expectedTargetsRevision: 1,
    ...overrides,
});

/** A well-formed generate body. */
const generateBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    startDate: DAY_KEY,
    idempotencyKey: IDEMPOTENCY_KEY,
    expectedPreferencesRevision: 1,
    expectedTargetsRevision: 1,
    ...overrides,
});

/** A well-formed regenerate body. */
const regenerateBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    idempotencyKey: IDEMPOTENCY_KEY,
    expectedPlanRevision: 1,
    expectedPreferencesRevision: 1,
    expectedTargetsRevision: 1,
    ...overrides,
});

/** A well-formed swap commit body. */
const commitBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    recipeVersionId: RECIPE_VERSION_ID,
    portionMultiplier: 1,
    expectedPlanRevision: 1,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
});

/** A well-formed planned-log body. */
const logBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    servings: 1,
    date: DAY_KEY,
    diaryMealId: DIARY_MEAL_ID,
    expectedPlanRevision: 1,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
});

/**
 * A recognisable stand-in for the stored response snapshot, so "the body is not
 * in the log line" is assertable by its absence rather than by inspection.
 */
const STORED_SNAPSHOT = 'stored-plan-snapshot';

/** What a keyed write's mocked service answers with. */
/**
 * A keyed write's service answer.
 *
 * `replayed` defaults to a FRESH commit because that is the ordinary case, and
 * every assertion that cares states it: the whole point of the field is that
 * `status` and `planRevisionAfter` are identical on both routes, so a test that
 * left it implicit would be asserting nothing about it.
 */
const keyedResult = (status: number, planRevisionAfter: number, replayed = false) => ({
    kind: 'ok' as const,
    result: {
        status,
        body: { snapshot: STORED_SNAPSHOT, planRevision: planRevisionAfter },
        planRevisionAfter,
        replayed,
    },
});

const asMock = (fn: unknown): jest.Mock => fn as unknown as jest.Mock;

/* ---------------------------------------------------------------------------
 * (i) A malformed request is refused by the controller, and the service is
 *     never entered
 * ------------------------------------------------------------------------- */

describe('the parse happens at the boundary, before the service is called', () => {
    it('refuses a step body the step parser rejects', async () => {
        const body = stepBody({ goal: 'sideways' });

        await expectRefusedAtBoundary(
            saveSetupStepController,
            { params: { step: 'goal' }, body },
            parseSetupStepRequest('goal', body) as Verdict,
            [asMock(saveSetupStep)],
        );
    });

    it('refuses a full-save body the update parser rejects', async () => {
        const body = updateBody({ diet: 'carnivore' });

        await expectRefusedAtBoundary(
            savePreferencesController,
            { body },
            parsePreferencesUpdateRequest(body) as Verdict,
            [asMock(savePreferences)],
        );
    });

    it('refuses a targets body the save parser rejects', async () => {
        const body = targetsBody({ calories: 'plenty' });

        await expectRefusedAtBoundary(
            saveNutritionTargetsController,
            { body },
            parseSaveTargetsRequest(body) as Verdict,
            [asMock(saveTargets)],
        );
    });

    it('refuses a generate body on syntax alone, before the key can be reserved', async () => {
        // `2026-02-30` is not a calendar date, and an unparsed one becomes an
        // Invalid Date inside the transaction that reserves the idempotency key.
        const body = generateBody({ startDate: '2026-02-30', idempotencyKey: 'not-a-uuid' });

        await expectRefusedAtBoundary(
            generatePlanController,
            { body },
            parseGeneratePlanSyntax(body) as Verdict,
            [asMock(generatePlan)],
        );
    });

    it('refuses a day read whose path ids are malformed, naming both segments', async () => {
        const params = { planId: 'plan-1', date: '2026-02-30' };
        const verdict = parseMealPlanDayPath(params) as Verdict;

        await expectRefusedAtBoundary(getPlanDayController, { params }, verdict, [asMock(getMealPlanDay)]);

        expect(verdict.details?.map((detail) => detail.field)).toEqual(['planId', 'date']);
    });

    it('refuses a regenerate request on the path id and the body together', async () => {
        const params = { planId: 'plan-1' };
        const body = regenerateBody({ expectedPlanRevision: 0 });

        await expectRefusedAtBoundary(
            regeneratePlanController,
            { params, body },
            parseRegeneratePlanRequest(params, body) as Verdict,
            [asMock(regeneratePlan)],
        );
    });

    it('refuses an affected-meals read whose planId is not a UUID', async () => {
        const params = { planId: 'plan-1' };

        await expectRefusedAtBoundary(
            getAffectedMealsController,
            { params },
            parseAffectedMealsPath(params) as Verdict,
            [asMock(getAffectedMeals)],
        );
    });

    it('refuses an alternatives read whose mealId is not a UUID', async () => {
        const params = { planId: PLAN_ID, mealId: 'meal-1' };

        await expectRefusedAtBoundary(
            getSwapAlternativesController,
            { params },
            parseSwapAlternativesPath(params) as Verdict,
            [asMock(getSwapAlternatives)],
        );
    });

    it('refuses a preview read whose recipeVersionId is not a UUID', async () => {
        const params = { planId: PLAN_ID, mealId: MEAL_ID, recipeVersionId: 'recipe-1' };

        await expectRefusedAtBoundary(
            getSwapPreviewController,
            { params },
            parseSwapPreviewPath(params) as Verdict,
            [asMock(getSwapPreview)],
        );
    });

    it('refuses a swap commit whose portion is outside the offered set', async () => {
        const params = { planId: PLAN_ID, mealId: MEAL_ID };
        const body = commitBody({ portionMultiplier: 2.5 });

        await expectRefusedAtBoundary(
            swapMealController,
            { params, body },
            parseSwapCommitRequest(params, body) as Verdict,
            [asMock(commitSwap)],
        );
    });

    it('refuses a planned-meal log whose servings are outside the permitted range', async () => {
        const params = { planId: PLAN_ID, mealId: MEAL_ID };
        const body = logBody({ servings: 99 });

        await expectRefusedAtBoundary(
            logPlannedMealController,
            { params, body },
            parseLogPlannedMealCall(params, body) as Verdict,
            [asMock(logPlannedMeal)],
        );
    });

    it('bounds the offending field names it records, however many the client sent', async () => {
        // A `read_only_field`/`unknown_field` detail's name is client-supplied,
        // so the list in the event is capped and the count is what stays
        // truthful. Twelve unknown keys plus one bad value: ten names, a count
        // of thirteen. The extra fault keeps this on the VERDICT path — a body
        // whose ONLY fault is unknown keys is answered as `ReadOnlyFieldError`,
        // and the same bound is asserted for that path below.
        const unknown: Record<string, unknown> = {};

        for (let index = 0; index < 12; index += 1) {
            unknown[`unknownKey${index}`] = index;
        }

        const body = { ...updateBody({ diet: 'carnivore' }), ...unknown };
        const verdict = parsePreferencesUpdateRequest(body) as Verdict;

        await expectRefusedAtBoundary(savePreferencesController, { body }, verdict, [asMock(savePreferences)]);

        const [refusal] = eventsNamed('request_refused');

        expect(String(refusal.fields.fields).split(',')).toHaveLength(10);
        expect(refusal.fields.detailCount).toBe(13);
    });
});

/* ---------------------------------------------------------------------------
 * (i-b) The one field-level condition with a typed class is refused AS that
 *       class, on the route as well as in the service
 * ------------------------------------------------------------------------- */

describe('a body whose only fault is keys the client may not write', () => {
    const readOnlyKeys = { setupStatus: 'completed', setupStep: 'review', revision: 9 };

    it.each([
        [
            'the step save',
            saveSetupStepController,
            { params: { step: 'goal' }, body: { ...stepBody(), ...readOnlyKeys } },
            'preferences.saveStep',
            asMock(saveSetupStep),
        ],
        [
            'the full save',
            savePreferencesController,
            { body: { ...updateBody(), ...readOnlyKeys } },
            'preferences.save',
            asMock(savePreferences),
        ],
    ] as const)(
        'is refused by %s as ReadOnlyFieldError, with the identical body and no service call',
        async (_name, handler, request, action, service) => {
            const { req, res, recorded } = doubles(request);

            await handler(req, res);

            // The wire body is the verdict's, because the class carries the whole
            // detail list — the three offending keys still come back in one 400.
            expect(recorded.statusCode).toBe(400);
            expect(recorded.body).toEqual({
                error: 'invalid_request',
                details: [
                    { field: 'setupStatus', code: 'read_only_field' },
                    { field: 'setupStep', code: 'read_only_field' },
                    { field: 'revision', code: 'read_only_field' },
                ],
            });
            expect(service).not.toHaveBeenCalled();

            // Mapped as the typed class rather than answered as a generic
            // verdict, which is what the event proves: `ReadOnlyFieldError` is
            // named, and no `request_refused` was emitted for this request.
            const rejections = eventsNamed('request_rejected');

            expect(rejections).toHaveLength(1);
            expect(rejections[0].level).toBe('warn');
            expect(rejections[0].fields).toEqual({
                action,
                userId: USER_ID,
                status: 400,
                code: 'invalid_request',
                errorName: 'ReadOnlyFieldError',
                fields: 'setupStatus,setupStep,revision',
                detailCount: 3,
            });
            expect(eventsNamed('request_refused')).toEqual([]);
            expect(captured).toHaveLength(1);
        },
    );

    it('bounds the names it records on this path as well', async () => {
        // The bound exists because the names are client-supplied, which is true
        // of this path too: twelve unknown keys, ten names, a count of twelve.
        const unknown: Record<string, unknown> = {};

        for (let index = 0; index < 12; index += 1) {
            unknown[`unknownKey${index}`] = index;
        }

        const { req, res, recorded } = doubles({ body: { ...updateBody(), ...unknown } });

        await savePreferencesController(req, res);

        expect(recorded.statusCode).toBe(400);

        const [rejection] = eventsNamed('request_rejected');

        expect(rejection.fields.errorName).toBe('ReadOnlyFieldError');
        expect(String(rejection.fields.fields).split(',')).toHaveLength(10);
        expect(rejection.fields.detailCount).toBe(12);
    });

    it('stays a returned verdict when the body is also wrong in another way', async () => {
        // A mixed body must keep naming every offending control at once, so it
        // is NOT the class's condition: one 400 carrying both kinds of detail.
        const body = { ...updateBody({ diet: 'carnivore' }), ...readOnlyKeys };
        const verdict = parsePreferencesUpdateRequest(body) as Verdict;

        await expectRefusedAtBoundary(savePreferencesController, { body }, verdict, [
            asMock(savePreferences),
        ]);

        expect(verdict.details?.map((detail) => detail.code)).toEqual([
            'read_only_field',
            'read_only_field',
            'read_only_field',
            'unknown_value',
        ]);
        expect(eventsNamed('request_rejected')).toEqual([]);
    });
});

/* ---------------------------------------------------------------------------
 * (ii) A well-formed request reaches the service exactly once, with the
 *      narrowed values
 * ------------------------------------------------------------------------- */

describe('a well-formed request reaches its service exactly once', () => {
    it('passes the step and the wire body, which is all this parser produces', async () => {
        // The preference request stage answers `ok` / `needs_context` /
        // refusal and carries NO payload, because a step's authoritative
        // payload is only decidable against the stored row. There is therefore
        // no narrowed value to forward here, and the claim this file makes
        // about this handler is the one above: a body the request alone
        // condemns never reaches the service at all.
        const body = stepBody();

        asMock(saveSetupStep).mockResolvedValue({ kind: 'ok', response: { preferences: {}, affectedMealCount: 0 } });

        const { req, res, recorded } = doubles({ params: { step: 'goal' }, body });

        await saveSetupStepController(req, res);

        expect(asMock(saveSetupStep)).toHaveBeenCalledTimes(1);
        expect(asMock(saveSetupStep)).toHaveBeenCalledWith(USER_ID, 'goal', body);
        expect(recorded.body).toEqual({ preferences: {}, affectedMealCount: 0 });
        expect(captured).toEqual([]);
    });

    it('passes the full-save wire body, for the same reason', async () => {
        const body = updateBody();

        asMock(savePreferences).mockResolvedValue({ kind: 'ok', response: { preferences: {}, affectedMealCount: 2 } });

        const { req, res } = doubles({ body });

        await savePreferencesController(req, res);

        expect(asMock(savePreferences)).toHaveBeenCalledTimes(1);
        expect(asMock(savePreferences)).toHaveBeenCalledWith(USER_ID, body);
    });

    it('passes the targets wire body, because the parsed request is not a narrowing of it', async () => {
        // `parseSaveTargetsRequest` produces a NORMALISED DTO, not a narrowed
        // copy of the request: `ManualSaveRequest` nests the four macros under
        // `values` where the body carries them flat. Forwarding it would hand
        // the service a different value, which the service's own parse then
        // rightly refuses — so the wire body is this service's contract, and
        // the boundary's job here is the refusal above.
        const body = targetsBody();
        const parsed = parseSaveTargetsRequest(body);

        expect(parsed.kind).toBe('ok');
        expect(parsed).not.toEqual(expect.objectContaining({ request: body }));

        asMock(saveTargets).mockResolvedValue({ kind: 'ok', response: { targets: {}, feasibility: { ok: true, warnings: [] } } });

        const { req, res } = doubles({ body });

        await saveNutritionTargetsController(req, res);

        expect(asMock(saveTargets)).toHaveBeenCalledTimes(1);
        expect(asMock(saveTargets)).toHaveBeenCalledWith(USER_ID, body);
    });

    it('calls the day read with the NARROWED path ids, not the raw params', async () => {
        asMock(getMealPlanDay).mockResolvedValue({ kind: 'ok', envelope: { planId: PLAN_ID } });

        const { req, res, recorded } = doubles({ params: { planId: PLAN_ID, date: DAY_KEY } });

        await getPlanDayController(req, res);

        expect(asMock(getMealPlanDay)).toHaveBeenCalledTimes(1);
        expect(asMock(getMealPlanDay)).toHaveBeenCalledWith(USER_ID, PLAN_ID, DAY_KEY);
        expect(recorded.body).toEqual({ planId: PLAN_ID });
    });

    it('calls the affected-meals read with the narrowed planId', async () => {
        asMock(getAffectedMeals).mockResolvedValue({ kind: 'ok', response: { meals: [] } });

        const { req, res } = doubles({ params: { planId: PLAN_ID } });

        await getAffectedMealsController(req, res);

        expect(asMock(getAffectedMeals)).toHaveBeenCalledTimes(1);
        expect(asMock(getAffectedMeals)).toHaveBeenCalledWith(USER_ID, PLAN_ID);
    });

    it('calls the alternatives read with the narrowed plan and meal ids', async () => {
        asMock(getSwapAlternatives).mockResolvedValue({ kind: 'ok', response: { current: {}, alternatives: [] } });

        const { req, res } = doubles({ params: { planId: PLAN_ID, mealId: MEAL_ID } });

        await getSwapAlternativesController(req, res);

        expect(asMock(getSwapAlternatives)).toHaveBeenCalledTimes(1);
        expect(asMock(getSwapAlternatives)).toHaveBeenCalledWith(USER_ID, PLAN_ID, MEAL_ID);
    });

    it('calls the preview read with all three narrowed ids', async () => {
        asMock(getSwapPreview).mockResolvedValue({ kind: 'ok', response: { alternative: {} } });

        const { req, res } = doubles({
            params: { planId: PLAN_ID, mealId: MEAL_ID, recipeVersionId: RECIPE_VERSION_ID },
        });

        await getSwapPreviewController(req, res);

        expect(asMock(getSwapPreview)).toHaveBeenCalledTimes(1);
        expect(asMock(getSwapPreview)).toHaveBeenCalledWith(USER_ID, PLAN_ID, MEAL_ID, RECIPE_VERSION_ID);
    });

    // THE FOUR KEYED WRITES FORWARD THE PARSER'S PAYLOAD, NOT THE REQUEST.
    //
    // Each of these asserts two things, and the second is the one that matters.
    // The value the service receives EQUALS the payload the parser produced —
    // which is what keeps the answer identical, since each of these services
    // derives its idempotency fingerprint from the payload it is given — and it
    // is NOT the request-body object, which is what proves no raw Express value
    // crossed the boundary. A deep-equality assertion alone could not tell the
    // two apart here, because these payloads are normalised copies of the same
    // wire field names and so compare equal to the body they came from.
    it('calls the generation with the parsed payload rather than the request body', async () => {
        const body = generateBody();
        const parsed = parseGeneratePlanSyntax(body) as { kind: 'ok'; payload: unknown };

        asMock(generatePlan).mockResolvedValue(keyedResult(201, 1));

        const { req, res } = doubles({ body });

        await generatePlanController(req, res);

        expect(asMock(generatePlan)).toHaveBeenCalledTimes(1);
        expect(asMock(generatePlan)).toHaveBeenCalledWith(USER_ID, parsed.payload);
        expect(asMock(generatePlan).mock.calls[0][1]).not.toBe(req.body);
    });

    it('calls the regeneration with the narrowed planId and the parsed payload', async () => {
        const body = regenerateBody();
        const parsed = parseRegeneratePlanRequest({ planId: PLAN_ID }, body) as {
            kind: 'ok';
            payload: unknown;
        };

        asMock(regeneratePlan).mockResolvedValue(keyedResult(201, 2));

        const { req, res } = doubles({ params: { planId: PLAN_ID }, body });

        await regeneratePlanController(req, res);

        expect(asMock(regeneratePlan)).toHaveBeenCalledTimes(1);
        expect(asMock(regeneratePlan)).toHaveBeenCalledWith(USER_ID, PLAN_ID, parsed.payload);
        expect(asMock(regeneratePlan).mock.calls[0][2]).not.toBe(req.body);
    });

    it('calls the commit with the narrowed ids and the parsed payload', async () => {
        const body = commitBody();
        const parsed = parseSwapCommitRequest({ planId: PLAN_ID, mealId: MEAL_ID }, body) as {
            kind: 'ok';
            payload: unknown;
        };

        asMock(commitSwap).mockResolvedValue(keyedResult(200, 4));

        const { req, res } = doubles({ params: { planId: PLAN_ID, mealId: MEAL_ID }, body });

        await swapMealController(req, res);

        expect(asMock(commitSwap)).toHaveBeenCalledTimes(1);
        expect(asMock(commitSwap)).toHaveBeenCalledWith(USER_ID, PLAN_ID, MEAL_ID, parsed.payload);
        expect(asMock(commitSwap).mock.calls[0][3]).not.toBe(req.body);
    });

    it('calls the planned-meal log with the narrowed ids and the parsed payload', async () => {
        const body = logBody();
        const parsed = parseLogPlannedMealCall({ planId: PLAN_ID, mealId: MEAL_ID }, body) as {
            kind: 'ok';
            payload: unknown;
        };

        asMock(logPlannedMeal).mockResolvedValue(keyedResult(201, 5));

        const { req, res } = doubles({ params: { planId: PLAN_ID, mealId: MEAL_ID }, body });

        await logPlannedMealController(req, res);

        expect(asMock(logPlannedMeal)).toHaveBeenCalledTimes(1);
        expect(asMock(logPlannedMeal)).toHaveBeenCalledWith(USER_ID, PLAN_ID, MEAL_ID, parsed.payload);
        expect(asMock(logPlannedMeal).mock.calls[0][3]).not.toBe(req.body);
    });

    it('records one keyed_write_answered event for an answered keyed write', async () => {
        asMock(generatePlan).mockResolvedValue(keyedResult(201, 1));

        const { req, res, recorded } = doubles({ body: generateBody() });

        await generatePlanController(req, res);

        expect(recorded.statusCode).toBe(201);

        const answered = eventsNamed('keyed_write_answered');

        expect(answered).toHaveLength(1);
        expect(answered[0].level).toBe('info');
        expect(answered[0].fields).toEqual({
            action: 'plans.generate',
            userId: USER_ID,
            idempotencyKey: IDEMPOTENCY_KEY,
            status: 201,
            planRevision: 1,
            replayed: false,
        });
        expect(captured).toHaveLength(1);
    });

    it('distinguishes a replayed answer from the commit it replays', async () => {
        // The pair that makes the field load-bearing. Both answers carry the
        // same status and the same revision — §0.5.1 requires the CLIENT to be
        // unable to tell them apart — so `replayed` is the only thing in the
        // log that says whether this user generated a plan twice or lost the
        // response to one generation. Asserted as a pair rather than in
        // isolation, because a field that never varies proves nothing.
        asMock(generatePlan).mockResolvedValueOnce(keyedResult(201, 1, false));
        asMock(generatePlan).mockResolvedValueOnce(keyedResult(201, 1, true));

        const first = doubles({ body: generateBody() });

        await generatePlanController(first.req, first.res);

        const replay = doubles({ body: generateBody() });

        await generatePlanController(replay.req, replay.res);

        const answered = eventsNamed('keyed_write_answered');

        expect(answered).toHaveLength(2);
        expect(answered.map((event) => event.fields.replayed)).toEqual([false, true]);
        // Identical in every other respect, including what the client received.
        expect(answered[0].fields.status).toBe(answered[1].fields.status);
        expect(answered[0].fields.planRevision).toBe(answered[1].fields.planRevision);
        expect(replay.recorded.statusCode).toBe(first.recorded.statusCode);
        expect(replay.recorded.body).toEqual(first.recorded.body);
    });
});

/* ---------------------------------------------------------------------------
 * (iii) The post-commit abort records the response it withholds
 * ------------------------------------------------------------------------- */

describe('a response withheld after the write committed', () => {
    it.each([
        ['generate', generatePlanController, generatePlan, { body: generateBody() }, 'plans.generate', 201, 3],
        [
            'regenerate',
            regeneratePlanController,
            regeneratePlan,
            { params: { planId: PLAN_ID }, body: regenerateBody() },
            'plans.regenerate',
            201,
            4,
        ],
        [
            'swap',
            swapMealController,
            commitSwap,
            { params: { planId: PLAN_ID, mealId: MEAL_ID }, body: commitBody() },
            'swaps.commit',
            200,
            5,
        ],
        [
            'log',
            logPlannedMealController,
            logPlannedMeal,
            { params: { planId: PLAN_ID, mealId: MEAL_ID }, body: logBody() },
            'log.plannedMeal',
            201,
            6,
        ],
    ])(
        'destroys the socket for %s and records the stored status and revision',
        async (actionType, handler, service, request, action, status, planRevision) => {
            // The seam is test-only, and the flag module reads NODE_ENV once at
            // load, so the precondition is asserted rather than assumed.
            expect(process.env.NODE_ENV).toBe('test');

            asMock(service).mockResolvedValue(keyedResult(status, planRevision));

            const { req, res, recorded } = doubles({
                ...(request as { params?: Record<string, unknown>; body?: unknown }),
                headers: { [POST_COMMIT_ABORT_HEADER]: actionType as string },
            });

            await (handler as (req: Request, res: Response) => Promise<unknown>)(req, res);

            expect(recorded.socketDestroyed).toBe(true);
            expect(recorded.statusCode).toBeNull();
            expect(recorded.body).toBeNull();

            const aborts = eventsNamed('response_aborted_after_commit');

            expect(aborts).toHaveLength(1);
            expect(aborts[0].level).toBe('warn');
            expect(aborts[0].fields.action).toBe(action);
            expect(aborts[0].fields.userId).toBe(USER_ID);
            expect(aborts[0].fields.status).toBe(status);
            expect(aborts[0].fields.planRevision).toBe(planRevision);
            expect(aborts[0].fields.idempotencyKey).toBe(IDEMPOTENCY_KEY);
            expect(aborts[0].fields.reason).toBe('post_commit_abort_requested');
            // The withheld answer was a fresh commit, and the event says so:
            // a retry of the same key would abort again, and only this field
            // would differ.
            expect(aborts[0].fields.replayed).toBe(false);
            // The withheld answer is NOT in the line: the stored snapshot is
            // the plan itself.
            expect(aborts[0].line).not.toContain(STORED_SNAPSHOT);
            expect(eventsNamed('keyed_write_answered')).toEqual([]);
            expect(captured).toHaveLength(1);
        },
    );
});

/* ---------------------------------------------------------------------------
 * (iv) An expected rejection answers as before and is now recorded
 * ------------------------------------------------------------------------- */

describe('an expected typed rejection', () => {
    it('answers 409 stale_revision with the unchanged body and one warn event', async () => {
        asMock(savePreferences).mockRejectedValue(new StaleRevisionError({ currentRevision: 7 }));

        const { req, res, recorded } = doubles({ body: updateBody() });

        await savePreferencesController(req, res);

        expect(recorded.statusCode).toBe(409);
        expect(recorded.body).toEqual({ error: 'stale_revision', currentRevision: 7 });

        const rejections = eventsNamed('request_rejected');

        expect(rejections).toHaveLength(1);
        expect(rejections[0].level).toBe('warn');
        expect(rejections[0].fields).toEqual({
            action: 'preferences.save',
            userId: USER_ID,
            status: 409,
            code: 'stale_revision',
            errorName: 'StaleRevisionError',
            currentRevision: 7,
        });
        // One event per answered request: a rejection is not also a failure.
        expect(eventsNamed('request_failed')).toEqual([]);
        expect(captured).toHaveLength(1);
    });

    it('names the caller in a capability refusal, which is the whole use of that event', async () => {
        // The gate runs AFTER `getUserId(req)` in all fifteen gated handlers.
        // It changes no response — every route here is mounted behind the auth
        // middleware, so the identity is already verified and available — and
        // it is what makes a `503` during a staged rollout answerable: "which
        // account was refused" is the only question an operator has, and a
        // refusal that named nobody could not answer it.
        const gate = jest.spyOn(featureFlags, 'isMealPlanningEnabled').mockReturnValue(false);

        try {
            const { req, res, recorded } = doubles({ params: { planId: PLAN_ID }, body: regenerateBody() });

            await regeneratePlanController(req, res);

            expect(recorded.statusCode).toBe(503);
            expect(recorded.body).toEqual({ error: 'feature_disabled' });
            // Refused at the capability, so the service is never reached.
            expect(asMock(regeneratePlan)).not.toHaveBeenCalled();

            const rejections = eventsNamed('request_rejected');

            expect(rejections).toHaveLength(1);
            expect(rejections[0].fields.userId).toBe(USER_ID);
            expect(rejections[0].fields.action).toBe('plans.regenerate');
            expect(rejections[0].fields.status).toBe(503);
            expect(rejections[0].fields.code).toBe('feature_disabled');
        } finally {
            gate.mockRestore();
        }
    });
});

/* ---------------------------------------------------------------------------
 * (v) An unmapped failure answers one stable code and logs nothing sensitive
 * ------------------------------------------------------------------------- */

describe('an unmapped failure', () => {
    it('answers 500 internal_error and records neither the message, a credential nor a stack', async () => {
        asMock(getCurrentMealPlan).mockRejectedValue(new Error('boom: postgresql://soh:secret@host/db'));

        const { req, res, recorded } = doubles({});

        await getCurrentPlansController(req, res);

        expect(recorded.statusCode).toBe(500);
        expect(recorded.body).toEqual({ error: 'internal_error' });

        const failures = eventsNamed('request_failed');

        expect(failures).toHaveLength(1);
        expect(failures[0].level).toBe('error');
        expect(failures[0].fields).toEqual({
            action: 'plans.current',
            userId: USER_ID,
            status: 500,
            code: 'internal_error',
            errorName: 'Error',
        });
        expect(failures[0].line).not.toContain('boom');
        expect(failures[0].line).not.toContain('secret');
        expect(failures[0].line).not.toContain('postgresql://');
        expect(failures[0].line).not.toContain(' at ');
        expect(failures[0].line).not.toContain('controllerBoundary');
        expect(captured).toHaveLength(1);
    });

    it('describes a thrown value that is not an Error without printing it', async () => {
        asMock(getCurrentMealPlan).mockRejectedValue('postgresql://soh:secret@host/db');

        const { req, res, recorded } = doubles({});

        await getCurrentPlansController(req, res);

        expect(recorded.body).toEqual({ error: 'internal_error' });

        const [failure] = eventsNamed('request_failed');

        expect(failure.fields.errorName).toBe('NonError');
        expect(failure.line).not.toContain('secret');
    });
});
