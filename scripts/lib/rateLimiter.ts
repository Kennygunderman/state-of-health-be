// Paces the catalog importer's USDA FoodData Central requests.
//
// The importer does not own its API key. `USDA_API_KEY` is the same key the
// running API uses on the request path — estimate grounding calls
// `searchGenericFoods` and `/api/macros/search-branded-foods` calls
// `searchBrandedFoods` — and USDA allows 1,000 requests per hour per key. An
// importer that saturates the key does not merely slow itself down: it
// degrades a live user feature. So the importer is capped at 900 per hour,
// leaving 100 per hour of headroom for that traffic, and when it runs out of
// allowance it PAUSES rather than failing (a multi-hour import that aborts on
// a full bucket would have to be restarted; one that waits simply finishes
// later, which is the whole point of the checkpointing around it).
//
// This module paces requests and reports what it paced (§1.1). It reads no
// manifest, touches no database, and decides nothing about catalog records.
// It deliberately does not import `usda.service.ts`: it gates transport, it
// never calls the vendor, and that module pulls in the Prisma client through
// `../prisma/client`. Vendor failures stay the vendor boundary's business —
// `UsdaError` is thrown and shaped by `usda.service.ts`, and nothing here
// catches or reshapes a USDA response (§9). The one error this module owns is
// a configuration error.
//
// Two gates enforce that cap, because a token bucket on its own cannot: it
// shapes the burst and paces smoothly, while an exact rolling-hour ledger of
// admitted attempts is what holds the run to `requestsPerHour` in ANY hour
// (see the derivation above `createUsdaRateLimiter`'s bounds check).
//
// The rate is a constructor argument, never an environment read inside the
// flow (§1.6/§5): `getUsdaImportRateLimitPerHour` is the single accessor that
// reads `USDA_IMPORT_RATE_LIMIT_PER_HOUR`, and it fails loudly (§9). The rules
// worth getting wrong — the refill arithmetic, the wait computation, the
// rolling-hour ledger, the host match and the burst invariant — are pure and
// exported so they can be unit tested with no clock and no network
// (§1.2/§7.1); `await sleep` and the `globalThis.fetch` patch are the only
// impure parts. Jest's `roots` is `<rootDir>/src`, so no test file can live in
// this folder (§11); `now`, `sleep` and `logger` are injected so a test can
// drive an hour of pacing instantly.

import { hostOf, type ScriptLogger } from './logger';

/** The host every USDA FoodData Central request is sent to. */
export const USDA_HOST = 'api.nal.usda.gov';

/** USDA's published ceiling: 1,000 requests per hour per API key. */
export const USDA_VENDOR_CAP_PER_HOUR = 1000;

/** 900 of that ceiling, leaving 100 per hour for the running API. */
export const DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR = 900;

/** One USDA detail batch (`POST /foods` takes 20 ids) may go out back-to-back. */
export const DEFAULT_BURST_CAPACITY = 20;

const MS_PER_HOUR = 3_600_000;

/**
 * The window the hourly ceiling is measured over. USDA's limit is stated per
 * hour and it is a ROLLING hour, not a wall-clock one: there is no top of the
 * hour at which the vendor forgives what the importer already spent, so the
 * ledger measures the last `MS_PER_HOUR` from every attempt.
 */
export const RATE_WINDOW_MS = MS_PER_HOUR;

const RATE_LIMIT_ENV_VAR = 'USDA_IMPORT_RATE_LIMIT_PER_HOUR';

/**
 * A rate configuration that cannot be honoured. Thrown at startup, before any
 * request is paced, because every alternative is worse: silently halving the
 * pace wastes hours, and silently doubling it gets a key the live API depends
 * on throttled.
 *
 * The offending numbers travel on the error (§8) so a caller can report them
 * without re-parsing the message. They are `null` when the failure did not
 * involve that particular number.
 */
export class RateLimitConfigError extends Error {
    constructor(
        message: string,
        public readonly requestsPerHour: number | null = null,
        public readonly burstCapacity: number | null = null,
        public readonly vendorCapPerHour: number | null = null,
    ) {
        super(message);
        this.name = 'RateLimitConfigError';
    }
}

/** A token bucket at an instant: whole-and-fractional tokens, and when they were counted. */
export interface BucketState {
    tokens: number;
    lastRefillMs: number;
}

