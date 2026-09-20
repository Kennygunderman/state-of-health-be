// The request-throttling boundary: the Express plumbing and the in-process
// store behind the three buckets `src/app.ts` mounts. Every decision it makes
// comes from `src/services/rateLimit.logic.ts`; this file owns only the things
// a pure module must not — the clock, the map, the response, and the one read
// of `process.env`.
//
// It answers QA finding F04 (no abuse control on any endpoint except the AI
// daily quota): 15 unauthenticated `POST /api/user` calls created fifteen real
// user rows, and 40 unauthenticated requests produced an unlimited stream of
// `401`s, with zero `429`s anywhere.
//
// WHY IT IS HAND-WRITTEN. AAP §0.4.2 fixes the dependency set — "No new runtime
// dependency is added to either repository" — so `express-rate-limit`, which
// the finding suggests, is not available. The arithmetic a fixed window needs
// is a dozen lines, and putting it in a pure `*.logic.ts` module makes it
// testable without a server, which a vendored middleware would not have been.
//
// WHAT THE STORE IS, AND WHAT THAT MEANS. One `Map` per limiter instance, in
// this process. Two consequences, both deliberate:
//
//  * A deployment with N API replicas enforces N times each limit, because the
//    replicas do not share the map. That is the honest cost of adding no
//    dependency (a shared counter would mean Redis), it fails OPEN rather than
//    closed, and every limit here is chosen as an abuse ceiling rather than a
//    quota anyone is metered against — so N× a ceiling is still a ceiling. The
//    AI daily quota, which IS metered per user, has always lived in the
//    database for exactly this reason and is untouched.
//  * The map is bounded. Entries are swept once their window has elapsed, and
//    `maxTrackedKeys` caps how many may be live at once; only the
//    per-principal bucket has non-trivial cardinality, and its keys are
//    verified-token subjects, which an attacker cannot mint.
//
// NO TIMER, ANYWHERE. The sweep is lazy — it runs on the request that would
// otherwise grow the map past its bound — because a `setInterval` in a module
// every test imports holds the event loop open and makes Jest hang at the end
// of a run. The cost is bounded: a sweep is O(size) and happens at most once
// per window per limiter under steady state.

import { NextFunction, Request, RequestHandler, Response } from 'express';

import {
    RateLimitKey,
    RateLimitPolicy,
    RateLimitWindow,
    deriveRateLimitKey,
    evaluateRateLimit,
    isWindowExpired,
    resolveRateLimitPolicies,
    windowSeconds,
} from '../services/rateLimit.logic';
import { logSafeEvent } from '../utils/safeLogger';

/**
 * The resolved policy set for this process, read ONCE at module load.
 *
 * The placement is the requirement in Rule backend-architecture §5 ("resolve
 * config once at the top of the module, not inside the flow"): a limiter that
 * re-read the environment per request could answer two requests under two
 * policies, and the environment is not reloadable anyway — `dotenv.config()`
 * runs in `server.ts` before this module is imported.
 *
 * Exported so an operator-facing surface — and the suite — can report the
 * policy actually in force rather than restating the defaults.
 */
export const rateLimitPolicies = resolveRateLimitPolicies();

/** The response body's `error` code for a throttled request. */
export const RATE_LIMITED_CODE = 'rate_limited';

/** The log event name. Underscored: `EVENT_NAME_PATTERN` rewrites a dotted name to `unnamed_event`. */
export const RATE_LIMIT_REFUSED_EVENT = 'rate_limit_refused';

/** The dotted form belongs in `action` — the partition every call site in this codebase follows. */
export const RATE_LIMIT_ACTION = 'app.rate_limit';

/** Emitted at most once per window per limiter, when the store has to evict a live entry. */
export const RATE_LIMIT_STORE_PRESSURE_EVENT = 'rate_limit_store_pressure';

/** The status a throttled request is answered with (RFC 6585 §4). */
const TOO_MANY_REQUESTS = 429;

/** The status whose surcharge makes an authentication flood terminate (CWE-307). */
const UNAUTHORIZED = 401;

/**
 * The refusal's headers.
 *
 * Emitted on the 429 ONLY, and that is a deliberate scope choice: three
 * limiters are mounted in sequence, so headers written on every response would
 * describe whichever bucket ran last rather than the one that matters. On a
 * refusal there is exactly one bucket to describe — the one that refused.
 *
 * `RateLimit-*` is the IETF draft spelling most clients and proxies already
 * read; `Retry-After` is the RFC 6585 requirement and the one a well-behaved
 * client actually honours.
 */
