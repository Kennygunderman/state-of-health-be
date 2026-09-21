import { PaginationBlock } from '../types/catalog';

/**
 * Offset pagination, shared by every paginated endpoint. The wire block is
 * declared once, in the type layer, and this module only builds it — the
 * dependency runs utils → types and never the reverse.
 *
 * The exports divide the scheme by boundary: `parsePaginationStrict` reads a
 * REQUEST and refuses a page block the endpoint cannot serve, `parsePagination`
 * bounds a page block that has no request behind it, `toPaginationBlock` builds
 * the response block, and `rowWindowFor` derives the `LIMIT`/`OFFSET` pair the
 * query actually runs with.
 *
 * TWO PARSERS, ONE BAND. Both read the same fields against the same constants
 * and the same caller options; what differs is the answer to a value outside
 * the band. A request gets a field error, because serving a clamped value
 * reports success for input that was silently rewritten (see
 * {@link parsePaginationStrict}); a trusted in-process caller gets a bounded
 * number, because there is no client to tell and no request to refuse (see
 * {@link parsePagination}).
 *
 * The offset lives here rather than at each call site because
 * `(page - 1) * limit` is arithmetic on request input: a page of
 * `99999999999999999999` parses to a finite but imprecise 1e20, and the product
 * then exceeds what PostgreSQL will accept for `OFFSET`, turning a query
 * parameter into a 500. One bounded derivation serves every caller, including
 * the ones that reach a service directly and never pass through a parser at
 * all.
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

/** The two fields of the page block a request can get wrong. */
export type PaginationField = 'page' | 'limit';

/**
 * The machine-readable `details[].code` vocabulary a refused page block uses:
 *
 *  - `invalid` — the value is not a whole number at all: free text, a
 *    fraction, a blank parameter, a non-scalar.
 *  - `out_of_range` — it IS a whole number, and not one this endpoint accepts.
 *
 * Two codes rather than one because the two corrections differ: the first asks
 * the caller to send a number, the second to send a different number. The
 * client maps the code to its own copy and never renders these words, which is
 * why they are wire tokens and not sentences (§0.5.2).
 */
export type PaginationFieldErrorCode = 'invalid' | 'out_of_range';

/**
 * One element of a `400 invalid_request` body's `details` array, narrowed to
 * the fields this module reads.
 *
 * `field` is a literal union so a caller cannot report a field the page block
 * does not have, and the shape stays structurally assignable to the wider
 * `{field: string; code: string}` detail the `*.logic.ts` request parsers merge
 * it into — so the one wire shape is shared rather than re-declared.
 */
export interface PaginationFieldError {
    field: PaginationField;
    code: PaginationFieldErrorCode;
}

/**
 * What {@link parsePaginationStrict} answers: the bounded pair, or every field
 * error the request earned.
 *
 * A RETURNED VERDICT, never a throw. The module stays deterministic, pure and
 * framework-free — no error class, no status code — and mapping the refusal to
 * `400 invalid_request` belongs to the controller that receives it
 * (Rule backend-architecture §7, §8).
 */
export type ParsedPaginationQuery =
    | { kind: 'ok'; page: number; limit: number }
    | { kind: 'error'; message: string; details: PaginationFieldError[] };

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
 * A decimal integer literal, optionally negative, and nothing else.
 *
 * Deliberately narrower than `Number.parseInt`, which is what makes the strict
 * reader below strict: `parseInt` reads a PREFIX, so `'2.7'` is 2 and
 * `'2abc'` is 2 — it answers a different request than the one that was sent.
 * A negative sign is admitted by the pattern on purpose so that `'-1'` is
 * classified as a whole number OUT OF RANGE rather than as unreadable text;
 * the range test below is what refuses it, and the caller is then told the
 * useful thing ("page must be between 1 and 100000") instead of being told its
 * number is not a number. A leading `+`, an exponent, a hexadecimal literal,
 * a thousands separator and a blank value are all refused as `invalid`.
 */
