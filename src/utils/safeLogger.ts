// Runtime-safe structured logging for the meal-planning runtime: the HTTP edge
// that handles a request, and the services behind it that have something an
// operator needs to know — `usda.service.ts` reports a cache write it could not
// record through these helpers rather than printing the driver's error.
//
// Whoever calls it, the rule is the same: record WHAT happened without
// recording the data it happened to.
//
// AAP §0.3.2/§0.7.1 make the three configured credentials
// (DATABASE_URL's userinfo, USDA_API_KEY as `api_key=` in a request URL,
// OPENROUTER_API_KEY as an `Authorization: Bearer` header) secrets the server
// must never print, and Rule backend-architecture §8 requires a safe message
// rather than the raw error object. `console.error('…', error)` satisfies
// neither: Node renders an Error's stack, a Prisma error's `meta` (which
// carries the failing statement's values), a vendor error body, and any
// newline inside them — a newline being all it takes to forge a second log
// line and make a forged event indistinguishable from a real one (CWE-117,
// CWE-532).
//
// So this module accepts PRIMITIVES ONLY and emits exactly one line. A caller
// cannot hand it an Error, a request body or a Prisma payload and have it
// serialized: a value outside the four permitted primitive types is replaced by
// a fixed marker before anything is stringified. That is the module's whole
// security contract, and it is a property of this file rather than a rule each
// call site has to remember.
//
// WHY IT IS NOT `scripts/lib/logger.ts`. That module is the CLI pipeline's
// logger and is excluded from `tsconfig.json`'s `include` (and from the Docker
// image), so `src/` cannot import it: a build would fail, or ship a file the
// image does not contain. The rules below are therefore stated here, in the
// smallest form the runtime edge needs — three exported helpers, no levels
// beyond the three the edge uses, no file descriptors, no environment reads and
// no import-time side effect (Rule backend-architecture §12).

/** The three levels the HTTP edge distinguishes: expected, notable, faulted. */
export type SafeLogLevel = 'info' | 'warn' | 'error';

/**
 * The only value types a field may carry.
 *
 * Deliberately not `unknown`: an `unknown` field is how an Error, a Prisma
 * error or a request body reaches a log line, and the whole point of this
 * module is that such a value cannot be expressed at a call site. A caller with
 * a structure to report reduces it to primitives first — a count, an id, a
 * closed-set code — which is also what keeps a log line bounded.
 */
export type SafeLogField = string | number | boolean | null;

/**
 * One event's fields. `undefined` is permitted and DROPPED rather than emitted,
 * so a call site can pass an optional correlation id (`planId`, `mealId`)
 * without branching on whether it knows it yet.
 */
export interface SafeLogFields {
    readonly [key: string]: SafeLogField | undefined;
}

/** Prefixes every line, so the feature's events are greppable as one stream. */
const LOG_PREFIX = '[meal-planning]';

/** Replaces a credential's value; the parameter name itself is kept, since it tells an operator which key was involved. */
const REDACTED = '***';

/**
 * Replaces a value that is not one of the four permitted primitives.
 *
 * A fixed marker rather than `String(value)` or `JSON.stringify(value)`: both
 * of those are exactly the leak this module exists to prevent, and either would
 * make the guarantee depend on what the value happens to contain.
 */
const UNLOGGABLE = '[unloggable]';

/** Marks a truncated string, so a bounded value is not mistaken for a complete one. */
const TRUNCATION_MARKER = '…';

/** The default bound on any single field value. Long enough for a UUID, a day key or a short reason; short enough that a vendor string cannot fill a log. */
const DEFAULT_MAX_TEXT_LENGTH = 200;

/** Field NAMES are written by this codebase, so they need a bound rather than a vocabulary. */
const MAX_FIELD_KEY_LENGTH = 64;

/** An error's `name` is a class name; 64 characters covers every class in this repo and bounds a foreign one. */
const MAX_ERROR_NAME_LENGTH = 64;

