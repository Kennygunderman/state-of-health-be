/**
 * `src/utils/pagination.ts` is the one shared offset parser every paginated
 * endpoint uses, so the cases worth pinning are the hostile ones: a stale
 * `limit` in a saved client request, a repeated query parameter, and a caller
 * that passes its own bound as `0` or `NaN`. Each of those has a specific
 * answer — clamp, first-occurrence-wins, sanitize — and each would be a real
 * production bug if it changed (an unbounded `limit`, a `null` in the wire
 * block, an infinite page count).
 */

import {
    DEFAULT_LIMIT,
    DEFAULT_PAGE,
    MAX_LIMIT,
    parsePagination,
    toPaginationBlock,
} from '../pagination';

describe('parsePagination — defaults', () => {
    it('falls back to page 1 and the default limit for an empty query', () => {
        expect(parsePagination({})).toEqual({ page: DEFAULT_PAGE, limit: DEFAULT_LIMIT });
    });

    it('treats undefined members as absent', () => {
        expect(parsePagination({ page: undefined, limit: undefined })).toEqual({
            page: DEFAULT_PAGE,
            limit: DEFAULT_LIMIT,
        });
    });

    it('reads well-formed string parameters, as Express delivers them', () => {
        expect(parsePagination({ page: '3', limit: '10' })).toEqual({ page: 3, limit: 10 });
    });

    it('reads numeric parameters too, for a caller that already coerced them', () => {
        expect(parsePagination({ page: 4, limit: 5 })).toEqual({ page: 4, limit: 5 });
    });
});

describe('parsePagination — repeated parameters', () => {
    it.each([
        ['page', { page: ['3', '9'] }, { page: 3, limit: DEFAULT_LIMIT }],
        ['limit', { limit: ['10', '50'] }, { page: DEFAULT_PAGE, limit: 10 }],
    ])('takes the first occurrence of a repeated %s', (_case, query, expected) => {
        // `?page=3&page=9` arrives as an array through `qs`. Taking the last
        // would let an appended parameter override an earlier one, and reading
        // the array itself would stringify to "3,9" and parse as 3 by accident.
        expect(parsePagination(query)).toEqual(expected);
    });

    it('falls back to the defaults for an empty array', () => {
        expect(parsePagination({ page: [], limit: [] })).toEqual({
            page: DEFAULT_PAGE,
            limit: DEFAULT_LIMIT,
        });
    });
});

describe('parsePagination — values that do not parse', () => {
    it.each([
        ['a word', 'abc'],
        ['a blank string', ''],
        ['whitespace', '   '],
        ['null', null],
        ['an object', { page: 2 }],
        ['a boolean', true],
    ])('ignores %s and uses the default page', (_case, value) => {
        expect(parsePagination({ page: value }).page).toBe(DEFAULT_PAGE);
    });

    it.each([
        ['a word', 'abc'],
        ['null', null],
    ])('ignores %s and uses the default limit', (_case, value) => {
        expect(parsePagination({ limit: value }).limit).toBe(DEFAULT_LIMIT);
    });

    it('truncates a numeric prefix rather than rejecting it', () => {
        expect(parsePagination({ page: '2abc', limit: '10.9' })).toEqual({ page: 2, limit: 10 });
    });
});

describe('parsePagination — out-of-range values', () => {
    it.each([
        ['zero', '0'],
        ['negative', '-5'],
        ['deeply negative', '-100000'],
    ])('clamps a %s page up to the first page', (_case, page) => {
        expect(parsePagination({ page }).page).toBe(DEFAULT_PAGE);
    });

    it('clamps a limit above the maximum down to it', () => {
        expect(parsePagination({ limit: '999' }).limit).toBe(MAX_LIMIT);
    });

    it.each([
        ['zero', '0'],
        ['negative', '-10'],
    ])('clamps a %s limit up to one row', (_case, limit) => {
        // Never 0: a zero limit reaches `Math.ceil(total / limit)` as Infinity
        // and serialises as null in the response block.
        expect(parsePagination({ limit }).limit).toBe(1);
    });

    it('accepts the maximum itself', () => {
        expect(parsePagination({ limit: String(MAX_LIMIT) }).limit).toBe(MAX_LIMIT);
    });
});

