/**
 * `mealPlanningAction.logic.ts` is the pure half of the meal-planning write
 * ledger (Agent Action Plan §0.5.1). This suite runs with NO DATABASE and no
 * mocks, which is the whole point of the layering Rule 7 §11 prescribes: "if
 * you find yourself needing a database to test a *rule*, the rule is in the
 * wrong layer". The lock-and-reserve behaviour those rules sit inside is
 * covered separately, against real PostgreSQL, by
 * `src/__tests__/api/concurrency.test.ts`.
 *
 * The assertions below are chosen for the bugs that would actually hurt, not
 * for the happy paths:
 *
 *  - a fingerprint that varied with key order would make a legitimate retry
 *    look like a conflict and BLOCK the user, so key-order stability is
 *    asserted first and from several angles;
 *  - a fingerprint that ignored a field would let a DIFFERENT request replay a
 *    stale result, so every field of every keyed payload is perturbed
 *    individually;
 *  - a replay decided after the revision check would strand a client forever,
 *    so `decideReplay`'s signature is asserted, not just its outputs;
 *  - a status re-derived at read time would retroactively rewrite what an
 *    already-stored action replays, so the read-back is checked with a status
 *    no derivation would ever produce.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
    LogPlannedMealResponse,
    MealPlanResponse,
    SwapMealResponse,
} from '../../types/mealPlanning';
import {
    ACTION_INTENT_MAX_AGE_MS,
    ACTION_TYPES,
    ActionResourceIds,
    KEYED_ACTION_RESPONSE_STATUS,
    KeyedActionType,
    MealPlanningActionRecord,
    StoredResponseRecord,
    buildRequestFingerprint,
    canonicalizeRequestBody,
    decideReplay,
    isActionExpired,
    readStoredResponse,
    shapeStoredResponse,
} from '../mealPlanningAction.logic';

/**
 * The module stores a response body without inspecting it, so these stand-ins
 * carry only an identifying field. Casting keeps the suite about the ledger
 * rules rather than about assembling three large DTOs the module never reads.
 */
const mealPlanBody = { id: 'plan-1', revision: 2 } as unknown as MealPlanResponse;
const swapBody = { planRevision: 5 } as unknown as SwapMealResponse;
const logBody = { planRevision: 6 } as unknown as LogPlannedMealResponse;

/** The swap payload of §0.5.2, used as the reference body for fingerprinting. */
const swapPayload = {
    recipeVersionId: 'recipe-version-1',
    portionMultiplier: 1.25,
    expectedPlanRevision: 4,
    idempotencyKey: '6f1b7a4c-1f2e-4c3a-9d5b-8e7f0a1b2c3d',
};

/** The log payload of §0.5.2, which carries the three fields §0.9.2 perturbs. */
const logPayload = {
    servings: 1,
    date: '2026-07-05',
    diaryMealId: 'diary-meal-1',
    expectedPlanRevision: 4,
    idempotencyKey: '6f1b7a4c-1f2e-4c3a-9d5b-8e7f0a1b2c3d',
};

const swapIds: ActionResourceIds = { planId: 'plan-1', mealId: 'meal-1' };

const fingerprintOf = (body: unknown, ids: ActionResourceIds = swapIds, action: KeyedActionType = 'swap'): string =>
    buildRequestFingerprint('POST', action, ids, body);

describe('ACTION_TYPES', () => {
    it('is the closed set of exactly the four keyed writes', () => {
        expect(ACTION_TYPES).toEqual(['generate', 'regenerate', 'swap', 'log']);
    });

    it('excludes the writes that are state-setting or revisioned rather than keyed', () => {
        // Grocery toggles and uncheck-all carry no key (last write wins), and
        // preference/target saves are revisioned. A member added here would
        // silently pull one of them into the ledger.
        const members: readonly string[] = ACTION_TYPES;

        for (const excluded of ['toggleGrocery', 'uncheckAllGroceries', 'savePreferences', 'saveTargets']) {
            expect(members).not.toContain(excluded);
        }
    });

    it('gives every member a response status and invents none', () => {
        expect(Object.keys(KEYED_ACTION_RESPONSE_STATUS).sort()).toEqual([...ACTION_TYPES].sort());
    });
});

