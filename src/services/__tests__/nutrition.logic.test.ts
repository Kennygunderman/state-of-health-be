/**
 * `parseLogEntryBody` is the branch point of
 * `POST /api/macros/meal/:mealId/entries` (Agent Action Plan §0.3.1): one
 * endpoint, two mutually exclusive body shapes, and a 400 verdict for
 * everything else.
 *
 * What this suite pins, and why each one is a decision someone could break:
 *
 *  - **The shape decision is never resolved by preference.** A body naming both
 *    a personal food and a catalog food is refused with `invalid_payload`.
 *    Preferring either one would log client-supplied macros against a catalog
 *    food — unverified numbers presented as source-backed nutrition — or push a
 *    catalog snapshot through the legacy `food_id` dedupe path.
 *  - **`servings` and `servingText` are not shape signals.** Both shapes carry
 *    them, so a body carrying only those two selects nothing and is refused.
 *  - **The legacy guard is the shipped one, verbatim.** §0.3.1 requires the
 *    legacy branch to keep `isValidMacroPayload`'s behaviour
 *    (`Number.isFinite(Number(value))`, `src/controllers/nutrition.controller.ts`)
 *    byte for byte, which means its coercions are part of the contract live
 *    clients depend on: a numeric-string macro is accepted and must reach the
 *    service unrounded. Tightening or loosening that is a wire-contract change,
 *    so the coercion cases below are asserted rather than left to drift.
 *  - **The catalog contract does not leak into the legacy branch, and vice
 *    versa.** The `[0.25, 10]` servings bound and the v4-UUID check apply to a
 *    catalog body only; `nutrition.service.ts` owns the legacy defaults.
 *  - **The specific `details[].code`, not merely that the verdict failed.** The
 *    codes are the wire vocabulary the client maps to copy, so every failing
 *    case asserts the field/code pairs it produced.
 *  - **Which of the three 400s each failure earns.** The legacy guard's verdict
 *    is answered with a frozen message-only body kept for shipped clients; a
 *    catalog field failure and a shapeless body are answered with a machine code
 *    and per-field details. One code for two of those is how the catalog shape
 *    came to lose its `invalid_request` code and details, so the three verdicts
 *    are asserted as distinct here rather than left to the controller's reading.
 *  - **A stored string PostgreSQL cannot hold.** A body whose `name`,
 *    `servingText` or `rawInput` carries U+0000 is refused with
 *    `invalid_request` and `invalid_characters` on the field that carries it.
 *    Unchecked it reaches the writer and returns as this endpoint's 500 for a
 *    request only the caller can fix. The suite pins where the check sits — after
 *    the legacy guard, so a body the guard already refuses keeps its frozen
 *    response and this verdict can only ever replace a 500 — and how narrow it
 *    is: every other control character still reaches the column and stores.
 *  - **Totality.** Every input — `null`, `undefined`, a primitive, an array, an
 *    object whose keys only look like properties — returns a verdict and never
 *    throws.
 *
 * `resolveLegacyInputMethod` is the module's second export and is tested in its
 * own suite below. It is here rather than in the writer that uses it for the
 * reason `backend-architecture` §11 gives: inside `logMealEntry`'s `create`
 * call the rule needs a database to test, and the rule — that a body may never
 * ask for a method the server writes on its own authority — is worth pinning,
 * because the app reads that one field as the diary's "From meal plan" origin.
 *
 * The suites after it cover the rest of this endpoint's decisions, each of them
 * here for the same reason — written beside a Prisma call they needed a database
 * and a seeded catalog to exercise, so their branches went untested:
 *
 *  - **`parseMealEntryPath` / `parseEntryPath`.** Both routes address a row by a
 *    `@db.Uuid` key, so an unparsable id is a PostgreSQL syntax error, and
 *    handing one to the writer answers a fixable request with a 500. The
 *    verdicts pin `400 invalid_request` with `invalid_id` on the field the
 *    caller must fix, and that a well-formed id is still left to the 404 that
 *    keeps "missing" and "not yours" indistinguishable.
 *  - **The stored-provenance vocabulary.** `toNutritionProvenance` reads an
 *    unrestricted TEXT column, and what it does with a value it does not know —
 *    report `null`, the unlabelled class — is safe for HISTORY and destructive
 *    for a NEW entry, which is why the catalog snapshot narrows before writing.
 *    The suite pins both halves, including that every class a catalog food may
 *    carry survives the read path, so a narrowed value can never come back
 *    unlabelled.
 *  - **`resolveCatalogEntrySnapshot`.** Which portion the entry is logged
 *    against, how that portion's macros are scaled from the food's basis, that
 *    they are rounded exactly once, and which provenance class they belong to.
 *    Every refusal is a published row that cannot produce a truthful snapshot,
 *    and each one fails closed: nothing is written rather than an invented gram
 *    weight, a NULL nutrient read as zero, or a provenance the diary cannot
 *    label.
 *  - **`containsNulCharacter` / `parseMealEntryEditBody`.** The stored-text rule
 *    as its own predicate, and the one body check on
 *    `PUT /api/macros/entry/:id`. That route has never validated its body and
 *    must go on accepting everything it accepts today, so the edit parser's
 *    suite is mostly the inputs it must still hand through untouched — the
 *    non-object body included, which reaches the writer exactly as it always
 *    has.
 *  - **`planMealEntryEdit`.** Whether an edit detaches the entry from the plan
 *    meal, recipe version or catalog food that vouches for its numbers.
 *    Detachment turns on an effective value change and never on field presence,
 *    so the suite's centre of gravity is the cases that must NOT detach: a
 *    servings edit, a whole-entry resubmission, a padded name, a macro that
 *    rounds to what is already stored.
 */

import { CATALOG_NUTRITION_PROVENANCES } from '../catalog.logic';
import {
    CLIENT_INPUT_METHODS,
    CLIENT_SNAPSHOT_PROVENANCE,
    CatalogEntryFood,
    CatalogSnapshotError,
    DEFAULT_INPUT_METHOD,
    DETACHED_ENTRY_SNAPSHOT,
    ENTRY_INPUT_METHODS,
    ENTRY_NUTRITION_PROVENANCES,
    InvalidServingError,
    PLANNED_INPUT_METHOD,
    PLANNED_SNAPSHOT_PROVENANCE,
    ParsedEntryPath,
    ParsedLogEntryBody,
    ParsedMealEntryEdit,
    ParsedMealEntryPath,
    StoredMealEntrySnapshot,
    containsNulCharacter,
    isEntryNutritionProvenance,
    parseEntryPath,
    parseLogEntryBody,
    parseMealEntryEditBody,
    parseMealEntryPath,
    planMealEntryEdit,
    resolveCatalogEntrySnapshot,
    resolveLegacyInputMethod,
    toNutritionProvenance,
} from '../nutrition.logic';

/** A syntactically valid v4 UUID: version nibble `4`, variant nibble `9`. */
const CATALOG_FOOD_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** The shipped 400 texts. Asserted literally — they are part of the wire contract. */
const LEGACY_REQUIRED_MESSAGE = 'name, calories, protein, carbs, and fat are required';
const CONFLICTING_REFERENCE_MESSAGE = 'foodId and catalogFoodId cannot both be provided';
const UNRECOGNIZED_MESSAGE = 'either catalogFoodId or name, calories, protein, carbs, and fat are required';
const SERVINGS_MESSAGE = 'servings must be a number between 0.25 and 10 with at most 2 decimal places';

/**
 * U+0000, written as an escape so it survives every editor and diff that would
 * otherwise swallow or normalise a literal NUL byte in this file.
 */
const NUL = '\u0000';

const validLegacyBody = (): Record<string, unknown> => ({
    name: 'Scrambled eggs',
    calories: 220,
    protein: 14,
    carbs: 2,
    fat: 16,
});

type ErrorVerdict = Extract<ParsedLogEntryBody, { kind: 'error' }>;
type LegacyVerdict = Extract<ParsedLogEntryBody, { kind: 'legacy' }>;
type CatalogVerdict = Extract<ParsedLogEntryBody, { kind: 'catalog' }>;

// The narrowing helpers throw with the discriminant they actually received, so
// a routing regression reads as "expected error, received catalog" rather than
// as a property access on the wrong variant.
const asError = (verdict: ParsedLogEntryBody): ErrorVerdict => {
    if (verdict.kind !== 'error') {
        throw new Error(`expected an error verdict, received "${verdict.kind}"`);
    }
    return verdict;
};

const asLegacy = (verdict: ParsedLogEntryBody): LegacyVerdict => {
    if (verdict.kind !== 'legacy') {
        throw new Error(`expected a legacy verdict, received "${verdict.kind}"`);
    }
    return verdict;
};

const asCatalog = (verdict: ParsedLogEntryBody): CatalogVerdict => {
    if (verdict.kind !== 'catalog') {
        throw new Error(`expected a catalog verdict, received "${verdict.kind}"`);
    }
    return verdict;
};

/** `field:code` pairs in the order the parser reported them. */
const fieldCodes = (verdict: ParsedLogEntryBody): string[] =>
    asError(verdict).details.map((detail) => `${detail.field}:${detail.code}`);

type EditOkVerdict = Extract<ParsedMealEntryEdit, { kind: 'ok' }>;

const asEditError = (verdict: ParsedMealEntryEdit): ErrorVerdict => {
    if (verdict.kind !== 'error') {
        throw new Error(`expected an error verdict, received "${verdict.kind}"`);
    }
    return verdict;
};

const asEditOk = (verdict: ParsedMealEntryEdit): EditOkVerdict => {
    if (verdict.kind !== 'ok') {
        throw new Error(`expected an ok verdict, received "${verdict.kind}"`);
    }
    return verdict;
};

const editFieldCodes = (verdict: ParsedMealEntryEdit): string[] =>
    asEditError(verdict).details.map((detail) => `${detail.field}:${detail.code}`);

