/**
 * Offset pagination, shared by every paginated endpoint. The offset itself
 * (`(page - 1) * limit`) stays with the caller that runs the query.
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

export interface PaginationBlock {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 50;

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
 * Clamps out-of-range values instead of rejecting them: a stale `limit` in a
 * client's saved request must not turn a list screen into an error, and an
 * unconditional clamp means no caller can forget the maximum. Request bodies
 * that must be refused belong to the `*.logic.ts` parsers that answer 400.
 */
export const parsePagination = (
    query: PaginationQuery,
    options: PaginationOptions = {},
): PaginationParams => {
    const maxLimit = options.maxLimit ?? MAX_LIMIT;
    const fallbackLimit = clampLimit(options.defaultLimit ?? DEFAULT_LIMIT, maxLimit);

    const requestedPage = readInteger(query.page);
    const requestedLimit = readInteger(query.limit);

    return {
        page: requestedPage === null ? DEFAULT_PAGE : Math.max(DEFAULT_PAGE, requestedPage),
        limit: requestedLimit === null ? fallbackLimit : clampLimit(requestedLimit, maxLimit),
    };
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