describe('canonicalizeRequestBody', () => {
    describe('object key order', () => {
        it('is identical for the same logical body written in a different order', () => {
            // The single most important property in the file: without it a
            // legitimate retry is rejected as a conflict.
            expect(canonicalizeRequestBody({ b: 1, a: 2, c: 3 })).toBe(canonicalizeRequestBody({ c: 3, a: 2, b: 1 }));
        });

        it('ignores key order at every depth', () => {
            const first = { outer: { z: 1, a: { n: 2, m: 3 } } };
            const second = { outer: { a: { m: 3, n: 2 }, z: 1 } };

            expect(canonicalizeRequestBody(first)).toBe(canonicalizeRequestBody(second));
        });

        it('sorts by code unit rather than by locale', () => {
            // 'B' (0x42) precedes 'a' (0x61) by code unit, while a locale
            // collation puts 'a' first. Pinning the code-unit order is what
            // stops two processes with different ICU data from disagreeing
            // about whether a retry is the same request.
            expect(canonicalizeRequestBody({ a: 1, B: 2 })).toBe('{"B":2.00,"a":1.00}');
        });

        it('accepts a prototype-less object as plain data', () => {
            const bare = Object.create(null) as Record<string, unknown>;
            bare.servings = 2;

            expect(canonicalizeRequestBody(bare)).toBe('{"servings":2.00}');
        });
    });

    describe('numeric canonicalisation', () => {
        it('collapses 1, 1.0 and "1" onto one token', () => {
            expect(canonicalizeRequestBody(1)).toBe('1.00');
            expect(canonicalizeRequestBody(1.0)).toBe('1.00');
            expect(canonicalizeRequestBody('1')).toBe('1.00');
        });

        it('keeps the repository\'s two-decimal fraction values intact', () => {
            // ⅓ and ⅔ are stored as 0.33 and 0.66 by the mobile fraction chips.
            expect(canonicalizeRequestBody(0.33)).toBe('0.33');
            expect(canonicalizeRequestBody(0.66)).toBe('0.66');
        });

        it('renders every allowed portion multiplier without drift', () => {
            const tokens = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((multiplier) =>
                canonicalizeRequestBody(multiplier),
            );

            expect(tokens).toEqual(['0.50', '0.75', '1.00', '1.25', '1.50', '1.75', '2.00']);
        });

        it('pads a single fraction digit', () => {
            expect(canonicalizeRequestBody(1.05)).toBe('1.05');
            expect(canonicalizeRequestBody(0.4)).toBe('0.40');
        });

        it('rounds a third decimal away, which only a value the parsers already reject can carry', () => {
            expect(canonicalizeRequestBody(1.005)).toBe('1.00');
            expect(canonicalizeRequestBody(0.333)).toBe('0.33');
            expect(canonicalizeRequestBody(0.336)).toBe('0.34');
        });

        it('never emits a negative zero', () => {
            expect(canonicalizeRequestBody(-0)).toBe('0.00');
            expect(canonicalizeRequestBody(-0.001)).toBe('0.00');
        });

        it('canonicalises negative values and exponential forms', () => {
            expect(canonicalizeRequestBody(-1.234)).toBe('-1.23');
            expect(canonicalizeRequestBody(1e3)).toBe('1000.00');
            expect(canonicalizeRequestBody('1e3')).toBe('1000.00');
        });

        it('treats text that is not a canonical JSON number as text', () => {
            // A leading zero, a trailing point, an explicit plus and a date are
            // all strings. Reading a date as a number would be catastrophic.
            expect(canonicalizeRequestBody('01')).toBe('"01"');
            expect(canonicalizeRequestBody('1.')).toBe('"1."');
            expect(canonicalizeRequestBody('+1')).toBe('"+1"');
            expect(canonicalizeRequestBody('0x10')).toBe('"0x10"');
            expect(canonicalizeRequestBody('NaN')).toBe('"NaN"');
            expect(canonicalizeRequestBody('2026-07-05')).toBe('"2026-07-05"');
            expect(canonicalizeRequestBody('')).toBe('""');
        });

        it('collapses a numeric string that carries surrounding whitespace', () => {
            expect(canonicalizeRequestBody(' 1 ')).toBe('1.00');
        });

        it('refuses a non-finite number, which JSON cannot carry at all', () => {
            expect(() => canonicalizeRequestBody(Number.NaN)).toThrow(/has no canonical form/);
            expect(() => canonicalizeRequestBody(Number.POSITIVE_INFINITY)).toThrow(/has no canonical form/);
            expect(() => canonicalizeRequestBody({ servings: Number.NEGATIVE_INFINITY })).toThrow(
                /\$\.servings is -Infinity/,
            );
        });

        it('refuses a magnitude too large to round without losing integer precision', () => {
            expect(() => canonicalizeRequestBody(1e20)).toThrow(/losing integer precision/);
            expect(() => canonicalizeRequestBody('1e20')).toThrow(/losing integer precision/);
        });
    });

    describe('arrays', () => {
        it('treats order as semantic', () => {
            expect(canonicalizeRequestBody([1, 2])).not.toBe(canonicalizeRequestBody([2, 1]));
        });

        it('renders a hole or an undefined element as null, exactly as JSON.stringify does', () => {
            expect(canonicalizeRequestBody([1, undefined, 2])).toBe('[1.00,null,2.00]');
            // eslint-disable-next-line no-sparse-arrays -- a sparse hole is the case under test
            expect(canonicalizeRequestBody([1, , 2])).toBe('[1.00,null,2.00]');
        });

        it('canonicalises nested members while preserving their position', () => {
            expect(canonicalizeRequestBody([{ b: 1, a: 2 }, []])).toBe('[{"a":2.00,"b":1.00},[]]');
        });
    });

    describe('null, undefined and absence', () => {
        it('keeps an explicit null distinct from an absent key', () => {
            // The distinction the preferences contract depends on: null means
            // "clear this", omitted means "leave it".
            expect(canonicalizeRequestBody({ goalWeightKg: null })).toBe('{"goalWeightKg":null}');
            expect(canonicalizeRequestBody({})).toBe('{}');
        });

        it('drops a property whose value is undefined, matching JSON.stringify', () => {
            expect(canonicalizeRequestBody({ goalWeightKg: undefined })).toBe('{}');
        });

        it('renders a top-level null or undefined as null', () => {
            expect(canonicalizeRequestBody(null)).toBe('null');
            expect(canonicalizeRequestBody(undefined)).toBe('null');
        });
    });

    describe('separation between types', () => {
        it('never lets a string impersonate another JSON type', () => {
            expect(canonicalizeRequestBody('true')).not.toBe(canonicalizeRequestBody(true));
            expect(canonicalizeRequestBody('false')).not.toBe(canonicalizeRequestBody(false));
            expect(canonicalizeRequestBody('null')).not.toBe(canonicalizeRequestBody(null));
        });

        it('distinguishes a scalar from a container holding it', () => {
            const forms = [
                canonicalizeRequestBody(1),
                canonicalizeRequestBody([1]),
                canonicalizeRequestBody({ a: 1 }),
            ];

            expect(new Set(forms).size).toBe(forms.length);
        });

        it('emits booleans as bare JSON literals', () => {
            expect(canonicalizeRequestBody({ noBudgetPreference: true })).toBe('{"noBudgetPreference":true}');
            expect(canonicalizeRequestBody({ noBudgetPreference: false })).toBe('{"noBudgetPreference":false}');
        });

        it('escapes a key or value that would otherwise break the encoding', () => {
            expect(canonicalizeRequestBody({ 'a"b': 'c,d' })).toBe('{"a\\"b":"c,d"}');
        });
    });

    describe('values with no faithful representation', () => {
        it('refuses a bigint, a function and a symbol', () => {
            expect(() => canonicalizeRequestBody(BigInt(10))).toThrow(/is a bigint/);
            expect(() => canonicalizeRequestBody({ fn: () => 1 })).toThrow(/is a function/);
            expect(() => canonicalizeRequestBody({ tag: Symbol('x') })).toThrow(/is a symbol/);
        });

        it('refuses a class instance rather than hashing it as an empty object', () => {
            // A Date, Map or Set has no own enumerable keys, so emitting `{}`
            // would silently drop its contents from the digest — the
            // field-blind fingerprint that lets a different request replay a
            // stale result.
            expect(() => canonicalizeRequestBody(new Date(0))).toThrow(/Date instance/);
            expect(() => canonicalizeRequestBody({ seen: new Set([1]) })).toThrow(/Set instance/);
            expect(() => canonicalizeRequestBody({ byId: new Map() })).toThrow(/Map instance/);
        });

        it('still names a non-plain object that has no constructor', () => {
            // An object whose prototype is itself prototype-less is neither
            // plain nor constructor-bearing. The message must degrade rather
            // than throw a second error while reporting the first.
            const exotic = Object.create(Object.create(null)) as object;

            expect(() => canonicalizeRequestBody(exotic)).toThrow(/non-plain instance/);
        });

        it('refuses a cycle and names where it was found', () => {
            const cyclic: Record<string, unknown> = { a: 1 };
            cyclic.self = cyclic;

            expect(() => canonicalizeRequestBody(cyclic)).toThrow(/\$\.self is a circular reference/);
        });

        it('accepts the same object referenced twice, which is not a cycle', () => {
            const shared = { a: 1 };

            expect(canonicalizeRequestBody({ p: shared, q: shared })).toBe('{"p":{"a":1.00},"q":{"a":1.00}}');
        });
    });

    it('is deterministic across repeated calls', () => {
        expect(canonicalizeRequestBody(logPayload)).toBe(canonicalizeRequestBody(logPayload));
    });
});