describe('parseLogEntryBody', () => {
    describe('a body that is not an object', () => {
        it.each([
            ['null', null],
            ['undefined', undefined],
            ['a string', '{"name":"eggs"}'],
            ['a number', 220],
            ['a boolean', true],
            ['an empty array', []],
            ['an array carrying a legacy-looking element', [{ name: 'eggs', calories: 1, protein: 1, carbs: 1, fat: 1 }]],
        ])('refuses %s as an unrecognized payload rather than throwing', (_case, body) => {
            const verdict = parseLogEntryBody(body);

            expect(verdict.kind).toBe('error');
            expect(asError(verdict).code).toBe('invalid_payload');
            expect(asError(verdict).message).toBe(UNRECOGNIZED_MESSAGE);
            expect(asError(verdict).details).toStrictEqual([{ field: 'body', code: 'unrecognized_payload' }]);
        });

        it('refuses an array even though an array is technically an object', () => {
            // Array.isArray is the check that matters: `body[0]` would otherwise be
            // read as a property and an array of one legacy entry would route.
            expect(fieldCodes(parseLogEntryBody([1, 2, 3]))).toStrictEqual(['body:unrecognized_payload']);
        });
    });

    describe('a body that names neither shape', () => {
        it('refuses an empty object', () => {
            const verdict = parseLogEntryBody({});

            expect(asError(verdict).code).toBe('invalid_payload');
            expect(fieldCodes(verdict)).toStrictEqual(['body:unrecognized_payload']);
        });

        it('refuses a body carrying only the fields both shapes share', () => {
            // servings and servingText belong to both shapes, so neither may act as
            // a shape signal — a body carrying only them selects nothing.
            const verdict = parseLogEntryBody({ servings: 2, servingText: '1 cup' });

            expect(asError(verdict).code).toBe('invalid_payload');
            expect(fieldCodes(verdict)).toStrictEqual(['body:unrecognized_payload']);
        });

        it('refuses a body whose only keys are named after prototype members', () => {
            const verdict = parseLogEntryBody({ constructor: 'x', toString: 'y', hasOwnProperty: 'z', valueOf: 1 });

            expect(fieldCodes(verdict)).toStrictEqual(['body:unrecognized_payload']);
        });

        it('does not let a JSON "__proto__" member supply the legacy fields', () => {
            // The express body is a JSON.parse result, which defines "__proto__" as
            // an own data property rather than walking the prototype setter. This
            // pins that: a parser swapped for a merge-based one would start reading
            // `name` off the prototype and route this body as a legacy entry.
            const polluted: unknown = JSON.parse(
                '{"__proto__": {"name": "eggs", "calories": 1, "protein": 1, "carbs": 1, "fat": 1}}',
            );

            expect(fieldCodes(parseLogEntryBody(polluted))).toStrictEqual(['body:unrecognized_payload']);
        });

        it('treats a present-but-null food reference as absent', () => {
            // JSON null is "no value", not "a value that fails validation": a body
            // whose only reference is null names no shape at all.
            expect(fieldCodes(parseLogEntryBody({ catalogFoodId: null, servings: 1 }))).toStrictEqual([
                'body:unrecognized_payload',
            ]);
        });
    });

    describe('a body naming both a personal and a catalog food', () => {
        it('refuses it with invalid_payload and blames both fields', () => {
            const verdict = parseLogEntryBody({
                ...validLegacyBody(),
                foodId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                catalogFoodId: CATALOG_FOOD_ID,
                servings: 1,
            });

            expect(asError(verdict).code).toBe('invalid_payload');
            expect(asError(verdict).message).toBe(CONFLICTING_REFERENCE_MESSAGE);
            expect(asError(verdict).details).toStrictEqual([
                { field: 'foodId', code: 'conflicting_food_reference' },
                { field: 'catalogFoodId', code: 'conflicting_food_reference' },
            ]);
        });

        it('refuses the conflict on presence alone, without first validating either id', () => {
            // Validating first and reporting invalid_id would tell the client to fix
            // the catalog id, when the actual defect is that the body names two foods.
            const verdict = parseLogEntryBody({ foodId: 'legacy-food', catalogFoodId: 'not-a-uuid' });

            expect(asError(verdict).code).toBe('invalid_payload');
            expect(fieldCodes(verdict)).toStrictEqual([
                'foodId:conflicting_food_reference',
                'catalogFoodId:conflicting_food_reference',
            ]);
        });

        it('is not triggered by a null foodId alongside a catalog id', () => {
            const verdict = parseLogEntryBody({ foodId: null, catalogFoodId: CATALOG_FOOD_ID, servings: 2 });

            expect(asCatalog(verdict).payload).toStrictEqual({
                catalogFoodId: CATALOG_FOOD_ID,
                servings: 2,
                inputMethod: 'search',
            });
        });

        it('routes to the legacy shape when the catalog id is null', () => {
            const verdict = parseLogEntryBody({ ...validLegacyBody(), foodId: 'legacy-food', catalogFoodId: null });

            expect(asLegacy(verdict).kind).toBe('legacy');
        });
    });

    describe('the legacy shape', () => {
        it('accepts a minimal legacy body and hands the body on unchanged', () => {
            const body = validLegacyBody();
            const verdict = parseLogEntryBody(body);

            expect(verdict.kind).toBe('legacy');
            // Identity, not equality: nutrition.service.ts reads foodId, servings,
            // servingText, inputMethod and rawInput off this object itself and
            // applies its own defaults, and a numeric-string macro must reach
            // Math.round untouched. A parser that rebuilt the payload would silently
            // drop whichever field it forgot.
            expect(asLegacy(verdict).payload).toBe(body);
        });

        it('accepts a full legacy body with every optional field set', () => {
            const body = {
                ...validLegacyBody(),
                foodId: 'personal-food-1',
                servings: 1.5,
                servingText: '2 eggs',
                inputMethod: 'ai_text',
                rawInput: 'two scrambled eggs',
            };

            expect(asLegacy(parseLogEntryBody(body)).payload).toBe(body);
        });

        it.each([
            [
                'foodId',
                { foodId: 'personal-food-1' },
                ['name:required', 'calories:required', 'protein:required', 'carbs:required', 'fat:required'],
            ],
            [
                'rawInput',
                { rawInput: '2 eggs' },
                ['name:required', 'calories:required', 'protein:required', 'carbs:required', 'fat:required'],
            ],
            ['name', { name: 'eggs' }, ['calories:required', 'protein:required', 'carbs:required', 'fat:required']],
            ['calories', { calories: 220 }, ['name:required', 'protein:required', 'carbs:required', 'fat:required']],
            ['protein', { protein: 14 }, ['name:required', 'calories:required', 'carbs:required', 'fat:required']],
            ['carbs', { carbs: 2 }, ['name:required', 'calories:required', 'protein:required', 'fat:required']],
            ['fat', { fat: 16 }, ['name:required', 'calories:required', 'protein:required', 'carbs:required']],
        ])('treats %s as a legacy shape signal and then reports the fields still missing', (_field, partial, expected) => {
            // Every one of these selects the legacy branch, which is what makes the
            // verdict legacy_fields_required (a legacy body with holes) rather than
            // invalid_payload (no shape at all) — the client is told which fields to
            // add, not that its request made no sense.
            const verdict = parseLogEntryBody(partial);

            expect(asError(verdict).code).toBe('legacy_fields_required');
            expect(asError(verdict).message).toBe(LEGACY_REQUIRED_MESSAGE);
            expect(fieldCodes(verdict)).toStrictEqual(expected);
        });

        it.each(['name', 'calories', 'protein', 'carbs', 'fat'])(
            'reports only %s when only %s is missing',
            (missingField) => {
                const body = validLegacyBody();
                delete body[missingField];

                expect(fieldCodes(parseLogEntryBody(body))).toStrictEqual([`${missingField}:required`]);
            },
        );

        it.each([
            ['a number', 42],
            ['null', null],
            ['an object', { first: 'eggs' }],
            ['an array', ['eggs']],
            ['an empty string', ''],
            ['whitespace only', '   \t  '],
        ])('refuses a name that is %s', (_case, name) => {
            const verdict = parseLogEntryBody({ ...validLegacyBody(), name });

            expect(asError(verdict).code).toBe('legacy_fields_required');
            expect(fieldCodes(verdict)).toStrictEqual(['name:required']);
        });

        it('accepts a padded name and hands it on untrimmed', () => {
            // The other side of the blank-name boundary: `trim()` decides
            // whether the name is empty, and that is all it does. The parser
            // must not normalise the value on the way through — the service
            // stores what the client sent, so trimming here would silently
            // rewrite the name that lands in the diary.
            const body = { ...validLegacyBody(), name: '  Scrambled eggs  ' };
            const verdict = parseLogEntryBody(body);

            expect(asLegacy(verdict).payload).toBe(body);
            expect(asLegacy(verdict).payload.name).toBe('  Scrambled eggs  ');
        });

        it.each([
            ['a non-numeric string', 'lots'],
            ['an object', {}],
            ['a two-element array', [1, 2]],
            ['NaN', Number.NaN],
            ['Infinity', Number.POSITIVE_INFINITY],
            ['-Infinity', Number.NEGATIVE_INFINITY],
        ])('refuses calories that are %s', (_case, calories) => {
            expect(fieldCodes(parseLogEntryBody({ ...validLegacyBody(), calories }))).toStrictEqual(['calories:required']);
        });

        it.each(['protein', 'carbs', 'fat'])('refuses a non-numeric %s in the same way as calories', (field) => {
            const verdict = parseLogEntryBody({ ...validLegacyBody(), [field]: 'some' });

            expect(fieldCodes(verdict)).toStrictEqual([`${field}:required`]);
        });

        it('reports every invalid field at once, in field order', () => {
            const verdict = parseLogEntryBody({ name: '  ', calories: 'a', protein: {}, carbs: [1, 2], fat: 'b' });

            expect(fieldCodes(verdict)).toStrictEqual([
                'name:required',
                'calories:required',
                'protein:required',
                'carbs:required',
                'fat:required',
            ]);
        });

        it('keeps the shipped numeric-string coercion, so a live client is not broken', () => {
            // §0.3.1: the legacy branch is the existing guard verbatim, and the
            // existing guard is Number.isFinite(Number(value)). Mobile clients have
            // always been able to send macros as strings, and the service rounds
            // them identically — tightening this to typeof === 'number' would reject
            // requests that are in flight today.
            const body = { name: 'eggs', calories: '220', protein: '14.5', carbs: '2', fat: '16' };

            expect(asLegacy(parseLogEntryBody(body)).payload).toBe(body);
        });

        it.each([
            ['null', null],
            ['an empty string', ''],
            ['an empty array', []],
            ['a boolean', true],
            ['a whitespace-padded numeral', ' 12 '],
        ])('accepts a macro sent as %s, because Number() coerces it to a finite value', (_case, calories) => {
            // Deliberately documented rather than silently inherited: these all
            // coerce to a finite number under the shipped guard and therefore reach
            // the service, which rounds them (null/''/[] to 0, true to 1). The
            // tolerance is the endpoint's shipped behaviour; narrowing it is a wire
            // contract change that must fail this test and be reviewed, not slip in.
            expect(parseLogEntryBody({ ...validLegacyBody(), calories }).kind).toBe('legacy');
        });

        it('accepts an entry whose every macro is zero', () => {
            // Black coffee and water are real entries. The guard is
            // Number.isFinite, and zero is finite — so a rewrite that reached
            // for truthiness (`!body.calories`) would start rejecting them
            // while still passing every other case in this suite.
            const body = { name: 'Black coffee', calories: 0, protein: 0, carbs: 0, fat: 0 };

            expect(asLegacy(parseLogEntryBody(body)).payload).toBe(body);
        });

        it('accepts negative macros, because the shipped guard does not bound sign', () => {
            // Pinned as current behaviour, not endorsed as sensible: the
            // endpoint has never rejected a negative macro, so introducing a
            // bound here would refuse bodies it accepts today. The bound
            // belongs to a reviewed contract change, and this test is what
            // makes that change visible.
            const body = { ...validLegacyBody(), calories: -220, protein: -14, carbs: -2, fat: -16 };

            expect(asLegacy(parseLogEntryBody(body)).payload).toBe(body);
        });

        it('does not apply the catalog servings contract to a legacy body', () => {
            // 99 servings is far outside the catalog [0.25, 10] bound. The legacy
            // branch must not police it: nutrition.service.ts owns the legacy
            // servings default, and adding a check here would reject bodies the
            // endpoint has always accepted.
            expect(parseLogEntryBody({ ...validLegacyBody(), servings: 99 }).kind).toBe('legacy');
        });

        it('does not require the legacy servingText or inputMethod to be well formed', () => {
            expect(parseLogEntryBody({ ...validLegacyBody(), servingText: 42, inputMethod: 'unknown_method' }).kind).toBe(
                'legacy',
            );
        });
    });

    describe('the catalog shape', () => {
        it('accepts the minimal catalog body and stamps the input method server-side', () => {
            const verdict = parseLogEntryBody({ catalogFoodId: CATALOG_FOOD_ID, servings: 1 });

            expect(verdict.kind).toBe('catalog');
            expect(asCatalog(verdict).payload).toStrictEqual({
                catalogFoodId: CATALOG_FOOD_ID,
                servings: 1,
                inputMethod: 'search',
            });
        });

        it('omits servingText entirely when the body did not send one', () => {
            const payload = asCatalog(parseLogEntryBody({ catalogFoodId: CATALOG_FOOD_ID, servings: 1 })).payload;

            // Absent, not present-and-undefined: logCatalogMealEntry derives the
            // portion description from the default portion when the key is missing.
            expect('servingText' in payload).toBe(false);
        });

        it('carries a string servingText through for the service to check against the catalog row', () => {
            const verdict = parseLogEntryBody({
                catalogFoodId: CATALOG_FOOD_ID,
                servings: 2,
                servingText: '1 medium (118 g)',
            });

            expect(asCatalog(verdict).payload).toStrictEqual({
                catalogFoodId: CATALOG_FOOD_ID,
                servings: 2,
                inputMethod: 'search',
                servingText: '1 medium (118 g)',
            });
        });

        it('carries an empty servingText through rather than rejecting it here', () => {
            // The check this module can make is the type. Whether the text names one
            // of that food's stored portion descriptions needs the catalog row, so
            // logCatalogMealEntry owns it and answers 400 invalid_serving — an empty
            // string simply matches no description.
            expect(asCatalog(parseLogEntryBody({ catalogFoodId: CATALOG_FOOD_ID, servings: 1, servingText: '' })).payload)
                .toStrictEqual({
                    catalogFoodId: CATALOG_FOOD_ID,
                    servings: 1,
                    inputMethod: 'search',
                    servingText: '',
                });
        });

        it.each([
            ['null', null],
            ['undefined', undefined],
        ])('treats a servingText sent as %s as absent rather than as a type error', (_case, servingText) => {
            const payload = asCatalog(
                parseLogEntryBody({ catalogFoodId: CATALOG_FOOD_ID, servings: 1, servingText }),
            ).payload;

            expect('servingText' in payload).toBe(false);
        });

        it.each([
            ['a number', 42],
            ['an object', { text: '1 cup' }],
            ['an array', ['1 cup']],
            ['a boolean', false],
        ])('refuses a servingText that is %s', (_case, servingText) => {
            const verdict = parseLogEntryBody({ catalogFoodId: CATALOG_FOOD_ID, servings: 1, servingText });

            expect(asError(verdict).code).toBe('invalid_request');
            expect(asError(verdict).message).toBe('servingText must be a string');
            expect(fieldCodes(verdict)).toStrictEqual(['servingText:invalid_type']);
        });

        it.each([
            ['a plain word', 'not-a-uuid'],
            ['a v1 UUID (wrong version nibble)', 'f47ac10b-58cc-1372-a567-0e02b2c3d479'],
            ['a wrong variant nibble', '3f2504e0-4f89-41d3-1a0c-0305e82c3301'],
            ['a truncated UUID', '3f2504e0-4f89-41d3-9a0c-0305e82c33'],
            ['a UUID with surrounding whitespace', ' 3f2504e0-4f89-41d3-9a0c-0305e82c3301 '],
            ['a braced UUID', '{3f2504e0-4f89-41d3-9a0c-0305e82c3301}'],
            ['a non-hex character', '3f2504e0-4f89-41d3-9a0c-0305e82c330g'],
            ['a number', 12345],
            ['an object', { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }],
            ['a boolean', true],
        ])('refuses a catalogFoodId that is %s', (_case, catalogFoodId) => {
            const verdict = parseLogEntryBody({ catalogFoodId, servings: 1 });

            expect(asError(verdict).code).toBe('invalid_request');
            expect(asError(verdict).message).toBe('catalogFoodId must be a v4 UUID');
            expect(fieldCodes(verdict)).toStrictEqual(['catalogFoodId:invalid_id']);
        });

        it('refuses an empty-string catalogFoodId instead of reading it as absent', () => {
            // Presence is `!== undefined && !== null`, deliberately not
            // truthiness: '' is a value the client sent, so it selects the
            // catalog shape and fails the id check. A truthiness test would
            // call it absent, and the body would fall through to a shape the
            // caller never asked for.
            const verdict = parseLogEntryBody({ catalogFoodId: '', servings: 1 });

            expect(asError(verdict).code).toBe('invalid_request');
            expect(fieldCodes(verdict)).toStrictEqual(['catalogFoodId:invalid_id']);
        });

        it('keeps an empty-string catalogFoodId on the catalog branch even beside a full legacy set', () => {
            // The consequence of the rule above, and the reason it matters: the
            // legacy macros must not rescue a body whose catalog id is unusable.
            // Routing it to the legacy writer would log client-supplied numbers
            // for a request that named a catalog food.
            const verdict = parseLogEntryBody({ ...validLegacyBody(), catalogFoodId: '' });

            expect(fieldCodes(verdict)).toStrictEqual(['catalogFoodId:invalid_id', 'servings:invalid_servings']);
        });

        it('accepts an upper-case v4 UUID and passes it through unchanged', () => {
            const upperCase = CATALOG_FOOD_ID.toUpperCase();
            const verdict = parseLogEntryBody({ catalogFoodId: upperCase, servings: 1 });

            // Case-insensitive by pattern, and not lower-cased on the way through:
            // Postgres compares uuid values by value, so normalising here would only
            // hide a mismatch somewhere else.
            expect(asCatalog(verdict).payload.catalogFoodId).toBe(upperCase);
        });

        it.each([
            ['the lower bound', 0.25],
            ['the upper bound', 10],
            ['a whole number inside the bound', 3],
            ['one decimal place', 1.5],
            ['two decimal places', 2.75],
            ['two and a half servings', 2.5],
            // The remaining serving-fraction chips the mobile app stores (¼ is
            // the lower bound above): ⅓ and ⅔ are stored as 0.33 and 0.66, so
            // the two-decimal rule has to admit them exactly as written —
            // compared naively, 0.33 * 100 is 33.000000000000004 and the chip
            // would stop being loggable.
            ['the mobile third chip', 0.33],
            ['the mobile half chip', 0.5],
            ['the mobile two-thirds chip', 0.66],
            ['the mobile three-quarters chip', 0.75],
        ])('accepts servings at %s', (_case, servings) => {
            expect(asCatalog(parseLogEntryBody({ catalogFoodId: CATALOG_FOOD_ID, servings })).payload.servings).toBe(
                servings,
            );
        });

        it.each([
            ['just below the lower bound', 0.24],
            ['zero', 0],
            ['negative', -1],
            ['just above the upper bound', 10.01],
            ['far above the upper bound', 1000],
            ['three decimal places', 1.005],
            ['three decimal places inside the bound', 0.333],
            ['NaN', Number.NaN],
            ['Infinity', Number.POSITIVE_INFINITY],
            ['a numeric string', '1'],
            ['null', null],
            ['undefined', undefined],
            ['an object', { value: 1 }],
            ['a boolean', true],
        ])('refuses servings that are %s', (_case, servings) => {
            const verdict = parseLogEntryBody({ catalogFoodId: CATALOG_FOOD_ID, servings });

            expect(asError(verdict).code).toBe('invalid_request');
            expect(asError(verdict).message).toBe(SERVINGS_MESSAGE);
            expect(fieldCodes(verdict)).toStrictEqual(['servings:invalid_servings']);
        });

        it('refuses a catalog body that omits servings altogether', () => {
            expect(fieldCodes(parseLogEntryBody({ catalogFoodId: CATALOG_FOOD_ID }))).toStrictEqual([
                'servings:invalid_servings',
            ]);
        });

        it('reports every catalog field error at once and joins their messages', () => {
            const verdict = parseLogEntryBody({ catalogFoodId: 'nope', servings: 99, servingText: 7 });

            expect(asError(verdict).code).toBe('invalid_request');
            expect(asError(verdict).message).toBe(
                `catalogFoodId must be a v4 UUID; ${SERVINGS_MESSAGE}; servingText must be a string`,
            );
            expect(fieldCodes(verdict)).toStrictEqual([
                'catalogFoodId:invalid_id',
                'servings:invalid_servings',
                'servingText:invalid_type',
            ]);
        });

        it.each([
            ['absent', undefined],
            ['the value the server itself stamps', 'search'],
            ['a known legacy method', 'ai_photo'],
            ['a method nobody defined', 'telepathy'],
            ['a number', 7],
            ['null', null],
        ])('stamps inputMethod as "search" when the body sends %s', (_case, inputMethod) => {
            // logCatalogMealEntry stamps the method server-side whatever the body
            // says, so carrying a client value forward would promise something the
            // service will not honour.
            const verdict = parseLogEntryBody({ catalogFoodId: CATALOG_FOOD_ID, servings: 1, inputMethod });

            expect(asCatalog(verdict).payload.inputMethod).toBe('search');
        });

        it('drops client-supplied macros and every unknown key', () => {
            const verdict = parseLogEntryBody({
                catalogFoodId: CATALOG_FOOD_ID,
                servings: 1.25,
                name: 'Definitely not 9000 calories',
                calories: 9000,
                protein: 9000,
                carbs: 9000,
                fat: 9000,
                rawInput: 'ignored',
                unknownKey: 'ignored',
            });

            // The catalog branch derives every number from the published
            // catalog_foods row, so a macro that survived into the payload would be
            // an unverified number stored as source-backed nutrition.
            expect(asCatalog(verdict).payload).toStrictEqual({
                catalogFoodId: CATALOG_FOOD_ID,
                servings: 1.25,
                inputMethod: 'search',
            });
        });

        it('selects the catalog shape even when the body also carries a full legacy set', () => {
            // No foodId, so there is no conflict: the catalog id decides, and the
            // legacy macros are dropped rather than logged.
            const verdict = parseLogEntryBody({ ...validLegacyBody(), catalogFoodId: CATALOG_FOOD_ID, servings: 2 });

            expect(asCatalog(verdict).payload).toStrictEqual({
                catalogFoodId: CATALOG_FOOD_ID,
                servings: 2,
                inputMethod: 'search',
            });
        });
    });

    describe('which of the three 400 verdicts a failure earns', () => {
        // Each verdict is rendered differently: legacy_fields_required keeps the
        // frozen message-only body shipped clients read, while the other two
        // carry the machine code and the per-field details. One code shared
        // across two routes is what let a catalog failure be answered with the
        // legacy message and lose both, so the partition is asserted here rather
        // than inferred from the controller.
        it.each([
            ['a legacy body with holes', 'legacy_fields_required', { name: 'eggs' }],
            ['a legacy body with an unusable name', 'legacy_fields_required', { ...validLegacyBody(), name: '  ' }],
            ['a legacy body with an unusable macro', 'legacy_fields_required', { ...validLegacyBody(), fat: 'lots' }],
            ['a catalog body with a malformed id', 'invalid_request', { catalogFoodId: 'nope', servings: 1 }],
            [
                'a catalog body with out-of-contract servings',
                'invalid_request',
                { catalogFoodId: CATALOG_FOOD_ID, servings: 99 },
            ],
            [
                'a catalog body with a non-string servingText',
                'invalid_request',
                { catalogFoodId: CATALOG_FOOD_ID, servings: 1, servingText: 7 },
            ],
            [
                'a body naming both a personal and a catalog food',
                'invalid_payload',
                { ...validLegacyBody(), foodId: 'personal-food-1', catalogFoodId: CATALOG_FOOD_ID },
            ],
            ['a body naming neither shape', 'invalid_payload', { servings: 2 }],
            ['a body that is not an object at all', 'invalid_payload', null],
        ])('answers %s with the %s verdict', (_case, expectedCode, body) => {
            expect(asError(parseLogEntryBody(body)).code).toBe(expectedCode);
        });

        it('gives the legacy verdict the frozen message it has always returned', () => {
            const verdict = asError(parseLogEntryBody({ name: 'eggs' }));

            expect(verdict.code).toBe('legacy_fields_required');
            expect(verdict.message).toBe(LEGACY_REQUIRED_MESSAGE);
        });

        it('never answers a catalog field failure with the legacy verdict or its message', () => {
            // The regression the third code prevents. A catalog caller sent no
            // name and no macros, so "name, calories, protein, carbs, and fat are
            // required" names nothing it can fix; its contract is the machine code
            // plus the field details.
            const verdict = asError(parseLogEntryBody({ catalogFoodId: 'nope', servings: 1 }));

            expect(verdict.code).toBe('invalid_request');
            expect(verdict.message).not.toBe(LEGACY_REQUIRED_MESSAGE);
            expect(verdict.details).toStrictEqual([{ field: 'catalogFoodId', code: 'invalid_id' }]);
        });

        it.each([
            ['a legacy body with holes', { name: 'eggs' }],
            ['a catalog body with a malformed id', { catalogFoodId: 'nope', servings: 1 }],
            ['a body naming neither shape', {}],
            [
                'a body naming both foods',
                { ...validLegacyBody(), foodId: 'personal-food-1', catalogFoodId: CATALOG_FOOD_ID },
            ],
        ])('reports %s as machine-readable details rather than prose', (_case, body) => {
            // `details` is what the client maps to copy; a sentence in either
            // member would leave it with nothing to map.
            const { details } = asError(parseLogEntryBody(body));

            expect(details.length).toBeGreaterThan(0);
            details.forEach((detail) => {
                expect(detail.field).toMatch(/^[a-zA-Z]+$/);
                expect(detail.code).toMatch(/^[a-z_]+$/);
            });
        });
    });

    describe('a stored string PostgreSQL cannot hold', () => {
        // U+0000 is the one character a `text` column cannot represent: the
        // column answers `22021 invalid byte sequence for encoding "UTF8": 0x00`
        // and the endpoint returned a 500 for a request only the caller can fix.
        // The verdict is the same `400 invalid_request` the path parsers below
        // already return for an unparsable id, so what these cases pin is the
        // field the caller has to fix, the order the check runs in, and how
        // narrow the rule is.
        it.each([
            ['name', { ...validLegacyBody(), name: `Scrambled${NUL}eggs` }],
            ['servingText', { ...validLegacyBody(), servingText: `2${NUL}eggs` }],
            ['rawInput', { ...validLegacyBody(), rawInput: `two${NUL}eggs` }],
        ])('refuses a legacy body whose %s carries U+0000', (field, body) => {
            const verdict = asError(parseLogEntryBody(body));

            expect(verdict.code).toBe('invalid_request');
            expect(verdict.details).toStrictEqual([{ field, code: 'invalid_characters' }]);
            expect(verdict.message).toBe(`${field} must not contain a NUL character (U+0000)`);
        });

        it.each([
            ['at the start', `${NUL}eggs`],
            ['in the middle', `scrambled${NUL}eggs`],
            ['at the end', `eggs${NUL}`],
            ['as the whole value', NUL],
            ['more than once', `a${NUL}b${NUL}c`],
        ])('refuses a name carrying U+0000 %s', (_case, name) => {
            expect(fieldCodes(parseLogEntryBody({ ...validLegacyBody(), name }))).toStrictEqual([
                'name:invalid_characters',
            ]);
        });

        it('reports a name that is nothing but U+0000 as unstorable, not as missing', () => {
            // The two name failures are distinct and must not collapse into each
            // other. `String.prototype.trim` removes WhiteSpace and
            // LineTerminator, and U+0000 is neither — so this name is not blank,
            // the required-field guard passes it, and answering "name is
            // required" would tell the caller to supply a name it already sent.
            expect(NUL.trim()).toBe(NUL);

            const verdict = asError(parseLogEntryBody({ ...validLegacyBody(), name: NUL }));

            expect(verdict.code).toBe('invalid_request');
            expect(verdict.message).not.toBe(LEGACY_REQUIRED_MESSAGE);
            expect(fieldCodes(verdict)).toStrictEqual(['name:invalid_characters']);
        });

        it('reports every unstorable field at once, in field order', () => {
            const verdict = asError(
                parseLogEntryBody({
                    ...validLegacyBody(),
                    name: `a${NUL}b`,
                    servingText: `c${NUL}d`,
                    rawInput: `e${NUL}f`,
                }),
            );

            expect(fieldCodes(verdict)).toStrictEqual([
                'name:invalid_characters',
                'servingText:invalid_characters',
                'rawInput:invalid_characters',
            ]);
            expect(verdict.message).toBe(
                'name must not contain a NUL character (U+0000); ' +
                    'servingText must not contain a NUL character (U+0000); ' +
                    'rawInput must not contain a NUL character (U+0000)',
            );
        });

        it('leaves the frozen legacy verdict in front of it, byte for byte', () => {
            // The ordering that makes this rule safe to add to a frozen guard
            // (§0.3.1): the required-field check runs first, so every body the
            // endpoint already refuses keeps the exact response shipped clients
            // read, and this verdict can only ever replace a 500. Reversing the
            // two would change a live 400.
            const verdict = asError(parseLogEntryBody({ name: `a${NUL}b`, calories: 220, protein: 14, carbs: 2 }));

            expect(verdict.code).toBe('legacy_fields_required');
            expect(verdict.message).toBe(LEGACY_REQUIRED_MESSAGE);
            expect(fieldCodes(verdict)).toStrictEqual(['fat:required']);
        });

        it('leaves the shape decision in front of it too', () => {
            // A body naming both foods is refused before either shape is parsed,
            // so the conflict — not the unstorable name — is what the caller is
            // told to fix, and the NUL never becomes the reason a two-food body
            // was rejected.
            const verdict = asError(
                parseLogEntryBody({
                    ...validLegacyBody(),
                    name: `a${NUL}b`,
                    foodId: 'personal-food-1',
                    catalogFoodId: CATALOG_FOOD_ID,
                }),
            );

            expect(verdict.code).toBe('invalid_payload');
            expect(verdict.message).toBe(CONFLICTING_REFERENCE_MESSAGE);
        });

        it.each([
            ['BEL', '\u0007'],
            ['ESC', '\u001b'],
            ['DEL', '\u007f'],
            ['a tab', '\t'],
            ['a newline', '\n'],
            ['a zero-width space', '\u200b'],
            ['an emoji', '🍳'],
        ])('accepts a name containing %s, which the column stores intact', (_case, marker) => {
            // The rule is U+0000 and nothing else. Every character here reaches
            // `meal_entries.name` today and round-trips, so widening this to a
            // general control-character filter would start refusing entries the
            // endpoint accepts and stores correctly.
            const body = { ...validLegacyBody(), name: `a${marker}b` };

            expect(asLegacy(parseLogEntryBody(body)).payload).toBe(body);
        });

        it.each([
            ['a numeric servingText', 'servingText', 42],
            ['an object rawInput', 'rawInput', {}],
            ['a null servingText', 'servingText', null],
        ])('never reports %s as unstorable', (_case, field, value) => {
            // Whether a non-string is storable at all is the column's own
            // question, and this route has always let it ask: the type stays
            // unjudged here exactly as it was before the rule was added.
            expect(parseLogEntryBody({ ...validLegacyBody(), [field]: value }).kind).toBe('legacy');
        });

        it('does not judge the legacy foodId, whose own column still refuses it', () => {
            // Deliberately out of the rule's reach and recorded as such:
            // `foodId` reaches `meal_entries.food_id`, a `@db.Uuid` column, and
            // the dedupe lookup that precedes the insert filters on it — so a
            // malformed one surfaces as the 500 it always has. Refusing it here
            // would be a new verdict on a shape §0.3.1 freezes.
            expect(parseLogEntryBody({ ...validLegacyBody(), foodId: `a${NUL}b` }).kind).toBe('legacy');
        });

        it('does not judge a legacy inputMethod, which is never stored as sent', () => {
            // `resolveLegacyInputMethod` whitelists this field, so an
            // unrecognised value — a NUL among them — is replaced by the default
            // and never reaches a column.
            expect(parseLogEntryBody({ ...validLegacyBody(), inputMethod: `ai${NUL}text` }).kind).toBe('legacy');
        });

        it('leaves a catalog body to the catalog contract, which already refuses it', () => {
            // The catalog writer stores no client string: the name is the
            // published food's own, and `servingText` is honoured only when it
            // equals one of that food's stored portion descriptions — a NUL
            // cannot, so the request is already answered with the typed
            // `invalid_serving` 400 rather than a 500. Adding the stored-text
            // rule to this shape would replace one 400 with another and change a
            // documented response.
            expect(
                parseLogEntryBody({ catalogFoodId: CATALOG_FOOD_ID, servings: 1, servingText: `1${NUL}cup` }).kind,
            ).toBe('catalog');
        });
    });
});

