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

import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
    LogPlannedMealResponse,
    MealPlanResponse,
    SwapMealResponse,
} from '../../types/mealPlanning';
import {
    ACTION_COMPLETION_FIELDS,
    ACTION_TYPES,
    AUTOCOMMIT_CLIENT_MEMBERS,
    ActionLedgerIntegrityError,
    ActionResourceIds,
    CREATED_ID_FIELDS,
    KEYED_ACTION_CREATED_ID_FIELDS,
    KEYED_ACTION_RESPONSE_STATUS,
    KeyedActionCreatedIds,
    KeyedActionType,
    TRANSACTION_CLIENT_MEMBERS,
    MealPlanningActionRecord,
    StoredResponseRecord,
    assertInteractiveTransactionClient,
    buildRequestFingerprint,
    canonicalizeRequestBody,
    classifyActionCompletion,
    decideReplay,
    diagnoseTransactionClient,
    findMissingCompletionFields,
    readStoredResponse,
    resolveCreatedIdColumns,
    shapeStoredResponse,
} from '../mealPlanningAction.logic';
// The whole module surface, for the one assertion that is about what this file
// does NOT export.
import * as ledgerLogic from '../mealPlanningAction.logic';
// TYPE-only, so ts-jest erases it and this suite still loads no Prisma client
// and touches no database. It buys the compile-time half of the
// transaction-client guard: the assertions that use it are type assertions,
// checked by `npm run typecheck:test` and by ts-jest's own diagnostics.
import type { MealPlanningTransactionClient } from '../mealPlanningAction.service';

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
        expect(ACTION_TYPES).toHaveLength(4);
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

    it('has no status for an action outside the set, which is the only gate the module offers', () => {
        // The status map is what an action type is validated against — there is
        // no separate validator — so an out-of-set name resolves to nothing
        // rather than to a plausible default that would let it be stored.
        const statusByName: Readonly<Record<string, number | undefined>> = KEYED_ACTION_RESPONSE_STATUS;

        expect(statusByName.toggleGrocery).toBeUndefined();
        expect(statusByName.savePreferences).toBeUndefined();
        expect(statusByName['']).toBeUndefined();
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
            // The three ways a client can re-serialise one number. Were they to
            // digest differently, a retry of the very same intent would be
            // answered 409 idempotency_conflict and the user would be stuck.
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

        it('collapses a value written with trailing precision onto the same token', () => {
            expect(canonicalizeRequestBody('1.50')).toBe(canonicalizeRequestBody(1.5));
            expect(canonicalizeRequestBody('2.00')).toBe(canonicalizeRequestBody(2));
            expect(canonicalizeRequestBody({ portionMultiplier: '1.50' })).toBe(
                canonicalizeRequestBody({ portionMultiplier: 1.5 }),
            );
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

    describe('text', () => {
        it('keeps a string that happens to hold JSON as text rather than re-parsing it', () => {
            // Re-parsing would sort the inner keys and canonicalise the inner
            // numbers, so two clients sending the same text would agree while a
            // client sending genuinely different text could be made to agree
            // too. The inner order below survives untouched.
            expect(canonicalizeRequestBody({ note: '{"b":1,"a":2}' })).toBe('{"note":"{\\"b\\":1,\\"a\\":2}"}');
        });

        it('is identical for text written as a JSON escape or as a literal', () => {
            // The two encodings of one character resolve to the same string at
            // parse time, so a client whose serialiser escapes non-ASCII still
            // replays rather than conflicting.
            const parsed = JSON.parse('{"name":"caf\\u00e9"}') as Record<string, unknown>;

            expect(canonicalizeRequestBody(parsed)).toBe(canonicalizeRequestBody({ name: 'caf\u00e9' }));
        });

        it('treats two Unicode normalisations of the same text as different requests', () => {
            // Pinned as observed, not as preferred: the module compares text as
            // parsed and applies no NFC/NFD normalisation, so a client that
            // changed normalisation between attempts would be answered
            // 409 idempotency_conflict. No keyed payload carries free text —
            // only uuids, ISO dates and numbers — so nothing reaches this path
            // today, and normalising inside the digest would be a change to the
            // module rather than to this suite.
            expect(canonicalizeRequestBody('caf\u00e9')).not.toBe(canonicalizeRequestBody('cafe\u0301'));
        });

        it('carries a character outside the basic plane through intact', () => {
            expect(canonicalizeRequestBody('a\u{1F600}')).toBe('"a\u{1F600}"');
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

    it('leaves the body it was given untouched, down to its key order', () => {
        // Sorting the caller's object in place would reorder the very request
        // the controller is about to hand to a service, so the sort has to
        // happen on a copy.
        const body = { b: 2, a: { d: 4, c: 3 }, list: [{ f: 6, e: 5 }] };

        canonicalizeRequestBody(body);

        expect(Object.keys(body)).toEqual(['b', 'a', 'list']);
        expect(Object.keys(body.a)).toEqual(['d', 'c']);
        expect(Object.keys(body.list[0])).toEqual(['f', 'e']);
        expect(body).toEqual({ b: 2, a: { d: 4, c: 3 }, list: [{ f: 6, e: 5 }] });
    });

    it('returns an already-canonical body unchanged', () => {
        expect(canonicalizeRequestBody({ a: 1, b: 2 })).toBe('{"a":1.00,"b":2.00}');
        expect(canonicalizeRequestBody({ a: 1, b: 2 })).toBe(canonicalizeRequestBody({ b: 2, a: 1 }));
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

    // Driven by the exported list rather than by four hand-written blocks, so a
    // fifth keyed action cannot be added without acquiring these assertions.
    describe.each(ACTION_TYPES)('the %s action', (action) => {
        const reorderedLogPayload = {
            idempotencyKey: logPayload.idempotencyKey,
            expectedPlanRevision: logPayload.expectedPlanRevision,
            diaryMealId: logPayload.diaryMealId,
            date: logPayload.date,
            servings: logPayload.servings,
        };

        it('fingerprints stably under key reordering', () => {
            expect(fingerprintOf(reorderedLogPayload, swapIds, action)).toBe(
                fingerprintOf(logPayload, swapIds, action),
            );
        });

        it('fingerprints distinctly from every sibling action carrying the same request', () => {
            const siblings = ACTION_TYPES.filter((other) => other !== action).map((other) =>
                fingerprintOf(logPayload, swapIds, other),
            );

            expect(siblings).toHaveLength(ACTION_TYPES.length - 1);
            expect(siblings).not.toContain(fingerprintOf(logPayload, swapIds, action));
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

    it('conflicts on a mismatch whether the row is still pending or already completed', () => {
        // The key is claimed either way, so the two states must agree: a
        // different request may never be admitted under a used key, and may
        // never be answered from a response it did not produce.
        const changed = fingerprintOf({ ...swapPayload, servings: 3 });
        const pending: StoredResponseRecord & { requestFingerprint: string } = {
            requestFingerprint: fingerprint,
            responseStatus: null,
            responseSnapshot: null,
            planRevisionAfter: null,
        };
        const completed: StoredResponseRecord & { requestFingerprint: string } = {
            requestFingerprint: fingerprint,
            responseStatus: 200,
            responseSnapshot: swapBody,
            planRevisionAfter: 5,
        };

        expect(decideReplay(pending, changed)).toBe('conflict');
        expect(decideReplay(completed, changed)).toBe('conflict');
    });

    it('conflicts when the same key was first used for a different action', () => {
        // The action type is part of the fingerprint and the key is unique per
        // user, so a log arriving under a swap's key is a different write
        // wearing a used key — never a retry of the swap.
        const asSwap = fingerprintOf(logPayload, swapIds, 'swap');
        const asLog = fingerprintOf(logPayload, swapIds, 'log');

        expect(decideReplay({ requestFingerprint: asSwap }, asLog)).toBe('conflict');
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

    it('still replays once the plan has moved far beyond the revision the action produced', () => {
        // The rule that keeps a committed action replayable: two rows that
        // differ only in the plan state they recorded reach the same verdict,
        // so a client whose response was lost learns its action succeeded
        // instead of being answered 409 stale_plan forever.
        const atRevisionOne: StoredResponseRecord & { requestFingerprint: string } = {
            requestFingerprint: fingerprint,
            responseStatus: 200,
            responseSnapshot: swapBody,
            planRevisionAfter: 1,
        };
        const atRevisionNinetyNine: StoredResponseRecord & { requestFingerprint: string } = {
            ...atRevisionOne,
            planRevisionAfter: 99,
        };

        expect(decideReplay(atRevisionOne, fingerprint)).toBe('replay');
        expect(decideReplay(atRevisionNinetyNine, fingerprint)).toBe('replay');
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
    it('stores 201 for a generate, which creates a plan', () => {
        expect(shapeStoredResponse('generate', mealPlanBody, 1).responseStatus).toBe(201);
    });

    it('stores 201 for a regenerate, which creates the plan that supersedes one', () => {
        expect(shapeStoredResponse('regenerate', mealPlanBody, 2).responseStatus).toBe(201);
    });

    it('stores 201 for a log, which creates a diary entry', () => {
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

    it('refuses a row missing only the status', () => {
        // Half-completed rows are corruption, not pending rows and not
        // replayable ones: §0.5.1 writes all three completion columns in the
        // one statement that completes a reservation, so no completion in this
        // ledger can produce this row. Answering a client from it would report
        // an outcome the ledger never recorded.
        expect(() =>
            readStoredResponse({ responseStatus: null, responseSnapshot: swapBody, planRevisionAfter: 5 }),
        ).toThrow(ActionLedgerIntegrityError);
        expect(() =>
            readStoredResponse({ responseStatus: null, responseSnapshot: swapBody, planRevisionAfter: 5 }),
        ).toThrow(/responseStatus is missing/);
    });

    it('refuses a row missing only the body', () => {
        expect(() =>
            readStoredResponse({ responseStatus: 200, responseSnapshot: null, planRevisionAfter: 5 }),
        ).toThrow(ActionLedgerIntegrityError);
        expect(() =>
            readStoredResponse({ responseStatus: 200, responseSnapshot: null, planRevisionAfter: 5 }),
        ).toThrow(/responseSnapshot is missing/);
    });

    it('refuses a row missing only the revision, rather than replaying it with a null revision', () => {
        // The case this rule exists for. A status and a body with no revision
        // reads like a successful action whose revision is merely unknown, and
        // the earlier reading returned exactly that — `planRevisionAfter: null`
        // — telling the client its write had succeeded while withholding the
        // revision every keyed response is required to carry.
        expect(() =>
            readStoredResponse({ responseStatus: 200, responseSnapshot: swapBody, planRevisionAfter: null }),
        ).toThrow(ActionLedgerIntegrityError);
        expect(() =>
            readStoredResponse({ responseStatus: 200, responseSnapshot: swapBody, planRevisionAfter: null }),
        ).toThrow(/planRevisionAfter is missing/);
    });

    it('refuses a row missing two of the three completion columns', () => {
        expect(() =>
            readStoredResponse({ responseStatus: null, responseSnapshot: null, planRevisionAfter: 5 }),
        ).toThrow(/responseStatus, responseSnapshot are missing/);
    });

    it('names the row in an integrity failure, and carries the missing columns as data', () => {
        // An operator has to find the row; a caller should not have to parse
        // the message to know what was wrong with it.
        let raised: ActionLedgerIntegrityError | null = null;

        try {
            readStoredResponse({
                id: 'ee6d8a5e-2f2c-4a6e-8d1b-1f9c0a7b3d42',
                responseStatus: 201,
                responseSnapshot: logBody,
                planRevisionAfter: null,
            });
        } catch (error) {
            raised = error as ActionLedgerIntegrityError;
        }

        expect(raised).toBeInstanceOf(ActionLedgerIntegrityError);
        expect(raised?.name).toBe('ActionLedgerIntegrityError');
        expect(raised?.missingFields).toEqual(['planRevisionAfter']);
        expect(raised?.actionId).toBe('ee6d8a5e-2f2c-4a6e-8d1b-1f9c0a7b3d42');
        expect(raised?.message).toContain('ee6d8a5e-2f2c-4a6e-8d1b-1f9c0a7b3d42');
    });

    it('reports an unidentified half-completed row without pretending to know its id', () => {
        let raised: ActionLedgerIntegrityError | null = null;

        try {
            readStoredResponse({ responseStatus: 201, responseSnapshot: logBody, planRevisionAfter: null });
        } catch (error) {
            raised = error as ActionLedgerIntegrityError;
        }

        expect(raised?.actionId).toBeNull();
        expect(raised?.message).toContain('(id unknown)');
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
        // The stored body itself, not a copy of it, which is what makes a
        // replay indistinguishable from the original response.
        expect(readStoredResponse(stored)?.body).toBe(logBody);
    });

    it('round-trips a nested plan snapshot without reordering a key or drifting a number', () => {
        const nested = {
            id: 'plan-1',
            revision: 2,
            days: [
                {
                    date: '2026-07-05',
                    plannedTotals: { calories: 1905.5, protein: 142.25, carbs: 188.75, fat: 61.5 },
                    meals: [{ slot: 'lunch', portionMultiplier: 1.25, planned: { calories: 610.4 } }],
                },
            ],
        } as unknown as MealPlanResponse;

        const replayed = readStoredResponse(shapeStoredResponse('generate', nested, 3));

        // Serialised, not only compared structurally: `toEqual` would accept a
        // reordered copy, and the two-decimal rounding the fingerprint applies
        // to a REQUEST must never reach a stored response.
        expect(JSON.stringify(replayed?.body)).toBe(JSON.stringify(nested));
        expect(replayed?.planRevisionAfter).toBe(3);
    });

    it('replays a generate row, which records a plan id and no diary entry', () => {
        const generateRow: MealPlanningActionRecord = {
            id: 'action-1',
            userId: 'user-1',
            idempotencyKey: swapPayload.idempotencyKey,
            actionType: 'generate',
            requestFingerprint: 'a'.repeat(64),
            mealPlanId: 'plan-1',
            mealPlanMealId: null,
            mealEntryId: null,
            responseStatus: 201,
            responseSnapshot: mealPlanBody,
            planRevisionAfter: 1,
            createdAt: new Date('2026-07-05T12:00:00.000Z'),
        };

        expect(readStoredResponse(generateRow)).toEqual({ status: 201, body: mealPlanBody, planRevisionAfter: 1 });
    });

    it('replays a log row whose three links are all set, carrying none of them into the response', () => {
        // The links stay on the row, where the tenant guards use them; what
        // goes back on the wire is the first response and nothing more.
        const logRow: MealPlanningActionRecord = {
            id: 'action-2',
            userId: 'user-1',
            idempotencyKey: swapPayload.idempotencyKey,
            actionType: 'log',
            requestFingerprint: 'b'.repeat(64),
            mealPlanId: 'plan-1',
            mealPlanMealId: 'meal-1',
            mealEntryId: 'entry-1',
            responseStatus: 201,
            responseSnapshot: logBody,
            planRevisionAfter: 6,
            createdAt: new Date('2026-07-05T12:00:00.000Z'),
        };

        expect(readStoredResponse(logRow)).toEqual({ status: 201, body: logBody, planRevisionAfter: 6 });
    });

    it('replays a years-old row, because a committed action never expires', () => {
        // §0.5.1 retains ledger rows indefinitely, so age is not an input to
        // any rule here: a client whose response was lost long ago still learns
        // that its action succeeded. The row is dated 2019 and carries the same
        // response as a fresh one.
        const ancientRow: MealPlanningActionRecord = {
            id: 'c2a8e0d4-5b6f-4c7a-9e8d-0f1a2b3c4d5e',
            userId: 'user-1',
            idempotencyKey: swapPayload.idempotencyKey,
            actionType: 'swap',
            requestFingerprint: 'c'.repeat(64),
            mealPlanId: 'plan-1',
            mealPlanMealId: 'meal-1',
            mealEntryId: null,
            responseStatus: 200,
            responseSnapshot: swapBody,
            planRevisionAfter: 7,
            createdAt: new Date('2019-01-01T00:00:00.000Z'),
        };

        expect(readStoredResponse(ancientRow)).toEqual({ status: 200, body: swapBody, planRevisionAfter: 7 });
    });

    it('replays a falsy but present body, which is still a stored response', () => {
        expect(readStoredResponse({ responseStatus: 200, responseSnapshot: 0, planRevisionAfter: 1 })?.body).toBe(0);
        expect(readStoredResponse({ responseStatus: 200, responseSnapshot: '', planRevisionAfter: 1 })?.body).toBe('');
    });
});

describe('the completion invariant', () => {
    it('names the three columns a completion fills, in one place', () => {
        // The service's compare-and-set predicate is the snake_case image of
        // this list, so a column added here without being added there would
        // leave the predicate matching a row it should have refused.
        expect(ACTION_COMPLETION_FIELDS).toEqual(['responseStatus', 'responseSnapshot', 'planRevisionAfter']);
    });

    it('reports a reserved row as pending', () => {
        const reserved: StoredResponseRecord = {
            responseStatus: null,
            responseSnapshot: null,
            planRevisionAfter: null,
        };

        expect(findMissingCompletionFields(reserved)).toEqual([
            'responseStatus',
            'responseSnapshot',
            'planRevisionAfter',
        ]);
        expect(classifyActionCompletion(reserved)).toBe('pending');
    });

    it('reports a completed row as completed', () => {
        const completed: StoredResponseRecord = {
            responseStatus: 200,
            responseSnapshot: swapBody,
            planRevisionAfter: 5,
        };

        expect(findMissingCompletionFields(completed)).toEqual([]);
        expect(classifyActionCompletion(completed)).toBe('completed');
    });

    it.each(ACTION_COMPLETION_FIELDS)('reports a row missing only %s as corrupt', (field) => {
        const row: Record<string, unknown> = {
            responseStatus: 201,
            responseSnapshot: logBody,
            planRevisionAfter: 6,
            [field]: null,
        };

        expect(findMissingCompletionFields(row as unknown as StoredResponseRecord)).toEqual([field]);
        expect(classifyActionCompletion(row as unknown as StoredResponseRecord)).toBe('corrupt');
    });

    it('counts an undefined column as unfilled, the way a raw row reads back', () => {
        const undefinedColumns = {
            responseStatus: 201,
            responseSnapshot: undefined,
            planRevisionAfter: 6,
        } as unknown as StoredResponseRecord;

        expect(classifyActionCompletion(undefinedColumns)).toBe('corrupt');
    });

    it('treats a falsy but present value as filled', () => {
        // A zero revision and an empty-string body are values; only null and
        // undefined mean "this column was never written".
        const zeroes: StoredResponseRecord = { responseStatus: 200, responseSnapshot: '', planRevisionAfter: 0 };

        expect(classifyActionCompletion(zeroes)).toBe('completed');
    });
});

describe('ledger row age', () => {
    it('is not a rule this module owns: nothing here can expire a row', () => {
        // AAP §0.5.1 retains meal_plan_actions rows indefinitely — they are
        // small, user-scoped and cascade on user deletion — so a committed
        // action stays replayable however old it is. The seven-day window is
        // §0.7.2's guard on the CLIENT's persisted pendingIntents and belongs
        // to the mobile store alone. A backend helper for it, even an unused
        // one, is an invitation to make a replay conditional on age, so the
        // absence is asserted rather than assumed.
        const ageSurface = Object.keys(ledgerLogic).filter((name) => /expir|max_?age|ttl|prune/i.test(name));

        expect(ageSurface).toEqual([]);
    });

    it('reads a stored response from the row alone, with no clock to pass it', () => {
        // One parameter: there is nowhere to put a "now", so no future caller
        // can make a replay depend on when the action happened.
        expect(readStoredResponse).toHaveLength(1);
        expect(classifyActionCompletion).toHaveLength(1);
    });
});

describe('resolveCreatedIdColumns', () => {
    const PLAN_ID = '11111111-1111-4111-8111-111111111111';
    const MEAL_ID = '22222222-2222-4222-8222-222222222222';
    const ENTRY_ID = '33333333-3333-4333-8333-333333333333';

    const idsFor = (action: KeyedActionType): Record<string, string> => {
        const required: readonly string[] = KEYED_ACTION_CREATED_ID_FIELDS[action];
        const all: Record<string, string> = {
            mealPlanId: PLAN_ID,
            mealPlanMealId: MEAL_ID,
            mealEntryId: ENTRY_ID,
        };

        return Object.fromEntries(required.map((field) => [field, all[field]]));
    };

    it('covers every keyed action, using only the three id columns', () => {
        expect(Object.keys(KEYED_ACTION_CREATED_ID_FIELDS).sort()).toEqual([...ACTION_TYPES].sort());
        expect(CREATED_ID_FIELDS).toEqual(['mealPlanId', 'mealPlanMealId', 'mealEntryId']);

        Object.values(KEYED_ACTION_CREATED_ID_FIELDS).forEach((fields) => {
            expect(fields.length).toBeGreaterThan(0);
            (fields as readonly string[]).forEach((field) => {
                expect(CREATED_ID_FIELDS as readonly string[]).toContain(field);
            });
        });
    });

    it('records a generate as the plan it published, and nothing else', () => {
        expect(resolveCreatedIdColumns('generate', { mealPlanId: PLAN_ID })).toEqual({
            mealPlanId: PLAN_ID,
            mealPlanMealId: null,
            mealEntryId: null,
        });
    });

    it('records a regenerate as the plan that superseded the old one', () => {
        expect(resolveCreatedIdColumns('regenerate', { mealPlanId: PLAN_ID })).toEqual({
            mealPlanId: PLAN_ID,
            mealPlanMealId: null,
            mealEntryId: null,
        });
    });

    it('records a swap as the plan and the planned meal it replaced', () => {
        expect(resolveCreatedIdColumns('swap', { mealPlanId: PLAN_ID, mealPlanMealId: MEAL_ID })).toEqual({
            mealPlanId: PLAN_ID,
            mealPlanMealId: MEAL_ID,
            mealEntryId: null,
        });
    });

    it('records a log as the plan, the meal and the diary entry it created', () => {
        expect(
            resolveCreatedIdColumns('log', { mealPlanId: PLAN_ID, mealPlanMealId: MEAL_ID, mealEntryId: ENTRY_ID }),
        ).toEqual({ mealPlanId: PLAN_ID, mealPlanMealId: MEAL_ID, mealEntryId: ENTRY_ID });
    });

    it.each(ACTION_TYPES)('fills exactly the columns %s records, and nulls the rest', (action) => {
        const required: readonly string[] = KEYED_ACTION_CREATED_ID_FIELDS[action];
        const columns = resolveCreatedIdColumns(action, idsFor(action));

        CREATED_ID_FIELDS.forEach((field) => {
            if (required.includes(field)) {
                expect(columns[field]).toEqual(expect.any(String));
            } else {
                // Explicitly null rather than absent: a completed row never
                // inherits an id this ledger did not choose.
                expect(columns[field]).toBeNull();
            }
        });
    });

    it.each(ACTION_TYPES)('refuses a %s completion that omits an id it records', (action) => {
        const required: readonly string[] = KEYED_ACTION_CREATED_ID_FIELDS[action];

        required.forEach((omitted) => {
            const ids = idsFor(action);

            delete ids[omitted];

            expect(() => resolveCreatedIdColumns(action, ids)).toThrow(
                new RegExp(`${omitted} is absent, but a ${action} records`),
            );
        });
    });

    it('refuses an id that is explicitly null where the action requires one', () => {
        expect(() => resolveCreatedIdColumns('swap', { mealPlanId: PLAN_ID, mealPlanMealId: null })).toThrow(
            /mealPlanMealId is null/,
        );
    });

    it('refuses an id that is not a row id', () => {
        // The columns are uuid, filled from gen_random_uuid(); anything else
        // cannot be a row this ledger may reference, and failing here says so
        // instead of letting Postgres reject the cast mid-transaction.
        expect(() => resolveCreatedIdColumns('generate', { mealPlanId: 'plan-1' })).toThrow(/mealPlanId is "plan-1"/);
        expect(() => resolveCreatedIdColumns('generate', { mealPlanId: 42 })).toThrow(/mealPlanId is 42/);
        expect(() =>
            resolveCreatedIdColumns('generate', { mealPlanId: `${PLAN_ID} ` }),
        ).toThrow(/is not a row id|records mealPlanId/);
    });

    it.each([
        ['generate', { mealPlanId: PLAN_ID, mealPlanMealId: MEAL_ID }, 'mealPlanMealId'],
        ['generate', { mealPlanId: PLAN_ID, mealEntryId: ENTRY_ID }, 'mealEntryId'],
        ['regenerate', { mealPlanId: PLAN_ID, mealEntryId: ENTRY_ID }, 'mealEntryId'],
        ['swap', { mealPlanId: PLAN_ID, mealPlanMealId: MEAL_ID, mealEntryId: ENTRY_ID }, 'mealEntryId'],
    ] as const)('refuses a %s completion carrying %s, which it never creates', (action, ids, stray) => {
        // Not a harmless extra column: the schema pairs each id with user_id in
        // a tenant guard, so a stray id is a claim about a row this action
        // never touched.
        expect(() => resolveCreatedIdColumns(action, ids)).toThrow(new RegExp(`carries ${stray}`));
        expect(() => resolveCreatedIdColumns(action, ids)).toThrow(new RegExp(`which a ${action} does not create`));
    });

    it('tolerates an irrelevant id given as null or absent', () => {
        expect(
            resolveCreatedIdColumns('generate', { mealPlanId: PLAN_ID, mealPlanMealId: null, mealEntryId: undefined }),
        ).toEqual({ mealPlanId: PLAN_ID, mealPlanMealId: null, mealEntryId: null });
    });

    it('refuses a completion that is not an object at all', () => {
        expect(() => resolveCreatedIdColumns('generate', undefined)).toThrow(/the completion is absent/);
        expect(() => resolveCreatedIdColumns('generate', null)).toThrow(/the completion is null/);
        expect(() => resolveCreatedIdColumns('generate', PLAN_ID)).toThrow(/not an object carrying mealPlanId/);
    });

    it('refuses an action type outside the closed set, rather than recording no ids', () => {
        expect(() => resolveCreatedIdColumns('toggle' as KeyedActionType, { mealPlanId: PLAN_ID })).toThrow(
            /"toggle" is not one of generate, regenerate, swap, log/,
        );
    });

    it('ties each action to its own ids at compile time', () => {
        // @ts-expect-error -- a generate records a plan and nothing else
        const strayEntry: KeyedActionCreatedIds<'generate'> = { mealPlanId: PLAN_ID, mealEntryId: ENTRY_ID };
        // @ts-expect-error -- a log records all three ids
        const incompleteLog: KeyedActionCreatedIds<'log'> = { mealPlanId: PLAN_ID };
        // @ts-expect-error -- an id may not be null in the typed contract
        const nullableId: KeyedActionCreatedIds<'generate'> = { mealPlanId: null };
        const swapIdsTyped: KeyedActionCreatedIds<'swap'> = { mealPlanId: PLAN_ID, mealPlanMealId: MEAL_ID };

        expect(strayEntry.mealPlanId).toBe(PLAN_ID);
        expect(incompleteLog.mealPlanId).toBe(PLAN_ID);
        expect(nullableId).toEqual({ mealPlanId: null });
        expect(swapIdsTyped.mealPlanMealId).toBe(MEAL_ID);
    });
});

describe('the transaction-client shape rule', () => {
    const noop = (): void => undefined;

    /** What `prisma.$transaction(…)` hands its callback: no deny-list member. */
    const openTransaction = { $queryRaw: noop, $executeRaw: noop };

    /** What the global client exposes, verified against a real Prisma client. */
    const globalClient = {
        $queryRaw: noop,
        $executeRaw: noop,
        $connect: noop,
        $disconnect: noop,
        $on: noop,
        $transaction: noop,
        $use: noop,
        $extends: noop,
    };

    it('lists Prisma\'s own deny list, and the members the ledger issues statements through', () => {
        expect(AUTOCOMMIT_CLIENT_MEMBERS).toEqual([
            '$connect',
            '$disconnect',
            '$on',
            '$transaction',
            '$use',
            '$extends',
        ]);
        expect(TRANSACTION_CLIENT_MEMBERS).toEqual(['$queryRaw', '$executeRaw']);
    });

    it('accepts an open interactive transaction', () => {
        expect(diagnoseTransactionClient(openTransaction)).toEqual({
            verdict: 'interactive',
            autocommitMembers: [],
            missingMembers: [],
        });
        expect(() => assertInteractiveTransactionClient(openTransaction, 'withUserLock')).not.toThrow();
    });

    it('refuses the global client, naming every member that gave it away', () => {
        // The bug this closes: the global client satisfies
        // Prisma.TransactionClient structurally, so it used to be accepted —
        // and then pg_advisory_xact_lock is released as its own statement
        // returns, the reservation commits alone, and a failure leaves a
        // permanently pending row.
        expect(diagnoseTransactionClient(globalClient)).toEqual({
            verdict: 'autocommit',
            autocommitMembers: ['$connect', '$disconnect', '$on', '$transaction', '$use', '$extends'],
            missingMembers: [],
        });
    });

    it.each(AUTOCOMMIT_CLIENT_MEMBERS)('refuses a client exposing %s on its own', (member) => {
        const candidate: Record<string, unknown> = { ...openTransaction, [member]: noop };

        expect(diagnoseTransactionClient(candidate)).toEqual({
            verdict: 'autocommit',
            autocommitMembers: [member],
            missingMembers: [],
        });
    });

    it('refuses a value that is not a Prisma client, naming what it lacks', () => {
        expect(diagnoseTransactionClient({ $queryRaw: noop })).toEqual({
            verdict: 'unusable',
            autocommitMembers: [],
            missingMembers: ['$executeRaw'],
        });
        expect(diagnoseTransactionClient({})).toEqual({
            verdict: 'unusable',
            autocommitMembers: [],
            missingMembers: ['$queryRaw', '$executeRaw'],
        });
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a string', 'prisma'],
        ['a number', 42],
    ])('refuses %s without reading a property off it', (_label, candidate) => {
        expect(diagnoseTransactionClient(candidate).verdict).toBe('unusable');
    });

    it('judges a callable client by the members it exposes', () => {
        // A Prisma client may be a callable proxy; the rule is about shape, not
        // about whether the value happens to be a plain object.
        const callable = Object.assign(() => undefined, openTransaction);

        expect(diagnoseTransactionClient(callable).verdict).toBe('interactive');
    });

    it('ignores a non-callable member of the same name', () => {
        expect(diagnoseTransactionClient({ ...openTransaction, $transaction: 'not a function' }).verdict).toBe(
            'interactive',
        );
        expect(diagnoseTransactionClient({ $queryRaw: noop, $executeRaw: 'not a function' }).verdict).toBe('unusable');
    });

    it('reports the misuse with the entry point to fix and the way to fix it', () => {
        expect(() => assertInteractiveTransactionClient(globalClient, 'runKeyedAction')).toThrow(TypeError);
        expect(() => assertInteractiveTransactionClient(globalClient, 'runKeyedAction')).toThrow(/runKeyedAction/);
        expect(() => assertInteractiveTransactionClient(globalClient, 'runKeyedAction')).toThrow(
            /\$transaction/,
        );
        expect(() => assertInteractiveTransactionClient(globalClient, 'runKeyedAction')).toThrow(
            /withMealPlanningTransaction/,
        );
        expect(() => assertInteractiveTransactionClient({}, 'completeAction')).toThrow(
            /completeAction was given a value that is not a Prisma client/,
        );
    });

    it('refuses the global client at compile time too', () => {
        // The runtime guard above catches a cast or a JavaScript caller; this
        // is the half that stops `runKeyedAction(prisma, …)` ever being
        // written. If the type stopped refusing the global client, the unused
        // directive below would itself become an error and this suite would
        // fail to compile.
        const autocommitClient = {} as unknown as PrismaClient;
        // @ts-expect-error -- the global client is not an open interactive transaction
        const misused: MealPlanningTransactionClient = autocommitClient;
        // A genuine transaction client still satisfies the type with no cast,
        // so every existing call shape keeps compiling.
        const interactiveClient = {} as unknown as Prisma.TransactionClient;
        const accepted: MealPlanningTransactionClient = interactiveClient;

        expect(misused).toBe(autocommitClient);
        expect(accepted).toBe(interactiveClient);
    });
});