describe('buildRequestFingerprint', () => {
    describe('stability — a legitimate retry must never look like a conflict', () => {
        it('is unchanged by the order the body was built in', () => {
            const reordered = {
                idempotencyKey: swapPayload.idempotencyKey,
                expectedPlanRevision: swapPayload.expectedPlanRevision,
                portionMultiplier: swapPayload.portionMultiplier,
                recipeVersionId: swapPayload.recipeVersionId,
            };

            expect(fingerprintOf(reordered)).toBe(fingerprintOf(swapPayload));
        });

        it('is unchanged by the order the resource ids were built in', () => {
            expect(fingerprintOf(swapPayload, { mealId: 'meal-1', planId: 'plan-1' })).toBe(
                fingerprintOf(swapPayload, swapIds),
            );
        });

        it('is unchanged by the casing or padding of the method', () => {
            expect(buildRequestFingerprint(' post ', 'swap', swapIds, swapPayload)).toBe(
                buildRequestFingerprint('POST', 'swap', swapIds, swapPayload),
            );
        });

        it('is unchanged when a number arrives as its numeric string', () => {
            expect(fingerprintOf({ ...swapPayload, expectedPlanRevision: '4' })).toBe(fingerprintOf(swapPayload));
        });

        it('is deterministic across repeated calls', () => {
            expect(fingerprintOf(swapPayload)).toBe(fingerprintOf(swapPayload));
        });

        it('is a lowercase 64-character hex digest', () => {
            expect(fingerprintOf(swapPayload)).toMatch(/^[0-9a-f]{64}$/);
        });
    });

    describe('sensitivity — a different request must never replay a stored result', () => {
        const baseline = fingerprintOf(logPayload, { planId: 'plan-1', mealId: 'meal-1' }, 'log');

        const differsFromBaseline = (body: unknown, ids: ActionResourceIds = swapIds, action: KeyedActionType = 'log') =>
            expect(fingerprintOf(body, ids, action)).not.toBe(baseline);

        it('changes when servings changes', () => {
            differsFromBaseline({ ...logPayload, servings: 2 });
            differsFromBaseline({ ...logPayload, servings: 0.66 });
        });

        it('changes when the diary date changes', () => {
            differsFromBaseline({ ...logPayload, date: '2026-07-06' });
        });

        it('changes when the diary bucket changes', () => {
            differsFromBaseline({ ...logPayload, diaryMealId: 'diary-meal-2' });
        });

        it('changes when the expected plan revision changes', () => {
            // This is what makes a refreshed preview a different request, so
            // the client mints a new key instead of replaying a dead one.
            differsFromBaseline({ ...logPayload, expectedPlanRevision: 5 });
        });

        it('changes when the recipe version changes', () => {
            expect(fingerprintOf({ ...swapPayload, recipeVersionId: 'recipe-version-2' })).not.toBe(
                fingerprintOf(swapPayload),
            );
        });

        it('changes when the previewed portion changes', () => {
            expect(fingerprintOf({ ...swapPayload, portionMultiplier: 1.5 })).not.toBe(fingerprintOf(swapPayload));
        });

        it('changes when either expected revision of a generation changes', () => {
            const generatePayload = {
                startDate: '2026-07-05',
                idempotencyKey: swapPayload.idempotencyKey,
                expectedPreferencesRevision: 3,
                expectedTargetsRevision: 7,
            };
            const generated = fingerprintOf(generatePayload, {}, 'generate');

            expect(fingerprintOf({ ...generatePayload, expectedPreferencesRevision: 4 }, {}, 'generate')).not.toBe(
                generated,
            );
            expect(fingerprintOf({ ...generatePayload, expectedTargetsRevision: 8 }, {}, 'generate')).not.toBe(
                generated,
            );
            expect(fingerprintOf({ ...generatePayload, startDate: '2026-07-12' }, {}, 'generate')).not.toBe(generated);
        });

        it('changes when the action type changes, so two routes cannot collide on one key', () => {
            const ids: ActionResourceIds = { planId: 'plan-1', mealId: 'meal-1' };
            const digests = ACTION_TYPES.map((action) => fingerprintOf(logPayload, ids, action));

            expect(new Set(digests).size).toBe(ACTION_TYPES.length);
        });

        it('changes when a resource id changes', () => {
            differsFromBaseline(logPayload, { planId: 'plan-1', mealId: 'meal-2' });
            differsFromBaseline(logPayload, { planId: 'plan-2', mealId: 'meal-1' });
        });

        it('changes when a resource id is added or dropped', () => {
            differsFromBaseline(logPayload, { planId: 'plan-1' });
            differsFromBaseline(logPayload, { planId: 'plan-1', mealId: 'meal-1', extraId: 'x' });
        });

        it('distinguishes transposed resource ids, which a positional pair could not', () => {
            expect(fingerprintOf(swapPayload, { planId: 'a', mealId: 'b' })).not.toBe(
                fingerprintOf(swapPayload, { planId: 'b', mealId: 'a' }),
            );
        });

        it('changes when the method changes', () => {
            expect(buildRequestFingerprint('PUT', 'swap', swapIds, swapPayload)).not.toBe(
                buildRequestFingerprint('POST', 'swap', swapIds, swapPayload),
            );
        });

        it('changes when the idempotency key changes, since the key is part of the request', () => {
            expect(fingerprintOf({ ...swapPayload, idempotencyKey: 'other-key' })).not.toBe(
                fingerprintOf(swapPayload),
            );
        });

        it('cannot be shifted by a value that looks like a delimiter', () => {
            // The four components are hashed as a JSON envelope, so no value
            // can impersonate a separator and move a component boundary.
            expect(fingerprintOf({ id: 'a|b' }, { planId: 'c' })).not.toBe(
                fingerprintOf({ id: 'a' }, { planId: 'b|c' }),
            );
        });
    });

    it('refuses a blank method rather than hashing without it', () => {
        expect(() => buildRequestFingerprint('   ', 'swap', swapIds, swapPayload)).toThrow(/method is blank/);
    });

    it('reports a body it cannot canonicalise instead of digesting it inaccurately', () => {
        expect(() => fingerprintOf({ loggedAt: new Date(0) })).toThrow(/Date instance/);
    });
});