describe('containsNulCharacter', () => {
    // The stored-text rule as its own predicate, tested here rather than only
    // through the two parsers because it is the whole of the decision: a string
    // PostgreSQL `text` cannot hold. `backend-architecture` §4 asks for exactly
    // this — the predicate in the logic module, with a test — and §11 is why it
    // cannot live beside the Prisma call it protects.
    it.each([
        ['a value that is only U+0000', NUL],
        ['U+0000 at the start', `${NUL}a`],
        ['U+0000 in the middle', `a${NUL}b`],
        ['U+0000 at the end', `a${NUL}`],
        ['several U+0000s', `${NUL}${NUL}`],
    ])('reports %s', (_case, value) => {
        expect(containsNulCharacter(value)).toBe(true);
    });

    it.each([
        ['an ordinary string', 'Scrambled eggs'],
        ['an empty string', ''],
        ['the two-character escape sequence, not the character', '\\u0000'],
        ['BEL', '\u0007'],
        ['ESC', '\u001b'],
        ['DEL', '\u007f'],
        ['whitespace only', '   \t\n '],
    ])('does not report %s', (_case, value) => {
        expect(containsNulCharacter(value)).toBe(false);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a number', 42],
        ['a boolean', true],
        ['an empty object', {}],
        ['an array containing the character', [NUL]],
        ['an object whose toString contains it', { toString: () => NUL }],
    ])('does not report %s, because only a string can be stored as text', (_case, value) => {
        // Never coerces. Stringifying the argument would invent a value the
        // request never sent and, for the object case, would call caller-supplied
        // code inside a validator.
        expect(containsNulCharacter(value)).toBe(false);
    });
});