/**
 * Event names are part of the log's schema, so they are validated rather than
 * sanitized: an operator's alert matches a literal, and a name assembled from
 * anything dynamic would silently break it. Anything outside the pattern is
 * replaced by a marker, which is visible in the log instead of failing the
 * request the event was describing.
 */
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const UNNAMED_EVENT = 'unnamed_event';

/**
 * A MACHINE code on a thrown value — Prisma's `P2002`, Node's `ECONNREFUSED`.
 * Bounded and alphanumeric, so a `code` that is really a message, a path or a
 * SQL fragment fails the test and is dropped rather than logged.
 */
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** What a thrown non-Error is called. Never `String(value)`, which would print the value itself. */
const NON_ERROR_NAME = 'NonError';

/** What an Error with a blank `name` is called. */
const FALLBACK_ERROR_NAME = 'Error';

/**
 * Every character that could end a log line or be interpreted as a terminal
 * control sequence: C0 (which contains CR and LF), DEL, C1, and the two Unicode
 * line separators. Collapsed to a space so one event is always one line — the
 * property that makes a log line's structure trustworthy (CWE-117).
 */
const LINE_BREAKING_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * `Bearer <token>` in any casing, as it appears in a reflected request header
 * or an OpenRouter error body. The keyword survives so the log still says an
 * authorization header was involved.
 */