/**
 * What the limiter paced. `catalog-import-usda.ts` writes this verbatim into
 * `data/meal-planning/reports/latest/import-report.json` as the `usdaRequests`
 * block, which `catalog-report.ts` reconciles against the import half — so
 * these field names are a contract, they stay camelCase like the rest of the
 * reports, and no field here may carry a secret (no URLs, no key fragments,
 * no host beyond the configured one).
 */
export interface UsdaRequestStats {
    configuredPerHour: number;
    vendorCapPerHour: number;
    burstCapacity: number;
    /** Physical fetches gated — `usda.service.ts`'s internal retries included. */
    attempts: number;
    pauses: number;
    totalPausedMs: number;
    longestPauseMs: number;
    firstAttemptAt: string | null;
    lastAttemptAt: string | null;
}

export interface UsdaRateLimiter {
    /**
     * Consumes one request's allowance — one burst token AND one slot in the
     * rolling-hour ceiling — waiting for however long the later of the two
     * takes. It waits; it never throws and never drops a request.
     */
    acquire(): Promise<void>;
    /**
     * Gates USDA traffic by wrapping `globalThis.fetch`, and returns the
     * function that puts the original back.
     *
     * This mutates a process-wide global, so the caller MUST invoke the
     * returned restore function in a `finally` — otherwise a failed import
     * leaves the wrapper installed for the rest of the process. Calling
     * `install` twice is the same installation, and the restore is safe to
     * call more than once.
     *
     * Restoring is ownership-safe: it puts the original back only while
     * `globalThis.fetch` is still this limiter's wrapper. If something else
     * wrapped `fetch` after `install()`, that owner is left alone and this
     * limiter's wrapper stays in the chain beneath it — harmless, because it
     * paces nothing but USDA traffic, and strictly better than silently
     * disabling a wrapper this module knows nothing about. A later restore
     * still succeeds once that owner steps down.
     */
    install(): () => void;
    stats(): UsdaRequestStats;
}

export interface UsdaRateLimiterOptions {
    requestsPerHour: number;
    vendorCapPerHour?: number;
    burstCapacity?: number;
    /** A bare hostname or a base URL — `usda.service.ts` honours `USDA_BASE_URL`. */
    host?: string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    logger?: ScriptLogger;
}

/**
 * What an environment value turned out to be when read as a decimal integer.
 * On `not_decimal`, `reads` is whatever `Number()` made of it — `NaN` or an
 * infinity when it could not be coerced at all.
 */
type DecimalIntegerRead =
    | { kind: 'ok'; value: number }
    | { kind: 'not_decimal'; reads: number }
    | { kind: 'not_exact'; digits: number };

/**
 * Reads an environment value as a decimal integer, or reports why it is not
 * one. Bounds are the caller's business; this decides only whether a number was
 * written at all, and whether the one written is the one that would be enforced.
 *
 * `Number()` implements the JavaScript numeric-literal grammar, not a decimal
 * reader, so on its own it accepts forms no operator means by a count: `0x10`
 * becomes 16, `1e3` becomes 1000, `+7` becomes 7, `8.` becomes 8, and because
 * `String.prototype.trim` removes U+00A0 a non-breaking space pasted before a
 * digit disappears silently. Each of those would be enforced as a rate nobody
 * asked for — `1e3` in particular lands on the vendor's full 1,000/hour, wiping
 * out the headroom this module exists to protect. `Number()` also rounds:
 * `Number('9007199254740993')` is 9007199254740992, which passes
 * `Number.isInteger` and every range check while no longer being the value that
 * was typed. So the digits are checked before the number is believed, and a
 * magnitude that cannot be represented exactly is refused rather than rounded.
 *
 * `budget.ts` reads `CATALOG_MODEL_CALL_BUDGET` and `CATALOG_BATCH_SIZE` under
 * this same rule. The rule is stated once per module rather than shared from a
 * third file because each module maps the outcome onto its own error class, and
 * neither may import the other: this one touches no database, and that one
 * never calls a vendor.
 */
