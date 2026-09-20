// The rate-limit wiring suite: the middleware factory driven over real HTTP,
// with the exact refusal a client receives asserted byte for byte.
//
// WHY IT BUILDS ITS OWN APP INSTEAD OF DRIVING `src/app.ts`. The policy
// resolver returns DISABLED policies under `NODE_ENV=test`
// (`rateLimit.logic.ts::resolveRateLimitPolicies`), and that is deliberate: the
// shipped suite runs ~1,100 tests through supertest against the real app,
// including concurrency cases that fire dozens of requests at once, and a live
// bucket there would fail tests that describe behaviour throttling has nothing
// to say about. The consequence is that a refusal cannot be observed through
// the shipped app at all, so this file assembles a small Express app of its own
// and injects explicit policies — two-request limits and a controlled clock —
// into `createRateLimiter`. What it proves is therefore the MIDDLEWARE's
// behaviour; that `src/app.ts` mounts it in the right three places is a
// property of that file's mount order, asserted below by rebuilding the same
// order (health route, limiter, parser, handlers) and showing the health route
// stays exempt by position.
//
// THE CLOCK IS INJECTED, not slept through. A window roll asserted with a real
// `setTimeout` is a flaky test that also makes the suite slower; `now` is a
// factory option for exactly this, so "the window rolled" is an arithmetic
// statement here rather than a timing one.
//
// WHAT IS BEING PROVEN, case by case:
//
//  * The refusal a client sees: status, body, and every header — because a
//    `Retry-After` a client cannot read is not abuse control, it is a 429 with
//    no remedy.
//  * The limit boundary: exactly `limit` requests are served and the next one
//    is not.
//  * The window rolls and the bucket serves again, so a refusal is temporary.
//  * Two principals do NOT share a bucket, and two unauthenticated callers DO
//    — the second half is the property that keeps a proxy's own address from
//    throttling the whole user base as one client.
//  * A `401` costs extra, so an authentication flood terminates (CWE-307).
//  * `/health` is exempt by POSITION, which is how `src/app.ts` exempts it.
//  * The refusal is logged at `warn`, under the name an operator alerts on,
//    carrying no path, no token subject and no address.
//  * A disabled policy admits everything, which is the posture the rest of this
//    directory runs under.

import express, { NextFunction, Request, Response } from 'express';
import supertest from 'supertest';

import {
    RATE_LIMITED_CODE,
    RATE_LIMIT_ACTION,
    RATE_LIMIT_REFUSED_EVENT,
    RateLimiter,
    createRateLimiter,
    rateLimitPolicies,
} from '../../middleware/rateLimit';
import { RateLimitPolicy } from '../../services/rateLimit.logic';

/** A fixed instant every case starts from; advanced explicitly, never slept. */
const START = 1_800_000_000_000;

const WINDOW_MS = 60_000;

interface Harness {
    readonly request: supertest.Agent;
    readonly limiter: RateLimiter;
    /** Moves the injected clock forward. */
    readonly advance: (ms: number) => void;
}

const policyOf = (overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
    name: 'global',
    enabled: true,
    limit: 2,
    windowMs: WINDOW_MS,
    failureSurcharge: 0,
    ...overrides,
});

/**
 * An app shaped like `src/app.ts`: an unauthenticated `/health` ABOVE the
 * limiter, the limiter, then the body parser and the routes.
 *
 * `identify` stands in for `authenticateFirebaseToken`, setting `req.user` from
 * a header the way `src/__tests__/setup/jestSetup.ts` does for the shipped
 * suite — so the per-principal key is derived from `req.user.uid` exactly as it
 * is in production, and an unauthenticated request reaches the limiter with no
 * principal at all.
 */
