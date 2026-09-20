// The rate-limit domain's unit suite: the fixed-window arithmetic, the bucket
// keys and the policy resolution behind the three limiters `src/app.ts` mounts.
//
// What it pins, beyond "the code runs":
//
//  * THE WINDOW BOUNDARY. `>=` versus `>` in `currentWindow` decides whether a
//    refused client waits one window or one window plus a millisecond, and
//    nothing else in the system would notice the difference.
//  * THE KEY PRIORITY. A verified principal must outrank any header, an
//    attacker-prepended `X-Forwarded-For` value must never become a key, and
//    with per-IP keying off every unauthenticated request must land in ONE
//    bucket — the property that keeps a proxy's own address from throttling the
//    whole user base as a single client.
//  * THE REFUSAL ACCOUNTING. A refused request still spends its tokens and
//    never moves the window's start, so a flood cannot hold a bucket closed
//    past the window it arrived in.
//  * THE CONFIGURED NUMBERS. Each default is the number the finding's
//    reproduction was sized against; a silent change to one is a change to the
//    abuse control, so the values are asserted rather than described.
//  * THE FAIL-LOUD KNOBS. A variable that is set but unreadable throws instead
//    of falling back, so a deployment cannot end up running a limit nobody
//    chose.

import {
    DEFAULT_AUTH_FAILURE_SURCHARGE,
    DEFAULT_GLOBAL_MAX,
    DEFAULT_MAX_TRACKED_KEYS,
    DEFAULT_PRINCIPAL_MAX,
    DEFAULT_SIGNUP_MAX,
    DEFAULT_TRUSTED_PROXY_DEPTH,
    DEFAULT_WINDOW_SECONDS,
    GLOBAL_BUCKET_KEY,
    RATE_LIMIT_AUTH_FAILURE_SURCHARGE_ENV_VAR,
    RATE_LIMIT_ENABLED_ENV_VAR,
    RATE_LIMIT_GLOBAL_MAX_ENV_VAR,
    RATE_LIMIT_GLOBAL_WINDOW_ENV_VAR,
    RATE_LIMIT_MAX_TRACKED_KEYS_ENV_VAR,
    RATE_LIMIT_PRINCIPAL_MAX_ENV_VAR,
    RATE_LIMIT_PRINCIPAL_WINDOW_ENV_VAR,
    RATE_LIMIT_SIGNUP_MAX_ENV_VAR,
    RATE_LIMIT_SIGNUP_WINDOW_ENV_VAR,
    RATE_LIMIT_TRUSTED_PROXY_DEPTH_ENV_VAR,
    RateLimitConfigError,
    RateLimitPolicy,
    chargeWindow,
    currentWindow,
    deriveRateLimitKey,
    evaluateRateLimit,
    isWindowExpired,
    openWindow,
    resolveRateLimitPolicies,
    windowSeconds,
} from '../rateLimit.logic';

/** A fixed instant, so every assertion below is about arithmetic rather than about now. */
const NOW = 1_800_000_000_000;

const policyOf = (overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
    name: 'global',
    enabled: true,
    limit: 3,
    windowMs: 60_000,
    failureSurcharge: 0,
    ...overrides,
});

/** A production-shaped environment: nothing set, and not the test posture. */
const PRODUCTION_ENV = { NODE_ENV: 'production' } as const;

