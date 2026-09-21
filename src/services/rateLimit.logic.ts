// The pure request-throttling domain: the fixed-window counter arithmetic, the
// bucket-key derivation, and the policy resolution behind the three limiters
// `src/middleware/rateLimit.ts` mounts. It answers the abuse-control gap QA
// recorded (F04): 40 authenticated requests, 40 unauthenticated requests and 15
// unauthenticated `POST /api/user` calls all produced zero 429s, so the only
// abuse control in the service was the AI daily quota.
//
// Everything here is deterministic and synchronous: no Prisma, no network, no
// clock and no `process.env` read of its own. `nowMs` arrives as a parameter
// and the environment arrives as an argument, which is what makes every rule
// below unit-testable with plain values — the split Rule backend-architecture
// §7 prescribes, where the middleware owns the store, the clock and the
// response and this module owns the decisions.
//
// THREE DESIGN CONSTRAINTS ARE LOAD-BEARING, and none of them is obvious from
// the shape of the code:
//
//  1. THE UNAUTHENTICATED BUCKET IS GLOBAL, NOT PER-IP. `src/app.ts`
//     deliberately leaves `trust proxy` unset, and this deployment sits behind
//     a proxy that APPENDS to `X-Forwarded-For` — so `req.ip` is the proxy's
//     own address for all production traffic and the header's FIRST value is
//     attacker-supplied. Keying on either one would throttle the entire user
//     base as a single client, or hand an attacker a free bucket per forged
//     header value. So unauthenticated traffic shares one process-wide bucket
//     and authenticated traffic is keyed per principal, which is the identity
//     the verified token establishes and nothing a client can mint.
//
//     Per-IP keying is still reachable, but only as an operator decision:
//     `trustedProxyDepth` names how many proxies of its own a deployment has,
//     and the client address is then read that many values from the RIGHT of
//     the header (each hop appends, so the rightmost values are the ones this
//     infrastructure wrote). It is 0 — off — by default, so the behaviour
//     cannot change by accident, and a depth that the header cannot satisfy
//     falls back rather than trusting a forged value.
//
//  2. A REFUSED REQUEST STILL CONSUMES ITS TOKENS, and the window START is
//     never moved by one. A fixed window that restarted on refusal would let a
//     flood hold a bucket closed indefinitely; with the start pinned, the
//     refusal ends when the window it belongs to ends, whatever arrives in
//     between.
//
//  3. AN EXPENSIVE OUTCOME COSTS MORE THAN ONE TOKEN. `evaluateRateLimit`
//     takes a cost, and the middleware charges a surcharge once it sees a
//     request answered `401` — which is what makes an unlimited stream of
//     failed authentications (CWE-307) terminate in a 429 without a separate
//     bucket, a separate store, or a change in `src/middleware/auth.ts`.

/* ---------------------------------------------------------------------------
 * Policy
 * ------------------------------------------------------------------------- */

/** The three buckets, named so a log line and a refusal body can say which one refused. */
export type RateLimitPolicyName = 'global' | 'signup' | 'principal';

/**
 * One resolved bucket policy. Frozen at resolution time and carried by value,
 * so a middleware instance cannot be reconfigured at runtime by a later
 * environment change.
 */
export interface RateLimitPolicy {
    /** Which bucket this is; emitted in the refusal body and the log line. */
    readonly name: RateLimitPolicyName;
    /** `false` makes every decision an allow — the posture under `NODE_ENV=test`. */
    readonly enabled: boolean;
    /** Tokens available per window. */
    readonly limit: number;
    /** Window length in milliseconds. */
    readonly windowMs: number;
    /**
     * Extra tokens a request answered `401` costs, charged after the response.
     * Non-zero only on the global bucket, which is the only one mounted ahead
     * of every authentication boundary.
     */
    readonly failureSurcharge: number;
}

/** Every policy the process runs, plus the two store-wide settings the middleware needs. */
export interface ResolvedRateLimitPolicies {
    /** Whether throttling is active at all in this process. */
    readonly enabled: boolean;
    /** The process-wide pre-parser ceiling, carrying the failed-authentication surcharge. */
    readonly global: RateLimitPolicy;
    /** The unauthenticated account-creation bucket on `POST /api/user`. */
    readonly signup: RateLimitPolicy;
    /** The per-principal bucket behind the authentication boundary. */
    readonly principal: RateLimitPolicy;
    /** How many proxies this deployment owns; 0 disables per-IP keying (the default). */
    readonly trustedProxyDepth: number;
    /** Upper bound on distinct keys any one limiter's store may hold. */
    readonly maxTrackedKeys: number;
}