describe('decideReplay', () => {
    const fingerprint = fingerprintOf(swapPayload);

    it('proceeds when no row exists', () => {
        expect(decideReplay(null, fingerprint)).toBe('proceed');
        expect(decideReplay(undefined, fingerprint)).toBe('proceed');
    });

    it('replays when the key and the request both match', () => {
        expect(decideReplay({ requestFingerprint: fingerprint }, fingerprint)).toBe('replay');
    });

    it('conflicts when the key matches but the request does not', () => {
        expect(decideReplay({ requestFingerprint: fingerprint }, fingerprintOf({ ...swapPayload, servings: 3 }))).toBe(
            'conflict',
        );
    });

    it('ignores accidental casing or whitespace around a stored digest', () => {
        // A spurious mismatch here would lock a user out of their own retry,
        // and normalising hex cannot merge two genuinely different digests.
        expect(decideReplay({ requestFingerprint: ` ${fingerprint.toUpperCase()} ` }, fingerprint)).toBe('replay');
    });

    it('takes no revision or status argument, so it cannot be ordered after a revision check', () => {
        // The load-bearing assertion of this file. Were the replay decision
        // made after the plan's revision were checked, a client whose response
        // was lost — and whose plan then advanced through another device's
        // swap — would be answered 409 stale_plan forever and could never
        // learn its own action had succeeded.
        expect(decideReplay).toHaveLength(2);
    });

    it('reaches the same verdict when handed a whole ledger row carrying plan state', () => {
        const row: MealPlanningActionRecord = {
            id: 'action-1',
            userId: 'user-1',
            idempotencyKey: swapPayload.idempotencyKey,
            actionType: 'swap',
            requestFingerprint: fingerprint,
            mealPlanId: 'plan-1',
            mealPlanMealId: 'meal-1',
            mealEntryId: null,
            responseStatus: 200,
            responseSnapshot: swapBody,
            planRevisionAfter: 99,
            createdAt: new Date('2026-07-05T12:00:00.000Z'),
        };

        expect(decideReplay(row, fingerprint)).toBe('replay');
    });

    it('replays a still-pending row, a state the per-user lock makes unreachable', () => {
        // Documented rather than given a fourth verdict: the reservation and
        // the write share one transaction, so a pending row is visible only to
        // the transaction that created it. Held in a variable so the reserved
        // row's unfilled columns travel with it, the way the service's row
        // would.
        const reservedRow = { requestFingerprint: fingerprint, responseStatus: null, planRevisionAfter: null };

        expect(decideReplay(reservedRow, fingerprint)).toBe('replay');
    });
});