const BEARER_PATTERN = /bearer\s+[^\s"',;)\]}]+/gi;

/**
 * The credential-bearing parameter names this service configures, as they
 * appear in a query string (`?api_key=…`), in an env line (`USDA_API_KEY=…`)
 * and in a reflected form body. Longest alternatives come first so
 * `access_token` is not split by `token`, and the value class stops at the
 * first delimiter so only the value is lost.
 *
 * Both halves are simple (a fixed alternation and one negated-class star), so
 * the match is linear in the input length: this runs on error text of
 * caller-influenced length, where a backtracking pattern would be a denial of
 * service rather than a formatting nit.
 */
const CREDENTIAL_PARAMETER_PATTERN =
    /(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|private[_-]?key|client[_-]?secret|service[_-]?account|password|passwd|secret|token)(\s*=\s*)[^\s&#"';]*/gi;

/** The `://` that separates a URL scheme from its authority. */
const SCHEME_SEPARATOR = '://';

/**
 * The longest scheme this scan will walk back over: one leading letter plus a
 * 40-character body. The longest registered scheme is about 20 characters, so
 * this admits an unregistered one while keeping the walk-back bounded — an
 * unbounded scheme body is quadratic in the length of a scheme-legal run, which
 * is the same denial of service the patterns above avoid.
 */
const MAX_SCHEME_LENGTH = 41;

const isAsciiLetter = (code: number): boolean =>
    (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

/** The characters RFC 3986 §3.1 allows in a scheme after its leading letter. */
const isSchemeCharacter = (code: number): boolean =>
    isAsciiLetter(code) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b /* + */ ||
    code === 0x2d /* - */ ||
    code === 0x2e /* . */;

/**
 * Where RFC 3986 §3.2 ends an authority: the first `/`, `?`, `#`, or any
 * whitespace — whitespace because a log line is prose, and the character after
 * a URL in it is usually a space.
 */
const isAuthorityTerminator = (code: number): boolean =>
    code === 0x2f || code === 0x3f || code === 0x23 || code <= 0x20;

/** Whether the run immediately left of a `://` is a scheme (it must contain a letter). */
const hasSchemeBefore = (value: string, separatorIndex: number): boolean => {
    const limit = separatorIndex > MAX_SCHEME_LENGTH ? separatorIndex - MAX_SCHEME_LENGTH : 0;
    let sawLetter = false;

    for (let index = separatorIndex; index > limit; index -= 1) {
        const code = value.charCodeAt(index - 1);

        if (!isSchemeCharacter(code)) {
            break;
        }
        if (isAsciiLetter(code)) {
            sawLetter = true;
        }
    }

    return sawLetter;
};

/**
 * Replaces the userinfo of every URL in a string with `***`, leaving scheme,
 * host, port, path, query and fragment untouched.
 *
 * This is the DATABASE_URL rule, and it is the reason it is scanned rather than
 * matched. The userinfo is everything before the LAST `@` in the authority: an
 * unescaped `@` is legal in a Postgres password and common in generated ones,
 * so reading the first `@` as the delimiter turns
 * `postgresql://soh:pa@ss@host/db` into a "host" of `ss@host` and prints the
 * password's suffix. A bare host is left alone deliberately — it is not a
 * credential, and it is the one field that says which database a request hit.
 *
 * The scan is linear: `indexOf` finds each `://` once, the walk-back for a
 * scheme is capped, and an authority cannot contain another `://` because it
 * cannot contain a `/`.
 */
const redactUrlUserinfo = (value: string): string => {
    let searchFrom = 0;
    let copiedUpTo = 0;
    let redacted = '';

    for (;;) {
        const separatorIndex = value.indexOf(SCHEME_SEPARATOR, searchFrom);

        if (separatorIndex < 0) {
            break;
        }
        if (!hasSchemeBefore(value, separatorIndex)) {
            // A bare `://`, or one whose left-hand run holds no letter. One
            // character is enough to advance: `://` cannot overlap itself.
            searchFrom = separatorIndex + 1;
            continue;
        }

        const authorityStart = separatorIndex + SCHEME_SEPARATOR.length;
        let authorityEnd = value.length;
        let lastAtSignIndex = -1;

        for (let index = authorityStart; index < value.length; index += 1) {
            const code = value.charCodeAt(index);

            if (isAuthorityTerminator(code)) {
                authorityEnd = index;
                break;
            }
            if (code === 0x40) {
                lastAtSignIndex = index;
            }
        }

        // Past the authority either way, so the loop always advances. An `@`
        // beyond it belongs to a path, query or fragment and is not userinfo.
        searchFrom = authorityEnd;

        if (lastAtSignIndex < 0) {
            continue;
        }

        redacted += `${value.slice(copiedUpTo, authorityStart)}${REDACTED}@`;
        copiedUpTo = lastAtSignIndex + 1;
    }

    if (copiedUpTo === 0) {
        return value;
    }

    return redacted + value.slice(copiedUpTo);
};

/**
 * The one way caller-supplied text reaches a log line.
 *
 * Applied in this order, and the order is load-bearing:
 *
 *  1. URL userinfo, before anything else can claim part of a credential written
 *     as a connection string.
 *  2. `Bearer <token>`, before the parameter rule can match `authorization`
 *     inside the same header text and stop at the wrong delimiter.
 *  3. Credential parameters, which keep the name and drop the value.
 *  4. CR/LF and every other control character collapse to a space, AFTER the
 *     three redactions: a control character inside a credential must be part of
 *     the run those rules consume, not a boundary that ends the match early and
 *     leaves the tail printed.
 *  5. Truncation last, so the bound applies to what is actually emitted.
 *
 * @param value text to make safe; a non-string at runtime yields `''` rather
 *   than throwing, because a log call must never be the thing that fails a request
 * @param maxLength bound on the result before the truncation marker; defaults
 *   to 200 characters
 */
export const sanitizeLogText = (value: string, maxLength: number = DEFAULT_MAX_TEXT_LENGTH): string => {
    if (typeof value !== 'string') {
        return '';
    }

    const redacted = redactUrlUserinfo(value)
        .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
        .replace(CREDENTIAL_PARAMETER_PATTERN, `$1$2${REDACTED}`)
        .replace(LINE_BREAKING_CHARACTERS, ' ');

    const bound =
        Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : DEFAULT_MAX_TEXT_LENGTH;

    return redacted.length > bound ? `${redacted.slice(0, bound)}${TRUNCATION_MARKER}` : redacted;
};

/** Reads a machine `code` off a thrown value, and nothing else. */
const readMachineCode = (error: unknown): string | undefined => {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }

    const code = (error as { code?: unknown }).code;

    return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined;
};

/**
 * The sanctioned way to describe a thrown value (Rule backend-architecture §8).
 *
 * Returns the class NAME and, when the value carries one, a machine `code` —
 * `name` keeps this feature's typed errors distinguishable in the log
 * (`StaleRevisionError` from `PlanNotFoundError`), and `code` is what makes a
 * Prisma failure actionable (`P2002` is a unique-constraint violation).
 *
 * It returns NOTHING else, and that is the finding this module answers:
 * `message` can carry a connection string, a SQL fragment, a vendor response
 * body or a request value; `stack` carries absolute paths; `cause` and `meta`
 * carry whole nested objects. None of them is reachable through this function,
 * so no call site can log them by accident.
 */
export const describeErrorSafely = (error: unknown): { errorName: string; errorCode?: string } => {
    const errorName =
        error instanceof Error
            ? sanitizeLogText(error.name, MAX_ERROR_NAME_LENGTH).trim() || FALLBACK_ERROR_NAME
            : NON_ERROR_NAME;
    const errorCode = readMachineCode(error);

    return errorCode === undefined ? { errorName } : { errorName, errorCode };
};

/**
 * Reduces one field value to something emittable.
 *
 * The final arm is unreachable through the declared type and REQUIRED at
 * runtime: `SafeLogFields` is a compile-time promise, and a value arriving from
 * an `unknown` cast, a JSON payload or a future edit must be replaced rather
 * than serialized. That arm is the guarantee that no Error, Prisma error,
 * request body or vendor payload can be smuggled through a field.
 */
const safeValue = (value: SafeLogField): SafeLogField => {
    if (typeof value === 'string') {
        return sanitizeLogText(value);
    }
    if (typeof value === 'number') {
        // `NaN` and `±Infinity` serialize as `null` through JSON.stringify
        // anyway; doing it here makes the emitted value the one this module
        // chose rather than one the serializer picked.
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'boolean' || value === null) {
        return value;
    }

    return UNLOGGABLE;
};

const safeFields = (fields: SafeLogFields): Record<string, SafeLogField> => {
    const safe: Record<string, SafeLogField> = {};

    if (typeof fields !== 'object' || fields === null) {
        return safe;
    }

    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) {
            continue;
        }

        safe[sanitizeLogText(key, MAX_FIELD_KEY_LENGTH)] = safeValue(value as SafeLogField);
    }

    return safe;
};