describe('parseMealEntryEditBody', () => {
    // `PUT /api/macros/entry/:id` has never validated its body, and everything
    // it accepts today it must go on accepting — so this suite is mostly the
    // bodies it must hand through untouched. The single refusal exists for the
    // same reason as the log route's: a `name` carrying U+0000 reaches
    // `meal_entries.name` and returns as a 500 for a fixable request.
    it('refuses a name carrying U+0000, naming the field', () => {
        const verdict = asEditError(parseMealEntryEditBody({ name: `Scrambled${NUL}eggs` }));

        expect(verdict.code).toBe('invalid_request');
        expect(verdict.details).toStrictEqual([{ field: 'name', code: 'invalid_characters' }]);
        expect(verdict.message).toBe('name must not contain a NUL character (U+0000)');
    });

    it('refuses a name that is nothing but U+0000', () => {
        expect(editFieldCodes(parseMealEntryEditBody({ name: NUL }))).toStrictEqual(['name:invalid_characters']);
    });

    it('hands a clean body on by identity, not as a rebuilt object', () => {
        // `planMealEntryEdit` reads each member itself and normalizes it the way
        // the column stores it, so a parser that rebuilt the payload would
        // silently drop whichever field it forgot — and a dropped field here is
        // an edit that detaches an entry from the plan meal vouching for it.
        const body = { name: 'Scrambled eggs', servings: 2, calories: 240 };

        expect(asEditOk(parseMealEntryEditBody(body)).payload).toBe(body);
    });

    it.each([
        ['an empty object', {}],
        ['a servings-only edit', { servings: 1.5 }],
        ['a macro-only edit', { calories: 240 }],
        ['a name containing other control characters', { name: 'a\u0007b\u001bc' }],
        ['a padded name', { name: '  Scrambled eggs  ' }],
        ['a name of the wrong type', { name: 42 }],
        ['a name explicitly nulled', { name: null }],
        ['a body of unrecognised keys', { nope: `a${NUL}b` }],
    ])('hands %s through unchanged', (_case, body) => {
        // Including the two that still fail at the column: a non-string name and
        // an unrecognised key carrying U+0000. The rule reports on the one field
        // the route stores and invents no other verdict, so nothing this route
        // answers today changes.
        expect(asEditOk(parseMealEntryEditBody(body)).payload).toBe(body);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a number', 7],
        ['a string', 'name=eggs'],
        ['an array', [{ name: `a${NUL}b` }]],
    ])('hands %s on to the writer, exactly as it always has', (_case, body) => {
        // A non-object body is not this parser's failure to report. The route has
        // always handed it to the writer — which answers with the 500 the
        // endpoint documents for a malformed body — and inventing a 400 here
        // would change a shipped response rather than replace an unanswerable
        // one.
        const verdict = parseMealEntryEditBody(body);

        expect(verdict.kind).toBe('ok');
        expect(asEditOk(verdict).payload).toBe(body);
    });

    it('returns a verdict for every input and never throws', () => {
        const inputs: unknown[] = [null, undefined, 0, '', false, [], {}, { name: NUL }, new Date(0), () => NUL];

        inputs.forEach((input) => {
            expect(() => parseMealEntryEditBody(input)).not.toThrow();
            expect(['ok', 'error']).toContain(parseMealEntryEditBody(input).kind);
        });
    });
});