describe('shapeStoredResponse', () => {
    it('stores 201 for the three actions that create a resource', () => {
        expect(shapeStoredResponse('generate', mealPlanBody, 1).responseStatus).toBe(201);
        expect(shapeStoredResponse('regenerate', mealPlanBody, 2).responseStatus).toBe(201);
        expect(shapeStoredResponse('log', logBody, 6).responseStatus).toBe(201);
    });

    it('stores 200 for a swap, which changes a resource rather than creating one', () => {
        expect(shapeStoredResponse('swap', swapBody, 5).responseStatus).toBe(200);
    });

    it('stores the body unchanged and beside the revision the action produced', () => {
        expect(shapeStoredResponse('swap', swapBody, 5)).toEqual({
            responseStatus: 200,
            responseSnapshot: swapBody,
            planRevisionAfter: 5,
        });
    });

    it('refuses a revision that is not a non-negative integer', () => {
        expect(() => shapeStoredResponse('swap', swapBody, Number.NaN)).toThrow(/not a non-negative integer/);
        expect(() => shapeStoredResponse('swap', swapBody, -1)).toThrow(/not a non-negative integer/);
        expect(() => shapeStoredResponse('swap', swapBody, 1.5)).toThrow(/not a non-negative integer/);
    });

    it('will not accept one action with another action\'s response body', () => {
        // A compile-time assertion: if the generic stopped pinning the pairing,
        // the unused @ts-expect-error below would itself become an error and
        // this suite would fail to compile.
        // @ts-expect-error -- a swap response may never be stored against a generate action
        expect(() => shapeStoredResponse('generate', swapBody, 1)).not.toThrow();
    });
});

