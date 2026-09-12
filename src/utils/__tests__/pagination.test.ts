/**
 * `src/utils/pagination.ts` replaces an idiom repeated across six shipped
 * controllers (`parseInt(req.query.page) || 1`), and it changes that idiom's
 * answer in two places on purpose: a `0` is clamped rather than defaulted, and
 * a negative value is clamped rather than passed through to the query. The
 * cases below are chosen for the decisions someone could reverse — the clamps,
 * the first-occurrence-wins reader, the caller-option sanitizing, and the two
 * `totalPages` answers the mobile client's pagination loop and io-ts codec
 * depend on.
 */

import { DEFAULT_LIMIT, DEFAULT_PAGE, MAX_LIMIT, parsePagination, toPaginationBlock } from '../pagination';

describe('parsePagination', () => {
    describe('page', () => {
        it('falls back to the default page when the query names none', () => {
            expect(parsePagination({}).page).toBe(DEFAULT_PAGE);
        });

        it('reads a well-formed page, as Express delivers it', () => {
            expect(parsePagination({ page: '1' }).page).toBe(1);
            expect(parsePagination({ page: '7' }).page).toBe(7);
        });

        it('reads a page a caller has already coerced to a number', () => {
            expect(parsePagination({ page: 4 }).page).toBe(4);
        });

        it('ignores a page that does not parse', () => {
            expect(parsePagination({ page: 'abc' }).page).toBe(DEFAULT_PAGE);
            expect(parsePagination({ page: '' }).page).toBe(DEFAULT_PAGE);
            expect(parsePagination({ page: '   ' }).page).toBe(DEFAULT_PAGE);
        });

        it('clamps a zero page up to the first page', () => {
            expect(parsePagination({ page: '0' }).page).toBe(1);
        });

        it('clamps a negative page up to the first page', () => {
            expect(parsePagination({ page: '-3' }).page).toBe(1);
            expect(parsePagination({ page: '-100000' }).page).toBe(1);
        });

        it('truncates a fractional page rather than rejecting it', () => {
            // `parseInt` truncation, kept deliberately so the parser answers
            // exactly what the six shipped controllers answer today. Do not
            // "correct" it into rounding: 2.7 must stay page 2.
            expect(parsePagination({ page: '2.7' }).page).toBe(2);
            expect(parsePagination({ page: '2abc' }).page).toBe(2);
        });

        it('takes the first occurrence of a repeated page parameter', () => {
            expect(parsePagination({ page: ['3', '9'] }).page).toBe(3);
        });
    });

    describe('limit', () => {
        it('falls back to the default limit when the query names none', () => {
            expect(parsePagination({}).limit).toBe(DEFAULT_LIMIT);
        });

        it('ignores a limit that does not parse', () => {
            expect(parsePagination({ limit: 'abc' }).limit).toBe(DEFAULT_LIMIT);
        });

        it('passes a limit inside the supported range through untouched', () => {
            expect(parsePagination({ limit: '1' }).limit).toBe(1);
            expect(parsePagination({ limit: '50' }).limit).toBe(50);
        });

        it('caps a limit above the shared maximum of 50', () => {
            expect(MAX_LIMIT).toBe(50);
            expect(parsePagination({ limit: '51' }).limit).toBe(50);
            expect(parsePagination({ limit: '1000' }).limit).toBe(50);
        });

        it('clamps a zero or negative limit up to one row, not to the default', () => {
            expect(parsePagination({ limit: '0' }).limit).toBe(1);
            expect(parsePagination({ limit: '-5' }).limit).toBe(1);
        });

        it('takes the first occurrence of a repeated limit parameter', () => {
            expect(parsePagination({ limit: ['10', '50'] }).limit).toBe(10);
        });
    });

    describe('options', () => {
        it('uses the caller default when the request names no limit', () => {
            expect(parsePagination({}, { defaultLimit: 12, maxLimit: 30 }).limit).toBe(12);
        });

        it('applies the caller maximum to a requested limit', () => {
            expect(parsePagination({ limit: '31' }, { defaultLimit: 12, maxLimit: 30 }).limit).toBe(30);
        });

        it('keeps the shared maximum when the caller names only a default', () => {
            expect(parsePagination({}, { defaultLimit: 30 }).limit).toBe(30);
            expect(parsePagination({ limit: '51' }, { defaultLimit: 30 }).limit).toBe(50);
        });

        it('clamps a caller default above the maximum down to it', () => {
            expect(parsePagination({}, { defaultLimit: 100 }).limit).toBe(50);
            expect(parsePagination({}, { defaultLimit: 100, maxLimit: 30 }).limit).toBe(30);
        });

        it('sanitizes a non-positive or fractional caller default', () => {
            expect(parsePagination({}, { defaultLimit: 0 }).limit).toBe(1);
            expect(parsePagination({}, { defaultLimit: -5 }).limit).toBe(1);
            expect(parsePagination({}, { defaultLimit: 10.7 }).limit).toBe(10);
        });

        it('falls back to the module default when the caller default is not finite', () => {
            expect(parsePagination({}, { defaultLimit: Number.NaN }).limit).toBe(DEFAULT_LIMIT);
            expect(parsePagination({}, { defaultLimit: Number.POSITIVE_INFINITY }).limit).toBe(DEFAULT_LIMIT);
        });

        it('sanitizes a non-positive caller maximum to one row', () => {
            expect(parsePagination({ limit: '25' }, { maxLimit: 0 }).limit).toBe(1);
            expect(parsePagination({ limit: '25' }, { maxLimit: -1 }).limit).toBe(1);
        });

        it('falls back to the module maximum when the caller maximum is not finite', () => {
            expect(parsePagination({ limit: '999' }, { maxLimit: Number.NaN }).limit).toBe(50);
            expect(parsePagination({ limit: '999' }, { maxLimit: Number.POSITIVE_INFINITY }).limit).toBe(50);
        });
    });

    describe('contract shape', () => {
        it('returns a page and a limit only, with the options argument omitted', () => {
            expect(parsePagination({})).toEqual({ page: DEFAULT_PAGE, limit: DEFAULT_LIMIT });
        });

        it('treats an empty options object as no options at all', () => {
            expect(parsePagination({ limit: '999' }, {})).toEqual({ page: DEFAULT_PAGE, limit: 50 });
        });
    });

    describe('hostile input', () => {
        it('returns the defaults for members of the wrong type, and never throws', () => {
            const query = { page: {}, limit: [] };

            expect(() => parsePagination(query)).not.toThrow();
            expect(parsePagination(query)).toEqual({ page: DEFAULT_PAGE, limit: DEFAULT_LIMIT });
            expect(parsePagination({ page: true, limit: false })).toEqual({
                page: DEFAULT_PAGE,
                limit: DEFAULT_LIMIT,
            });
        });

        it('treats null and undefined members as absent', () => {
            expect(parsePagination({ page: null, limit: undefined })).toEqual({
                page: DEFAULT_PAGE,
                limit: DEFAULT_LIMIT,
            });
            expect(parsePagination({ page: undefined, limit: null })).toEqual({
                page: DEFAULT_PAGE,
                limit: DEFAULT_LIMIT,
            });
        });
    });
});