/**
 * A rate-limit environment variable that is set but cannot be read as the
 * number it names.
 *
 * Its own class rather than a bare `Error`, for the reason Rule
 * backend-architecture §8 gives: the caller — module initialisation in
 * `src/middleware/rateLimit.ts` — must be able to tell a misconfigured limit
 * from any other startup failure, and `describeErrorSafely` prints the class
 * name.
 */
export class RateLimitConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RateLimitConfigError';
    }
}

/* ---------------------------------------------------------------------------
 * The configured numbers, and why each is the number it is
 * ------------------------------------------------------------------------- */

/** Every window is expressed in seconds in the environment and milliseconds in code. */
const MILLISECONDS_PER_SECOND = 1000;

/** The switch that turns throttling off wholesale; only the exact string `false` does it. */
export const RATE_LIMIT_ENABLED_ENV_VAR = 'RATE_LIMIT_ENABLED';

export const RATE_LIMIT_GLOBAL_MAX_ENV_VAR = 'RATE_LIMIT_GLOBAL_MAX';
export const RATE_LIMIT_GLOBAL_WINDOW_ENV_VAR = 'RATE_LIMIT_GLOBAL_WINDOW_SECONDS';
export const RATE_LIMIT_AUTH_FAILURE_SURCHARGE_ENV_VAR = 'RATE_LIMIT_AUTH_FAILURE_SURCHARGE';
export const RATE_LIMIT_SIGNUP_MAX_ENV_VAR = 'RATE_LIMIT_SIGNUP_MAX';
export const RATE_LIMIT_SIGNUP_WINDOW_ENV_VAR = 'RATE_LIMIT_SIGNUP_WINDOW_SECONDS';
export const RATE_LIMIT_PRINCIPAL_MAX_ENV_VAR = 'RATE_LIMIT_PRINCIPAL_MAX';
export const RATE_LIMIT_PRINCIPAL_WINDOW_ENV_VAR = 'RATE_LIMIT_PRINCIPAL_WINDOW_SECONDS';
export const RATE_LIMIT_TRUSTED_PROXY_DEPTH_ENV_VAR = 'RATE_LIMIT_TRUSTED_PROXY_DEPTH';
export const RATE_LIMIT_MAX_TRACKED_KEYS_ENV_VAR = 'RATE_LIMIT_MAX_TRACKED_KEYS';

/** Every bucket's default window. One minute is short enough that a refusal is self-clearing. */
export const DEFAULT_WINDOW_SECONDS = 60;

/**
 * The process-wide ceiling: 20 requests a second sustained.
 *
 * It has to clear the concurrency QA already recorded as correct behaviour — 40
 * authenticated requests in 0.6 s and 8 simultaneous grocery toggles in 0.11 s
 * — by a wide margin, because this bucket sees ALL traffic (it is mounted ahead
 * of the authentication boundary, where no principal is known yet). Its job is
 * not fairness between users, which the per-principal bucket below owns; it is
 * to stop a flood before `express.json()` can be made to parse its bodies.
 */
export const DEFAULT_GLOBAL_MAX = 1200;

/**
 * What a `401` answer costs the global bucket, on top of the one token every
 * request costs: 29, so a failed authentication costs 30 in total and 40 of
 * them in a minute exhaust {@link DEFAULT_GLOBAL_MAX}.
 *
 * That number is chosen against the finding: QA's "40 unauthenticated requests
 * in 0.0 s → 0 × 429" is exactly the burst that must now terminate in a
 * refusal, while ordinary traffic — where a 401 is a client whose token has
 * just expired, not a guesser — pays nothing extra beyond the one token.
 */
export const DEFAULT_AUTH_FAILURE_SURCHARGE = 29;