describe('resolveRateLimitPolicies', () => {
    describe('the defaults an unconfigured deployment runs', () => {
        it('enables all three buckets outside the test environment', () => {
            const policies = resolveRateLimitPolicies(PRODUCTION_ENV);

            expect(policies.enabled).toBe(true);
            expect(policies.global.enabled).toBe(true);
            expect(policies.signup.enabled).toBe(true);
            expect(policies.principal.enabled).toBe(true);
        });

        it('sizes each bucket at the number the finding was measured against', () => {
            const policies = resolveRateLimitPolicies(PRODUCTION_ENV);

            expect(policies.global.limit).toBe(DEFAULT_GLOBAL_MAX);
            expect(policies.global.failureSurcharge).toBe(DEFAULT_AUTH_FAILURE_SURCHARGE);
            expect(policies.signup.limit).toBe(DEFAULT_SIGNUP_MAX);
            expect(policies.principal.limit).toBe(DEFAULT_PRINCIPAL_MAX);
            expect(policies.trustedProxyDepth).toBe(DEFAULT_TRUSTED_PROXY_DEPTH);
            expect(policies.maxTrackedKeys).toBe(DEFAULT_MAX_TRACKED_KEYS);
        });

        it('gives every bucket the same one-minute window', () => {
            const policies = resolveRateLimitPolicies(PRODUCTION_ENV);

            for (const policy of [policies.global, policies.signup, policies.principal]) {
                expect(policy.windowMs).toBe(DEFAULT_WINDOW_SECONDS * 1000);
                expect(windowSeconds(policy)).toBe(DEFAULT_WINDOW_SECONDS);
            }
        });

        it('names each bucket, so a refusal can say which one refused', () => {
            const policies = resolveRateLimitPolicies(PRODUCTION_ENV);

            expect(policies.global.name).toBe('global');
            expect(policies.signup.name).toBe('signup');
            expect(policies.principal.name).toBe('principal');
        });

        it('charges the surcharge on the global bucket only — the one bucket ahead of every auth boundary', () => {
            const policies = resolveRateLimitPolicies(PRODUCTION_ENV);

            expect(policies.signup.failureSurcharge).toBe(0);
            expect(policies.principal.failureSurcharge).toBe(0);
        });

        it('sizes the surcharge so the finding\u2019s 40-request unauthenticated burst exhausts the global bucket', () => {
            const policies = resolveRateLimitPolicies(PRODUCTION_ENV);
            const costOfAFailedAuthentication = 1 + policies.global.failureSurcharge;

            expect(Math.floor(policies.global.limit / costOfAFailedAuthentication)).toBe(40);
        });

        it('leaves the concurrency QA recorded as correct well inside both live buckets', () => {
            const policies = resolveRateLimitPolicies(PRODUCTION_ENV);

            // 40 authenticated requests in 0.6 s, and 8 simultaneous grocery
            // toggles: both must stay far below the per-principal bucket and
            // below the process-wide ceiling.
            expect(policies.principal.limit).toBeGreaterThan(40 + 8);
            expect(policies.global.limit).toBeGreaterThan(40 + 8);
        });

        it('keeps the signup bucket low enough to refuse the finding\u2019s 15-request burst', () => {
            expect(resolveRateLimitPolicies(PRODUCTION_ENV).signup.limit).toBeLessThan(15);
        });
    });

    describe('the two ways it comes out disabled', () => {
        it('disables everything under NODE_ENV=test, so the shipped suite is not throttled', () => {
            const policies = resolveRateLimitPolicies({ NODE_ENV: 'test' });

            expect(policies.enabled).toBe(false);
            expect(policies.global.enabled).toBe(false);
            expect(policies.signup.enabled).toBe(false);
            expect(policies.principal.enabled).toBe(false);
        });

        it('disables everything on the operator kill switch', () => {
            expect(
                resolveRateLimitPolicies({ ...PRODUCTION_ENV, [RATE_LIMIT_ENABLED_ENV_VAR]: 'false' }).enabled,
            ).toBe(false);
        });

        it('treats only the exact string "false" as off', () => {
            for (const value of ['FALSE', 'False', '0', 'no', 'true', '']) {
                expect(
                    resolveRateLimitPolicies({ ...PRODUCTION_ENV, [RATE_LIMIT_ENABLED_ENV_VAR]: value }).enabled,
                ).toBe(true);
            }
        });

        it('keeps the configured sizes even while disabled, so a restart with it on needs no other change', () => {
            const policies = resolveRateLimitPolicies({
                NODE_ENV: 'test',
                [RATE_LIMIT_SIGNUP_MAX_ENV_VAR]: '4',
            });

            expect(policies.signup.limit).toBe(4);
            expect(policies.signup.enabled).toBe(false);
        });
    });

    describe('the knobs an operator may set', () => {
        it('takes every limit, window and store bound from the environment', () => {
            const policies = resolveRateLimitPolicies({
                ...PRODUCTION_ENV,
                [RATE_LIMIT_GLOBAL_MAX_ENV_VAR]: '50',
                [RATE_LIMIT_GLOBAL_WINDOW_ENV_VAR]: '5',
                [RATE_LIMIT_AUTH_FAILURE_SURCHARGE_ENV_VAR]: '9',
                [RATE_LIMIT_SIGNUP_MAX_ENV_VAR]: '2',
                [RATE_LIMIT_SIGNUP_WINDOW_ENV_VAR]: '30',
                [RATE_LIMIT_PRINCIPAL_MAX_ENV_VAR]: '7',
                [RATE_LIMIT_PRINCIPAL_WINDOW_ENV_VAR]: '15',
                [RATE_LIMIT_TRUSTED_PROXY_DEPTH_ENV_VAR]: '2',
                [RATE_LIMIT_MAX_TRACKED_KEYS_ENV_VAR]: '128',
            });

            expect(policies.global).toEqual({
                name: 'global',
                enabled: true,
                limit: 50,
                windowMs: 5_000,
                failureSurcharge: 9,
            });
            expect(policies.signup).toEqual({
                name: 'signup',
                enabled: true,
                limit: 2,
                windowMs: 30_000,
                failureSurcharge: 0,
            });
            expect(policies.principal).toEqual({
                name: 'principal',
                enabled: true,
                limit: 7,
                windowMs: 15_000,
                failureSurcharge: 0,
            });
            expect(policies.trustedProxyDepth).toBe(2);
            expect(policies.maxTrackedKeys).toBe(128);
        });

        it('accepts a surcharge of zero — the way to keep the ceiling and drop the auth-failure penalty', () => {
            expect(
                resolveRateLimitPolicies({
                    ...PRODUCTION_ENV,
                    [RATE_LIMIT_AUTH_FAILURE_SURCHARGE_ENV_VAR]: '0',
                }).global.failureSurcharge,
            ).toBe(0);
        });

        it('treats a blank or whitespace value as unset', () => {
            const policies = resolveRateLimitPolicies({
                ...PRODUCTION_ENV,
                [RATE_LIMIT_SIGNUP_MAX_ENV_VAR]: '',
                [RATE_LIMIT_GLOBAL_MAX_ENV_VAR]: '   ',
            });

            expect(policies.signup.limit).toBe(DEFAULT_SIGNUP_MAX);
            expect(policies.global.limit).toBe(DEFAULT_GLOBAL_MAX);
        });

        it('reads a value that carries surrounding whitespace', () => {
            expect(
                resolveRateLimitPolicies({ ...PRODUCTION_ENV, [RATE_LIMIT_SIGNUP_MAX_ENV_VAR]: ' 6 ' }).signup.limit,
            ).toBe(6);
        });

        it('defaults to the process environment when given none', () => {
            // The suite runs under NODE_ENV=test, which is exactly the posture
            // the zero-argument form has to report.
            expect(process.env.NODE_ENV).toBe('test');
            expect(resolveRateLimitPolicies().enabled).toBe(false);
        });
    });

    describe('a variable that is set but cannot be read', () => {
        const unusable: readonly [string, string][] = [
            [RATE_LIMIT_GLOBAL_MAX_ENV_VAR, 'lots'],
            [RATE_LIMIT_GLOBAL_MAX_ENV_VAR, '0'],
            [RATE_LIMIT_GLOBAL_MAX_ENV_VAR, '-5'],
            [RATE_LIMIT_GLOBAL_MAX_ENV_VAR, '12.5'],
            [RATE_LIMIT_GLOBAL_WINDOW_ENV_VAR, '0'],
            [RATE_LIMIT_GLOBAL_WINDOW_ENV_VAR, '7200'],
            [RATE_LIMIT_AUTH_FAILURE_SURCHARGE_ENV_VAR, '-1'],
            [RATE_LIMIT_SIGNUP_MAX_ENV_VAR, 'ten'],
            [RATE_LIMIT_SIGNUP_WINDOW_ENV_VAR, 'NaN'],
            [RATE_LIMIT_PRINCIPAL_MAX_ENV_VAR, '1e400'],
            [RATE_LIMIT_PRINCIPAL_WINDOW_ENV_VAR, '-30'],
            [RATE_LIMIT_TRUSTED_PROXY_DEPTH_ENV_VAR, '9'],
            [RATE_LIMIT_TRUSTED_PROXY_DEPTH_ENV_VAR, '-1'],
            [RATE_LIMIT_MAX_TRACKED_KEYS_ENV_VAR, '0'],
        ];

        it.each(unusable)('refuses %s="%s" rather than silently using the default', (variable, value) => {
            expect(() => resolveRateLimitPolicies({ ...PRODUCTION_ENV, [variable]: value })).toThrow(
                RateLimitConfigError,
            );
        });

        it('names the variable, the bound and the default in the message', () => {
            expect(() =>
                resolveRateLimitPolicies({ ...PRODUCTION_ENV, [RATE_LIMIT_SIGNUP_MAX_ENV_VAR]: 'ten' }),
            ).toThrow(/RATE_LIMIT_SIGNUP_MAX must be an integer between 1 and \d+/);
            expect(() =>
                resolveRateLimitPolicies({ ...PRODUCTION_ENV, [RATE_LIMIT_SIGNUP_MAX_ENV_VAR]: 'ten' }),
            ).toThrow(new RegExp(`default of ${DEFAULT_SIGNUP_MAX}`));
        });

        it('fails the same way under the test posture, so a typo cannot hide behind a disabled policy', () => {
            expect(() =>
                resolveRateLimitPolicies({ NODE_ENV: 'test', [RATE_LIMIT_SIGNUP_MAX_ENV_VAR]: 'ten' }),
            ).toThrow(RateLimitConfigError);
        });
    });
});

