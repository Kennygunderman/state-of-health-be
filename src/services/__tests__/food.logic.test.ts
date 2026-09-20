// The personal-food write contract, as a unit: what `POST /api/foods` and
// `PUT /api/foods/:id` accept, what they refuse, and which of the two 400
// bodies each refusal earns.
//
// WHAT EACH CASE IS PINNING.
//
//  - **The frozen create sentence.** Every client that has sent a nameless or
//    non-numeric create body has read `name, calories, protein, carbs, and fat
//    are required`, with no machine code beside it. A rewrite that answered the
//    §0.5.2 envelope there instead would change a shipped response, so the
//    verdict CODE is asserted and not merely the 400.
//  - **The numeric-string coercion.** `Number(value)`, not `typeof value ===
//    'number'`: a macro sent as `"220"` has always been accepted and the writer
//    rounds it identically, so tightening it would refuse live requests.
//  - **The bounds that replace a 500.** `foods`' four macro columns are `int4`
//    and `serving_amount` is `double precision`; an unbounded value was rounded
//    into the column and came back as this route's 500. Those are the only
//    responses these parsers change.
//  - **The update route's partial contract.** An absent key is a column the
//    request does not mention, so every field is judged only when the body
//    names it — and a body naming nothing is still the no-op the route answers
//    today, which is what keeps a client that sends `{}` working.
//  - **Which failures the two routes judge alike.** The `foods` row is the same
//    row either way, so a value the create route refuses must not be writable
//    through an update instead. The shared cases are driven through both
//    parsers rather than asserted once.

import {
    FOOD_FIELD_CODES,
    FOOD_MACRO_FIELDS,
    FOOD_NAME_FIELD,
    FOOD_REQUIRED_MESSAGE,
    FOOD_SERVING_AMOUNT_FIELD,
    FoodErrorVerdict,
    MAX_FOOD_MACRO_MAGNITUDE,
    MAX_FOOD_NAME_LENGTH,
    MAX_SERVING_AMOUNT,
    ParsedCreateFood,
    ParsedFoodPath,
    ParsedUpdateFood,
    parseCreateFoodBody,
    parseFoodPath,
    parseUpdateFoodBody,
} from '../food.logic';

/** A well-formed create body, the shape the shipped app posts. */
const validBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'Greek yogurt',
    calories: 120,
    protein: 20,
    carbs: 7,
    fat: 0,
    ...overrides,
});

type AnyVerdict = ParsedCreateFood | ParsedUpdateFood | ParsedFoodPath;

const asError = (verdict: AnyVerdict): FoodErrorVerdict => {
    if (verdict.kind !== 'error') {
        throw new Error('expected a refusal, received an accepted body');
    }

    return verdict;
};

/** `field:code` pairs in the order the parser reported them. */
const fieldCodes = (verdict: AnyVerdict): string[] =>
    asError(verdict).details.map((detail) => `${detail.field}:${detail.code}`);