describe('resolveLegacyInputMethod', () => {
    it.each(['library', 'search', 'ai_text', 'ai_photo'])('honours %s, which a client may ask for', (method) => {
        expect(resolveLegacyInputMethod(method)).toBe(method);
    });

    it('refuses the planned-meal method however plainly a body asks for it', () => {
        // The forgery this function exists to refuse. The app captions a diary
        // row "From meal plan" from this field alone, so honouring a request's
        // 'meal_plan' would let it claim a planned origin for macros it supplied
        // itself — no plan, no recipe version, and nutrition the server never
        // derived. Only `insertPlannedMealEntry` writes this value.
        expect(resolveLegacyInputMethod(PLANNED_INPUT_METHOD)).toBe(DEFAULT_INPUT_METHOD);
        expect(resolveLegacyInputMethod('meal_plan')).toBe('library');
    });

    it.each([
        ['a method nobody defined', 'telepathy'],
        ['an empty string', ''],
        ['the same method in upper case', 'LIBRARY'],
        ['a padded method', ' library '],
        ['the planned method in mixed case', 'Meal_Plan'],
        ['undefined', undefined],
        ['null', null],
        ['a number', 7],
        ['a boolean', true],
        ['an object', { inputMethod: 'library' }],
        ['an array of methods', ['library']],
    ])('resolves %s to the default', (_case, value) => {
        // Unchanged from the whitelist this replaced: an unusable method is not a
        // rejected request, it is simply not honoured. Matching is exact, so no
        // case folding or trimming rescues a value either.
        expect(resolveLegacyInputMethod(value)).toBe(DEFAULT_INPUT_METHOD);
    });

    describe('the two vocabularies it resolves between', () => {
        it('stores five methods, the planned one among them', () => {
            // The column's vocabulary (Agent Action Plan §0.5.1): `mapEntry` emits
            // every one of these and `insertPlannedMealEntry` writes the last.
            expect([...ENTRY_INPUT_METHODS]).toStrictEqual(['library', 'search', 'ai_text', 'ai_photo', 'meal_plan']);
        });

        it('accepts four of them from a request body, never the planned one', () => {
            expect([...CLIENT_INPUT_METHODS]).toStrictEqual(['library', 'search', 'ai_text', 'ai_photo']);
            expect(CLIENT_INPUT_METHODS).not.toContain(PLANNED_INPUT_METHOD);
        });

        it('falls back to a method a client could have asked for anyway', () => {
            // 'library' is the column default and the value the legacy writer has
            // always stored for an unrecognised method, so resolving to it adds no
            // new wire value for an older client to decode.
            expect(CLIENT_INPUT_METHODS).toContain(DEFAULT_INPUT_METHOD);
            expect(DEFAULT_INPUT_METHOD).toBe('library');
        });

        it('resolves every stored method to itself except the one only the server writes', () => {
            ENTRY_INPUT_METHODS.forEach((method) => {
                expect(resolveLegacyInputMethod(method)).toBe(
                    method === PLANNED_INPUT_METHOD ? DEFAULT_INPUT_METHOD : method,
                );
            });
        });
    });
});