const harnessFor = (
    policy: RateLimitPolicy,
    options: { readonly trustedProxyDepth?: number; readonly identify?: boolean } = {},
): Harness => {
    let nowMs = START;
    const limiter = createRateLimiter(policy, {
        now: () => nowMs,
        trustedProxyDepth: options.trustedProxyDepth ?? 0,
    });
    const app = express();

    app.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok' });
    });

    if (options.identify === true) {
        app.use((req: Request, res: Response, next: NextFunction) => {
            const uid = req.header('x-test-user-id');

            if (uid === undefined || uid.length === 0) {
                return res.status(401).json({ error: 'No token provided' });
            }

            (req as Request & { user?: { uid: string } }).user = { uid };

            return next();
        });
    }

    app.use(limiter.handler);
    app.use(express.json());

    app.get('/api/thing', (_req: Request, res: Response) => {
        res.json({ ok: true });
    });
    app.post('/api/thing', (req: Request, res: Response) => {
        res.status(201).json({ received: req.body });
    });
    app.get('/api/denied', (_req: Request, res: Response) => {
        res.status(401).json({ error: 'Invalid token' });
    });

    return {
        request: supertest(app),
        limiter,
        advance: (ms: number) => {
            nowMs += ms;
        },
    };
};

/** Drives one path N times in order and returns the status of each answer. */
const statusesOf = async (harness: Harness, count: number, path: string = '/api/thing'): Promise<number[]> => {
    const statuses: number[] = [];

    for (let index = 0; index < count; index += 1) {
        const response = await harness.request.get(path);

        statuses.push(response.status);
    }

    return statuses;
};