const RETRY_AFTER_HEADER = 'Retry-After';
const RATELIMIT_LIMIT_HEADER = 'RateLimit-Limit';
const RATELIMIT_REMAINING_HEADER = 'RateLimit-Remaining';
const RATELIMIT_RESET_HEADER = 'RateLimit-Reset';
const RATELIMIT_POLICY_HEADER = 'RateLimit-Policy';

/**
 * Knobs a caller may inject. All three default to the module-level policy set;
 * they exist so `src/__tests__/api/rateLimit.test.ts` can drive the real
 * middleware with a two-request window and a controlled clock — the policies
 * are disabled under `NODE_ENV=test`, so injection is the only way to observe
 * a refusal at all.
 */
export interface RateLimiterOptions {
    /** Proxies this deployment owns; 0 (the default) disables per-IP keying. */
    readonly trustedProxyDepth?: number;
    /** Upper bound on live keys in this limiter's store. */
    readonly maxTrackedKeys?: number;
    /** The clock. Injected only by tests; production reads `Date.now`. */
    readonly now?: () => number;
}

/**
 * A mounted limiter: the Express handler plus the two reads that make its store
 * observable and resettable.
 *
 * `handler` is what `app.use` takes. `size` and `reset` exist for the suite and
 * for an operator reading the store's occupancy; neither is a control input,
 * and nothing in the request path calls them.
 */
export interface RateLimiter {
    /** The Express middleware. */
    readonly handler: RequestHandler;
    /** Live key count — an operator/test read, never a control input. */
    readonly size: () => number;
    /** Drops every window. Used between test cases; never called in production. */
    readonly reset: () => void;
}

/**
 * Builds one limiter over one policy.
 *
 * @param policy the bucket to spend from, already resolved
 * @param options the store bound, the proxy depth and the clock
 */