/** A syntactically valid v4 UUID, distinct from the catalog one above. */
const MEAL_ID = '9b2fbd4c-7c21-4a17-8b36-1d5a2d4f9c10';
const ENTRY_ID = 'c0a80121-7ac0-4f2e-b1f7-3f8c1d9a4e62';

const asPathError = (verdict: ParsedMealEntryPath | ParsedEntryPath): ErrorVerdict => {
    if (verdict.kind !== 'error') {
        throw new Error(`expected an error verdict, received "${verdict.kind}"`);
    }

    return verdict;
};

describe('parseMealEntryPath', () => {
    it('accepts a v4 UUID and hands back the id the writers address the meal by', () => {
        expect(parseMealEntryPath({ mealId: MEAL_ID })).toStrictEqual({ kind: 'ok', mealId: MEAL_ID });
    });

    it('accepts an upper-case UUID, which PostgreSQL parses identically', () => {
        const upper = MEAL_ID.toUpperCase();

        expect(parseMealEntryPath({ mealId: upper })).toStrictEqual({ kind: 'ok', mealId: upper });
    });

    it.each([
        ['a string that is not a UUID at all', 'not-a-uuid'],
        ['a SQL fragment', "' OR 1=1--"],
        ['an empty segment', ''],
        ['a UUID missing its hyphens', '9b2fbd4c7c214a178b361d5a2d4f9c10'],
        ['a brace-wrapped UUID PostgreSQL would accept but no row can hold', `{${MEAL_ID}}`],
        ['a padded UUID', ` ${MEAL_ID} `],
        ['a v1 UUID, which gen_random_uuid never produces', '9b2fbd4c-7c21-1a17-8b36-1d5a2d4f9c10'],
        ['a UUID with an out-of-range variant nibble', '9b2fbd4c-7c21-4a17-1b36-1d5a2d4f9c10'],
        ['a truncated UUID', '9b2fbd4c-7c21-4a17-8b36'],
        ['an absent parameter', undefined],
        ['null', null],
        ['a number', 7],
        ['an array of ids', [MEAL_ID]],
        ['an object', { mealId: MEAL_ID }],
    ])('refuses %s with invalid_id on mealId', (_case, mealId) => {
        // The whole point of the verdict: every one of these would otherwise
        // reach `meals.id`, a @db.Uuid column, and come back as a 500 for a
        // request the caller could have fixed.
        const verdict = parseMealEntryPath({ mealId });

        expect(asPathError(verdict).code).toBe('invalid_request');
        expect(asPathError(verdict).details).toStrictEqual([{ field: 'mealId', code: 'invalid_id' }]);
        expect(asPathError(verdict).message).toBe('mealId must be a v4 UUID');
    });

    it('leaves a well-formed id that names nothing to the 404', () => {
        // Existence is not this parser's business, and must not be: answering
        // differently for an id that exists and one that does not is how an
        // endpoint tells a caller whose rows they are looking at.
        expect(parseMealEntryPath({ mealId: ENTRY_ID }).kind).toBe('ok');
    });
});

describe('parseEntryPath', () => {
    it('accepts a v4 UUID and hands back the entry id', () => {
        expect(parseEntryPath({ id: ENTRY_ID })).toStrictEqual({ kind: 'ok', entryId: ENTRY_ID });
    });

    it.each([
        ['a string that is not a UUID', 'entry-1'],
        ['an empty segment', ''],
        ['an absent parameter', undefined],
        ['null', null],
        ['a number', 12],
        ['an object', {}],
    ])('refuses %s with invalid_id on id', (_case, id) => {
        const verdict = parseEntryPath({ id });

        expect(asPathError(verdict).code).toBe('invalid_request');
        expect(asPathError(verdict).details).toStrictEqual([{ field: 'id', code: 'invalid_id' }]);
    });

    it('names the route parameter the caller sees rather than an internal name', () => {
        // `PUT /macros/entry/:id` — the detail has to name `id`, because that is
        // the segment the client is being told to fix.
        expect(asPathError(parseEntryPath({ id: 'nope' })).details[0].field).toBe('id');
        expect(asPathError(parseMealEntryPath({ mealId: 'nope' })).details[0].field).toBe('mealId');
    });
});

describe('the stored nutrition-provenance vocabulary', () => {
    it('holds the four classes the column may carry', () => {
        expect([...ENTRY_NUTRITION_PROVENANCES]).toStrictEqual([
            'source_backed',
            'ingredient_derived',
            'ai_estimated',
            'user_entered',
        ]);
    });

    it('reads every class it names back as itself', () => {
        ENTRY_NUTRITION_PROVENANCES.forEach((provenance) => {
            expect(isEntryNutritionProvenance(provenance)).toBe(true);
            expect(toNutritionProvenance(provenance)).toBe(provenance);
        });
    });

    it.each([
        ['a NULL column, which is a row written before the column existed', null],
        ['a class nobody defined', 'verified'],
        ['an empty string', ''],
        ['the right class in the wrong case', 'Source_Backed'],
        ['a padded class', ' source_backed '],
    ])('reads %s as the unlabelled class', (_case, stored) => {
        // `null` is "unknown / user-entered" and renders no provenance caption.
        // For HISTORY that is the honest reading; for a NEW entry it would be a
        // lost label, which is why `resolveCatalogEntrySnapshot` refuses to
        // write a value this function cannot read.
        expect(toNutritionProvenance(stored)).toBeNull();
    });

    it.each([
        ['an inherited object property', 'toString'],
        ['a prototype member', 'constructor'],
    ])('does not admit %s as a class', (_case, stored) => {
        // The membership test is `hasOwnProperty`, not `in`: `'toString' in
        // members` is true of every object literal.
        expect(isEntryNutritionProvenance(stored)).toBe(false);
        expect(toNutritionProvenance(stored)).toBeNull();
    });

    it.each([
        ['undefined', undefined],
        ['a number', 1],
        ['an object', { provenance: 'source_backed' }],
        ['an array', ['source_backed']],
    ])('does not admit %s as a class', (_case, value) => {
        expect(isEntryNutritionProvenance(value)).toBe(false);
    });

    it('classifies a client-supplied snapshot as user-entered and a planned one as source-backed', () => {
        expect(CLIENT_SNAPSHOT_PROVENANCE).toBe('user_entered');
        expect(PLANNED_SNAPSHOT_PROVENANCE).toBe('source_backed');
        expect(ENTRY_NUTRITION_PROVENANCES).toContain(CLIENT_SNAPSHOT_PROVENANCE);
        expect(ENTRY_NUTRITION_PROVENANCES).toContain(PLANNED_SNAPSHOT_PROVENANCE);
    });

    it('can read back every class a catalog food may carry', () => {
        // The invariant behind the snapshot's narrowing: the catalog set is a
        // SUBSET of what an entry may hold, so a provenance the snapshot accepts
        // always survives `mapEntry` and reaches the diary as a label. If a
        // class were ever added to the catalog set alone, a logged entry would
        // carry a value this module reads as `null` and the label would vanish.
        CATALOG_NUTRITION_PROVENANCES.forEach((provenance) => {
            expect(toNutritionProvenance(provenance)).toBe(provenance);
        });
    });
});

/**
 * A published food as the columns hold it: per 100 g, 150 kcal / 15 P / 20 C /
 * 2 F, with one default portion of 200 g — so the default portion is exactly
 * twice the basis and the scaling is legible in the expectations.
 */
const catalogFood = (overrides: Partial<CatalogEntryFood> = {}): CatalogEntryFood => ({
    id: '2f9a1c44-5d3e-4b21-9f77-8c6b0e4d1a55',
    nutrition_basis: 'per_100g',
    basis_amount: 100,
    calories: 150,
    protein_g: 15,
    carbs_g: 20,
    fat_g: 2,
    density_g_per_ml: null,
    nutrition_provenance: 'source_backed',
    catalog_food_portions: [{ description: '1 cup', gram_weight: 200, is_default: true }],
    ...overrides,
});