describe('parseCreateFoodBody', () => {
    describe('the frozen guard', () => {
        it('accepts the minimal body and hands it on by identity', () => {
            // Not a rebuilt object: `createFood` reads `servingUnit`, `brand`
            // and `source` itself and applies its own defaults and whitelist, so
            // a parser that rebuilt the payload would silently drop them.
            const body = validBody();
            const verdict = parseCreateFoodBody(body);

            expect(verdict.kind).toBe('ok');
            expect(verdict.kind === 'ok' && verdict.payload).toBe(body);
        });

        it.each([
            ['an absent name', { name: undefined }, 'name'],
            ['a blank name', { name: '   ' }, 'name'],
            ['a name that is not a string', { name: 42 }, 'name'],
            ['a name explicitly nulled', { name: null }, 'name'],
            ['calories that do not coerce', { calories: 'lots' }, 'calories'],
            ['protein sent as an object', { protein: {} }, 'protein'],
            ['carbs sent as NaN over the wire', { carbs: 'NaN' }, 'carbs'],
            ['fat sent as Infinity', { fat: Number.POSITIVE_INFINITY }, 'fat'],
        ])('refuses %s with the frozen message-only verdict', (_case, overrides, field) => {
            const verdict = asError(parseCreateFoodBody(validBody(overrides)));

            expect(verdict.code).toBe('food_fields_required');
            expect(verdict.message).toBe(FOOD_REQUIRED_MESSAGE);
            expect(fieldCodes(verdict)).toStrictEqual([`${field}:${FOOD_FIELD_CODES.REQUIRED}`]);
        });

        it('reports every missing field at once, in the order the message lists them', () => {
            expect(fieldCodes(parseCreateFoodBody({}))).toStrictEqual([
                'name:required',
                'calories:required',
                'protein:required',
                'carbs:required',
                'fat:required',
            ]);
        });

        it.each([
            ['null', null],
            ['undefined', undefined],
            ['an array', [validBody()]],
            ['a number', 7],
            ['a string', 'name=eggs'],
        ])('refuses a body that is %s rather than throwing', (_case, body) => {
            expect(asError(parseCreateFoodBody(body)).code).toBe('food_fields_required');
        });

        it.each([
            ['a numeric string, which the writer rounds identically', '220'],
            ['null, which coerces to zero', null],
            ['a boolean, which coerces to one', true],
            ['an empty string, which coerces to zero', ''],
            ['zero, because black coffee is a real food', 0],
            ['a negative macro, which this table has never bounded by sign', -220],
        ])('keeps accepting calories sent as %s', (_case, calories) => {
            expect(parseCreateFoodBody(validBody({ calories })).kind).toBe('ok');
        });

        it('answers the frozen guard before the bounds', () => {
            // A body wrong both ways keeps the response it earns today.
            const verdict = asError(parseCreateFoodBody(validBody({ name: '  ', calories: 1e308 })));

            expect(verdict.code).toBe('food_fields_required');
        });
    });

    describe('the stored bounds', () => {
        it.each(FOOD_MACRO_FIELDS)('refuses a %s past the stored magnitude', (field) => {
            for (const value of [MAX_FOOD_MACRO_MAGNITUDE + 1, 1e308, -1e308, 2147483648]) {
                const verdict = asError(parseCreateFoodBody(validBody({ [field]: value })));

                expect(verdict.code).toBe('invalid_request');
                expect(fieldCodes(verdict)).toStrictEqual([`${field}:${FOOD_FIELD_CODES.OUT_OF_RANGE}`]);
            }
        });

        it('accepts a macro at the bound itself', () => {
            expect(parseCreateFoodBody(validBody({ calories: MAX_FOOD_MACRO_MAGNITUDE })).kind).toBe('ok');
        });

        it('states the bound in its message', () => {
            expect(asError(parseCreateFoodBody(validBody({ calories: 1e308 }))).message).toBe(
                `calories must be between -${MAX_FOOD_MACRO_MAGNITUDE} and ${MAX_FOOD_MACRO_MAGNITUDE}`,
            );
        });

        it.each([
            ['past its bound', MAX_SERVING_AMOUNT + 1, FOOD_FIELD_CODES.OUT_OF_RANGE],
            ['1e308', 1e308, FOOD_FIELD_CODES.OUT_OF_RANGE],
            ['not a number at all', 'four', FOOD_FIELD_CODES.INVALID_TYPE],
            ['an object', {}, FOOD_FIELD_CODES.INVALID_TYPE],
        ])('refuses a servingAmount that is %s', (_case, servingAmount, code) => {
            expect(fieldCodes(parseCreateFoodBody(validBody({ servingAmount })))).toStrictEqual([
                `${FOOD_SERVING_AMOUNT_FIELD}:${code}`,
            ]);
        });

        it.each([
            ['absent', undefined],
            ['null, which the writer defaults to one', null],
            ['a fraction', 0.5],
            ['the bound itself', MAX_SERVING_AMOUNT],
        ])('accepts a servingAmount that is %s', (_case, servingAmount) => {
            expect(parseCreateFoodBody(validBody({ servingAmount })).kind).toBe('ok');
        });

        it('refuses a name past the stored cap', () => {
            const verdict = asError(parseCreateFoodBody(validBody({ name: 'x'.repeat(MAX_FOOD_NAME_LENGTH + 1) })));

            expect(verdict.code).toBe('invalid_request');
            expect(verdict.message).toBe(`name must be at most ${MAX_FOOD_NAME_LENGTH} characters`);
            expect(fieldCodes(verdict)).toStrictEqual([`${FOOD_NAME_FIELD}:${FOOD_FIELD_CODES.INVALID_LENGTH}`]);
        });

        it.each([
            ['the cap itself', MAX_FOOD_NAME_LENGTH],
            ['the longest USDA-derived name this repository carries', 184],
        ])('accepts a name of %s characters', (_case, length) => {
            expect(parseCreateFoodBody(validBody({ name: 'x'.repeat(length) })).kind).toBe('ok');
        });

        it('measures the name cap after the trim the writer applies', () => {
            const padded = `  ${'x'.repeat(MAX_FOOD_NAME_LENGTH)}  `;

            expect(parseCreateFoodBody(validBody({ name: padded })).kind).toBe('ok');
        });

        it('reports every offending field of one body at once, in column order', () => {
            const verdict = parseCreateFoodBody(
                validBody({
                    name: 'x'.repeat(MAX_FOOD_NAME_LENGTH + 1),
                    calories: 1e308,
                    fat: 1e308,
                    servingAmount: 1e308,
                }),
            );

            expect(fieldCodes(verdict)).toStrictEqual([
                'name:invalid_length',
                'calories:out_of_range',
                'fat:out_of_range',
                'servingAmount:out_of_range',
            ]);
        });
    });
});