/**
 * Unauthenticated account creation: 10 a minute for the whole process.
 *
 * Low deliberately. `POST /api/user` is the one unauthenticated write in the
 * service, QA created fifteen real user rows with it in 0.1 s, and 10/minute is
 * still 14,400 a day — orders of magnitude above any legitimate signup rate for
 * this application, and low enough that the finding's 15-request burst is
 * refused partway through.
 */
export const DEFAULT_SIGNUP_MAX = 10;

/**
 * Per principal: 300 a minute, 5 a second sustained.
 *
 * Sized to leave every recorded legitimate pattern untouched — the 40-request
 * 0.6 s burst and the 8 concurrent toggles both sit an order of magnitude below
 * it — while bounding what one compromised or runaway client can cost the
 * database.
 */
export const DEFAULT_PRINCIPAL_MAX = 300;

/**
 * Per-IP keying off by default: this deployment's proxy appends to
 * `X-Forwarded-For`, so with no operator-declared depth there is no value in
 * that header this process may believe.
 */
export const DEFAULT_TRUSTED_PROXY_DEPTH = 0;

/**
 * The cap on distinct keys one store may hold, and why a cap is safe here.
 *
 * Only the per-principal bucket has unbounded-looking cardinality, and its keys
 * are verified-token subjects: an attacker cannot mint one without credentials,
 * so the live key count tracks real users rather than request volume. 50,000
 * entries of `{windowStartedAt, consumed}` is a few megabytes, and the
 * middleware sweeps expired entries before it ever reaches the cap.
 */
export const DEFAULT_MAX_TRACKED_KEYS = 50_000;

/** Above this, a window is long enough that a refusal outlives the incident it answers. */
const MAX_WINDOW_SECONDS = 3600;

/** More trusted hops than any sane topology; a bound, so a typo cannot index absurdly. */
const MAX_TRUSTED_PROXY_DEPTH = 8;

/* ---------------------------------------------------------------------------
 * Environment parsing
 * ------------------------------------------------------------------------- */

/**
 * The environment shape this module reads. `NodeJS.ProcessEnv` structurally,
 * but declared as its own index signature so a test can pass a literal without
 * constructing a process environment.
 */
export interface RateLimitEnvironment {
    readonly [key: string]: string | undefined;
}

/**
 * One optional integer knob.
 *
 * ABSENT OR BLANK FALLS BACK; PRESENT-BUT-UNREADABLE THROWS. That asymmetry is
 * the same decision `resolveConnectionLimit` in `src/prisma/client.ts` makes,
 * for the same reason: every variable here is optional and documented with its
 * default, so the only way to reach the throw is to have written something —
 * and a limit an operator wrote but the process could not read must not be
 * silently replaced by a different number. A security control quietly running
 * at a value nobody chose is the failure mode this file exists to remove.
 */
const readBoundedInteger = (
    env: RateLimitEnvironment,
    variable: string,
    fallback: number,
    minimum: number,
    maximum: number,
    description: string,
): number => {
    const configured = env[variable];

    if (configured === undefined || configured.trim().length === 0) {
        return fallback;
    }

    const parsed = Number(configured.trim());

    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new RateLimitConfigError(
            `${variable} must be an integer between ${minimum} and ${maximum} (${description}); ` +
                `received "${configured}". Leave it unset to use the default of ${fallback}.`,
        );
    }

    return parsed;
};

/**
 * Resolves every policy from one environment snapshot.
 *
 * Pure: it reads only its argument, so the middleware can resolve it once at
 * module load — the placement Rule backend-architecture §5 requires — while the
 * tests drive it with literals.
 *
 * `NODE_ENV === 'test'` yields DISABLED policies, and that is a deliberate
 * property of the policy rather than of each call site: the suite drives the
 * shipped `app.ts` through supertest, including deliberate concurrency cases,
 * and a live bucket there would fail tests that describe behaviour throttling
 * has nothing to say about. The limiter's own suite therefore builds its own
 * app and injects explicit policies, which is also the only way to assert the
 * refusal itself.
 *
 * @param env the environment to read; defaults to the process environment
 */