const readDecimalInteger = (raw: string): DecimalIntegerRead => {
    // Only ASCII whitespace is stripped, deliberately NOT `String.trim()`:
    // trim also removes U+00A0, U+FEFF and the other Unicode space
    // separators, so a non-breaking space or a byte-order mark pasted in front
    // of a digit would vanish here and the value would be accepted as though it
    // had been typed cleanly. An invisible character in a .env line is exactly
    // what to fail loudly on — it survives later edits, defeats a grep for the
    // value, and any other reader of the same file (a shell `export`, a
    // compose file, a secrets manager) may well disagree about it.
    const trimmed = raw.replace(/^[ \t\n\r\v\f]+/, '').replace(/[ \t\n\r\v\f]+$/, '');

    if (!/^[0-9]+$/.test(trimmed)) {
        // What `Number()` would have made of it is the useful half of the
        // report — it is the rate the run would otherwise have enforced —
        // whereas the raw string is never echoed: a misplaced paste can put a
        // credential on a line that reaches terminals, CI logs and committed
        // reports.
        return { kind: 'not_decimal', reads: Number(trimmed) };
    }

    const value = Number(trimmed);
    if (!Number.isSafeInteger(value)) {
        // Digits only by now, so the only way here is a magnitude past
        // 2^53-1, where the nearest representable double is a different
        // number. The digit count says how far out of range it is without
        // echoing either the raw text or the misleading rounded value.
        return { kind: 'not_exact', digits: trimmed.replace(/^0+(?=[0-9])/, '').length };
    }

    return { kind: 'ok', value };
};

/**
 * Resolves the importer's hourly rate — the only place
 * `USDA_IMPORT_RATE_LIMIT_PER_HOUR` is read.
 *
 * Absent or blank means the default. A value that is present but unusable
 * throws instead of falling back, which is where this deliberately parts
 * company with `entitlement.service.ts`'s `getDailyQuota()`: a quota that
 * quietly reverts to its default only affects the caller, whereas a rate that
 * quietly reverts hides a typo that either wastes hours of import time or
 * throttles the key the live API shares.
 */
export const getUsdaImportRateLimitPerHour = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = env[RATE_LIMIT_ENV_VAR];
    if (raw === undefined || raw.trim().length === 0) {
        return DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR;
    }

    const read = readDecimalInteger(raw);

    if (read.kind === 'not_decimal') {
        // The number `Number()` would have produced is safe to echo; the raw
        // string is not, for the reason given on `readDecimalInteger`.
        const observed = Number.isFinite(read.reads) ? `${read.reads}` : 'not a number';
        throw new RateLimitConfigError(
            `${RATE_LIMIT_ENV_VAR} must be decimal digits only, with no sign, decimal point, exponent or hex prefix (got ${observed})`,
            Number.isFinite(read.reads) ? read.reads : null,
            null,
            USDA_VENDOR_CAP_PER_HOUR,
        );
    }

    if (read.kind === 'not_exact') {
        // No `requestsPerHour` travels on this one: every candidate value is
        // either the raw text or the rounded number, and reporting the rounded
        // number is the specific dishonesty this rejection exists to prevent.
        throw new RateLimitConfigError(
            `${RATE_LIMIT_ENV_VAR} is too large to be read exactly: ${read.digits} digits exceeds the largest safe integer ${Number.MAX_SAFE_INTEGER}`,
            null,
            null,
            USDA_VENDOR_CAP_PER_HOUR,
        );
    }

    if (read.value <= 0 || read.value > USDA_VENDOR_CAP_PER_HOUR) {
        throw new RateLimitConfigError(
            `${RATE_LIMIT_ENV_VAR} must be an integer between 1 and ${USDA_VENDOR_CAP_PER_HOUR} (got ${read.value})`,
            read.value,
            null,
            USDA_VENDOR_CAP_PER_HOUR,
        );
    }

    return read.value;
};

/**
 * Advances a bucket to `nowMs`, clamped at `capacity`.
 *
 * Monotonic-safe on purpose: `Date.now()` can step backwards (NTP correction,
 * a VM resuming), and a bucket that lost tokens to a clock adjustment would
 * stall an import for no reason. A reading at or before `lastRefillMs` adds
 * nothing, removes nothing, and never rewinds `lastRefillMs` — otherwise the
 * next legitimate reading would measure its elapsed time from the wrong
 * origin and hand out tokens the vendor never granted.
 */