describe('the rate-limit middleware over HTTP', () => {
    // Every refusal below emits a real log line, so the writers are captured
    // for the whole file rather than per case: it keeps the run's output clean,
    // and it turns the level partition into an invariant checked after EVERY
    // case instead of an assertion two of them happen to make — a refusal that
    // was ever written as a fault fails the case that produced it.
    let warnLines: string[] = [];
    let errorLines: string[] = [];

    beforeEach(() => {
        warnLines = [];
        errorLines = [];
        jest.spyOn(console, 'warn').mockImplementation((line: unknown) => {
            warnLines.push(String(line));
        });
        jest.spyOn(console, 'error').mockImplementation((line: unknown) => {
            errorLines.push(String(line));
        });
    });

    afterEach(() => {
        const faults = errorLines;

        jest.restoreAllMocks();

        expect(faults).toEqual([]);
    });

    describe('the refusal a client receives', () => {
        it('answers 429 with the documented body once the bucket is empty', async () => {
            const harness = harnessFor(policyOf({ name: 'signup', limit: 1 }));

            await harness.request.get('/api/thing').expect(200);

            const refused = await harness.request.get('/api/thing');

            expect(refused.status).toBe(429);
            expect(refused.body).toEqual({
                error: RATE_LIMITED_CODE,
                policy: 'signup',
                limit: 1,
                retryAfterSeconds: 60,
                resetsAt: new Date(START + WINDOW_MS).toISOString(),
            });
        });

        it('carries Retry-After and the RateLimit-* headers a client can act on', async () => {
            const harness = harnessFor(policyOf({ limit: 1 }));

            await harness.request.get('/api/thing').expect(200);
            harness.advance(15_000);

            const refused = await harness.request.get('/api/thing');

            expect(refused.status).toBe(429);
            expect(refused.headers['retry-after']).toBe('45');
            expect(refused.headers['ratelimit-limit']).toBe('1');
            expect(refused.headers['ratelimit-remaining']).toBe('0');
            expect(refused.headers['ratelimit-reset']).toBe('45');
            expect(refused.headers['ratelimit-policy']).toBe('1;w=60');
        });

        it('refuses before the body parser runs, so a flood cannot make the process parse payloads', async () => {
            const harness = harnessFor(policyOf({ limit: 1 }));

            await harness.request.post('/api/thing').send({ first: true }).expect(201);

            // Deliberately malformed: had the parser run ahead of the limiter,
            // this would be answered 400 by body-parser instead of 429.
            const refused = await harness.request
                .post('/api/thing')
                .set('Content-Type', 'application/json')
                .send('{"broken": ');

            expect(refused.status).toBe(429);
            expect(refused.body.error).toBe(RATE_LIMITED_CODE);
        });
    });

    describe('the limit boundary', () => {
        it('serves exactly the limit and refuses the request after it', async () => {
            const harness = harnessFor(policyOf({ limit: 3 }));

            expect(await statusesOf(harness, 5)).toEqual([200, 200, 200, 429, 429]);
        });

        it('keeps refusing for the rest of the window, then serves again once it rolls', async () => {
            const harness = harnessFor(policyOf({ limit: 1 }));

            expect(await statusesOf(harness, 2)).toEqual([200, 429]);

            harness.advance(WINDOW_MS - 1);
            expect(await statusesOf(harness, 1)).toEqual([429]);

            harness.advance(1);
            expect(await statusesOf(harness, 2)).toEqual([200, 429]);
        });
    });

    describe('who shares a bucket', () => {
        it('gives two verified principals independent buckets', async () => {
            const harness = harnessFor(policyOf({ name: 'principal', limit: 1 }), { identify: true });

            await harness.request.get('/api/thing').set('x-test-user-id', 'user-a').expect(200);
            await harness.request.get('/api/thing').set('x-test-user-id', 'user-a').expect(429);

            // B is unaffected by A having exhausted its own bucket.
            await harness.request.get('/api/thing').set('x-test-user-id', 'user-b').expect(200);
            await harness.request.get('/api/thing').set('x-test-user-id', 'user-b').expect(429);

            expect(harness.limiter.size()).toBe(2);
        });

        it('puts unauthenticated callers in ONE bucket, whatever X-Forwarded-For claims', async () => {
            const harness = harnessFor(policyOf({ limit: 1 }));

            await harness.request.get('/api/thing').set('X-Forwarded-For', '198.51.100.1').expect(200);
            await harness.request.get('/api/thing').set('X-Forwarded-For', '198.51.100.2').expect(429);

            expect(harness.limiter.size()).toBe(1);
        });

        it('keys per client address only once an operator declares the proxy depth', async () => {
            const harness = harnessFor(policyOf({ limit: 1 }), { trustedProxyDepth: 1 });

            // One proxy appends the address it saw, so the LAST value is the
            // client and the prepended one is the attacker's.
            await harness.request.get('/api/thing').set('X-Forwarded-For', 'evil, 198.51.100.1').expect(200);
            await harness.request.get('/api/thing').set('X-Forwarded-For', 'other, 198.51.100.1').expect(429);
            await harness.request.get('/api/thing').set('X-Forwarded-For', 'evil, 198.51.100.2').expect(200);
        });
    });

    describe('what a failed authentication costs', () => {
        it('charges the surcharge after the response and refuses sooner than the request count would', async () => {
            const harness = harnessFor(policyOf({ limit: 10, failureSurcharge: 4 }));

            // Each 401 costs 1 + 4 = 5, so the third request is refused while a
            // 1-token accounting would have served ten.
            expect(await statusesOf(harness, 3, '/api/denied')).toEqual([401, 401, 429]);
        });

        it('charges nothing extra for a request that was answered normally', async () => {
            const harness = harnessFor(policyOf({ limit: 5, failureSurcharge: 4 }));

            expect(await statusesOf(harness, 6)).toEqual([200, 200, 200, 200, 200, 429]);
        });

        it('leaves a refusal itself unsurcharged, so a 429 does not pay a 401\u2019s price', async () => {
            const harness = harnessFor(policyOf({ limit: 1, failureSurcharge: 100 }));

            await harness.request.get('/api/denied').expect(401);
            await harness.request.get('/api/thing').expect(429);

            harness.advance(WINDOW_MS);

            // The window rolled; the 100-token surcharge did not leak into it.
            await harness.request.get('/api/thing').expect(200);
        });
    });

    describe('what is exempt', () => {
        it('never throttles /health, because it is mounted above the limiter', async () => {
            const harness = harnessFor(policyOf({ limit: 1 }));

            expect(await statusesOf(harness, 3)).toEqual([200, 429, 429]);

            // The bucket is empty and staying empty; the probe still answers.
            for (let probe = 0; probe < 5; probe += 1) {
                const response = await harness.request.get('/health');

                expect(response.status).toBe(200);
                expect(response.body).toEqual({ status: 'ok' });
            }
        });

        it('admits everything under a disabled policy, and stores nothing', async () => {
            const harness = harnessFor(policyOf({ enabled: false, limit: 1 }));

            expect(await statusesOf(harness, 5)).toEqual([200, 200, 200, 200, 200]);
            expect(harness.limiter.size()).toBe(0);
        });
    });

    describe('what a refusal records', () => {
        it('logs one warn-level line under the operator-facing event name', async () => {
            const harness = harnessFor(policyOf({ name: 'principal', limit: 1 }), { identify: true });

            await harness.request.get('/api/thing').set('x-test-user-id', 'user-a').expect(200);
            await harness.request.get('/api/thing').set('x-test-user-id', 'user-a').expect(429);

            expect(warnLines).toHaveLength(1);

            const prefix = `[meal-planning] ${RATE_LIMIT_REFUSED_EVENT} `;

            expect(warnLines[0].startsWith(prefix)).toBe(true);
            expect(JSON.parse(warnLines[0].slice(prefix.length))).toEqual({
                action: RATE_LIMIT_ACTION,
                policy: 'principal',
                keyKind: 'user',
                method: 'GET',
                status: 429,
                code: RATE_LIMITED_CODE,
                limit: 1,
                windowSeconds: 60,
                retryAfterSeconds: 60,
                consumed: 2,
            });
        });

        it('records no path, no token subject and no client address', async () => {
            const harness = harnessFor(policyOf({ limit: 1 }), { identify: true });

            await harness.request.get('/api/thing').set('x-test-user-id', 'secret-uid-42').expect(200);
            await harness.request
                .get('/api/thing')
                .set('x-test-user-id', 'secret-uid-42')
                .set('X-Forwarded-For', '198.51.100.77')
                .expect(429);

            expect(warnLines).toHaveLength(1);
            expect(warnLines[0]).not.toContain('secret-uid-42');
            expect(warnLines[0]).not.toContain('198.51.100.77');
            expect(warnLines[0]).not.toContain('/api/thing');
        });

        it('says which class of caller was refused, so a global refusal is not read as a per-user one', async () => {
            const harness = harnessFor(policyOf({ limit: 1 }));

            await harness.request.get('/api/thing').expect(200);
            await harness.request.get('/api/thing').expect(429);

            expect(warnLines).toHaveLength(1);
            expect(JSON.parse(warnLines[0].slice(`[meal-planning] ${RATE_LIMIT_REFUSED_EVENT} `.length)).keyKind).toBe(
                'global',
            );
        });
    });

    describe('the store bound', () => {
        it('evicts rather than growing past maxTrackedKeys', async () => {
            let nowMs = START;
            const limiter = createRateLimiter(policyOf({ name: 'principal', limit: 5 }), {
                now: () => nowMs,
                maxTrackedKeys: 2,
            });
            const app = express();

            app.use((req: Request, _res: Response, next: NextFunction) => {
                (req as Request & { user?: { uid: string } }).user = { uid: req.header('x-test-user-id') ?? 'anon' };
                next();
            });
            app.use(limiter.handler);
            app.get('/api/thing', (_req: Request, res: Response) => {
                res.json({ ok: true });
            });

            const client = supertest(app);

            for (const uid of ['a', 'b', 'c', 'd']) {
                await client.get('/api/thing').set('x-test-user-id', uid).expect(200);
            }

            expect(limiter.size()).toBeLessThanOrEqual(2);

            // And once the windows have elapsed the sweep, not the eviction,
            // is what reclaims them.
            nowMs += WINDOW_MS;
            await client.get('/api/thing').set('x-test-user-id', 'e').expect(200);
            expect(limiter.size()).toBeLessThanOrEqual(2);
        });

        it('drops every window on reset', async () => {
            const harness = harnessFor(policyOf({ limit: 1 }));

            await harness.request.get('/api/thing').expect(200);
            expect(harness.limiter.size()).toBe(1);

            harness.limiter.reset();

            expect(harness.limiter.size()).toBe(0);
            await harness.request.get('/api/thing').expect(200);
        });
    });

    describe('the policy this process actually mounted', () => {
        it('is disabled, because the suite runs under NODE_ENV=test', () => {
            expect(process.env.NODE_ENV).toBe('test');
            expect(rateLimitPolicies.enabled).toBe(false);
            expect(rateLimitPolicies.global.enabled).toBe(false);
            expect(rateLimitPolicies.signup.enabled).toBe(false);
            expect(rateLimitPolicies.principal.enabled).toBe(false);
        });

        it('keeps per-IP keying off, so no bucket can be keyed on a proxy\u2019s address', () => {
            expect(rateLimitPolicies.trustedProxyDepth).toBe(0);
        });
    });
});