export const resolveRateLimitPolicies = (
    env: RateLimitEnvironment = process.env,
): ResolvedRateLimitPolicies => {
    // Two independent reasons to be off, and they are not the same reason: an
    // operator kill switch, and the test posture above.
    const enabled = env[RATE_LIMIT_ENABLED_ENV_VAR] !== 'false' && env.NODE_ENV !== 'test';

    const windowOf = (variable: string): number =>
        readBoundedInteger(env, variable, DEFAULT_WINDOW_SECONDS, 1, MAX_WINDOW_SECONDS, 'the window length in seconds') *
        MILLISECONDS_PER_SECOND;

    return {
        enabled,
        global: {
            name: 'global',
            enabled,
            limit: readBoundedInteger(
                env,
                RATE_LIMIT_GLOBAL_MAX_ENV_VAR,
                DEFAULT_GLOBAL_MAX,
                1,
                Number.MAX_SAFE_INTEGER,
                'requests per window across the whole process',
            ),
            windowMs: windowOf(RATE_LIMIT_GLOBAL_WINDOW_ENV_VAR),
            failureSurcharge: readBoundedInteger(
                env,
                RATE_LIMIT_AUTH_FAILURE_SURCHARGE_ENV_VAR,
                DEFAULT_AUTH_FAILURE_SURCHARGE,
                0,
                Number.MAX_SAFE_INTEGER,
                'extra tokens a request answered 401 costs',
            ),
        },
        signup: {
            name: 'signup',
            enabled,
            limit: readBoundedInteger(
                env,
                RATE_LIMIT_SIGNUP_MAX_ENV_VAR,
                DEFAULT_SIGNUP_MAX,
                1,
                Number.MAX_SAFE_INTEGER,
                'unauthenticated account creations per window',
            ),
            windowMs: windowOf(RATE_LIMIT_SIGNUP_WINDOW_ENV_VAR),
            failureSurcharge: 0,
        },
        principal: {
            name: 'principal',
            enabled,
            limit: readBoundedInteger(
                env,
                RATE_LIMIT_PRINCIPAL_MAX_ENV_VAR,
                DEFAULT_PRINCIPAL_MAX,
                1,
                Number.MAX_SAFE_INTEGER,
                'requests per authenticated principal per window',
            ),
            windowMs: windowOf(RATE_LIMIT_PRINCIPAL_WINDOW_ENV_VAR),
            failureSurcharge: 0,
        },
        trustedProxyDepth: readBoundedInteger(
            env,
            RATE_LIMIT_TRUSTED_PROXY_DEPTH_ENV_VAR,
            DEFAULT_TRUSTED_PROXY_DEPTH,
            0,
            MAX_TRUSTED_PROXY_DEPTH,
            'proxies this deployment owns, counted back from X-Forwarded-For; 0 disables per-IP keying',
        ),
        maxTrackedKeys: readBoundedInteger(
            env,
            RATE_LIMIT_MAX_TRACKED_KEYS_ENV_VAR,
            DEFAULT_MAX_TRACKED_KEYS,
            1,
            Number.MAX_SAFE_INTEGER,
            'distinct keys one limiter store may hold',
        ),
    };
};

/* ---------------------------------------------------------------------------
 * Key derivation
 * ------------------------------------------------------------------------- */

/** What a bucket key identifies: one verified principal, one client address, or everyone. */
export type RateLimitKeyKind = 'user' | 'ip' | 'global';

/**
 * A bucket key: the `kind` is what goes in a log line, the `value` is what
 * indexes the store. They are separate because the kind is safe to publish and
 * the value is not — `value` carries a token subject or a client address.
 */
export interface RateLimitKey {
    readonly kind: RateLimitKeyKind;
    readonly value: string;
}

/**
 * Everything about a request that can identify a caller, reduced to values
 * before it reaches this module.
 *
 * `principalId` is `unknown` on purpose: it comes from `(req as any).user.uid`,
 * which no type system is guarding, so the narrowing has to happen here rather
 * than being assumed at the call site.
 */
export interface RateLimitIdentity {
    /** The verified token's subject, when the request has passed an auth boundary. */
    readonly principalId?: unknown;
    /** The raw `X-Forwarded-For` header, in either shape Express can produce. */
    readonly forwardedFor?: string | string[];
    /** The socket's peer address — the proxy's, in this deployment. */
    readonly socketAddress?: string;
}

/** The single global key. A constant, so the log and the store agree on its spelling. */
export const GLOBAL_BUCKET_KEY = 'global:all';

const USER_KEY_PREFIX = 'user:';

const IP_KEY_PREFIX = 'ip:';