export const refillBucket = (
    state: BucketState,
    nowMs: number,
    tokensPerMs: number,
    capacity: number,
): BucketState => {
    const elapsedMs = Number.isFinite(nowMs) ? nowMs - state.lastRefillMs : 0;

    if (!(elapsedMs > 0)) {
        return { tokens: Math.min(state.tokens, capacity), lastRefillMs: state.lastRefillMs };
    }

    return {
        tokens: Math.min(state.tokens + elapsedMs * tokensPerMs, capacity),
        lastRefillMs: nowMs,
    };
};

/**
 * How long to wait, from `nowMs`, before one whole token is available.
 *
 * Zero when the bucket already has one. A non-positive or non-finite rate
 * returns `Infinity` rather than zero: at that rate a token never arrives, and
 * answering "go ahead" would be a lie that lets an unpaced request out.
 * `createUsdaRateLimiter` rejects such rates, so `acquire` never sees it.
 */
export const waitMsForToken = (
    state: BucketState,
    nowMs: number,
    tokensPerMs: number,
    capacity: number,
): number => {
    const refilled = refillBucket(state, nowMs, tokensPerMs, capacity);

    if (refilled.tokens >= 1) {
        return 0;
    }
    if (!(tokensPerMs > 0)) {
        return Number.POSITIVE_INFINITY;
    }

    return Math.ceil((1 - refilled.tokens) / tokensPerMs);
};

/**
 * Drops the attempt stamps that have aged out of the window ending at `nowMs`.
 *
 * The far boundary is INCLUSIVE — a stamp exactly at `nowMs - windowMs` still
 * counts — which costs one millisecond of allowance and buys an unconditional
 * guarantee. Read the hour as `(nowMs - windowMs, nowMs]` and an exclusive
 * boundary is correct, but read it as the closed `[nowMs - windowMs, nowMs]`
 * and an exclusive boundary admits `limit + 1`: the stamp that just aged out
 * plus a full window. USDA does not publish which way it counts, and the whole
 * point of this ledger is a ceiling that holds either way, so the boundary
 * instant is charged rather than forgiven. `windowWaitMs` floors the resulting
 * zero wait at 1ms, which is exactly how long that slot is withheld.
 *
 * A stamp that is not a finite number is dropped outright — it could never age
 * out and would freeze the ledger for the rest of the run.
 */
export const pruneAttemptWindow = (
    stamps: readonly number[],
    nowMs: number,
    windowMs: number,
): number[] => {
    const cutoffMs = nowMs - windowMs;

    if (!Number.isFinite(cutoffMs)) {
        // A reading that cannot produce a cutoff says nothing about what has
        // aged out, and pruning on it would hand back an hour of allowance the
        // vendor never granted. Keep every usable stamp instead.
        return stamps.filter((stamp) => Number.isFinite(stamp));
    }

    return stamps.filter((stamp) => Number.isFinite(stamp) && stamp >= cutoffMs);
};

/**
 * How long to wait, from `nowMs`, before the rolling window has room for one
 * more attempt. Zero while it holds fewer than `limit`.
 *
 * The wait is measured from the OLDEST stamp still inside the window, which is
 * the head: `recordAttemptWindow` keeps the sequence monotonically
 * nondecreasing. Reading the head rather than scanning for the minimum is also
 * the safe direction if a caller hands over an unordered array — the head is
 * then never older than the true minimum, so the wait can only come out longer
 * than needed, never shorter.
 */
export const windowWaitMs = (
    stamps: readonly number[],
    nowMs: number,
    limit: number,
    windowMs: number,
): number => {
    const inWindow = pruneAttemptWindow(stamps, nowMs, windowMs);

    if (inWindow.length < limit) {
        return 0;
    }

    const oldestMs = inWindow[0];
    if (oldestMs === undefined) {
        return 0;
    }

    // The floor is load-bearing in two cases. A stamp sitting exactly on the
    // inclusive far boundary computes a zero wait, and that slot is withheld
    // for the one millisecond it takes to leave the closed window. An unusable
    // clock (a non-finite reading prunes nothing and can compute a non-finite
    // difference) would otherwise either let `acquire` spin or park the import
    // forever on an infinite wait.
    const waitMs = Math.ceil(oldestMs + windowMs - nowMs);
    return Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 1;
};