describe('parsePagination — caller options', () => {
    it('uses the caller default when the request names no limit', () => {
        expect(parsePagination({}, { defaultLimit: 10 }).limit).toBe(10);
    });

    it('applies the caller maximum to a requested limit', () => {
        expect(parsePagination({ limit: '40' }, { maxLimit: 20 }).limit).toBe(20);
    });

    it('clamps the caller default to the caller maximum', () => {
        // An endpoint declaring `defaultLimit: 100, maxLimit: 30` is a
        // configuration mistake; answering 100 rows would break its own bound.
        expect(parsePagination({}, { defaultLimit: 100, maxLimit: 30 }).limit).toBe(30);
    });

    it.each([
        ['zero', 0, 1],
        ['negative', -5, 1],
        ['fractional', 10.7, 10],
    ])('sanitizes a %s caller default', (_case, defaultLimit, expected) => {
        expect(parsePagination({}, { defaultLimit }).limit).toBe(expected);
    });

    it.each([
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('falls back to the module default when the caller default is %s', (_case, defaultLimit) => {
        expect(parsePagination({}, { defaultLimit }).limit).toBe(DEFAULT_LIMIT);
    });

    it.each([
        ['zero', 0, 1],
        ['negative', -1, 1],
    ])('sanitizes a %s caller maximum to one row', (_case, maxLimit, expected) => {
        expect(parsePagination({ limit: '25' }, { maxLimit }).limit).toBe(expected);
    });

    it.each([
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('falls back to the module maximum when the caller maximum is %s', (_case, maxLimit) => {
        expect(parsePagination({ limit: '999' }, { maxLimit }).limit).toBe(MAX_LIMIT);
    });

    it('treats an empty options object as no options at all', () => {
        expect(parsePagination({ limit: '999' }, {})).toEqual({ page: DEFAULT_PAGE, limit: MAX_LIMIT });
    });
});

describe('toPaginationBlock', () => {
    it('reports no pages for an empty result set', () => {
        // Not 1: the client pages while `page < totalPages`, so a phantom page
        // would make it request an empty second page for every empty list.
        expect(toPaginationBlock(0, 1, 25)).toEqual({ page: 1, limit: 25, total: 0, totalPages: 0 });
    });

    it.each([
        [25, 25, 1],
        [26, 25, 2],
        [50, 25, 2],
        [51, 25, 3],
    ])('rounds %i rows at %i per page up to %i pages', (total, limit, totalPages) => {
        expect(toPaginationBlock(total, 1, limit).totalPages).toBe(totalPages);
    });

    it.each([
        ['zero', 0],
        ['negative', -5],
    ])('reports no pages for a %s limit instead of Infinity', (_case, limit) => {
        // Guards the raw caller: Infinity serialises as null, and a null
        // totalPages fails the client's io-ts codec.
        const block = toPaginationBlock(100, 1, limit);

        expect(block.totalPages).toBe(0);
        expect(Number.isFinite(block.totalPages)).toBe(true);
    });

    it('echoes the page and limit it was given without re-clamping them', () => {
        // Clamping belongs to `parsePagination`; a block that silently altered
        // the page would disagree with the rows the caller actually queried.
        expect(toPaginationBlock(10, 7, 3)).toEqual({ page: 7, limit: 3, total: 10, totalPages: 4 });
    });
});

describe('the module defaults', () => {
    it('pins the shared page size and its ceiling', () => {
        expect(DEFAULT_PAGE).toBe(1);
        expect(DEFAULT_LIMIT).toBe(25);
        expect(MAX_LIMIT).toBe(50);
        expect(DEFAULT_LIMIT).toBeLessThanOrEqual(MAX_LIMIT);
    });
});
