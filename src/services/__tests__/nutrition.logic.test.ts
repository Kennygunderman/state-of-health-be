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
 */

import {
    CLIENT_INPUT_METHODS,
    DEFAULT_INPUT_METHOD,
    ENTRY_INPUT_METHODS,
    PLANNED_INPUT_METHOD,
    ParsedLogEntryBody,
    parseLogEntryBody,
    resolveLegacyInputMethod,
} from '../nutrition.logic';

/** A syntactically valid v4 UUID: version nibble `4`, variant nibble `9`. */
const CATALOG_FOOD_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** The shipped 400 texts. Asserted literally — they are part of the wire contract. */
const LEGACY_REQUIRED_MESSAGE = 'name, calories, protein, carbs, and fat are required';
const CONFLICTING_REFERENCE_MESSAGE = 'foodId and catalogFoodId cannot both be provided';
const UNRECOGNIZED_MESSAGE = 'either catalogFoodId or name, calories, protein, carbs, and fat are required';
const SERVINGS_MESSAGE = 'servings must be a number between 0.25 and 10 with at most 2 decimal places';

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