describe('resolveCatalogEntrySnapshot', () => {
    describe('the portion the entry is logged against', () => {
        it('takes the default portion when the request names none', () => {
            const snapshot = resolveCatalogEntrySnapshot(catalogFood(), undefined);

            expect(snapshot.servingText).toBe('1 cup');
            expect(snapshot.perServing).toStrictEqual({ calories: 300, protein: 30, carbs: 40, fat: 4 });
        });

        it('takes a named portion and scales that portion, not the default', () => {
            const food = catalogFood({
                catalog_food_portions: [
                    { description: '1 cup', gram_weight: 200, is_default: true },
                    { description: '1 tbsp', gram_weight: 15, is_default: false },
                ],
            });

            const snapshot = resolveCatalogEntrySnapshot(food, '1 tbsp');

            // 15 g of a 150 kcal/100 g food: 22.5 rounded once.
            expect(snapshot).toStrictEqual({
                servingText: '1 tbsp',
                perServing: { calories: 23, protein: 2, carbs: 3, fat: 0 },
                nutritionProvenance: 'source_backed',
            });
        });

        it('stores the portion description the catalog measured, not the text the client sent', () => {
            // The two are equal strings here, and that is the point: the stored
            // label comes from the matched portion, so it can only ever describe
            // the numbers stored beside it.
            const snapshot = resolveCatalogEntrySnapshot(catalogFood(), '1 cup');

            expect(snapshot.servingText).toBe('1 cup');
        });

        it.each([
            ['a portion this food does not store', '1 slice'],
            ['the right portion in the wrong case', '1 CUP'],
            ['a padded description', ' 1 cup '],
            ['an empty description', ''],
        ])('refuses %s rather than falling back to the default portion', (_case, servingText) => {
            // Falling back would label one portion's numbers with another
            // portion's name — the unverifiable claim this refusal exists for.
            expect(() => resolveCatalogEntrySnapshot(catalogFood(), servingText)).toThrow(InvalidServingError);
        });

        it('reports the text it refused, so the caller learns which value to fix', () => {
            try {
                resolveCatalogEntrySnapshot(catalogFood(), '1 slice');
                throw new Error('expected InvalidServingError');
            } catch (error) {
                expect(error).toBeInstanceOf(InvalidServingError);
                expect((error as InvalidServingError).servingText).toBe('1 slice');
            }
        });

        it('refuses a food with no default portion', () => {
            const food = catalogFood({
                catalog_food_portions: [{ description: '1 cup', gram_weight: 200, is_default: false }],
            });

            expect(() => resolveCatalogEntrySnapshot(food, undefined)).toThrow(CatalogSnapshotError);
        });

        it('refuses a food with no portions at all', () => {
            expect(() => resolveCatalogEntrySnapshot(catalogFood({ catalog_food_portions: [] }), undefined)).toThrow(
                CatalogSnapshotError,
            );
        });

        it.each([
            ['zero', 0],
            ['negative', -50],
            ['not a number', Number.NaN],
            ['infinite', Number.POSITIVE_INFINITY],
        ])('refuses a %s portion weight instead of inventing one', (_case, gram_weight) => {
            const food = catalogFood({
                catalog_food_portions: [{ description: '1 cup', gram_weight, is_default: true }],
            });

            expect(() => resolveCatalogEntrySnapshot(food, undefined)).toThrow(CatalogSnapshotError);
        });
    });

    describe('the basis the stated values are scaled from', () => {
        it('scales a per-100g basis by mass', () => {
            const food = catalogFood({ basis_amount: 50, calories: 75, protein_g: 7, carbs_g: 10, fat_g: 1 });

            // 75 kcal per 50 g, logged as a 200 g portion.
            expect(resolveCatalogEntrySnapshot(food, undefined).perServing).toStrictEqual({
                calories: 300,
                protein: 28,
                carbs: 40,
                fat: 4,
            });
        });

        it('scales a per-100ml basis through the food´s own density', () => {
            const food = catalogFood({
                nutrition_basis: 'per_100ml',
                basis_amount: 100,
                density_g_per_ml: 1.03,
                catalog_food_portions: [{ description: '1 cup', gram_weight: 206, is_default: true }],
            });

            // 100 ml at 1.03 g/ml is 103 g, and the portion is exactly twice that.
            expect(resolveCatalogEntrySnapshot(food, undefined).perServing).toStrictEqual({
                calories: 300,
                protein: 30,
                carbs: 40,
                fat: 4,
            });
        });

        it.each([
            ['an absent density', null],
            ['a zero density', 0],
            ['a negative density', -1],
        ])('refuses a per-100ml basis with %s rather than reading millilitres as grams', (_case, density) => {
            const food = catalogFood({ nutrition_basis: 'per_100ml', density_g_per_ml: density });

            expect(() => resolveCatalogEntrySnapshot(food, undefined)).toThrow(CatalogSnapshotError);
        });

        it('scales a per-serving basis by the default portion´s gram weight', () => {
            const food = catalogFood({
                nutrition_basis: 'per_serving',
                basis_amount: 1,
                calories: 90,
                protein_g: 9,
                carbs_g: 12,
                fat_g: 1,
                catalog_food_portions: [{ description: '1 bar', gram_weight: 40, is_default: true }],
            });

            // One serving weighs 40 g and the logged portion IS that serving.
            expect(resolveCatalogEntrySnapshot(food, undefined).perServing).toStrictEqual({
                calories: 90,
                protein: 9,
                carbs: 12,
                fat: 1,
            });
        });

        it('reads a per-serving basis_amount as a count of servings', () => {
            const food = catalogFood({
                nutrition_basis: 'per_serving',
                basis_amount: 2,
                calories: 180,
                protein_g: 18,
                carbs_g: 24,
                fat_g: 2,
                catalog_food_portions: [{ description: '1 bar', gram_weight: 40, is_default: true }],
            });

            // A label stating two servings' worth describes 80 g, so one 40 g bar
            // is half of it. Treating basis_amount as one serving would double
            // every value.
            expect(resolveCatalogEntrySnapshot(food, undefined).perServing).toStrictEqual({
                calories: 90,
                protein: 9,
                carbs: 12,
                fat: 1,
            });
        });

        it('scales a named portion from the default portion´s basis on a per-serving food', () => {
            const food = catalogFood({
                nutrition_basis: 'per_serving',
                basis_amount: 1,
                calories: 90,
                protein_g: 9,
                carbs_g: 12,
                fat_g: 1,
                catalog_food_portions: [
                    { description: '1 bar', gram_weight: 40, is_default: true },
                    { description: '1 box', gram_weight: 200, is_default: false },
                ],
            });

            // The basis is still the DEFAULT portion's weight; the named portion
            // only decides how much of it the entry logs.
            expect(resolveCatalogEntrySnapshot(food, '1 box').perServing).toStrictEqual({
                calories: 450,
                protein: 45,
                carbs: 60,
                fat: 5,
            });
        });

        it.each([
            ['a basis nobody defined', 'per_ounce'],
            ['the right basis in the wrong case', 'PER_100G'],
            ['an empty basis', ''],
        ])('refuses %s', (_case, nutrition_basis) => {
            expect(() => resolveCatalogEntrySnapshot(catalogFood({ nutrition_basis }), undefined)).toThrow(
                CatalogSnapshotError,
            );
        });

        it.each([
            ['zero', 0],
            ['negative', -100],
            ['not a number', Number.NaN],
        ])('refuses a %s basis amount', (_case, basis_amount) => {
            expect(() => resolveCatalogEntrySnapshot(catalogFood({ basis_amount }), undefined)).toThrow(
                CatalogSnapshotError,
            );
        });
    });

    describe('the nutrients it stores', () => {
        it('keeps a genuine zero rather than treating it as missing', () => {
            const food = catalogFood({ calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });

            expect(resolveCatalogEntrySnapshot(food, undefined).perServing).toStrictEqual({
                calories: 0,
                protein: 0,
                carbs: 0,
                fat: 0,
            });
        });

        it.each(['calories', 'protein_g', 'carbs_g', 'fat_g'] as const)(
            'refuses a food whose %s is NULL instead of reading it as zero',
            (nutrient) => {
                // Reading NULL as 0 would log a number nobody measured under a
                // source-backed label, which is the one thing this path may not do.
                expect(() => resolveCatalogEntrySnapshot(catalogFood({ [nutrient]: null }), undefined)).toThrow(
                    CatalogSnapshotError,
                );
            },
        );

        it.each(['calories', 'protein_g', 'carbs_g', 'fat_g'] as const)(
            'refuses a negative %s, which no food has and validation cannot publish',
            (nutrient) => {
                expect(() => resolveCatalogEntrySnapshot(catalogFood({ [nutrient]: -1 }), undefined)).toThrow(
                    CatalogSnapshotError,
                );
            },
        );

        it.each(['calories', 'protein_g', 'carbs_g', 'fat_g'] as const)('refuses a non-finite %s', (nutrient) => {
            expect(() => resolveCatalogEntrySnapshot(catalogFood({ [nutrient]: Number.NaN }), undefined)).toThrow(
                CatalogSnapshotError,
            );
        });

        it('rounds the scaled value once, not the stated value before scaling', () => {
            const food = catalogFood({
                basis_amount: 100,
                calories: 10.4,
                protein_g: 1.4,
                carbs_g: 0.5,
                fat_g: 0.04,
                catalog_food_portions: [{ description: '1 kg', gram_weight: 1000, is_default: true }],
            });

            // Rounding first and scaling after would give 100 / 10 / 0 / 0.
            expect(resolveCatalogEntrySnapshot(food, undefined).perServing).toStrictEqual({
                calories: 104,
                protein: 14,
                carbs: 5,
                fat: 0,
            });
        });

        it('stores integers, because the column is an Int', () => {
            const snapshot = resolveCatalogEntrySnapshot(
                catalogFood({ calories: 133.33, protein_g: 6.66, carbs_g: 2.22, fat_g: 1.11 }),
                undefined,
            );

            Object.values(snapshot.perServing).forEach((value) => {
                expect(Number.isInteger(value)).toBe(true);
            });
        });
    });

    describe('the provenance class it writes', () => {
        it.each(CATALOG_NUTRITION_PROVENANCES)('carries the food´s own %s class through', (provenance) => {
            expect(
                resolveCatalogEntrySnapshot(catalogFood({ nutrition_provenance: provenance }), undefined)
                    .nutritionProvenance,
            ).toBe(provenance);
        });

        it.each([
            ['a class nobody defined', 'verified'],
            ['an empty class', ''],
            ['the right class in the wrong case', 'Source_Backed'],
            ['a padded class', ' ai_estimated '],
            ['the client-supplied class, which no catalog food may claim', 'user_entered'],
        ])('refuses %s rather than storing a value the diary cannot label', (_case, nutrition_provenance) => {
            // The failure this narrowing exists for: stored as given, an
            // unreadable class comes back from `toNutritionProvenance` as `null`,
            // which renders NO caption — so an AI-estimated food would be logged
            // with its mandatory estimate label silently missing. Failing closed
            // writes no entry at all, which is the direction a nutrition label
            // has to fail in.
            expect(() =>
                resolveCatalogEntrySnapshot(catalogFood({ nutrition_provenance }), undefined),
            ).toThrow(CatalogSnapshotError);
        });

        it('refuses a corrupt class before it considers the portion the request named', () => {
            // A published row that cannot be labelled is refused whatever the
            // request asked for, so no combination of request values reaches the
            // insert past it.
            expect(() =>
                resolveCatalogEntrySnapshot(catalogFood({ nutrition_provenance: 'verified' }), '1 slice'),
            ).toThrow(CatalogSnapshotError);
        });
    });
});

