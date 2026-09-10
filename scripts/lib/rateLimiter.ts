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
// The rate is a constructor argument, never an environment read inside the
// flow (§1.6/§5): `getUsdaImportRateLimitPerHour` is the single accessor that
// reads `USDA_IMPORT_RATE_LIMIT_PER_HOUR`, and it fails loudly (§9). The rules
// worth getting wrong — the refill arithmetic, the wait computation, the host
// match and the burst invariant — are pure and exported so they can be unit
// tested with no clock and no network (§1.2/§7.1); `await sleep` and the
// `globalThis.fetch` patch are the only impure parts. Jest's `roots` is
// `<rootDir>/src`, so no test file can live in this folder (§11); `now`,
// `sleep` and `logger` are injected so a test can drive an hour of pacing
// instantly.

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
    /** Consumes one request's allowance, waiting if none is available. */
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

    const parsed = Number(raw.trim());
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > USDA_VENDOR_CAP_PER_HOUR) {
        // The parsed number is safe to echo; the raw string is not. A
        // misplaced paste can put a credential on this line, and this message
        // reaches terminals, CI logs and committed reports.
        const observed = Number.isFinite(parsed) ? `${parsed}` : 'not a number';
        throw new RateLimitConfigError(
            `${RATE_LIMIT_ENV_VAR} must be an integer between 1 and ${USDA_VENDOR_CAP_PER_HOUR} (got ${observed})`,
            Number.isFinite(parsed) ? parsed : null,
            null,
            USDA_VENDOR_CAP_PER_HOUR,
        );
    }

    return parsed;
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

// `hostOf` reduces a URL to its hostname but answers 'invalid-url' for a bare
// hostname, so which form arrived has to be decided first. Both are accepted
// because `usda.service.ts` reads `USDA_BASE_URL`, and a caller wiring the
// limiter to a mock server would naturally pass that base URL straight through.
const normalizeHost = (host: string): string => {
    const trimmed = host.trim();
    if (!trimmed.includes('://')) {
        return trimmed.toLowerCase();
    }
    const parsed = hostOf(trimmed);
    return parsed === 'invalid-url' ? '' : parsed;
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
        return new URL(href).hostname.toLowerCase() === expected;
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

    // A token bucket with capacity C refilling at rate R admits up to
    // C + R*T requests in any window of length T. The burst allowance is
    // therefore not free: it is a bill the vendor pays on top of the rate.
    // C = 900 with R = 900/hour would admit 1,800 in a rolling hour and blow
    // straight through USDA's 1,000/hour cap — which is why the burst stays
    // small (one detail batch) and why it is the SUM, not the rate alone, that
    // has to fit under the vendor's ceiling. Do not "simplify" the capacity to
    // requestsPerHour.
    if (capacity + requestsPerHour > vendorCapPerHour) {
        reject(
            `burstCapacity ${capacity} + requestsPerHour ${requestsPerHour} exceeds ` +
                `vendorCapPerHour ${vendorCapPerHour}: a token bucket admits capacity + rate * window ` +
                `requests, so the burst and the rate must fit under the vendor's hourly cap together`,
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
        // An empty bucket answers "later", never "no": the import pauses
        // rather than failing, because aborting a multi-hour run over
        // allowance it will have again in seconds is strictly worse than
        // waiting for it. Looping rather than sleeping once is deliberate — a
        // coarse timer can wake early — and it cannot spin hot, because
        // `tokens < 1` makes `waitMsForToken` round up to at least 1ms.
        for (;;) {
            const nowMs = readClock();
            state = refillBucket(state, nowMs, tokensPerMs, capacity);

            if (state.tokens >= 1) {
                state = { tokens: state.tokens - 1, lastRefillMs: state.lastRefillMs };
                recordAttempt(nowMs);
                return;
            }

            const waitMs = waitMsForToken(state, nowMs, tokensPerMs, capacity);
            recordPause(waitMs);
            // One line per pause, never per request: at 900 requests an hour a
            // per-request line is ~900 lines that bury the pauses, which are
            // the only thing here an operator has to act on. Logged before the
            // wait so a live run shows the pause while it is happening.
            logger?.info('usda_rate_limit_pause', {
                waitMs,
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
            // Safe to call twice, and deliberately narrow: after restoring it
            // must not overwrite whatever is installed by then, which may be
            // someone else's wrapper rather than ours.
            if (!active) {
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