describe('deriveRateLimitKey', () => {
    describe('a verified principal', () => {
        it('keys on the token subject', () => {
            expect(deriveRateLimitKey({ principalId: 'firebase-uid-1' })).toEqual({
                kind: 'user',
                value: 'user:firebase-uid-1',
            });
        });

        it('outranks every header, at any proxy depth', () => {
            expect(
                deriveRateLimitKey(
                    {
                        principalId: 'firebase-uid-1',
                        forwardedFor: '203.0.113.9, 10.0.0.7',
                        socketAddress: '10.0.0.7',
                    },
                    2,
                ),
            ).toEqual({ kind: 'user', value: 'user:firebase-uid-1' });
        });

        it('trims the subject, so two spellings of one principal share a bucket', () => {
            expect(deriveRateLimitKey({ principalId: '  firebase-uid-1  ' }).value).toBe('user:firebase-uid-1');
        });

        it.each([
            ['absent', undefined],
            ['blank', '   '],
            ['empty', ''],
            ['a number', 42],
            ['an object', { uid: 'firebase-uid-1' }],
            ['null', null],
        ])('falls back to the global bucket when the subject is %s', (_label, principalId) => {
            expect(deriveRateLimitKey({ principalId })).toEqual({ kind: 'global', value: GLOBAL_BUCKET_KEY });
        });
    });

    describe('unauthenticated traffic with per-IP keying off (the default)', () => {
        it('puts every request in ONE bucket, whatever the headers claim', () => {
            const forged = deriveRateLimitKey({ forwardedFor: '198.51.100.1', socketAddress: '10.0.0.7' });
            const other = deriveRateLimitKey({ forwardedFor: '198.51.100.2', socketAddress: '10.0.0.8' });

            expect(forged).toEqual({ kind: 'global', value: GLOBAL_BUCKET_KEY });
            expect(other).toEqual(forged);
        });

        it('ignores the header even when the depth argument is omitted entirely', () => {
            expect(deriveRateLimitKey({ forwardedFor: '198.51.100.1, 10.0.0.7' }).kind).toBe('global');
        });
    });

    describe('unauthenticated traffic at an operator-declared proxy depth', () => {
        it('reads the client address back from the RIGHT, so a prepended value is never the key', () => {
            // The attacker sent `X-Forwarded-For: 1.2.3.4`; this deployment's
            // one proxy appended the address it really saw.
            expect(deriveRateLimitKey({ forwardedFor: '1.2.3.4, 203.0.113.9' }, 1)).toEqual({
                kind: 'ip',
                value: 'ip:203.0.113.9',
            });
        });

        it('counts two hops back when the deployment declares two proxies', () => {
            expect(deriveRateLimitKey({ forwardedFor: '1.2.3.4, 203.0.113.9, 10.0.0.7' }, 2)).toEqual({
                kind: 'ip',
                value: 'ip:203.0.113.9',
            });
        });

        it('joins a repeated header in order before counting', () => {
            expect(deriveRateLimitKey({ forwardedFor: ['1.2.3.4', '203.0.113.9, 10.0.0.7'] }, 2)).toEqual({
                kind: 'ip',
                value: 'ip:203.0.113.9',
            });
        });

        it('tolerates the whitespace and empty elements a proxy chain produces', () => {
            expect(deriveRateLimitKey({ forwardedFor: ' 1.2.3.4 ,, 203.0.113.9 ' }, 1)).toEqual({
                kind: 'ip',
                value: 'ip:203.0.113.9',
            });
        });

        it('keys IPv6 in either notation', () => {
            expect(deriveRateLimitKey({ forwardedFor: '2001:db8::1' }, 1).value).toBe('ip:2001:db8::1');
            expect(deriveRateLimitKey({ forwardedFor: '[2001:db8::1]:443' }, 1).value).toBe('ip:[2001:db8::1]:443');
        });

        it('falls back to the socket when the header carries fewer hops than declared', () => {
            expect(deriveRateLimitKey({ forwardedFor: '203.0.113.9', socketAddress: '10.0.0.7' }, 2)).toEqual({
                kind: 'ip',
                value: 'ip:10.0.0.7',
            });
        });

        it('falls back to the socket when the header is absent', () => {
            expect(deriveRateLimitKey({ socketAddress: '10.0.0.7' }, 1)).toEqual({
                kind: 'ip',
                value: 'ip:10.0.0.7',
            });
        });

        it('refuses a header value that is not an address, so a forged key cannot fill the store', () => {
            const oversized = 'a'.repeat(200);

            expect(deriveRateLimitKey({ forwardedFor: oversized, socketAddress: '10.0.0.7' }, 1).value).toBe(
                'ip:10.0.0.7',
            );
            expect(deriveRateLimitKey({ forwardedFor: 'evil host', socketAddress: '10.0.0.7' }, 1).value).toBe(
                'ip:10.0.0.7',
            );
        });

        it('refuses an unusable socket address too, and lands in the global bucket', () => {
            expect(deriveRateLimitKey({ forwardedFor: 'nonsense', socketAddress: 'also nonsense' }, 1)).toEqual({
                kind: 'global',
                value: GLOBAL_BUCKET_KEY,
            });
        });

        it('lands in the global bucket when neither header nor socket says anything', () => {
            expect(deriveRateLimitKey({}, 1)).toEqual({ kind: 'global', value: GLOBAL_BUCKET_KEY });
        });

        it('lands in the global bucket when an empty header carries no hop at all', () => {
            expect(deriveRateLimitKey({ forwardedFor: '  ,  ' }, 1)).toEqual({
                kind: 'global',
                value: GLOBAL_BUCKET_KEY,
            });
        });
    });
});