/** A logged planned meal as the row holds it: 420 kcal / 32 P / 44 C / 11 F per serving. */
const storedEntry = (overrides: Partial<StoredMealEntrySnapshot> = {}): StoredMealEntrySnapshot => ({
    name: 'Greek yogurt bowl',
    calories: 420,
    protein_g: 32,
    carbs_g: 44,
    fat_g: 11,
    meal_plan_meal_id: 'a6e1b5c2-9d47-4c8a-8f31-2b7e6c0d5a94',
    catalog_food_id: null,
    recipe_version_id: null,
    ...overrides,
});

/** The same numbers the row holds, as a client re-submitting the form would send them. */
const unchangedPayload = () => ({ name: 'Greek yogurt bowl', calories: 420, protein: 32, carbs: 44, fat: 11 });

describe('planMealEntryEdit', () => {
    describe('edits that must NOT detach', () => {
        it('leaves the links alone for a servings-only edit', () => {
            const plan = planMealEntryEdit(storedEntry(), { servings: 2 });

            expect(plan).toStrictEqual({ fields: { servings: 2 }, detachesFromSource: false });
        });

        it('leaves the links alone when a client re-submits the whole entry unaltered', () => {
            // The case that made this rule necessary: a full-form save, or a
            // retry of a request whose response was lost, changes nothing about
            // what the food IS — so the planned meal stays LOGGED, "From meal
            // plan" stays under the row, and the source label survives.
            const plan = planMealEntryEdit(storedEntry(), unchangedPayload());

            expect(plan.detachesFromSource).toBe(false);
            expect(plan.fields).toStrictEqual({
                name: 'Greek yogurt bowl',
                calories: 420,
                protein_g: 32,
                carbs_g: 44,
                fat_g: 11,
            });
        });

        it('leaves the links alone for a servings edit sent alongside the unchanged snapshot', () => {
            const plan = planMealEntryEdit(storedEntry(), { ...unchangedPayload(), servings: 0.5 });

            expect(plan.detachesFromSource).toBe(false);
            expect(plan.fields.servings).toBe(0.5);
        });

        it('compares the name as the column would hold it, so padding is not an edit', () => {
            const plan = planMealEntryEdit(storedEntry(), { name: '  Greek yogurt bowl  ' });

            expect(plan.fields.name).toBe('Greek yogurt bowl');
            expect(plan.detachesFromSource).toBe(false);
        });

        it.each([
            ['a macro that rounds to the stored value', { calories: 420.4 }],
            ['a macro that rounds up to the stored value', { protein: 31.6 }],
            ['every macro sent with sub-integer noise', { calories: 419.5, protein: 32.2, carbs: 43.8, fat: 11.4 }],
        ])('compares macros as the column would hold them: %s is not an edit', (_case, payload) => {
            expect(planMealEntryEdit(storedEntry(), payload).detachesFromSource).toBe(false);
        });

        it('does not detach an entry that carries no link, however much the edit changes', () => {
            const plan = planMealEntryEdit(
                storedEntry({ meal_plan_meal_id: null }),
                { name: 'Something else', calories: 900 },
            );

            expect(plan.detachesFromSource).toBe(false);
            expect(plan.fields).toStrictEqual({ name: 'Something else', calories: 900 });
        });

        it('writes nothing and detaches nothing for an empty payload', () => {
            expect(planMealEntryEdit(storedEntry(), {})).toStrictEqual({ fields: {}, detachesFromSource: false });
        });
    });

    describe('edits that MUST detach', () => {
        it('detaches when the name is rewritten', () => {
            const plan = planMealEntryEdit(storedEntry(), { name: 'Greek yogurt bowl with honey' });

            expect(plan.detachesFromSource).toBe(true);
        });

        it.each([
            ['calories', { calories: 421 }],
            ['protein', { protein: 33 }],
            ['carbs', { carbs: 45 }],
            ['fat', { fat: 12 }],
        ])('detaches when %s is rewritten', (_case, payload) => {
            expect(planMealEntryEdit(storedEntry(), payload).detachesFromSource).toBe(true);
        });

        it('detaches when one macro changes among several that did not', () => {
            const plan = planMealEntryEdit(storedEntry(), { ...unchangedPayload(), fat: 20 });

            expect(plan.detachesFromSource).toBe(true);
            expect(plan.fields.fat_g).toBe(20);
        });

        it.each([
            ['a planned meal', { meal_plan_meal_id: 'a6e1b5c2-9d47-4c8a-8f31-2b7e6c0d5a94' }],
            ['a catalog food', { catalog_food_id: '2f9a1c44-5d3e-4b21-9f77-8c6b0e4d1a55' }],
            ['a recipe version', { recipe_version_id: '7d3c9f10-2a56-4e83-9b1d-4f8e2c6a0b37' }],
        ])('detaches an entry linked to %s', (_case, links) => {
            const existing = storedEntry({
                meal_plan_meal_id: null,
                catalog_food_id: null,
                recipe_version_id: null,
                ...links,
            });

            expect(planMealEntryEdit(existing, { calories: 500 }).detachesFromSource).toBe(true);
        });

        it('treats a macro it cannot compare as a rewrite', () => {
            // `NaN !== NaN`, so an uncomparable value must not be read as "equal
            // to what is stored". The write it belongs to is refused at the
            // column, so nothing is actually detached — but the decision itself
            // may never default to "unchanged".
            expect(planMealEntryEdit(storedEntry(), { calories: Number.NaN }).detachesFromSource).toBe(true);
        });
    });

    describe('the values it writes', () => {
        it('maps each payload field to the column it belongs to', () => {
            const plan = planMealEntryEdit(storedEntry(), {
                servings: 1.5,
                name: 'Renamed',
                calories: 1,
                protein: 2,
                carbs: 3,
                fat: 4,
            });

            expect(plan.fields).toStrictEqual({
                servings: 1.5,
                name: 'Renamed',
                calories: 1,
                protein_g: 2,
                carbs_g: 3,
                fat_g: 4,
            });
        });

        it('omits every column the request did not mention', () => {
            const plan = planMealEntryEdit(storedEntry(), { carbs: 50 });

            expect(Object.keys(plan.fields)).toStrictEqual(['carbs_g']);
        });

        it('writes servings exactly as sent, because how much was eaten is not rounded', () => {
            expect(planMealEntryEdit(storedEntry(), { servings: 0.33 }).fields.servings).toBe(0.33);
        });

        it('passes a name that is not a string straight through', () => {
            // This route has never validated its body, so a non-string `name` is
            // reachable and the shipped writer answered it with a 500 (it called
            // `.trim()` on it). Passing it through keeps that answer — Prisma
            // refuses it at the `String` column — where coercing it to '42' would
            // store a name the caller never sent and dropping it would turn a
            // broken request into a silent success. The cast is the point: only
            // an untyped body can get here.
            const plan = planMealEntryEdit(storedEntry(), { name: 42 as unknown as string });

            expect(plan.fields.name).toBe(42);
            expect(plan.detachesFromSource).toBe(true);
        });
    });

    describe('what a detached entry keeps', () => {
        it('clears all three links and falls back to the client-entered classes', () => {
            expect(DETACHED_ENTRY_SNAPSHOT).toStrictEqual({
                meal_plan_meal_id: null,
                catalog_food_id: null,
                recipe_version_id: null,
                input_method: 'library',
                nutrition_provenance: 'user_entered',
            });
        });

        it('falls back to values an older client already decodes', () => {
            // 'library' is the column default and a method a body could have
            // asked for anyway; 'user_entered' renders no source label. Neither
            // adds a wire value a shipped client has not seen.
            expect(DETACHED_ENTRY_SNAPSHOT.input_method).toBe(DEFAULT_INPUT_METHOD);
            expect(DETACHED_ENTRY_SNAPSHOT.nutrition_provenance).toBe(CLIENT_SNAPSHOT_PROVENANCE);
            expect(DETACHED_ENTRY_SNAPSHOT.input_method).not.toBe(PLANNED_INPUT_METHOD);
        });
    });
});