const INTEGER_TEXT_PATTERN = /^-?\d+$/;

/**
 * A request value as the strict reader classifies it, before any bound is
 * applied. `unrepresentable` is a fourth case rather than part of `invalid`
 * because a twenty-digit page IS an integer literal — it is simply larger than
 * IEEE-754 can hold exactly (`Number('99999999999999999999')` is 1e20), so the
 * honest answer is that it is out of range, and the arithmetic it would have
 * reached never runs.
 */
type RequestedInteger =
    | { kind: 'absent' }
    | { kind: 'integer'; value: number }
    | { kind: 'invalid' }
    | { kind: 'unrepresentable' };

/**
 * Reads one request value strictly.
 *
 * `qs` yields an array when a parameter repeats (`?page=1&page=2`); the first
 * occurrence wins, exactly as {@link parsePagination} treats it, and a repeated
 * parameter with no values at all (`?page[]=`) reads as absent. A value already
 * coerced to a `number` by a typed caller is accepted when it is a safe
 * integer, so the same parser serves an Express query string and an internal
 * call without either having to pre-format for the other.
 */
const readRequestedInteger = (value: unknown): RequestedInteger => {
    const raw = Array.isArray(value) ? value[0] : value;

    if (raw === undefined) {
        return { kind: 'absent' };
    }

    if (typeof raw === 'number') {
        if (Number.isSafeInteger(raw)) {
            return { kind: 'integer', value: raw };
        }

        // `Number.isInteger` is false for NaN and both infinities, so only a
        // genuine integer too large to hold exactly reaches the second branch.
        return Number.isInteger(raw) ? { kind: 'unrepresentable' } : { kind: 'invalid' };
    }

    if (typeof raw !== 'string') {
        return { kind: 'invalid' };
    }

    const text = raw.trim();

    if (!INTEGER_TEXT_PATTERN.test(text)) {
        return { kind: 'invalid' };
    }

    const parsed = Number(text);

    return Number.isSafeInteger(parsed) ? { kind: 'integer', value: parsed } : { kind: 'unrepresentable' };
};

/** The rule one strictly parsed field is held to. */
interface FieldBounds {
    field: PaginationField;
    min: number;
    max: number;
    /** Applied only when the field is absent — never to a value that failed. */
    fallback: number;
}

/**
 * One resolved field. Discriminated on `kind` rather than on the presence of a
 * property so that a single early return narrows BOTH fields for the success
 * path below — no unreachable fallback, and therefore no branch a test could
 * never cover.
 */
type ResolvedField =
    | { kind: 'value'; value: number }
    | { kind: 'error'; error: PaginationFieldError; message: string };

type ResolvedFieldError = Extract<ResolvedField, { kind: 'error' }>;

const isFieldFailure = (resolved: ResolvedField): resolved is ResolvedFieldError => resolved.kind === 'error';

/**
 * Resolves one field of the page block: the caller's default when it was not
 * sent, the value when it is a whole number inside the bound, and a field error
 * otherwise.
 *
 * The `message` is a server-side diagnostic the request parser composes into
 * one sentence; the client renders `details`, never this string.
 */
const resolveRequestedField = (raw: unknown, bounds: FieldBounds): ResolvedField => {
    const requested = readRequestedInteger(raw);

    if (requested.kind === 'absent') {
        return { kind: 'value', value: bounds.fallback };
    }

    if (requested.kind === 'invalid') {
        return {
            kind: 'error',
            error: { field: bounds.field, code: 'invalid' },
            message: `${bounds.field} must be a whole number`,
        };
    }

    const outOfRange: ResolvedField = {
        kind: 'error',
        error: { field: bounds.field, code: 'out_of_range' },
        message: `${bounds.field} must be between ${bounds.min} and ${bounds.max}`,
    };

    if (requested.kind === 'unrepresentable') {
        return outOfRange;
    }

    return requested.value < bounds.min || requested.value > bounds.max
        ? outOfRange
        : { kind: 'value', value: requested.value };
};

