// The weigh-in write contract, as a unit: what `POST /api/weigh-in` accepts,
// what it refuses, and WHICH of its two 400 bodies each refusal earns.
//
// The split is the whole point of this suite. The guard the endpoint shipped
// with keeps a frozen message-only body, because every client that has ever
// sent a zero, a negative or an unparsable date has been shown that exact
// sentence; the bound this release adds — a weight past
// MAX_WEIGH_IN_MAGNITUDE, which used to be accepted and STORED — is the
// `400 invalid_request` envelope §0.5.2 specifies. A rewrite that collapsed the
// two into one body would pass a test that only asserted "400" and would change
// a live response, so every case here asserts the verdict code as well.

import {
    LOGGED_AT_FIELD,
    MAX_WEIGH_IN_MAGNITUDE,
    ParsedWeighInBody,
    WEIGHT_FIELD,
    WEIGH_IN_FIELD_CODES,
    WEIGH_IN_RANGE_MESSAGE,
    WEIGH_IN_REQUIRED_MESSAGE,
    WEIGH_IN_ID_FIELD,
    ParsedWeighInPath,
    parseWeighInBody,
    parseWeighInPath,
} from '../weighIn.logic';

/** A well-formed body, the shape the shipped app posts. */
const validBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    weight: 180,
    loggedAt: '2026-09-19T12:00:00.000Z',
    ...overrides,
});

const asOk = (verdict: ParsedWeighInBody): Extract<ParsedWeighInBody, { kind: 'ok' }> => {
    if (verdict.kind !== 'ok') {
        throw new Error(`expected an accepted body, got ${verdict.kind}/${verdict.code}`);
    }

    return verdict;
};

const asError = (verdict: ParsedWeighInBody): Extract<ParsedWeighInBody, { kind: 'error' }> => {
    if (verdict.kind !== 'error') {
        throw new Error('expected a refusal, got an accepted body');
    }

    return verdict;
};

/** `field:code` pairs, so a case reads as the wire detail it produces. */
const fieldCodes = (verdict: ParsedWeighInBody): string[] =>
    asError(verdict).details.map((detail) => `${detail.field}:${detail.code}`);

describe('parseWeighInBody', () => {
    describe('a body the endpoint accepts', () => {
        it('returns the coerced weight and the parsed instant', () => {
            const parsed = asOk(parseWeighInBody(validBody()));

            expect(parsed.weight).toBe(180);
            expect(parsed.loggedAt.toISOString()).toBe('2026-09-19T12:00:00.000Z');
        });

        it('keeps the shipped numeric-string coercion, so a live client is not broken', () => {
            // The guard has always been Number(weight): a client sending "180.5"
            // is accepted and stored, and tightening that to typeof === 'number'
            // would refuse requests that are in flight today.
            expect(asOk(parseWeighInBody(validBody({ weight: '180.5' }))).weight).toBe(180.5);
        });

        it('accepts an epoch-millisecond loggedAt, which new Date parses as an instant', () => {
            const parsed = asOk(parseWeighInBody(validBody({ loggedAt: 1_789_000_000_000 })));

            expect(parsed.loggedAt.toISOString()).toBe(new Date(1_789_000_000_000).toISOString());
        });

        it('accepts a loggedAt of null, because new Date(null) is the epoch', () => {
            // Pinned as current behaviour rather than endorsed: `null` coerces to
            // 0 and stores 1970-01-01. Refusing it would be a new verdict on a
            // body the endpoint accepts today.
            expect(asOk(parseWeighInBody(validBody({ loggedAt: null }))).loggedAt.getTime()).toBe(0);
        });

        it.each([
            ['the smallest positive weight', 0.1],
            ['the bound itself', MAX_WEIGH_IN_MAGNITUDE],
            ['just inside the bound', MAX_WEIGH_IN_MAGNITUDE - 0.5],
        ])('accepts %s', (_case, weight) => {
            expect(asOk(parseWeighInBody(validBody({ weight }))).weight).toBe(weight);
        });

        it('accepts every real reading in every unit the app offers', () => {
            // The bound is unit-agnostic on purpose: the column records whatever
            // unit the client is set to, so 300 kg, its 661 lb and its 47 st must
            // all pass the same cap.
            for (const weight of [300, 661, 47]) {
                expect(parseWeighInBody(validBody({ weight })).kind).toBe('ok');
            }
        });
    });

    describe('the frozen guard', () => {
        it.each([
            ['zero', 0],
            ['a negative weight', -5],
            ['a non-numeric string', 'heavy'],
            ['NaN over the wire as null', null],
            ['an object', {}],
            ['Infinity as a string', 'Infinity'],
        ])('refuses %s with the message-only body', (_case, weight) => {
            const verdict = asError(parseWeighInBody(validBody({ weight })));

            expect(verdict.code).toBe('weigh_in_fields_required');
            expect(verdict.message).toBe(WEIGH_IN_REQUIRED_MESSAGE);
            expect(fieldCodes(verdict)).toStrictEqual([`${WEIGHT_FIELD}:${WEIGH_IN_FIELD_CODES.REQUIRED}`]);
        });

        it('refuses a missing weight', () => {
            const verdict = asError(parseWeighInBody({ loggedAt: '2026-09-19T12:00:00.000Z' }));

            expect(verdict.code).toBe('weigh_in_fields_required');
            expect(fieldCodes(verdict)).toStrictEqual([`${WEIGHT_FIELD}:${WEIGH_IN_FIELD_CODES.REQUIRED}`]);
        });

        it.each([
            ['an unparsable date', 'not-a-date'],
            ['an absent date', undefined],
            ['an object', { when: 'now' }],
        ])('refuses %s as loggedAt', (_case, loggedAt) => {
            const verdict = asError(parseWeighInBody(validBody({ loggedAt })));

            expect(verdict.code).toBe('weigh_in_fields_required');
            expect(fieldCodes(verdict)).toStrictEqual([`${LOGGED_AT_FIELD}:${WEIGH_IN_FIELD_CODES.REQUIRED}`]);
        });

        it('reports both fields of one body at once', () => {
            expect(fieldCodes(parseWeighInBody({ weight: 0, loggedAt: 'nope' }))).toStrictEqual([
                `${WEIGHT_FIELD}:${WEIGH_IN_FIELD_CODES.REQUIRED}`,
                `${LOGGED_AT_FIELD}:${WEIGH_IN_FIELD_CODES.REQUIRED}`,
            ]);
        });

        it.each([
            ['null', null],
            ['undefined', undefined],
            ['an array', [180]],
            ['a number', 180],
            ['a string', 'weight=180'],
        ])('refuses a body that is %s rather than throwing', (_case, body) => {
            const verdict = asError(parseWeighInBody(body));

            expect(verdict.code).toBe('weigh_in_fields_required');
            expect(verdict.message).toBe(WEIGH_IN_REQUIRED_MESSAGE);
        });

        it('answers the frozen guard first when a body fails both ways', () => {
            // A body whose weight is unusable AND out of range is told about the
            // guard, so the response it earns today does not change.
            const verdict = asError(parseWeighInBody(validBody({ weight: -1e308 })));

            expect(verdict.code).toBe('weigh_in_fields_required');
        });
    });

    describe('the magnitude bound', () => {
        it.each([
            ['1e308, the value QA stored', 1e308],
            ['just past the bound', MAX_WEIGH_IN_MAGNITUDE + 1],
            ['1e15', 1e15],
            ['999999', 999999],
        ])('refuses %s with the invalid_request envelope', (_case, weight) => {
            const verdict = asError(parseWeighInBody(validBody({ weight })));

            expect(verdict.code).toBe('invalid_request');
            expect(verdict.message).toBe(WEIGH_IN_RANGE_MESSAGE);
            expect(fieldCodes(verdict)).toStrictEqual([`${WEIGHT_FIELD}:${WEIGH_IN_FIELD_CODES.OUT_OF_RANGE}`]);
        });

        it('applies to a numeric string too, since the coercion runs first', () => {
            expect(asError(parseWeighInBody(validBody({ weight: '1e308' }))).code).toBe('invalid_request');
        });

        it('states the bound in its message, so the caller learns the window', () => {
            expect(WEIGH_IN_RANGE_MESSAGE).toBe(`weight must be at most ${MAX_WEIGH_IN_MAGNITUDE}`);
            expect(MAX_WEIGH_IN_MAGNITUDE).toBe(2000);
        });
    });
});

