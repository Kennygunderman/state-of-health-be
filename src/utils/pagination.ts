import { PaginationBlock } from '../types/catalog';

/**
 * Offset pagination, shared by every paginated endpoint. The wire block is
 * declared once, in the type layer, and this module only builds it — the
 * dependency runs utils → types and never the reverse.
 *
 * The three exports divide the scheme by boundary: `parsePagination` reads the
 * request, `toPaginationBlock` builds the response block, and `rowWindowFor`
 * derives the `LIMIT`/`OFFSET` pair the query actually runs with. The offset
 * lives here rather than at each call site because `(page - 1) * limit` is
 * arithmetic on request input: a page of `99999999999999999999` parses to a
 * finite but imprecise 1e20, and the product then exceeds what PostgreSQL will
 * accept for `OFFSET`, turning a query parameter into a 500. One bounded
 * derivation serves every caller, including the ones that reach a service
 * directly and never pass through `parsePagination`.
 */

/**
 * Members are `unknown` so an Express `req.query` is structurally assignable
 * without this module depending on Express. Do not narrow them to
 * `Request['query']` — that would couple pure logic to the framework.
 */
export interface PaginationQuery {
    page?: unknown;
    limit?: unknown;
}

export interface PaginationOptions {
    defaultLimit?: number;
    maxLimit?: number;
}

export interface PaginationParams {
    page: number;
    limit: number;
}

/** The `LIMIT` and `OFFSET` a paged query runs with, both already bounded. */
export interface RowWindow {
    limit: number;
    offset: number;
}

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 50;

/**
 * The deepest page any caller can ask for.
 *
 * A bound is required rather than tidy: `page` arrives as text, and every value
 * that parses to a finite number used to reach `OFFSET` unchanged — so a
 * twenty-digit page became an imprecise 1e20, its product with `limit` left
 * PostgreSQL's accepted range, and a query parameter produced a 500 instead of
 * a page. Clamping keeps the module total (see {@link parsePagination}); the
 * value sits orders of magnitude past anything these endpoints page — 100,000
 * pages is 2.5 million rows at the default limit and 5 million at `MAX_LIMIT` —
 * so no honest request ever meets it.
 */
export const MAX_PAGE = 100_000;

/**
 * The most rows one query may return, whatever a caller asks for.
 *
 * Distinct from `MAX_LIMIT`, and deliberately far above it: `MAX_LIMIT` is the
 * HTTP contract (`GET /catalog/foods` caps a page at 50), while this is the
 * absolute guard on the number that reaches `LIMIT`. A service called directly
 * — `catalog.service.searchPublishedFoods`, which `scripts/search-benchmark.ts`
 * times in process with a `limit` of 75 to prove pages 1 to 3 concatenate to
 * one reference page — must stay able to exceed the route's cap, so the guard
 * has to sit above 75 rather than at it.
 */
export const MAX_ROWS = 1_000;

/**
 * The largest offset {@link rowWindowFor} can produce, reached only at both
 * bounds at once.
 *
 * Derived rather than chosen, so the two clamps compose exactly: with `page` at
 * `MAX_PAGE` and `limit` at `MAX_ROWS` the product is this number and can be no
 * larger. Exported because it is the guarantee callers rely on — the offset
 * handed to a database is always a safe, non-negative integer below it — and
 * because a test can then pin the extreme instead of trusting the arithmetic.
 */
export const MAX_OFFSET = (MAX_PAGE - 1) * MAX_ROWS;

const MIN_LIMIT = 1;

/**
 * `qs` yields an array when a parameter repeats (`?page=1&page=2`); the first
 * occurrence wins. Anything that does not parse to a finite integer is treated
 * as absent so the caller's default applies.
 */
const readInteger = (value: unknown): number | null => {
    const raw = Array.isArray(value) ? value[0] : value;
    const parsed = Number.parseInt(String(raw), 10);

    return Number.isFinite(parsed) ? parsed : null;
};