/**
 * Records one admitted attempt and drops whatever aged out with it.
 *
 * The appended stamp is clamped to `Math.max(nowMs, lastStamp)`, mirroring
 * `refillBucket`'s monotonic-safety posture: `Date.now()` can step backwards
 * (NTP correction, a VM resuming), and a stamp written behind the previous one
 * would age out early and grant allowance the vendor did not. The clamp keeps
 * the sequence nondecreasing, which is what makes the head the oldest entry.
 *
 * A non-finite reading is stamped at the most recent known one rather than
 * dropped — an admitted attempt that leaves no trace is exactly the allowance
 * leak this ledger exists to close.
 */
export const recordAttemptWindow = (
    stamps: readonly number[],
    nowMs: number,
    windowMs: number,
): number[] => {
    const lastMs = stamps.length > 0 ? stamps[stamps.length - 1] : undefined;
    const previousMs = lastMs !== undefined && Number.isFinite(lastMs) ? lastMs : 0;
    const stampedMs = Number.isFinite(nowMs) ? Math.max(nowMs, previousMs) : previousMs;

    // Pruned against the clamped stamp, not the raw reading: the monotonic
    // maximum is the ledger's notion of now, so the two operations cannot
    // disagree about which entries are still inside the hour.
    return pruneAttemptWindow([...stamps, stampedMs], stampedMs, windowMs);
};

/**
 * Reduces a hostname to the one form host comparisons are made in: lower case,
 * with the DNS root's trailing dot removed.
 *
 * `api.nal.usda.gov.` is the fully qualified spelling of `api.nal.usda.gov` —
 * it resolves to the same addresses and reaches the same vendor — but WHATWG
 * `URL` keeps the dot in `hostname`, and `hostOf` only lower-cases. Comparing
 * the raw hostname therefore reads the FQDN form as a different host, and an
 * unrecognised host is not paced: the request would go to USDA spending none of
 * this limiter's allowance, against a key whose 1,000/hour the running API
 * shares. Exactly one dot is stripped, because `api.nal.usda.gov..` is not a
 * resolvable name and must keep failing the match rather than be repaired into
 * one.
 *
 * This is the same rule `dbGuard.ts` applies to `DATABASE_URL`
 * (`hostname.toLowerCase().replace(/\.$/, '')`), and the two must agree: a host
 * that one module treats as USDA and the other as unrecognised is the gap this
 * closes.
 */
const canonicalHostname = (hostname: string): string => hostname.toLowerCase().replace(/\.$/, '');

// `hostOf` reduces a URL to its hostname but answers 'invalid-url' for a bare
// hostname, so which form arrived has to be decided first. Both are accepted
// because `usda.service.ts` reads `USDA_BASE_URL`, and a caller wiring the
// limiter to a mock server would naturally pass that base URL straight through.
// Both branches canonicalise, so a configured host, a configured base URL and
// an outgoing request URL are all compared in the same form.
const normalizeHost = (host: string): string => {
    const trimmed = host.trim();
    if (!trimmed.includes('://')) {
        return canonicalHostname(trimmed);
    }
    const parsed = hostOf(trimmed);
    return parsed === 'invalid-url' ? '' : canonicalHostname(parsed);
};

// `fetch` accepts a string, a URL or a Request. The `url`/`href` duck-typing
// covers a Request without naming its type and a URL that crossed a realm
// boundary, where `instanceof` would quietly fail and leave requests unpaced.
const hrefOf = (input: unknown): string | null => {
    if (typeof input === 'string') {
        return input;
    }
    if (input instanceof URL) {
        return input.href;
    }
    if (typeof input === 'object' && input !== null) {
        const candidate = input as { url?: unknown; href?: unknown };
        if (typeof candidate.url === 'string') {
            return candidate.url;
        }
        if (typeof candidate.href === 'string') {
            return candidate.href;
        }
    }
    return null;
};

/**
 * Whether a `fetch` argument addresses the paced host. Anything that does not
 * parse is not a USDA request and passes through unpaced — a malformed URL is
 * the caller's problem to hear about from `fetch`, not this module's to spend
 * allowance on.
 */