describe('parseUpdateFoodBody', () => {
    it.each([
        ['an empty object, which writes no column', {}],
        ['a name-only edit', { name: 'Skyr' }],
        ['a macro-only edit', { calories: 130 }],
        ['a macro sent as a numeric string', { calories: '130' }],
        ['a macro explicitly nulled, which the writer rounds to zero', { calories: null }],
        ['a servingUnit edit, which this parser does not judge', { servingUnit: 'cup' }],
        ['a brand cleared, which is a nullable column', { brand: null }],
        ['a name at the stored cap', { name: 'x'.repeat(MAX_FOOD_NAME_LENGTH) }],
        ['a servingAmount inside its bound', { servingAmount: 2 }],
    ])('hands %s through unchanged', (_case, body) => {
        const verdict = parseUpdateFoodBody(body);

        expect(verdict.kind).toBe('ok');
        expect(verdict.kind === 'ok' && verdict.payload).toBe(body);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['an array', [{ name: 'Skyr' }]],
        ['a string', 'name=Skyr'],
    ])('treats a body that is %s as an empty edit rather than a refusal', (_case, body) => {
        const verdict = parseUpdateFoodBody(body);

        expect(verdict.kind).toBe('ok');
        expect(verdict.kind === 'ok' && verdict.payload).toStrictEqual({});
    });

    it.each([
        ['a name that is not a string, which used to be a TypeError', { name: 123 }, 'name:invalid_type'],
        ['a name explicitly nulled', { name: null }, 'name:invalid_type'],
        ['a name past the stored cap', { name: 'x'.repeat(301) }, 'name:invalid_length'],
        ['a macro that does not coerce', { calories: 'x' }, 'calories:invalid_type'],
        ['a macro past the stored magnitude', { protein: 1e308 }, 'protein:out_of_range'],
        ['a servingAmount that does not coerce', { servingAmount: 'two' }, 'servingAmount:invalid_type'],
        ['a servingAmount past its bound', { servingAmount: 1e308 }, 'servingAmount:out_of_range'],
        ['a servingAmount nulled, which the NOT NULL column refuses', { servingAmount: null }, 'servingAmount:invalid_type'],
    ])('refuses %s with the invalid_request envelope', (_case, body, detail) => {
        const verdict = asError(parseUpdateFoodBody(body));

        expect(verdict.code).toBe('invalid_request');
        expect(fieldCodes(verdict)).toStrictEqual([detail]);
    });

    it('reports every offending field of one body at once, in column order', () => {
        expect(
            fieldCodes(parseUpdateFoodBody({ name: 123, carbs: 'x', fat: 1e308, servingAmount: null })),
        ).toStrictEqual([
            'name:invalid_type',
            'carbs:invalid_type',
            'fat:out_of_range',
            'servingAmount:invalid_type',
        ]);
    });

    it('never answers the frozen create sentence, which belongs to the other route', () => {
        // The update route has no required fields — an absent key is a column it
        // leaves alone — so it can only ever produce the envelope verdict.
        for (const body of [{}, { name: 123 }, { calories: 1e308 }]) {
            const verdict = parseUpdateFoodBody(body);

            expect(verdict.kind === 'error' ? verdict.code : 'ok').not.toBe('food_fields_required');
        }
    });
});