describe('toPaginationBlock', () => {
    describe('totalPages', () => {
        it('reports no pages for an empty result set', () => {
            // Not 1. The mobile client pages while `page < totalPages`, so a
            // phantom first page would make every empty list fetch a second.
            expect(toPaginationBlock(0, 1, 25)).toEqual({ page: 1, limit: 25, total: 0, totalPages: 0 });
        });

        it('rounds a partial last page up', () => {
            expect(toPaginationBlock(1, 1, 25).totalPages).toBe(1);
            expect(toPaginationBlock(26, 1, 25).totalPages).toBe(2);
            expect(toPaginationBlock(51, 1, 25).totalPages).toBe(3);
        });

        it('adds no page for an exact multiple of the limit', () => {
            expect(toPaginationBlock(25, 1, 25).totalPages).toBe(1);
            expect(toPaginationBlock(50, 1, 25).totalPages).toBe(2);
        });

        it('reports no pages for a non-positive limit instead of Infinity', () => {
            // `JSON.stringify(Infinity)` emits `null`, and a null `totalPages`
            // fails the client's `io.number` codec for the whole response.
            expect(toPaginationBlock(100, 1, 0).totalPages).toBe(0);
            expect(toPaginationBlock(100, 1, -5).totalPages).toBe(0);
        });
    });

    describe('the wire block', () => {
        it('echoes the total, page and limit it was given without re-clamping them', () => {
            expect(toPaginationBlock(100, 2, 25)).toEqual({ page: 2, limit: 25, total: 100, totalPages: 4 });
            expect(toPaginationBlock(10, 7, 3)).toEqual({ page: 7, limit: 3, total: 10, totalPages: 4 });
        });

        it('emits the four keys the client decodes, in the order the shipped endpoints emit them', () => {
            expect(Object.keys(toPaginationBlock(100, 2, 25))).toEqual(['page', 'limit', 'total', 'totalPages']);
        });
    });
});