export const isUsdaRequestUrl = (input: unknown, host: string = USDA_HOST): boolean => {
    const href = hrefOf(input);
    const expected = normalizeHost(host);

    if (href === null || expected.length === 0) {
        return false;
    }

    try {
        return canonicalHostname(new URL(href).hostname) === expected;
    } catch {
        return false;
    }
};

// Deliberately not `unref()`'d: a pause has to keep the process alive, or a
// run that pauses near the end would exit mid-import and look like a clean
// finish.
const defaultSleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

// A stats field must never be able to end a multi-hour import, and
// `toISOString()` throws on a timestamp outside the Date range.
const isoOf = (epochMs: number): string | null => {
    if (!Number.isFinite(epochMs)) {
        return null;
    }
    try {
        return new Date(epochMs).toISOString();
    } catch {
        return null;
    }
};

/**
 * Builds a pacer for one import run. Nothing is installed and no environment
 * variable is read here — the caller passes the rate in (from
 * `getUsdaImportRateLimitPerHour`) and calls `install()` inside its own flow,
 * so importing this module has no side effect.
 *
 * @throws RateLimitConfigError when the configuration cannot be honoured.
 */
export const createUsdaRateLimiter = (options: UsdaRateLimiterOptions): UsdaRateLimiter => {
    const requestsPerHour = options.requestsPerHour;
    const vendorCapPerHour = options.vendorCapPerHour ?? USDA_VENDOR_CAP_PER_HOUR;
    const capacity = options.burstCapacity ?? Math.min(requestsPerHour, DEFAULT_BURST_CAPACITY);
    const logger = options.logger;

    const reject = (message: string): never => {
        throw new RateLimitConfigError(message, requestsPerHour, capacity, vendorCapPerHour);
    };

    const requirePositiveInteger = (label: string, value: number): void => {
        if (!Number.isInteger(value) || value <= 0) {
            const observed = Number.isFinite(value) ? `${value}` : 'not a number';
            reject(`${label} must be a positive integer (got ${observed})`);
        }
    };

    requirePositiveInteger('requestsPerHour', requestsPerHour);
    requirePositiveInteger('vendorCapPerHour', vendorCapPerHour);
    // A capacity below one whole token could never be spent, so `acquire`
    // would wait for a token the clamp forbids it to ever hold — an import
    // that hangs instead of running.
    requirePositiveInteger('burstCapacity', capacity);

    // WHY THERE ARE TWO GATES, AND WHY NEITHER IS REDUNDANT.
    //
    // A token bucket with capacity C refilling at rate R admits up to
    // C + R*T requests in any window of length T. So the bucket ALONE cannot
    // hold the importer to `requestsPerHour`: after any idle stretch it stands
    // full, and the hour that follows admits C + R*1h — 20 + 900 = 920 at the
    // defaults, which leaves the live API 80 of USDA's 1,000 instead of the
    // 100 this rate exists to reserve (AAP 0.7.1). The burst allowance is not
    // free; it is a bill the vendor pays on top of the rate.
    //
    // The exact rolling-hour ledger (`attemptWindow` in `acquire`) is
    // therefore the BINDING gate: it admits at most `requestsPerHour` attempts
    // in any hour, idle stretch or not, so 900 is the importer's total and the
    // headroom is real. The bucket's remaining job is shaping — one detail
    // batch back-to-back, then a smooth one-every-four-seconds pace, instead
    // of 900 requests fired at the vendor in the first second of the hour and
    // then 59 minutes of silence. Delete either one and the module is wrong in
    // a different way: without the ledger the 920 is back, without the bucket
    // the pacing is gone.
    //
    // What the configuration must satisfy is consequently narrower than the
    // old `C + R <= vendorCap`: the ceiling itself has to fit under the
    // vendor's cap, and the burst has to be spendable within the ceiling.
    if (requestsPerHour > vendorCapPerHour) {
        reject(
            `requestsPerHour ${requestsPerHour} exceeds vendorCapPerHour ${vendorCapPerHour}: ` +
                `the importer's rolling-hour ceiling is the total it may spend, so it has to fit ` +
                `under the vendor's hourly cap with headroom left for the running API`,
        );
    }
    // A burst wider than the hourly ceiling can never be spent in full — the
    // ledger stops it at `requestsPerHour` — so configuring one asks for
    // allowance that does not exist, and the extra capacity would only delay
    // the pacing the bucket is there to provide.
    if (capacity > requestsPerHour) {
        reject(
            `burstCapacity ${capacity} exceeds requestsPerHour ${requestsPerHour}: the rolling-hour ` +
                `ledger admits at most requestsPerHour attempts per hour, so a wider burst can never ` +
                `be spent in full`,
        );
    }

    const host = normalizeHost(options.host ?? USDA_HOST);
    // An unusable host matches nothing, which would leave every USDA request
    // unpaced — the same outcome as not installing the limiter at all, but
    // silent. The raw value is not echoed: a base URL can carry userinfo.
    if (host.length === 0) {
        reject('host must be a hostname or a base URL; an unusable host would leave every request unpaced');
    }

    const tokensPerMs = requestsPerHour / MS_PER_HOUR;
    const now = options.now ?? ((): number => Date.now());
    const sleep = options.sleep ?? defaultSleep;

    // Keeps every downstream calculation finite even if an injected clock
    // misbehaves; the loop in `acquire` still relies on the clock advancing.
    const readClock = (): number => {
        const reading = now();
        return Number.isFinite(reading) ? reading : 0;
    };

    // The bucket starts full so the first detail batch is not made to wait for
    // allowance the importer has not yet spent.
    let state: BucketState = { tokens: capacity, lastRefillMs: readClock() };

    // The rolling-hour ledger: one stamp per ADMITTED attempt, pruned to the
    // last hour on every pass, so it is bounded by `requestsPerHour` entries.
    // It starts empty because a fresh limiter has spent nothing — the run's
    // history before this process is not knowable here, and assuming a full
    // ledger would idle the first hour of every import.
    let attemptWindow: number[] = [];

    const counters = {
        attempts: 0,
        pauses: 0,
        totalPausedMs: 0,
        longestPauseMs: 0,
        firstAttemptAt: null as string | null,
        lastAttemptAt: null as string | null,
    };

    const recordAttempt = (nowMs: number): void => {
        counters.attempts += 1;
        const at = isoOf(nowMs);
        if (counters.firstAttemptAt === null) {
            counters.firstAttemptAt = at;
        }
        counters.lastAttemptAt = at;
    };

    const recordPause = (waitMs: number): void => {
        counters.pauses += 1;
        if (Number.isFinite(waitMs)) {
            counters.totalPausedMs += waitMs;
            counters.longestPauseMs = Math.max(counters.longestPauseMs, waitMs);
        }
    };

    const acquire = async (): Promise<void> => {
        // An exhausted gate answers "later", never "no": the import pauses
        // rather than failing, because aborting a multi-hour run over
        // allowance it will have again in seconds is strictly worse than
        // waiting for it. Looping rather than sleeping once is deliberate — a
        // coarse timer can wake early, and a wait satisfying one gate can
        // leave the other short — and it cannot spin hot, because both
        // `waitMsForToken` and `windowWaitMs` round a non-zero wait up to at
        // least 1ms.
        for (;;) {
            const nowMs = readClock();
            state = refillBucket(state, nowMs, tokensPerMs, capacity);
            attemptWindow = pruneAttemptWindow(attemptWindow, nowMs, RATE_WINDOW_MS);

            const bucketWaitMs = waitMsForToken(state, nowMs, tokensPerMs, capacity);
            const ceilingWaitMs = windowWaitMs(attemptWindow, nowMs, requestsPerHour, RATE_WINDOW_MS);

            // Both gates have to be open, and an admitted attempt is charged to
            // both: one token spent and one stamp recorded. Charging only the
            // bucket is what let an idle-then-burst run reach C + R*T.
            if (bucketWaitMs === 0 && ceilingWaitMs === 0) {
                state = { tokens: state.tokens - 1, lastRefillMs: state.lastRefillMs };
                attemptWindow = recordAttemptWindow(attemptWindow, nowMs, RATE_WINDOW_MS);
                recordAttempt(nowMs);
                return;
            }

            // The longer wait, because satisfying the nearer gate would only
            // wake into the other one.
            const waitMs = Math.max(bucketWaitMs, ceilingWaitMs);
            // Which gate held is the one thing an operator needs from this
            // line: 'burst' is the pacer doing its job between batches, while
            // 'hourly_ceiling' means the run has spent its whole hourly
            // allowance and is waiting for the oldest attempt to age out.
            const reason: 'burst' | 'hourly_ceiling' =
                ceilingWaitMs >= bucketWaitMs ? 'hourly_ceiling' : 'burst';

            recordPause(waitMs);
            // One line per pause, never per request: at 900 requests an hour a
            // per-request line is ~900 lines that bury the pauses, which are
            // the only thing here an operator has to act on. Logged before the
            // wait so a live run shows the pause while it is happening.
            logger?.info('usda_rate_limit_pause', {
                waitMs,
                reason,
                attempts: counters.attempts,
                configuredPerHour: requestsPerHour,
            });
            await sleep(waitMs);
        }
    };

    type FetchFn = typeof globalThis.fetch;

    let restoreInstalled: (() => void) | null = null;

    const install = (): (() => void) => {
        // Installing twice would wrap the wrapper and spend two tokens per
        // request, silently halving the configured rate — so a second call is
        // the same installation, not a new one.
        if (restoreInstalled !== null) {
            return restoreInstalled;
        }

        // Captured at install time, not at module load, so whatever is
        // currently installed is what the wrapper delegates to.
        const original: FetchFn = globalThis.fetch;
        let active = true;

        // Gating `globalThis.fetch` is what makes the accounting per PHYSICAL
        // request. `usda.service.ts` retries up to four times around its own
        // `fetch` call, so wrapping its exported functions would count one
        // logical lookup and miss up to three real vendor requests; it also
        // catches the background cache refresh, which no service call fronts,
        // and correctly counts nothing for a cache hit that never fetches.
        const paced = async (...args: Parameters<FetchFn>): ReturnType<FetchFn> => {
            // Everything that is not USDA traffic — OpenRouter, evidence
            // retrieval — passes straight through: no token, no stats, no log
            // line, no delay.
            if (isUsdaRequestUrl(args[0], host)) {
                await acquire();
            }
            return original(...args);
        };

        const restore = (): void => {
            // Safe to call twice: once it has handed the global back, what is
            // installed by then is somebody else's business.
            if (!active) {
                return;
            }

            // Deliberately narrow, and this identity check is the whole of it:
            // the original goes back only while the global is still OUR
            // wrapper. Anything installed on top of it — a sibling limiter, a
            // test transport, an instrumentation hook — owns `globalThis.fetch`
            // now, and assigning `original` over that would silently disable a
            // wrapper this module knows nothing about. `Object.assign` returns
            // its target, so the value installed below is `paced` itself.
            if (globalThis.fetch !== paced) {
                // `active` and `restoreInstalled` stay set on purpose, which
                // keeps both halves of the contract: `install` still refuses to
                // wrap twice, and a later `restore` succeeds once the newer
                // owner steps down and our wrapper is the global again. Host
                // only, never a URL — a USDA URL carries `api_key`.
                logger?.debug('usda_rate_limit_restore_skipped', {
                    host,
                    reason: 'foreign_fetch_owner',
                });
                return;
            }

            active = false;
            restoreInstalled = null;
            globalThis.fetch = original;
        };

        // Carries the real fetch's own enumerable properties across. On Node
        // 22 that copies nothing (fetch has none), but a runtime attaching a
        // helper such as undici's `preconnect` would otherwise lose it behind
        // the wrapper. No cast is needed — lib.dom types fetch as a plain
        // function, verified by compiling.
        globalThis.fetch = Object.assign(paced, original);
        restoreInstalled = restore;

        logger?.debug('usda_rate_limit_installed', {
            host,
            configuredPerHour: requestsPerHour,
            burstCapacity: capacity,
            vendorCapPerHour,
        });

        return restore;
    };

    const stats = (): UsdaRequestStats => ({
        configuredPerHour: requestsPerHour,
        vendorCapPerHour,
        burstCapacity: capacity,
        attempts: counters.attempts,
        pauses: counters.pauses,
        totalPausedMs: counters.totalPausedMs,
        longestPauseMs: counters.longestPauseMs,
        firstAttemptAt: counters.firstAttemptAt,
        lastAttemptAt: counters.lastAttemptAt,
    });

    return { acquire, install, stats };
};