describe('readStoredResponse', () => {
    it('returns nothing when there is no row', () => {
        expect(readStoredResponse(null)).toBeNull();
        expect(readStoredResponse(undefined)).toBeNull();
    });

    it('returns nothing for a reserved row that has not completed', () => {
        expect(readStoredResponse({ responseStatus: null, responseSnapshot: null, planRevisionAfter: null })).toBeNull();
    });

    it('returns nothing when either half of the stored response is missing', () => {
        expect(readStoredResponse({ responseStatus: 200, responseSnapshot: null, planRevisionAfter: 5 })).toBeNull();
        expect(readStoredResponse({ responseStatus: null, responseSnapshot: swapBody, planRevisionAfter: 5 })).toBeNull();
    });

    it('tolerates a raw row whose empty columns read back as undefined', () => {
        const undefinedColumns = {
            responseStatus: undefined,
            responseSnapshot: undefined,
            planRevisionAfter: undefined,
        } as unknown as StoredResponseRecord;

        expect(readStoredResponse(undefinedColumns)).toBeNull();
    });

    it('reads the stored status back verbatim instead of re-deriving it', () => {
        // 299 is a status no derivation in this module would ever produce, so
        // only a genuine read-back can return it. Persisting the status is what
        // stops a future change to an endpoint's success code from rewriting
        // what an already-stored action replays.
        expect(readStoredResponse({ responseStatus: 299, responseSnapshot: swapBody, planRevisionAfter: 4 })).toEqual({
            status: 299,
            body: swapBody,
            planRevisionAfter: 4,
        });
    });

    it('round-trips everything shapeStoredResponse wrote', () => {
        const stored = shapeStoredResponse('log', logBody, 6);

        expect(readStoredResponse(stored)).toEqual({ status: 201, body: logBody, planRevisionAfter: 6 });
    });

    it('reports a missing revision as null rather than inventing one', () => {
        expect(
            readStoredResponse({ responseStatus: 200, responseSnapshot: swapBody, planRevisionAfter: null }),
        ).toEqual({ status: 200, body: swapBody, planRevisionAfter: null });
    });

    it('replays a falsy but present body, which is still a stored response', () => {
        expect(readStoredResponse({ responseStatus: 200, responseSnapshot: 0, planRevisionAfter: 1 })?.body).toBe(0);
        expect(readStoredResponse({ responseStatus: 200, responseSnapshot: '', planRevisionAfter: 1 })?.body).toBe('');
    });
});