export const createRateLimiter = (policy: RateLimitPolicy, options: RateLimiterOptions = {}): RateLimiter => {
    const windows = new Map<string, RateLimitWindow>();
    const trustedProxyDepth = options.trustedProxyDepth ?? rateLimitPolicies.trustedProxyDepth;
    const maxTrackedKeys = options.maxTrackedKeys ?? rateLimitPolicies.maxTrackedKeys;
    const now = options.now ?? Date.now;

    /** When the store last reported pressure, so the warning cannot itself become a flood. */
    let lastPressureReportAt = 0;

    const keyFor = (req: Request): RateLimitKey =>
        deriveRateLimitKey(
            {
                // `(req as any).user` is what `authenticateFirebaseToken` sets,
                // and it is `any` there; the narrowing happens in the logic
                // module, which takes the subject as `unknown` precisely so no
                // call site has to assert a shape it cannot guarantee.
                principalId: (req as Request & { user?: { uid?: unknown } }).user?.uid,
                forwardedFor: req.headers['x-forwarded-for'],
                socketAddress: req.socket.remoteAddress,
            },
            trustedProxyDepth,
        );

    /**
     * Makes room for one more key.
     *
     * Sweeps elapsed windows first — under steady state that is always enough,
     * because a key is only live for one window. If every entry is still live,
     * the one closest to expiry is evicted: it is the entry with the least
     * enforcement left to do, and dropping it costs a fraction of a window
     * rather than refusing a request the policy would have allowed. The
     * eviction is reported once per window, because a store that is genuinely
     * too small for its traffic is a configuration fact an operator needs.
     */
    const makeRoom = (nowMs: number): void => {
        if (windows.size < maxTrackedKeys) {
            return;
        }

        for (const [key, window] of windows) {
            if (isWindowExpired(policy, window, nowMs)) {
                windows.delete(key);
            }
        }

        if (windows.size < maxTrackedKeys) {
            return;
        }

        let earliestKey: string | undefined;
        let earliestStartedAt = Number.POSITIVE_INFINITY;

        for (const [key, window] of windows) {
            if (window.windowStartedAt < earliestStartedAt) {
                earliestStartedAt = window.windowStartedAt;
                earliestKey = key;
            }
        }

        if (earliestKey !== undefined) {
            windows.delete(earliestKey);
        }

        if (nowMs - lastPressureReportAt >= policy.windowMs) {
            lastPressureReportAt = nowMs;
            logSafeEvent('warn', RATE_LIMIT_STORE_PRESSURE_EVENT, {
                action: RATE_LIMIT_ACTION,
                policy: policy.name,
                trackedKeys: windows.size,
                maxTrackedKeys,
            });
        }
    };

    /**
     * Spends `cost` tokens against one key without deciding anything.
     *
     * Takes the key VALUE rather than the request, so the surcharge below is
     * charged to the exact bucket the request was admitted under: re-deriving
     * the key after the response would read a `req.user` that may have been set
     * in between, and charge a principal for a refusal the global bucket saw.
     */
    const spend = (keyValue: string, cost: number): void => {
        if (cost <= 0) {
            return;
        }

        const decision = evaluateRateLimit(policy, windows.get(keyValue), now(), cost);

        windows.set(keyValue, decision.window);
    };

    const handler: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
        if (!policy.enabled) {
            // No store write at all while disabled: a policy that is off must
            // not accumulate state nothing will ever read.
            return next();
        }

        const nowMs = now();
        const key = keyFor(req);
        const stored = windows.get(key.value);

        if (stored === undefined) {
            makeRoom(nowMs);
        }

        const decision = evaluateRateLimit(policy, stored, nowMs, 1);

        windows.set(key.value, decision.window);

        if (decision.allowed) {
            if (policy.failureSurcharge > 0) {
                // Registered BEFORE next(), so it is attached however the
                // response is produced — including a handler that answers
                // synchronously. A `401` is what an unauthenticated flood costs
                // extra; the surcharge is charged after the answer rather than
                // in `middleware/auth.ts`, which keeps the throttle out of the
                // authentication path entirely and needs no cooperation from
                // any handler that answers 401 (the global auth boundary, the
                // per-route avatar auth, a future one).
                res.on('finish', () => {
                    if (res.statusCode === UNAUTHORIZED) {
                        spend(key.value, policy.failureSurcharge);
                    }
                });
            }

            return next();
        }

        // One scrubbed line per refusal, at `warn` rather than `error`: a
        // refusal is a decision this server made, not a fault it suffered —
        // the level partition `src/__tests__/api/controllerBoundary.test.ts`
        // pins. It carries NO client data: no path (which can hold an entity
        // id), no token subject and no address. `keyKind` says which class of
        // caller was refused, which is what an operator needs to tell a
        // per-principal refusal from a process-wide one.
        logSafeEvent('warn', RATE_LIMIT_REFUSED_EVENT, {
            action: RATE_LIMIT_ACTION,
            policy: policy.name,
            keyKind: key.kind,
            method: req.method,
            status: TOO_MANY_REQUESTS,
            code: RATE_LIMITED_CODE,
            limit: decision.limit,
            windowSeconds: windowSeconds(policy),
            retryAfterSeconds: decision.retryAfterSeconds,
            consumed: decision.window.consumed,
        });

        res.setHeader(RETRY_AFTER_HEADER, String(decision.retryAfterSeconds));
        res.setHeader(RATELIMIT_LIMIT_HEADER, String(decision.limit));
        res.setHeader(RATELIMIT_REMAINING_HEADER, '0');
        res.setHeader(RATELIMIT_RESET_HEADER, String(decision.retryAfterSeconds));
        res.setHeader(RATELIMIT_POLICY_HEADER, `${decision.limit};w=${windowSeconds(policy)}`);

        return res.status(TOO_MANY_REQUESTS).json({
            error: RATE_LIMITED_CODE,
            policy: policy.name,
            limit: decision.limit,
            retryAfterSeconds: decision.retryAfterSeconds,
            resetsAt: new Date(decision.resetAtMs).toISOString(),
        });
    };

    return {
        handler,
        size: () => windows.size,
        reset: () => windows.clear(),
    };
};

/**
 * The process-wide ceiling, mounted ahead of every body parser so a flood
 * cannot make `express.json()` parse its payloads, and carrying the
 * failed-authentication surcharge.
 */
export const globalRateLimiter = createRateLimiter(rateLimitPolicies.global);

/** Unauthenticated account creation on `POST /api/user` — the one unauthenticated write. */
export const signupRateLimiter = createRateLimiter(rateLimitPolicies.signup);

/** Per verified principal, mounted immediately after the authentication boundary. */
export const principalRateLimiter = createRateLimiter(rateLimitPolicies.principal);