describe('currentWindow', () => {
    it('opens a window for a key that has none', () => {
        expect(currentWindow(policyOf(), undefined, NOW)).toEqual({ windowStartedAt: NOW, consumed: 0 });
    });

    it('keeps the stored window while it is still running', () => {
        const stored = { windowStartedAt: NOW, consumed: 2 };

        expect(currentWindow(policyOf(), stored, NOW + 59_999)).toBe(stored);
    });

    it('opens the next window exactly at the boundary, never a millisecond later', () => {
        const stored = { windowStartedAt: NOW, consumed: 3 };

        expect(currentWindow(policyOf(), stored, NOW + 60_000)).toEqual({
            windowStartedAt: NOW + 60_000,
            consumed: 0,
        });
    });

    it('opens a fresh window when the clock has stepped backwards', () => {
        const stored = { windowStartedAt: NOW, consumed: 3 };

        expect(currentWindow(policyOf(), stored, NOW - 5_000)).toEqual({
            windowStartedAt: NOW - 5_000,
            consumed: 0,
        });
    });
});

describe('chargeWindow', () => {
    it('spends tokens without moving the window start', () => {
        expect(chargeWindow({ windowStartedAt: NOW, consumed: 1 }, 29)).toEqual({
            windowStartedAt: NOW,
            consumed: 30,
        });
    });

    it('leaves the input untouched', () => {
        const window = { windowStartedAt: NOW, consumed: 1 };

        chargeWindow(window, 5);

        expect(window.consumed).toBe(1);
    });
});