/**
 * The console writers, read at call time through an arrow so a test's spy on
 * `console.warn` is the function this module calls, and so an unrecognised
 * level cannot index `console` with an arbitrary string.
 */
const LEVEL_WRITERS: Readonly<Record<SafeLogLevel, (line: string) => void>> = {
    info: (line) => console.info(line),
    warn: (line) => console.warn(line),
    error: (line) => console.error(line),
};

/**
 * Emits ONE line for one event: `[meal-planning] <event> <json>`.
 *
 * One line per event is what makes the stream parseable and what lets an
 * operator count outcomes; every value in `<json>` has been through the rules
 * above, so the line carries no credential, no stack, no vendor text and no
 * second line. The level says how to read the event, not how bad it is:
 * `info` for an answered request, `warn` for an expected refusal or rejection,
 * `error` for a server fault.
 *
 * @example
 * logSafeEvent('warn', 'request_rejected', {
 *     action: 'plans.regenerate',
 *     userId,
 *     status: 409,
 *     code: 'stale_plan',
 *     currentRevision: error.currentRevision,
 * });
 */
export const logSafeEvent = (level: SafeLogLevel, event: string, fields: SafeLogFields): void => {
    const write = LEVEL_WRITERS[level] ?? LEVEL_WRITERS.error;
    const name = typeof event === 'string' && EVENT_NAME_PATTERN.test(event) ? event : UNNAMED_EVENT;

    // Total by construction: every value in the map is a string, a finite
    // number, a boolean or null, so there is no cycle, no BigInt and no
    // `toJSON` for `JSON.stringify` to fail on.
    write(`${LOG_PREFIX} ${name} ${JSON.stringify(safeFields(fields))}`);
};