const clampLimit = (limit: number, maxLimit: number): number =>
    Math.min(Math.max(limit, MIN_LIMIT), maxLimit);

/**
 * Bounds a page on both sides and truncates it to an integer, so what leaves
 * this module is always a whole page number in `[DEFAULT_PAGE, MAX_PAGE]`.
 * Truncation happens after the bound, which is what makes an imprecise value
 * such as 1e20 safe: it is compared, not carried.
 */
const clampPage = (page: number): number =>
    Math.min(Math.max(Math.trunc(page), DEFAULT_PAGE), MAX_PAGE);

/**
 * A caller's own option is sanitized rather than trusted or rejected: a `0` or
 * `NaN` bound would silently break the positive bounded limit this module
 * promises (`NaN` reaches `Math.ceil(total / limit)` and serializes as `null`),
 * while throwing would make the one shared parser partial for every endpoint.
 */
const sanitizeOptionLimit = (value: number | undefined, fallback: number): number =>
    value === undefined || !Number.isFinite(value)
        ? fallback
        : Math.max(Math.trunc(value), MIN_LIMIT);

/**
 * Clamps out-of-range values instead of rejecting them: a stale `limit` in a
 * client's saved request must not turn a list screen into an error, and an
 * unconditional clamp means no caller can forget the maximum. Request bodies
 * that must be refused belong to the `*.logic.ts` parsers that answer 400.
 */
export const parsePagination = (
    query: PaginationQuery,
    options: PaginationOptions = {},
): PaginationParams => {
    const maxLimit = sanitizeOptionLimit(options.maxLimit, MAX_LIMIT);
    const fallbackLimit = clampLimit(sanitizeOptionLimit(options.defaultLimit, DEFAULT_LIMIT), maxLimit);

    const requestedPage = readInteger(query.page);
    const requestedLimit = readInteger(query.limit);

    return {
        page: requestedPage === null ? DEFAULT_PAGE : clampPage(requestedPage),
        limit: requestedLimit === null ? fallbackLimit : clampLimit(requestedLimit, maxLimit),
    };
};

/**
 * The `LIMIT` and `OFFSET` for one page, bounded so neither can reach a
 * database as a value it will reject.
 *
 * Called with whatever a caller has: `parsePagination`'s output, which is
 * already in range, or raw arguments from a direct service caller. Both are
 * normalized the same way, because the defect this closes is exactly the
 * second case — a value no request parser saw. `limit` is sanitized like a
 * caller option (unreadable → the module default, non-positive → one row) and
 * then capped at `MAX_ROWS`; `page` is bounded by {@link MAX_PAGE}, with
 * anything unreadable treated as the first page rather than as zero rows.
 *
 * The offset is computed from the SAME sanitized limit the window reports, so a
 * caller cannot page with one number and select with another — the two are one
 * value by construction, not two that have to be kept in step. It needs no
 * clamp of its own for the same reason: both factors are already bounded, so
 * the product is a non-negative integer no larger than {@link MAX_OFFSET}.
 */
export const rowWindowFor = (page: number, limit: number): RowWindow => {
    const rows = Math.min(sanitizeOptionLimit(limit, DEFAULT_LIMIT), MAX_ROWS);
    const boundedPage = Number.isFinite(page) ? clampPage(page) : DEFAULT_PAGE;

    return { limit: rows, offset: (boundedPage - 1) * rows };
};

/**
 * An empty result set reports `totalPages: 0`, not 1 — the client pages while
 * `page < totalPages`. The non-positive `limit` guard keeps a raw caller from
 * producing `Infinity`, which would serialize as `null` in the response.
 */
export const toPaginationBlock = (
    total: number,
    page: number,
    limit: number,
): PaginationBlock => ({
    page,
    limit,
    total,
    totalPages: limit <= 0 ? 0 : Math.ceil(total / limit),
});