describe('evaluateRateLimit', () => {
    describe('a bucket being spent down', () => {
        it('allows the first request and reports the remaining tokens', () => {
            expect(evaluateRateLimit(policyOf(), undefined, NOW)).toEqual({
                allowed: true,
                window: { windowStartedAt: NOW, consumed: 1 },
                limit: 3,
                remaining: 2,
                resetAtMs: NOW + 60_000,
                retryAfterSeconds: 60,
            });
        });

        it('allows exactly the limit and refuses the request after it', () => {
            const policy = policyOf({ limit: 2 });
            const first = evaluateRateLimit(policy, undefined, NOW);
            const second = evaluateRateLimit(policy, first.window, NOW);
            const third = evaluateRateLimit(policy, second.window, NOW);

            expect([first.allowed, second.allowed, third.allowed]).toEqual([true, true, false]);
            expect(second.remaining).toBe(0);
        });

        it('never reports a negative remaining count', () => {
            const policy = policyOf({ limit: 1 });
            const refused = evaluateRateLimit(policy, { windowStartedAt: NOW, consumed: 9 }, NOW);

            expect(refused.allowed).toBe(false);
            expect(refused.remaining).toBe(0);
        });
    });

    describe('what a refusal costs', () => {
        it('still spends the tokens, so a refused caller gets no free retry', () => {
            const refused = evaluateRateLimit(policyOf({ limit: 1 }), { windowStartedAt: NOW, consumed: 1 }, NOW);

            expect(refused.window.consumed).toBe(2);
        });

        it('never moves the window start, so the refusal ends when the window does', () => {
            const policy = policyOf({ limit: 1 });
            const refused = evaluateRateLimit(policy, { windowStartedAt: NOW, consumed: 1 }, NOW + 30_000);

            expect(refused.window.windowStartedAt).toBe(NOW);
            expect(refused.resetAtMs).toBe(NOW + 60_000);
            expect(refused.retryAfterSeconds).toBe(30);
        });

        it('lets the bucket serve again once the window has rolled', () => {
            const policy = policyOf({ limit: 1 });
            const refused = evaluateRateLimit(policy, { windowStartedAt: NOW, consumed: 1 }, NOW);
            const afterTheWindow = evaluateRateLimit(policy, refused.window, NOW + 60_000);

            expect(afterTheWindow.allowed).toBe(true);
            expect(afterTheWindow.window).toEqual({ windowStartedAt: NOW + 60_000, consumed: 1 });
        });
    });

    describe('an expensive outcome', () => {
        it('charges the cost it is given', () => {
            const charged = evaluateRateLimit(policyOf({ limit: 100 }), undefined, NOW, 30);

            expect(charged.window.consumed).toBe(30);
            expect(charged.remaining).toBe(70);
        });

        it('refuses when the cost alone exceeds what is left', () => {
            const policy = policyOf({ limit: 30 });
            const decision = evaluateRateLimit(policy, { windowStartedAt: NOW, consumed: 29 }, NOW, 30);

            expect(decision.allowed).toBe(false);
        });

        it('turns 40 failed authentications into a refusal on the 41st, at the shipped defaults', () => {
            const { global } = resolveRateLimitPolicies(PRODUCTION_ENV);
            const costOfAFailure = 1 + global.failureSurcharge;
            let window = openWindow(NOW);
            let refusals = 0;
            let served = 0;

            for (let request = 0; request < 41; request += 1) {
                const decision = evaluateRateLimit(global, window, NOW, 1);

                if (decision.allowed) {
                    served += 1;
                    // The surcharge is charged after the response, exactly as
                    // the middleware charges it on `finish`.
                    window = chargeWindow(decision.window, costOfAFailure - 1);
                } else {
                    refusals += 1;
                    window = decision.window;
                }
            }

            expect(served).toBe(40);
            expect(refusals).toBe(1);
        });
    });

    describe('retry-after arithmetic', () => {
        it('rounds a partial second up, so a client never retries too early', () => {
            const decision = evaluateRateLimit(policyOf(), { windowStartedAt: NOW, consumed: 0 }, NOW + 59_500);

            expect(decision.retryAfterSeconds).toBe(1);
        });

        it('never reports zero seconds', () => {
            const decision = evaluateRateLimit(
                policyOf({ windowMs: 1_000 }),
                { windowStartedAt: NOW, consumed: 0 },
                NOW + 999,
            );

            expect(decision.retryAfterSeconds).toBe(1);
        });
    });

    describe('a disabled policy', () => {
        const disabled = policyOf({ enabled: false, limit: 1 });

        it('allows a request the limit would have refused', () => {
            expect(evaluateRateLimit(disabled, { windowStartedAt: NOW, consumed: 99 }, NOW).allowed).toBe(true);
        });

        it('charges nothing, so a disabled deployment accumulates no state', () => {
            const decision = evaluateRateLimit(disabled, undefined, NOW);

            expect(decision.window.consumed).toBe(0);
            expect(decision.remaining).toBe(disabled.limit);
        });
    });
});

describe('isWindowExpired', () => {
    it('is false inside the window', () => {
        expect(isWindowExpired(policyOf(), { windowStartedAt: NOW, consumed: 1 }, NOW + 59_999)).toBe(false);
    });

    it('is true at the boundary, agreeing with currentWindow', () => {
        const policy = policyOf();
        const window = { windowStartedAt: NOW, consumed: 1 };

        expect(isWindowExpired(policy, window, NOW + 60_000)).toBe(true);
        expect(currentWindow(policy, window, NOW + 60_000)).not.toBe(window);
    });
});

describe('windowSeconds', () => {
    it('reports the window in whole seconds for a body and a log line', () => {
        expect(windowSeconds(policyOf({ windowMs: 30_000 }))).toBe(30);
        expect(windowSeconds(policyOf({ windowMs: 1_500 }))).toBe(2);
    });
});