/**
 * An IPv4 or IPv6 address as a proxy writes one, optionally with a port or an
 * IPv6 zone. Validated rather than trusted because a forged header value
 * becomes a STORE KEY: without a bound and a charset, one attacker could fill
 * the key space with garbage of their own choosing.
 */
const CLIENT_ADDRESS_PATTERN = /^[0-9a-fA-F:.%[\]]{3,49}$/;

/**
 * The client address `trustedProxyDepth` hops back from the end of
 * `X-Forwarded-For`, or `undefined` when the header cannot honestly supply one.
 *
 * Counted from the RIGHT, and that is the whole point: every hop APPENDS, so
 * the last value was written by the proxy nearest this process and the first
 * value is whatever the client sent — the one an attacker controls. With
 * `depth = 1` and `X-Forwarded-For: 203.0.113.9, 10.0.0.7`, the address is
 * `203.0.113.9`: index `length - depth`. A header with fewer values than the
 * declared depth is a topology mismatch rather than a client to blame, so it
 * yields `undefined` and the caller falls back.
 */
const clientAddressFromForwardedFor = (
    forwardedFor: string | string[] | undefined,
    trustedProxyDepth: number,
): string | undefined => {
    if (forwardedFor === undefined || trustedProxyDepth <= 0) {
        return undefined;
    }

    // A repeated header arrives as an array; RFC 7239 semantics are the same as
    // one header with the values joined in order.
    const joined = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
    const hops = joined
        .split(',')
        .map((hop) => hop.trim())
        .filter((hop) => hop.length > 0);

    const candidate = hops[hops.length - trustedProxyDepth];

    return candidate !== undefined && CLIENT_ADDRESS_PATTERN.test(candidate) ? candidate : undefined;
};

/**
 * The bucket one request belongs to.
 *
 * In priority order, and the order is the security statement:
 *
 *  1. A verified principal, when there is one. It is the only identity a client
 *     cannot choose, so it is preferred over any header whenever it exists.
 *  2. A client address, but ONLY at an operator-declared proxy depth (see
 *     {@link clientAddressFromForwardedFor}). Off by default.
 *  3. Otherwise the single global bucket — never `req.ip` and never the first
 *     `X-Forwarded-For` value, because in this deployment the first is the
 *     attacker's and the socket address is the proxy's, shared by every client.
 *
 * @param identity the request's identifying values
 * @param trustedProxyDepth how many proxies this deployment owns; 0 disables
 *   per-IP keying entirely
 */
export const deriveRateLimitKey = (
    identity: RateLimitIdentity,
    trustedProxyDepth: number = DEFAULT_TRUSTED_PROXY_DEPTH,
): RateLimitKey => {
    const { principalId, forwardedFor, socketAddress } = identity;

    if (typeof principalId === 'string' && principalId.trim().length > 0) {
        return { kind: 'user', value: `${USER_KEY_PREFIX}${principalId.trim()}` };
    }

    if (trustedProxyDepth > 0) {
        const forwarded = clientAddressFromForwardedFor(forwardedFor, trustedProxyDepth);

        if (forwarded !== undefined) {
            return { kind: 'ip', value: `${IP_KEY_PREFIX}${forwarded}` };
        }

        // The socket's peer, which is the proxy in a proxied deployment and the
        // real client in a direct one. Reached only when per-IP keying is ON
        // and the header could not answer, so it is the operator's stated
        // topology being honoured rather than a guess.
        if (socketAddress !== undefined && CLIENT_ADDRESS_PATTERN.test(socketAddress)) {
            return { kind: 'ip', value: `${IP_KEY_PREFIX}${socketAddress}` };
        }
    }

    return { kind: 'global', value: GLOBAL_BUCKET_KEY };
};

/* ---------------------------------------------------------------------------
 * Fixed-window arithmetic
 * ------------------------------------------------------------------------- */

/**
 * One key's position in the current window. Immutable — every function here
 * returns a new state rather than mutating one, so the store's contents cannot
 * be changed by a decision that was never applied.
 */
export interface RateLimitWindow {
    /** When this window opened, in epoch milliseconds. Never moved by a refusal. */
    readonly windowStartedAt: number;
    /** Tokens spent in this window, refusals included. */
    readonly consumed: number;
}