/**
 * THE LENIENT CONTRACT, AND NO LONGER THE REQUEST BOUNDARY. Clamps
 * out-of-range values instead of rejecting them, so it is total and can be
 * called with anything — which makes it the safety backstop for a trusted
 * caller that never met a request parser, and the shape the six shipped list
 * controllers' `parseInt(req.query.page) || 1` idiom can be replaced with
 * without changing what those endpoints answer.
 *
 * It is NOT what an HTTP request parses through any more, and must not become
 * that again: a clamp answers a request nobody made (`limit=51` served as 50,
 * `page=2.7` served as page 2, `page=-1` served as page 1) and reports success
 * for input it silently rewrote, which is the CWE-20 defect
 * {@link parsePaginationStrict} exists to close. A route boundary uses the
 * strict sibling and answers `400 invalid_request`; this function bounds a
 * value that has no request behind it.
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
 * THE REQUEST-BOUNDARY CONTRACT: parses `?page=` and `?limit=` strictly, and
 * refuses what it cannot serve instead of rewriting it.
 *
 * AAP §0.5.2 fixes the rule this implements — `page >= 1`, `limit` within the
 * route's band, and "server-side validation applied before any Prisma or
 * planning work (`*.logic.ts` parsers, 400 with field codes)". Clamping cannot
 * express that: a caller who sends `limit=1000` and receives 50 rows with
 * `200 OK` was told its request succeeded, and a caller who sends `page=2.7`
 * silently reads page 2. Neither can be distinguished from a correct request,
 * so a paging bug in a client — or a probe of the endpoint — looks like normal
 * traffic (CWE-20). This parser makes the difference visible at the boundary,
 * before a statement is issued.
 *
 * TWO CONTRACTS, ONE SCHEME. The bounds, the defaults and the option handling
 * are the same ones {@link parsePagination} applies, taken from the same
 * constants, so the strict and lenient answers can never disagree about what
 * the band IS — only about what to do with a value outside it.
 *
 * DEFAULTS BELONG TO OMITTED FIELDS ONLY. An absent `page` is page one and an
 * absent `limit` is the caller's default, because a request that names neither
 * is a well-formed request for the first page. A field that was SENT is
 * answered on its own terms: a whole number inside the band is used exactly as
 * given, and anything else is a field error. Nothing sent is ever replaced by a
 * default, which would hide the caller's mistake behind a plausible answer.
 *
 * EVERY FAILING FIELD IS REPORTED, page before limit, so a request that gets
 * both wrong is corrected in one round trip rather than two. The CALLER'S OWN
 * options are still sanitized rather than refused (see
 * {@link sanitizeOptionLimit}): they are a route's configuration, not request
 * input, and a route that mis-declares its band is a bug to fix in code, not a
 * 400 to show a user.
 */
export const parsePaginationStrict = (
    query: PaginationQuery,
    options: PaginationOptions = {},
): ParsedPaginationQuery => {
    const maxLimit = sanitizeOptionLimit(options.maxLimit, MAX_LIMIT);
    const fallbackLimit = clampLimit(sanitizeOptionLimit(options.defaultLimit, DEFAULT_LIMIT), maxLimit);

    const page = resolveRequestedField(query.page, {
        field: 'page',
        min: DEFAULT_PAGE,
        max: MAX_PAGE,
        fallback: DEFAULT_PAGE,
    });
    const limit = resolveRequestedField(query.limit, {
        field: 'limit',
        min: MIN_LIMIT,
        max: maxLimit,
        fallback: fallbackLimit,
    });

    if (page.kind === 'error' || limit.kind === 'error') {
        const failures = [page, limit].filter(isFieldFailure);

        return {
            kind: 'error',
            message: failures.map((failure) => failure.message).join('; '),
            details: failures.map((failure) => failure.error),
        };
    }

    return { kind: 'ok', page: page.value, limit: limit.value };
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