// The `:id` path segment of `DELETE /api/weigh-in/:id`.
//
// This closed a measured 500: the raw segment reached
// `body_weight_entries.deleteMany()` and the connector threw P2023 ("Error
// creating UUID, invalid character"), which the handler answered as
// `500 {"error":"Failed to delete weigh-in"}` while logging the raw Prisma
// error. §0.5.2 requires `400 invalid_request` with a field code, which is what
// the diary's entry routes and the food routes already answer for the same
// input, so the three families now refuse identically.
describe('parseWeighInPath', () => {
    const errorVerdict = (id: unknown): Extract<ParsedWeighInPath, { kind: 'error' }> => {
        const parsed = parseWeighInPath(id);
        if (parsed.kind !== 'error') {
            throw new Error(`expected a refusal for ${JSON.stringify(id)}`);
        }
        return parsed;
    };

    it('accepts a canonical uuid and hands back the same string', () => {
        const id = '26e3f146-bca2-45af-a30c-69f462190536';
        expect(parseWeighInPath(id)).toEqual({ kind: 'ok', id });
    });

    it('accepts an upper-case uuid, because PostgreSQL does', () => {
        const id = '26E3F146-BCA2-45AF-A30C-69F462190536';
        expect(parseWeighInPath(id)).toEqual({ kind: 'ok', id });
    });

    it.each([
        ['a bare word', 'not-a-uuid'],
        ['an empty segment', ''],
        ['a uuid missing its last group', '26e3f146-bca2-45af-a30c'],
        ['a uuid with an extra group', '26e3f146-bca2-45af-a30c-69f462190536-0000'],
        ['a non-hex character', '26e3f146-bca2-45af-a30c-69f46219053g'],
        ['the urn form PostgreSQL tolerates but this contract does not', 'urn:uuid:26e3f146-bca2-45af-a30c-69f462190536'],
        ['surrounding whitespace', ' 26e3f146-bca2-45af-a30c-69f462190536 '],
        ['a number', 42],
        ['null', null],
        ['undefined, which is what an unrouted segment yields', undefined],
        ['an object', { id: '26e3f146-bca2-45af-a30c-69f462190536' }],
    ])('refuses %s', (_label, id) => {
        expect(parseWeighInPath(id).kind).toBe('error');
    });

    it('reports the §0.5.2 envelope: invalid_request naming the id field', () => {
        const verdict = errorVerdict('not-a-uuid');
        expect(verdict.code).toBe('invalid_request');
        expect(verdict.details).toEqual([{ field: WEIGH_IN_ID_FIELD, code: WEIGH_IN_FIELD_CODES.INVALID_ID }]);
    });

    it('spells the code exactly as the other route families spell it', () => {
        expect(WEIGH_IN_FIELD_CODES.INVALID_ID).toBe('invalid_id');
        expect(WEIGH_IN_ID_FIELD).toBe('id');
    });
});