/** The answer for one request, and the state to store back for its key. */
export interface RateLimitDecision {
    /** Whether the request may proceed. */
    readonly allowed: boolean;
    /** The window state after this request's cost is charged. */
    readonly window: RateLimitWindow;
    /** The policy's limit, for the response headers. */
    readonly limit: number;
    /** Tokens left after this request; never negative. */
    readonly remaining: number;
    /** When the current window ends, in epoch milliseconds. */
    readonly resetAtMs: number;
    /** Whole seconds until {@link resetAtMs}, at least 1 — the `Retry-After` value. */
    readonly retryAfterSeconds: number;
}

/** A fresh window opening now. */
export const openWindow = (nowMs: number): RateLimitWindow => ({ windowStartedAt: nowMs, consumed: 0 });

/**
 * The window a request at `nowMs` belongs to: the stored one while it is still
 * running, a fresh one once it has elapsed.
 *
 * `>=` rather than `>` at the boundary, so a window is exactly `windowMs` long
 * and a request arriving at `windowStartedAt + windowMs` opens the next one.
 * That single character decides whether a client is throttled for one window or
 * for one window plus a millisecond, which is why the boundary has its own
 * test.
 */
export const currentWindow = (
    policy: RateLimitPolicy,
    stored: RateLimitWindow | undefined,
    nowMs: number,
): RateLimitWindow => {
    if (stored === undefined || nowMs - stored.windowStartedAt >= policy.windowMs || nowMs < stored.windowStartedAt) {
        // The third condition handles a clock that moved backwards (NTP step,
        // container suspend): a stored window in the future would otherwise
        // hold the bucket until real time caught up with it.
        return openWindow(nowMs);
    }

    return stored;
};

/** The same window with `cost` more tokens spent. */
export const chargeWindow = (window: RateLimitWindow, cost: number): RateLimitWindow => ({
    windowStartedAt: window.windowStartedAt,
    consumed: window.consumed + cost,
});

/**
 * The decision for one request against one key's stored window.
 *
 * A DISABLED POLICY ALWAYS ALLOWS AND NEVER CHARGES, so a caller does not have
 * to branch on `policy.enabled` and a disabled deployment does not accumulate
 * state it will never read.
 *
 * A REFUSAL STILL CHARGES. The tokens are spent whether or not the request was
 * served, which is what makes a flood visible in `consumed` and what stops a
 * refused caller from getting a free retry; the window's START is untouched, so
 * refusal always ends when the window does.
 *
 * @param policy the bucket being spent from
 * @param stored the key's last known window, or `undefined` for a first request
 * @param nowMs the current time, passed in so this function has no clock
 * @param cost tokens this request spends; > 1 for an outcome worth discouraging
 */
export const evaluateRateLimit = (
    policy: RateLimitPolicy,
    stored: RateLimitWindow | undefined,
    nowMs: number,
    cost: number = 1,
): RateLimitDecision => {
    const window = currentWindow(policy, stored, nowMs);
    const resetAtMs = window.windowStartedAt + policy.windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / MILLISECONDS_PER_SECOND));

    if (!policy.enabled) {
        return {
            allowed: true,
            window,
            limit: policy.limit,
            remaining: policy.limit,
            resetAtMs,
            retryAfterSeconds,
        };
    }

    const charged = chargeWindow(window, cost);
    const allowed = window.consumed + cost <= policy.limit;

    return {
        allowed,
        window: charged,
        limit: policy.limit,
        remaining: Math.max(0, policy.limit - charged.consumed),
        resetAtMs,
        retryAfterSeconds,
    };
};

/** The window length in whole seconds, for a refusal body and a log line. */
export const windowSeconds = (policy: RateLimitPolicy): number =>
    Math.round(policy.windowMs / MILLISECONDS_PER_SECOND);

/**
 * Whether a stored window has elapsed at `nowMs` and can be evicted.
 *
 * The store's sweep predicate, here rather than in the middleware because it is
 * the same window arithmetic as {@link currentWindow} and the two must not be
 * able to disagree about when a window is over.
 */
export const isWindowExpired = (policy: RateLimitPolicy, window: RateLimitWindow, nowMs: number): boolean =>
    nowMs - window.windowStartedAt >= policy.windowMs;