describe('the bounds both routes share', () => {
    // The `foods` row is the same row either way, so a value one route refuses
    // must not be writable through the other.
    it.each([
        ['a macro past the stored magnitude', { calories: 1e308 }, 'calories:out_of_range'],
        ['a servingAmount past its bound', { servingAmount: 1e308 }, 'servingAmount:out_of_range'],
        ['a name past the stored cap', { name: 'x'.repeat(301) }, 'name:invalid_length'],
    ])('refuses %s on both routes, with the same detail', (_case, overrides, detail) => {
        expect(fieldCodes(parseCreateFoodBody(validBody(overrides)))).toStrictEqual([detail]);
        expect(fieldCodes(parseUpdateFoodBody(overrides))).toStrictEqual([detail]);
    });
});

// The path the two id-bearing routes read.
//
// Both handlers used to hand `req.params.id` straight to Prisma, so
// `PUT /api/foods/not-a-uuid` answered `500 {"error":"Failed to update food"}`
// (P2023) while `PUT /api/macros/entry/not-a-uuid` answered
// `400 {"error":"invalid_request","details":[{"field":"id","code":"invalid_id"}]}`
// for the same class of input. AAP §0.5.2 requires the typed refusal for every
// path id, so these cases pin that the two route families now agree, and that
// the accepted grammar is the ORM's rather than PostgreSQL's looser `uuid_in`.
describe('parseFoodPath', () => {
    it('accepts a canonical uuid and hands the id on unchanged', () => {
        const verdict = parseFoodPath('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');

        expect(verdict).toStrictEqual({ kind: 'ok', id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' });
    });

    it('accepts an upper-case uuid, because the ORM parser does', () => {
        expect(parseFoodPath('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11').kind).toBe('ok');
    });

    it.each([
        ['an unparsable word', 'not-a-uuid'],
        ['an empty segment', ''],
        ['a uuid missing its last group', 'a0eebc99-9c0b-4ef8-bb6d'],
        ['a uuid with a non-hex digit', 'g0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
        ['an unhyphenated uuid', 'a0eebc999c0b4ef8bb6d6bb9bd380a11'],
        ['a uuid with trailing text', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11x'],
        ['a numeric id', 1234 as unknown as string],
        ['an absent segment', undefined as unknown as string],
        ['a null segment', null as unknown as string],
    ])('refuses %s with the diary routes own field and code', (_case, id) => {
        expect(fieldCodes(parseFoodPath(id))).toStrictEqual(['id:invalid_id']);
    });

    it('reports the refusal as invalid_request, so the wire carries details', () => {
        expect(asError(parseFoodPath('not-a-uuid')).code).toBe('invalid_request');
    });

    it('describes the failure as an id rather than as a numeric range', () => {
        // The shared `boundMessage` default speaks about a macro's range, which
        // would misdescribe a path id; this is what keeps that fallthrough out.
        expect(asError(parseFoodPath('not-a-uuid')).message).toBe('id must be a UUID');
    });
});