describe('isActionExpired', () => {
    const createdAt = new Date('2026-07-05T00:00:00.000Z');
    const at = (offsetMs: number): Date => new Date(createdAt.getTime() + offsetMs);

    it('pins the window at seven days', () => {
        expect(ACTION_INTENT_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('is not expired before the boundary', () => {
        expect(isActionExpired({ createdAt }, at(0))).toBe(false);
        expect(isActionExpired({ createdAt }, at(ACTION_INTENT_MAX_AGE_MS - 1))).toBe(false);
    });

    it('is not expired exactly at the boundary', () => {
        // Inclusive on purpose: a retry landing on the limit still replays
        // under its own key instead of silently minting a new one.
        expect(isActionExpired({ createdAt }, at(ACTION_INTENT_MAX_AGE_MS))).toBe(false);
    });

    it('is expired one millisecond past the boundary', () => {
        expect(isActionExpired({ createdAt }, at(ACTION_INTENT_MAX_AGE_MS + 1))).toBe(true);
    });

    it('accepts a Date, an ISO string or epoch milliseconds for either timestamp', () => {
        const expiredAt = at(ACTION_INTENT_MAX_AGE_MS + 1);

        expect(isActionExpired({ createdAt: createdAt.toISOString() }, expiredAt)).toBe(true);
        expect(isActionExpired({ createdAt: createdAt.getTime() }, expiredAt.toISOString())).toBe(true);
        expect(isActionExpired({ createdAt }, expiredAt.getTime())).toBe(true);
    });

    it('treats a clock that runs backwards as not expired', () => {
        expect(isActionExpired({ createdAt }, at(-5000))).toBe(false);
    });

    it('honours a caller-supplied window', () => {
        expect(isActionExpired({ createdAt }, at(1000), 1000)).toBe(false);
        expect(isActionExpired({ createdAt }, at(1001), 1000)).toBe(true);
        expect(isActionExpired({ createdAt }, at(1), 0)).toBe(true);
    });

    it('refuses a window that would silently disable the guard', () => {
        expect(() => isActionExpired({ createdAt }, at(0), Number.NaN)).toThrow(/non-negative/);
        expect(() => isActionExpired({ createdAt }, at(0), -1)).toThrow(/non-negative/);
    });

    it('refuses a timestamp it cannot read, naming which one', () => {
        expect(() => isActionExpired({ createdAt: 'not-a-date' }, at(0))).toThrow(/createdAt is not a usable/);
        expect(() => isActionExpired({ createdAt }, 'not-a-date')).toThrow(/now is not a usable/);
        expect(() => isActionExpired({ createdAt: new Date('nope') }, at(0))).toThrow(/createdAt is not a usable/);
        expect(() => isActionExpired({ createdAt }, Number.NaN)).toThrow(/now is not a usable/);
    });
});

describe('the module itself', () => {
    const moduleSource = readFileSync(join(__dirname, '..', 'mealPlanningAction.logic.ts'), 'utf8');

    /**
     * The source with its comments removed. The purity assertions below have to
     * read CODE: the module's own documentation names `process.env` and the
     * clock in order to explain that it touches neither, and a scan that
     * matched prose would fail on the very comment promising the property.
     */
    const moduleCode = moduleSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    it('imports nothing beyond node:crypto and the meal-planning wire contract', () => {
        // The dependency whitelist, asserted rather than assumed: a Prisma
        // client, a service or an env accessor appearing here would mean a rule
        // had drifted out of the pure layer.
        const imported = moduleSource
            .split('\n')
            .filter((line) => line.startsWith('import '))
            .map((line) => line.split("'")[1]);

        expect(imported).toEqual(['node:crypto', '../types/mealPlanning']);
    });

    it('reads no clock, no environment and performs no I/O', () => {
        // Rule 7 §7's defining constraint for a *.logic.ts module, asserted
        // rather than trusted: `isActionExpired` takes "now" as a parameter
        // precisely so this list can stay empty.
        expect(moduleCode).not.toMatch(/process\.env/);
        expect(moduleCode).not.toMatch(/Date\.now\(/);
        expect(moduleCode).not.toMatch(/new Date\(/);
        expect(moduleCode).not.toMatch(/Math\.random\(/);
        expect(moduleCode).not.toMatch(/\basync\b/);
        expect(moduleCode).not.toMatch(/\bawait\b/);
        expect(moduleCode).not.toMatch(/require\(/);
    });
});

