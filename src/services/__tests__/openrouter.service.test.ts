/**
 * `openrouter.service.ts` is the OpenRouter vendor boundary extracted from
 * `estimate.service.ts` (Agent Action Plan §0.4.3). Two shipped endpoints reach
 * a model through it — `POST /api/macros/estimate` and
 * `POST /api/macros/label-scan` — and both used to reach it through private
 * helpers that threw `EstimateFailedError` directly. The extraction gives the
 * transport its own error class and makes `estimate.service.ts` translate back,
 * so the failure text a client sees now survives a translation step that did
 * not exist before. Nothing else in the repository pins that text.
 *
 * What this suite pins, and why each one is a decision someone could break:
 *
 *  - **The six failure messages, byte for byte.** They are asserted with `toBe`
 *    against literals, never with `toContain`: a substring assertion passes a
 *    reworded prefix, which is exactly the regression the extraction risks.
 *    Both endpoints are then driven end to end so the same six strings are
 *    proven to arrive as `EstimateFailedError.message` unchanged.
 *  - **The error-class rethrow guard, positionally.** `http`, `empty` and
 *    `unparseable` are raised INSIDE `callOpenRouter`'s own `try`, so without
 *    the `instanceof` guard at the top of its `catch` they would be re-wrapped
 *    as `network` and nest one message inside another. Each of the three is
 *    asserted negatively as well as positively.
 *  - **The outbound request.** For a vendor boundary the request IS the
 *    observable contract, so the URL, method, headers, body, `temperature: 0`
 *    and the untouched JSON schema are all asserted. A typo in the default
 *    model silently changes which model two live endpoints call.
 *  - **Every failure leaves as an `OpenRouterError`.** A raw `Response`, a bare
 *    `TypeError` from serialisation, a `SyntaxError` from an unreadable body or
 *    an `AbortError` escaping this module would all force callers to
 *    pattern-match a vendor error shape (Rule 7 §9).
 *  - **The accessor fails loudly and for free.** A missing key costs neither a
 *    request nor a timer, because `getOpenRouterConfig()` runs before either
 *    exists.
 *  - **This boundary does not meter.** Request-time quota belongs to
 *    `entitlement.service.ts`, which consumes it BEFORE the call so a failed
 *    call is not a free retry; the offline catalog scripts meter at operator
 *    scope. A boundary that also metered would double-count.
 *  - **Totality of `parseModelJson`.** Model output is untrusted text, so every
 *    shape — fenced, prose-wrapped, brace-less, blank, an array, a fence inside
 *    a string value — returns a value or an `OpenRouterError`, and never a
 *    `SyntaxError`.
 *
 * No `jest.mock` is used. `callOpenRouter` takes a `fetchImpl` parameter, so
 * direct tests inject through that declared seam; `estimate.service.ts` calls
 * it with four arguments and exposes no seam, so those tests stub
 * `globalThis.fetch`. Both are restored after every test, as is `process.env`.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import type { MessageContent, OpenRouterConfig, OpenRouterError, OpenRouterErrorKind } from '../openrouter.service';

/**
 * The module is required per test rather than imported once, because it reads
 * `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` ONCE at module load (Rule 7 §9,
 * "read config once at the top of the module"). `jestSetup.ts` deletes both
 * keys before any test file loads, so a test that needs either one sets it and
 * then takes a fresh instance; assigning to `process.env` alone would have no
 * effect on an already-loaded instance.
 *
 * Each instance carries its own `OpenRouterError` class, so `instanceof` is
 * always checked against the class of the same handle the call came from.
 */
type OpenRouterModule = typeof import('../openrouter.service');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const REQUEST_TIMEOUT_MS = 30_000;

/** Obviously fake: nothing here may resemble a real provider credential. */
const API_KEY = 'test-openrouter-key';

const SYSTEM_PROMPT = 'You are a nutritionist estimating one eating occasion.';
const USER_TEXT = 'two scrambled eggs and a slice of toast';
const JSON_SCHEMA = {
    name: 'meal_estimate',
    strict: true,
    schema: {
        type: 'object',
        properties: { items: { type: 'array' }, confidence: { type: 'string' } },
        required: ['items', 'confidence'],
        additionalProperties: false,
    },
};

/**
 * THE SIX CLIENT-VISIBLE FAILURE STRINGS.
 *
 * Every one of these is returned verbatim to a mobile client by
 * `POST /api/macros/estimate` and `POST /api/macros/label-scan`: the controller
 * maps `EstimateFailedError` to a 502 whose body carries this message, and
 * `estimate.service.ts` builds that error from an `OpenRouterError`'s message
 * without rewriting it. Editing any string below — including its punctuation,
 * its `: ` separator and its lack of a trailing period — changes what those two
 * shipped endpoints tell a user, so it is a documented behaviour change and not
 * a wording tidy-up. Two of the six are templates and are asserted as
 * fully-formed literals at each use.
 */
const NOT_CONFIGURED_MESSAGE = 'OPENROUTER_API_KEY is not configured';
const EMPTY_COMPLETION_MESSAGE = 'OpenRouter returned an empty completion';
const TIMED_OUT_MESSAGE = 'OpenRouter request timed out';
const UNPARSEABLE_MESSAGE = 'Model returned unparseable output';
/** `http`: `OpenRouter returned ${status}: ${body.slice(0, 300)}`. */
const HTTP_MESSAGE_PREFIX = 'OpenRouter returned ';
/** `network`: `OpenRouter request failed: ${(error as Error).message}`. */
const VENDOR_FAILURE_PREFIX = 'OpenRouter request failed:';

/** The number of leading body characters the `http` message carries. */
const HTTP_BODY_LIMIT = 300;

type FetchStub = jest.MockedFunction<typeof fetch>;

const REAL_FETCH = globalThis.fetch;

/**
 * Taken at file evaluation, which is after `jestSetup.ts` has deleted
 * `OPENROUTER_API_KEY` and `USDA_API_KEY` — so the snapshot correctly records
 * both as absent and `afterEach` restores that state rather than a developer's.
 */
const ENV_SNAPSHOT: NodeJS.ProcessEnv = { ...process.env };

const setEnvValue = (key: string, value: string | undefined): void => {
    if (value === undefined) {
        delete process.env[key];
        return;
    }

    process.env[key] = value;
};

const restoreEnvironment = (): void => {
    for (const key of Object.keys(process.env)) {
        if (!(key in ENV_SNAPSHOT)) {
            delete process.env[key];
        }
    }

    Object.assign(process.env, ENV_SNAPSHOT);
};

interface VendorEnvironment {
    apiKey?: string;
    model?: string;
}

/** A fresh module instance whose import-time config is exactly `environment`. */
const loadOpenRouter = (environment: VendorEnvironment = {}): OpenRouterModule => {
    setEnvValue('OPENROUTER_API_KEY', environment.apiKey);
    setEnvValue('OPENROUTER_MODEL', environment.model);

    let loaded!: OpenRouterModule;
    jest.isolateModules(() => {
        loaded = require('../openrouter.service') as OpenRouterModule;
    });

    return loaded;
};

/** The common case: a key is present and no model is pinned by the env. */
const loadConfigured = (): OpenRouterModule => loadOpenRouter({ apiKey: API_KEY });

const jsonResponse = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

/** The minimal OpenRouter envelope: `{choices: [{message: {content}}]}`. */
const completion = (content: unknown): Response => jsonResponse({ choices: [{ message: { content } }] });

const failureResponse = (status: number, body: string): Response => new Response(body, { status });

const respondWith = (...responses: Response[]): FetchStub => {
    const queue = [...responses];

    return jest.fn(async (): Promise<Response> => {
        const next = queue.shift();
        if (next === undefined) {
            throw new Error('The stub received more requests than it was given responses for.');
        }

        return next;
    }) as unknown as FetchStub;
};

const rejectWith = (error: unknown): FetchStub =>
    jest.fn(async (): Promise<Response> => {
        throw error;
    }) as unknown as FetchStub;

/** Rejects only when the request's own signal aborts, as `fetch` itself does. */
const abortAwareFetch = (): FetchStub =>
    jest.fn(
        (_input: unknown, init?: RequestInit): Promise<Response> =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(abortError());
                });
            }),
    ) as unknown as FetchStub;

const abortError = (): Error => {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';

    return error;
};

const describeValue = (value: unknown): string =>
    value instanceof Error ? `${value.name}: ${value.message}` : `${typeof value} (${String(value)})`;

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/**
 * A service file's source with its comments removed.
 *
 * Two properties this suite has to pin are absences — that the vendor boundary
 * does not meter, and that the estimate service translates at exactly one place
 * — and an absence is not observable from behaviour. Comments are stripped
 * because both files discuss the very identifiers being searched for: the
 * boundary's header names `entitlement.service` in order to say that metering
 * happens there, and prose saying so must not be read as code doing so. The
 * `[^:]` guard keeps `https://` out of the line-comment pattern.
 */
const codeOf = (fileName: string): string =>
    readFileSync(join(__dirname, '..', fileName), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

const rejectionOf = async (call: Promise<unknown>): Promise<unknown> => {
    try {
        await call;
    } catch (error) {
        return error;
    }

    throw new Error('Expected the call to reject, but it resolved.');
};

const throwOf = (run: () => unknown): unknown => {
    try {
        run();
    } catch (error) {
        return error;
    }

    throw new Error('Expected the call to throw, but it returned.');
};

/**
 * Narrows a caught `unknown` (strict mode's `useUnknownInCatchVariables`) and,
 * in doing so, asserts the boundary's central promise: whatever went wrong, the
 * value that left the module is an `OpenRouterError`. The failure message names
 * what actually arrived, so a leaked `TypeError` reads as such.
 */
const asVendorError = (error: unknown, openRouter: OpenRouterModule): OpenRouterError => {
    if (!(error instanceof openRouter.OpenRouterError)) {
        throw new Error(`Expected an OpenRouterError, received ${describeValue(error)}.`);
    }

    return error;
};

const vendorFailure = async (openRouter: OpenRouterModule, call: Promise<unknown>): Promise<OpenRouterError> =>
    asVendorError(await rejectionOf(call), openRouter);

const vendorFailureSync = (openRouter: OpenRouterModule, run: () => unknown): OpenRouterError =>
    asVendorError(throwOf(run), openRouter);

interface OutboundBody {
    model: string;
    temperature: number;
    messages: Array<{ role: string; content: MessageContent }>;
    response_format: { type: string; json_schema: unknown };
}

interface SentRequest {
    url: string;
    method: string | undefined;
    headers: unknown;
    body: OutboundBody;
    signal: AbortSignal | null | undefined;
}

const sentRequest = (stub: FetchStub, index = 0): SentRequest => {
    const call = stub.mock.calls[index];
    if (call === undefined) {
        throw new Error(
            `Expected the stub to have received request ${index + 1}, but it received ${stub.mock.calls.length}.`,
        );
    }

    const [input, init] = call;
    if (typeof init?.body !== 'string') {
        throw new Error(`Expected a serialised request body, received ${describeValue(init?.body)}.`);
    }

    return {
        url: String(input),
        method: init.method,
        headers: init.headers,
        body: JSON.parse(init.body) as OutboundBody,
        signal: init.signal,
    };
};

beforeEach(() => {
    // Installed so that a test which forgets to stub cannot reach the network:
    // the seam tests pass their own stub, and the tests that assert "no request
    // was issued" assert against this one.
    globalThis.fetch = jest.fn(async (): Promise<Response> => {
        throw new Error('Unexpected request to globalThis.fetch: this test installed no global stub.');
    }) as unknown as FetchStub;
});

afterEach(() => {
    globalThis.fetch = REAL_FETCH;
    restoreEnvironment();
    jest.useRealTimers();
    jest.resetAllMocks();
});

describe('callOpenRouter', () => {
    describe('the outbound request', () => {
        it('posts to the OpenRouter chat-completions URL', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(stub).toHaveBeenCalledTimes(1);
            expect(sentRequest(stub).url).toBe('https://openrouter.ai/api/v1/chat/completions');
            expect(sentRequest(stub).method).toBe('POST');
        });

        it('authenticates with a bearer header and declares a JSON body', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(sentRequest(stub).headers).toStrictEqual({
                Authorization: 'Bearer test-openrouter-key',
                'Content-Type': 'application/json',
            });
        });

        it('sends exactly the documented body, with the prompts as system and user messages', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(sentRequest(stub).body).toStrictEqual({
                model: DEFAULT_MODEL,
                temperature: 0,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: USER_TEXT },
                ],
                response_format: { type: 'json_schema', json_schema: JSON_SCHEMA },
            });
        });

        it('pins temperature at zero', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(sentRequest(stub).body.temperature).toBe(0);
        });

        it('passes the callers JSON schema through unaltered', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(completion('{"items":[]}'));
            const schema = {
                name: 'label_scan',
                strict: true,
                schema: {
                    type: 'object',
                    properties: { name: { type: ['string', 'null'] }, calories: { type: 'integer' } },
                    required: ['name', 'calories'],
                    additionalProperties: false,
                },
            };

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, schema, undefined, stub);

            expect(sentRequest(stub).body.response_format).toStrictEqual({
                type: 'json_schema',
                json_schema: schema,
            });
        });

        it('carries the multimodal content parts of the label-scan path unchanged', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(completion('{"calories":210}'));
            const userContent: MessageContent = [
                { type: 'text', text: 'read this label' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
            ];

            await openRouter.callOpenRouter(SYSTEM_PROMPT, userContent, JSON_SCHEMA, undefined, stub);

            expect(sentRequest(stub).body.messages[1]).toStrictEqual({ role: 'user', content: userContent });
        });

        it('attaches an abort signal that is not yet aborted', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            const { signal } = sentRequest(stub);
            expect(signal).toBeInstanceOf(AbortSignal);
            expect(signal?.aborted).toBe(false);
        });

        it('issues one request per call, so the boundary adds no round trip of its own', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(stub).toHaveBeenCalledTimes(1);
        });

        it('uses globalThis.fetch when no implementation is injected', async () => {
            const openRouter = loadConfigured();
            globalThis.fetch = respondWith(completion('{"items":[1]}'));

            const result = await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA);

            expect(result).toStrictEqual({ items: [1] });
            const globalStub = jest.mocked(globalThis.fetch);
            expect(globalStub).toHaveBeenCalledTimes(1);
            expect(String(globalStub.mock.calls[0][0])).toBe(OPENROUTER_URL);
        });
    });

    describe('the model', () => {
        it('prefers an explicit override over everything else', async () => {
            const openRouter = loadOpenRouter({ apiKey: API_KEY, model: 'vendor/env-model' });
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, 'openai/gpt-4o-mini', stub);

            expect(sentRequest(stub).body.model).toBe('openai/gpt-4o-mini');
        });

        it('falls back to OPENROUTER_MODEL when no override is given', async () => {
            const openRouter = loadOpenRouter({ apiKey: API_KEY, model: 'vendor/env-model' });
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(sentRequest(stub).body.model).toBe('vendor/env-model');
        });

        it('falls back to google/gemini-2.5-flash when neither is set', async () => {
            const openRouter = loadOpenRouter({ apiKey: API_KEY });
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(sentRequest(stub).body.model).toBe('google/gemini-2.5-flash');
        });

        it('treats a blank OPENROUTER_MODEL as unset', async () => {
            const openRouter = loadOpenRouter({ apiKey: API_KEY, model: '' });
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(sentRequest(stub).body.model).toBe(DEFAULT_MODEL);
        });

        it('treats a blank override as unset', async () => {
            const openRouter = loadOpenRouter({ apiKey: API_KEY, model: 'vendor/env-model' });
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, '', stub);

            expect(sentRequest(stub).body.model).toBe('vendor/env-model');
        });
    });

    describe('a successful completion', () => {
        it('returns the object parsed from choices[0].message.content', async () => {
            const openRouter = loadConfigured();
            const content = JSON.stringify({ items: [{ name: 'Eggs', calories: 180 }], confidence: 'high' });
            const stub = respondWith(completion(content));

            const result = await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(result).toStrictEqual({ items: [{ name: 'Eggs', calories: 180 }], confidence: 'high' });
        });

        it('reads only the first choice', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(
                jsonResponse({
                    choices: [{ message: { content: '{"picked":"first"}' } }, { message: { content: '{"picked":"second"}' } }],
                }),
            );

            const result = await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(result).toStrictEqual({ picked: 'first' });
        });

        it('recovers a fenced object, so a model that ignores json_schema still succeeds', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(completion('```json\n{"items":[],"confidence":"low"}\n```'));

            const result = await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(result).toStrictEqual({ items: [], confidence: 'low' });
        });
    });

    describe('timer discipline', () => {
        it('clears the timeout once the call resolves, leaving nothing pending', async () => {
            jest.useFakeTimers();
            const openRouter = loadConfigured();
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(jest.getTimerCount()).toBe(0);
            jest.runOnlyPendingTimers();
            expect(sentRequest(stub).signal?.aborted).toBe(false);
        });

        it('clears the timeout when the call fails, leaving nothing pending', async () => {
            jest.useFakeTimers();
            const openRouter = loadConfigured();
            const stub = respondWith(failureResponse(500, 'upstream exploded'));

            await rejectionOf(openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(jest.getTimerCount()).toBe(0);
        });

        it('keeps exactly one timer armed while the request is in flight', async () => {
            jest.useFakeTimers();
            const openRouter = loadConfigured();
            const stub = abortAwareFetch();

            const call = openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);
            expect(jest.getTimerCount()).toBe(1);

            jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
            const error = await vendorFailure(openRouter, call);

            expect(error.kind).toBe('timeout');
            expect(jest.getTimerCount()).toBe(0);
        });

        it('aborts the in-flight request through the signal it attached', async () => {
            jest.useFakeTimers();
            const openRouter = loadConfigured();
            const stub = abortAwareFetch();

            const call = openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);
            expect(sentRequest(stub).signal?.aborted).toBe(false);

            jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
            await rejectionOf(call);

            expect(sentRequest(stub).signal?.aborted).toBe(true);
        });

        it('does not abort one millisecond before the timeout', async () => {
            jest.useFakeTimers();
            const openRouter = loadConfigured();
            const stub = abortAwareFetch();

            const call = openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);
            jest.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1);

            expect(sentRequest(stub).signal?.aborted).toBe(false);
            expect(jest.getTimerCount()).toBe(1);

            jest.advanceTimersByTime(1);
            await rejectionOf(call);
            expect(sentRequest(stub).signal?.aborted).toBe(true);
        });
    });
});

describe('OpenRouterError', () => {
    const ALL_KINDS: OpenRouterErrorKind[] = ['not_configured', 'http', 'empty', 'timeout', 'network', 'unparseable'];

    describe('the class itself', () => {
        it('is an Error subclass carrying a stable name, so catch-narrowing works', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(failureResponse(500, 'boom'));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error).toBeInstanceOf(Error);
            expect(error).toBeInstanceOf(openRouter.OpenRouterError);
            expect(error.name).toBe('OpenRouterError');
            expect(ALL_KINDS).toContain(error.kind);
        });
    });

    describe('not_configured', () => {
        it('reports a missing key with the shipped message', async () => {
            const openRouter = loadOpenRouter();
            const stub = respondWith(completion('{"items":[]}'));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('not_configured');
            expect(error.message).toBe('OPENROUTER_API_KEY is not configured');
            expect(error.message).toBe(NOT_CONFIGURED_MESSAGE);
            expect(error.status).toBeUndefined();
        });

        it('reports an empty-string key the same way', async () => {
            const openRouter = loadOpenRouter({ apiKey: '' });

            const error = vendorFailureSync(openRouter, () => openRouter.getOpenRouterConfig());

            expect(error.kind).toBe('not_configured');
            expect(error.message).toBe(NOT_CONFIGURED_MESSAGE);
        });
    });

    describe('http', () => {
        it('reports the status and the response body', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(failureResponse(429, 'rate limit exceeded'));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('http');
            expect(error.message).toBe('OpenRouter returned 429: rate limit exceeded');
        });

        it('reports an empty body as an empty segment after the separator', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(failureResponse(503, ''));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.message).toBe('OpenRouter returned 503: ');
        });

        it('truncates the body at 300 characters and carries nothing beyond them', async () => {
            const openRouter = loadConfigured();
            const head = 'a'.repeat(HTTP_BODY_LIMIT);
            const stub = respondWith(failureResponse(503, `${head}${'b'.repeat(200)}`));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.message).toBe(`${HTTP_MESSAGE_PREFIX}503: ${head}`);
            expect(error.message).not.toContain('b');
            expect(error.message).toHaveLength(`${HTTP_MESSAGE_PREFIX}503: `.length + HTTP_BODY_LIMIT);
        });

        it('keeps a body of exactly 300 characters whole', async () => {
            const openRouter = loadConfigured();
            const body = 'c'.repeat(HTTP_BODY_LIMIT);
            const stub = respondWith(failureResponse(500, body));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.message).toBe(`${HTTP_MESSAGE_PREFIX}500: ${body}`);
        });

        it('survives a response body that cannot be read, reporting no body rather than the read failure', async () => {
            const openRouter = loadConfigured();
            const unreadable = {
                ok: false,
                status: 500,
                text: (): Promise<string> => Promise.reject(new Error('stream closed')),
            } as unknown as Response;
            const stub = respondWith(unreadable);

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('http');
            expect(error.message).toBe('OpenRouter returned 500: ');
            expect(error.message).not.toContain('stream closed');
            expect(error.status).toBe(500);
        });

        it.each([429, 500, 502, 503, 400, 401])('carries status %i as error data', async (status) => {
            const openRouter = loadConfigured();
            const stub = respondWith(failureResponse(status, 'vendor said no'));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('http');
            expect(error.status).toBe(status);
            expect(error.message).toBe(`OpenRouter returned ${status}: vendor said no`);
        });
    });

    describe('empty', () => {
        // The vendor said nothing usable, which is a different failure from
        // having said something unreadable: every structural deviation from
        // `{choices: [{message: {content: <non-blank string>}}]}` is reported as
        // `empty`, and none of them may surface as a TypeError from reading
        // through a missing level of the envelope.
        const emptyEnvelopes: Array<[string, () => Response]> = [
            ['choices absent', () => jsonResponse({})],
            ['an empty choices array', () => jsonResponse({ choices: [] })],
            ['a choice without a message', () => jsonResponse({ choices: [{}] })],
            ['null content', () => completion(null)],
            ['empty-string content', () => completion('')],
            ['whitespace-only content', () => completion('   ')],
            ['tab-and-newline content', () => completion('\n\t ')],
            ['a payload that is not an object', () => jsonResponse('just a string')],
            ['a null payload', () => jsonResponse(null)],
            ['an array payload', () => jsonResponse([{ message: { content: '{"a":1}' } }])],
            ['choices as an object rather than an array', () => jsonResponse({ choices: { 0: { message: { content: '{"a":1}' } } } })],
            ['a null first choice', () => jsonResponse({ choices: [null] })],
            ['a string first choice', () => jsonResponse({ choices: ['text'] })],
            ['a null message', () => jsonResponse({ choices: [{ message: null }] })],
            ['a string message', () => jsonResponse({ choices: [{ message: 'text' }] })],
            ['numeric content', () => completion(42)],
            ['object content', () => completion({ items: [] })],
            ['array content', () => completion([1, 2])],
            ['boolean content', () => completion(false)],
        ];

        it.each(emptyEnvelopes)('reports %s as an empty completion', async (_label, buildResponse) => {
            const openRouter = loadConfigured();
            const stub = respondWith(buildResponse());

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('empty');
            expect(error.message).toBe('OpenRouter returned an empty completion');
            expect(error.message).toBe(EMPTY_COMPLETION_MESSAGE);
            expect(error.status).toBeUndefined();
        });
    });

    describe('timeout', () => {
        it('reports an AbortError by name, whatever its own message said', async () => {
            const openRouter = loadConfigured();
            const stub = rejectWith(abortError());

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('timeout');
            expect(error.message).toBe('OpenRouter request timed out');
            expect(error.message).toBe(TIMED_OUT_MESSAGE);
            expect(error.message).not.toContain('This operation was aborted');
            expect(error.status).toBeUndefined();
        });

        it('recognises the DOMException undici actually raises on abort', async () => {
            const openRouter = loadConfigured();
            const stub = rejectWith(new DOMException('This operation was aborted', 'AbortError'));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('timeout');
            expect(error.message).toBe(TIMED_OUT_MESSAGE);
        });
    });

    describe('network', () => {
        it('interpolates the thrown error message verbatim', async () => {
            const openRouter = loadConfigured();
            const stub = rejectWith(new TypeError('fetch failed'));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('network');
            expect(error.message).toBe('OpenRouter request failed: fetch failed');
            expect(error.status).toBeUndefined();
        });

        it('does not let the vendor error type escape', async () => {
            const openRouter = loadConfigured();
            const stub = rejectWith(new TypeError('fetch failed'));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error).not.toBeInstanceOf(TypeError);
            expect(error.name).toBe('OpenRouterError');
        });

        it('reports a socket failure with the socket message', async () => {
            const openRouter = loadConfigured();
            const stub = rejectWith(new Error('socket hang up'));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('network');
            expect(error.message).toBe('OpenRouter request failed: socket hang up');
        });

        it('reports a rejection that is not an Error without crashing on it', async () => {
            const openRouter = loadConfigured();
            const stub = rejectWith('not even an error');

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('network');
            expect(error.message).toBe('OpenRouter request failed: undefined');
        });

        it('reports an unreadable success body as a transport failure, not as empty output', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(new Response('not json at all', { status: 200 }));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('network');
            expect(error.message.startsWith(VENDOR_FAILURE_PREFIX)).toBe(true);
            expect(error.message).not.toBe(EMPTY_COMPLETION_MESSAGE);
        });

        it('wraps a schema that cannot be serialised, and never reaches the vendor', async () => {
            const openRouter = loadConfigured();
            const circular: Record<string, unknown> = { name: 'meal_estimate' };
            circular.self = circular;
            const stub = respondWith(completion('{"items":[]}'));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, circular, undefined, stub));

            expect(error.kind).toBe('network');
            expect(error.message.startsWith(VENDOR_FAILURE_PREFIX)).toBe(true);
            expect(stub).not.toHaveBeenCalled();
        });
    });

    describe('unparseable', () => {
        it('reports content with no recoverable object', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(completion('I cannot help with that request.'));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('unparseable');
            expect(error.message).toBe('Model returned unparseable output');
            expect(error.message).toBe(UNPARSEABLE_MESSAGE);
            expect(error.status).toBeUndefined();
        });

        // `unparseable` carries two different shipped messages, and the
        // difference is a contract rather than an oversight. Content with no
        // usable `{...}` block never reached a second `JSON.parse` and has
        // always reported 'Model returned unparseable output'; content that did
        // contain a block let the second parse's SyntaxError escape to the
        // transport catch, which reported it as 'OpenRouter request failed:
        // <syntax message>'. Both reach the client through EstimateFailedError,
        // so neither may be unified with the other.
        it('reports a recoverable block that is still malformed with the vendor-failure wording', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(completion('{"items": }'));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('unparseable');
            expect(error.message.startsWith(VENDOR_FAILURE_PREFIX)).toBe(true);
            expect(error.message).not.toBe(UNPARSEABLE_MESSAGE);
        });
    });
});


/**
 * THE ORDERING INSIDE `callOpenRouter`'s CATCH BLOCK.
 *
 * `http`, `empty` and `unparseable` are all thrown from INSIDE the same `try`
 * that the transport catch guards, so the first line of that catch —
 * `if (error instanceof OpenRouterError) throw error;`, which was
 * `if (error instanceof EstimateFailedError) throw error;` before the
 * extraction — is the only thing stopping them from being caught and re-wrapped
 * as `network`. Without it an unreadable model response reaches the client as
 * 'OpenRouter request failed: Model returned unparseable output': the wrong
 * kind, and one message nested inside another. Nothing else would catch that
 * regression, because the nested string still CONTAINS the original one — which
 * is why each case below asserts the absence of the wrapper as explicitly as it
 * asserts the message, and why the last two cases prove the guard still lets a
 * genuine transport failure through as `network`.
 */
describe('callOpenRouter error ordering', () => {
    it('leaves an unrecoverable model response as unparseable, never re-wrapped as network', async () => {
        const openRouter = loadConfigured();
        const stub = respondWith(completion('I am sorry, I cannot produce that.'));

        const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

        expect(error.kind).toBe('unparseable');
        expect(error.message).toBe(UNPARSEABLE_MESSAGE);
        expect(error.kind).not.toBe('network');
        expect(error.message).not.toContain(VENDOR_FAILURE_PREFIX);
        expect(occurrences(error.message, VENDOR_FAILURE_PREFIX)).toBe(0);
    });

    it('leaves a non-ok response as http, never re-wrapped as network', async () => {
        const openRouter = loadConfigured();
        const stub = respondWith(failureResponse(502, 'bad gateway'));

        const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

        expect(error.kind).toBe('http');
        expect(error.message).toBe('OpenRouter returned 502: bad gateway');
        expect(error.kind).not.toBe('network');
        expect(error.message).not.toContain(VENDOR_FAILURE_PREFIX);
        expect(error.status).toBe(502);
    });

    it('leaves an empty completion as empty, never re-wrapped as network', async () => {
        const openRouter = loadConfigured();
        const stub = respondWith(completion(''));

        const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

        expect(error.kind).toBe('empty');
        expect(error.message).toBe(EMPTY_COMPLETION_MESSAGE);
        expect(error.kind).not.toBe('network');
        expect(error.message).not.toContain(VENDOR_FAILURE_PREFIX);
    });

    it('still reports a genuine transport failure as network, so the guard does not swallow its own case', async () => {
        const openRouter = loadConfigured();
        const stub = rejectWith(new TypeError('fetch failed'));

        const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

        expect(error.kind).toBe('network');
        expect(occurrences(error.message, VENDOR_FAILURE_PREFIX)).toBe(1);
        expect(error.message).toBe('OpenRouter request failed: fetch failed');
    });

    it('still reports a timeout as timeout, so the guard does not shadow the abort branch', async () => {
        const openRouter = loadConfigured();
        const stub = rejectWith(abortError());

        const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

        expect(error.kind).toBe('timeout');
        expect(error.message).toBe(TIMED_OUT_MESSAGE);
        expect(error.message).not.toContain(VENDOR_FAILURE_PREFIX);
    });

    it('rethrows an OpenRouterError raised before the request unchanged, rather than wrapping it', async () => {
        const openRouter = loadConfigured();
        const raised = new openRouter.OpenRouterError('empty', 'raised while serialising the schema');
        const schema = {
            toJSON: (): never => {
                throw raised;
            },
        };
        const stub = respondWith(completion('{"items":[]}'));

        const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, schema, undefined, stub));

        expect(error).toBe(raised);
        expect(error.kind).toBe('empty');
        expect(error.message).toBe('raised while serialising the schema');
        expect(error.message).not.toContain(VENDOR_FAILURE_PREFIX);
        expect(stub).not.toHaveBeenCalled();
    });

    // Wrapping exactly once is a property of the error classes, not of counting
    // substrings: a vendor message that happens to quote the prefix is still
    // interpolated verbatim, so the count below is 2 by design.
    it('interpolates a vendor message verbatim even when it already contains the wrapper prefix', async () => {
        const openRouter = loadConfigured();
        const stub = rejectWith(new Error('OpenRouter request failed: already wrapped once'));

        const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

        expect(error.kind).toBe('network');
        expect(occurrences(error.message, VENDOR_FAILURE_PREFIX)).toBe(2);
        expect(error.message).toBe('OpenRouter request failed: OpenRouter request failed: already wrapped once');
    });
});


describe('parseModelJson', () => {
    // Model output is untrusted text, so the recovery order is the contract:
    // JSON.parse first, and only on failure strip ``` fences and take the span
    // from the FIRST '{' to the LAST '}'. That order is why a fence appearing
    // inside a string value survives — the first parse already succeeded — and
    // the span is why a stray '}' before the object does not defeat recovery.
    describe('content it recovers', () => {
        const recovered: Array<[string, string, unknown]> = [
            ['a clean object', '{"items":[],"confidence":"low"}', { items: [], confidence: 'low' }],
            ['an empty object', '{}', {}],
            ['a json-tagged fence', '```json\n{"a":1}\n```', { a: 1 }],
            ['a bare fence', '```\n{"a":1}\n```', { a: 1 }],
            ['a fence with no newlines', '```json{"a":1}```', { a: 1 }],
            ['prose on both sides', 'Here is the result: {"a":1} Hope that helps.', { a: 1 }],
            ['text after a closing fence', '```json\n{"a":1}\n```\nDone.', { a: 1 }],
            ['nested braces', '```json\n{"a":{"b":{"c":1}}}\n```', { a: { b: { c: 1 } } }],
            ['a stray closing brace before a complete object', '} {"a":1}', { a: 1 }],
            ['a fence inside a string value', '{"note":"wrap it in ```json fences```"}', { note: 'wrap it in ```json fences```' }],
            ['an object whose string value holds braces', '{"note":"a { and a }"}', { note: 'a { and a }' }],
            // Surprising but real, and worth stating: the span runs from the
            // first '{' to the last '}', so a fenced single-element array
            // yields the element and discards the array wrapper. The
            // multi-element form cannot be salvaged that way and is asserted
            // among the malformed spans below.
            ['the element of a fenced single-element array', '```json\n[{"a":1}]\n```', { a: 1 }],
        ];

        it.each(recovered)('recovers %s', (_label, raw, expected) => {
            const { parseModelJson } = loadConfigured();

            expect(parseModelJson(raw)).toStrictEqual(expected);
        });

        // The brace scan targets objects, so a non-object JSON document only
        // survives when the FIRST parse accepts it. That asymmetry is pinned
        // rather than assumed: a bare array is returned, a fenced one is not
        // recoverable at all.
        const nonObjects: Array<[string, string, unknown]> = [
            ['a top-level array', '[1,2]', [1, 2]],
            ['a top-level array of objects', '[{"a":1}]', [{ a: 1 }]],
            ['a null literal', 'null', null],
            ['a number literal', '42', 42],
            ['a string literal', '"just text"', 'just text'],
            ['a boolean literal', 'false', false],
        ];

        it.each(nonObjects)('returns %s unchanged, because the first parse accepts it', (_label, raw, expected) => {
            const { parseModelJson } = loadConfigured();

            expect(parseModelJson(raw)).toStrictEqual(expected);
        });
    });

    describe('content it cannot recover', () => {
        const unrecoverable: Array<[string, string]> = [
            ['no braces at all', 'I cannot help with that request.'],
            ['an empty string', ''],
            ['a whitespace-only string', '   '],
            ['a newline-only string', '\n\n'],
            ['an opening brace with no closing brace', 'here it comes: {'],
            ['a closing brace before the only opening brace', 'oops } then {'],
            ['braces in the wrong order', '}{'],
            ['an unterminated object', '{"a":1'],
            ['a fenced array', '```json\n[1,2]\n```'],
        ];

        it.each(unrecoverable)('reports %s as unparseable output', (_label, raw) => {
            const openRouter = loadConfigured();

            const error = vendorFailureSync(openRouter, () => openRouter.parseModelJson(raw));

            expect(error.kind).toBe('unparseable');
            expect(error.message).toBe('Model returned unparseable output');
            expect(error.message).toBe(UNPARSEABLE_MESSAGE);
        });

        // A recoverable span that still will not parse is the one unparseable
        // outcome that carries the vendor-failure wording (see the note in
        // `openrouter.service.ts`): before the extraction the second parse's
        // SyntaxError escaped to the transport catch and was reported this way,
        // and that message reaches the client, so it must not be unified with
        // the message above.
        const malformedSpans: Array<[string, string]> = [
            ['a braced span with a missing value', '{"items": }'],
            ['a braced span with a stray comma', '```json\n{"a": ,}\n```'],
            ['two objects in one response', '{"a":1} {"b":2}'],
            ['single-quoted keys', "{'a':1}"],
            ['a fenced multi-element array of objects', '```json\n[{"a":1},{"b":2}]\n```'],
        ];

        it.each(malformedSpans)('reports %s with the vendor-failure wording', (_label, raw) => {
            const openRouter = loadConfigured();

            const error = vendorFailureSync(openRouter, () => openRouter.parseModelJson(raw));

            expect(error.kind).toBe('unparseable');
            expect(error.message.startsWith(VENDOR_FAILURE_PREFIX)).toBe(true);
            expect(error.message).not.toBe(UNPARSEABLE_MESSAGE);
        });

        it('never lets a SyntaxError escape, whichever branch failed', () => {
            const openRouter = loadConfigured();

            for (const raw of ['no braces here', '{"a": }']) {
                const error = vendorFailureSync(openRouter, () => openRouter.parseModelJson(raw));

                expect(error).not.toBeInstanceOf(SyntaxError);
                expect(error.name).toBe('OpenRouterError');
                expect(error.status).toBeUndefined();
            }
        });
    });
});

describe('getOpenRouterConfig', () => {
    describe('a missing key', () => {
        it('fails loudly with the shipped message and issues no request', () => {
            const openRouter = loadOpenRouter();

            const error = vendorFailureSync(openRouter, () => openRouter.getOpenRouterConfig());

            expect(error.kind).toBe('not_configured');
            expect(error.message).toBe('OPENROUTER_API_KEY is not configured');
            expect(jest.mocked(globalThis.fetch)).not.toHaveBeenCalled();
        });

        it('costs neither a request nor a timer when reached through callOpenRouter', async () => {
            jest.useFakeTimers();
            const openRouter = loadOpenRouter();
            const stub = respondWith(completion('{"items":[]}'));

            const error = await vendorFailure(openRouter, openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub));

            expect(error.kind).toBe('not_configured');
            expect(stub).not.toHaveBeenCalled();
            expect(jest.mocked(globalThis.fetch)).not.toHaveBeenCalled();
            expect(jest.getTimerCount()).toBe(0);
        });

        it('treats an empty-string key as no key at all', () => {
            const openRouter = loadOpenRouter({ apiKey: '' });

            const error = vendorFailureSync(openRouter, () => openRouter.getOpenRouterConfig());

            expect(error.kind).toBe('not_configured');
        });
    });

    describe('a key that is present', () => {
        it('returns the key with the default model', () => {
            const openRouter = loadOpenRouter({ apiKey: API_KEY });
            const expected: OpenRouterConfig = { apiKey: API_KEY, model: DEFAULT_MODEL };

            expect(openRouter.getOpenRouterConfig()).toStrictEqual(expected);
        });

        it('returns the key with the model pinned by the environment', () => {
            const openRouter = loadOpenRouter({ apiKey: API_KEY, model: 'vendor/env-model' });
            const expected: OpenRouterConfig = { apiKey: API_KEY, model: 'vendor/env-model' };

            expect(openRouter.getOpenRouterConfig()).toStrictEqual(expected);
        });

        // The shipped guard is a truthiness check, which the extraction keeps
        // verbatim: a key of spaces is a configured key, and the request goes
        // out with it. Treating it as absent here would change what two live
        // endpoints do with a mis-set environment variable, so the behaviour is
        // pinned as it is rather than as it might ideally be.
        it('treats a whitespace-only key as configured, exactly as the shipped guard did', async () => {
            const openRouter = loadOpenRouter({ apiKey: '   ' });
            const stub = respondWith(completion('{"items":[]}'));

            expect(openRouter.getOpenRouterConfig()).toStrictEqual({ apiKey: '   ', model: DEFAULT_MODEL });

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(sentRequest(stub).headers).toStrictEqual({
                Authorization: 'Bearer    ',
                'Content-Type': 'application/json',
            });
        });

        it('returns the same instance to every caller', () => {
            const openRouter = loadOpenRouter({ apiKey: API_KEY });

            expect(openRouter.getOpenRouterConfig()).toBe(openRouter.getOpenRouterConfig());
        });
    });

    // Rule 7 §9 requires an integration's config to be read once, at the module
    // boundary, rather than per call. That is observable: once an instance
    // exists, the environment it was built from no longer matters.
    describe('config is resolved once, at module load', () => {
        it('ignores a key added to the environment after the module resolved', () => {
            const openRouter = loadOpenRouter();
            process.env.OPENROUTER_API_KEY = 'late-key';

            const error = vendorFailureSync(openRouter, () => openRouter.getOpenRouterConfig());

            expect(error.kind).toBe('not_configured');
        });

        it('ignores a key removed from the environment after the module resolved', () => {
            const openRouter = loadOpenRouter({ apiKey: API_KEY });
            delete process.env.OPENROUTER_API_KEY;

            expect(openRouter.getOpenRouterConfig()).toStrictEqual({ apiKey: API_KEY, model: DEFAULT_MODEL });
        });

        it('ignores a model changed in the environment after the module resolved', async () => {
            const openRouter = loadOpenRouter({ apiKey: API_KEY, model: 'vendor/env-model' });
            process.env.OPENROUTER_MODEL = 'vendor/changed-model';
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(openRouter.getOpenRouterConfig().model).toBe('vendor/env-model');
            expect(sentRequest(stub).body.model).toBe('vendor/env-model');
        });

        it('resolves independently per module instance', () => {
            const first = loadOpenRouter({ apiKey: 'first-key', model: 'vendor/first' });
            const second = loadOpenRouter({ apiKey: 'second-key', model: 'vendor/second' });

            expect(first.getOpenRouterConfig()).toStrictEqual({ apiKey: 'first-key', model: 'vendor/first' });
            expect(second.getOpenRouterConfig()).toStrictEqual({ apiKey: 'second-key', model: 'vendor/second' });
        });
    });

    // Rule 7 §9 also requires metering BEFORE a paid call, and that duty is
    // deliberately not this module's: `entitlement.service.ts` consumes the
    // per-user daily quota at request time (before the call, so a failure is
    // not a free retry) and `scripts/lib/budget.ts` reserves against the
    // operator budget for the offline catalog runs. If this boundary metered
    // too, every request-time call would be counted twice. The source is read
    // here because the absence of a dependency is not otherwise observable
    // from behaviour.
    describe('the boundary does not meter', () => {
        const moduleCode = codeOf('openrouter.service.ts');

        it.each(['entitlement', 'ai_usage', 'assertAndConsumeAiCall', 'prisma', 'budget'])(
            'does not reach for %s',
            (identifier) => {
                expect(moduleCode).not.toContain(identifier);
            },
        );

        it('imports nothing at all, so it cannot reach a quota ledger or a database', () => {
            expect(moduleCode).not.toMatch(/\bimport\b/);
            expect(moduleCode).not.toMatch(/\brequire\s*\(/);
        });

        it('completes a call without any quota state in existence', async () => {
            const openRouter = loadConfigured();
            const stub = respondWith(completion('{"items":[]}'));

            await openRouter.callOpenRouter(SYSTEM_PROMPT, USER_TEXT, JSON_SCHEMA, undefined, stub);

            expect(stub).toHaveBeenCalledTimes(1);
        });
    });
});


/**
 * The other half of the extraction: `estimate.service.ts` must turn every
 * `OpenRouterError` back into the `EstimateFailedError` its controller already
 * maps, carrying the SAME message text as before. These tests drive the two
 * shipped entry points — `estimateMeal` (POST /api/macros/estimate) and
 * `scanLabel` (POST /api/macros/label-scan) — through the global `fetch`,
 * because `callModel` calls `callOpenRouter` with four arguments and exposes no
 * injection seam of its own.
 *
 * Grounding is deliberately kept away from USDA here. `searchGenericFoods`
 * reaches `usdaGet`, which reads `usda_api_cache` through Prisma BEFORE it
 * checks the API key, so any item with a positive gram weight would open a
 * database connection — which a unit test must not do (Rule 7 §11). The two
 * levers that keep it out are `ESTIMATE_GROUNDING=off` and an item whose gram
 * weight resolves to 0, which short-circuits before any USDA call. The judge
 * round trip and a failing `searchGenericFoods` are reachable only past that
 * read, so they belong to the integration suites; what is provable here is that
 * every call site shares ONE translation point, which is asserted structurally
 * below.
 */
describe('estimate.service regression', () => {
    interface EstimateHarness {
        estimate: typeof import('../estimate.service');
        openRouter: OpenRouterModule;
    }

    /**
     * One registry for the whole block: `openrouter.service` is required first
     * so that `estimate.service` receives that very instance, which is what
     * makes its `error instanceof OpenRouterError` check meaningful. Memoised
     * so only one `PrismaClient` is ever constructed behind
     * `estimate.service` → `usda.service` (construction is lazy; nothing here
     * connects).
     */
    const loadHarness = (() => {
        const cache = new Map<string, EstimateHarness>();

        return (apiKey?: string): EstimateHarness => {
            const cacheKey = apiKey ?? '<none>';
            const cached = cache.get(cacheKey);
            if (cached !== undefined) {
                return cached;
            }

            setEnvValue('OPENROUTER_API_KEY', apiKey);
            setEnvValue('OPENROUTER_MODEL', undefined);

            let loaded!: EstimateHarness;
            jest.isolateModules(() => {
                const openRouter = require('../openrouter.service') as OpenRouterModule;
                const estimate = require('../estimate.service') as typeof import('../estimate.service');
                loaded = { estimate, openRouter };
            });

            cache.set(cacheKey, loaded);

            return loaded;
        };
    })();

    const configuredHarness = (): EstimateHarness => loadHarness(API_KEY);

    const modelItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        name: 'Scrambled eggs',
        quantityText: '2',
        grams: 0,
        calories: 220,
        protein: 14,
        carbs: 2,
        fat: 16,
        ...overrides,
    });

    const estimateCompletion = (payload: unknown): Response => completion(JSON.stringify(payload));

    const globalStub = (): FetchStub => jest.mocked(globalThis.fetch) as FetchStub;

    const asFailedEstimate = (error: unknown, harness: EstimateHarness): Error => {
        if (!(error instanceof harness.estimate.EstimateFailedError)) {
            throw new Error(`Expected an EstimateFailedError, received ${describeValue(error)}.`);
        }

        return error;
    };

    /**
     * Every vendor failure mode with the message the endpoint has always shown
     * a client. `not_configured` is absent because it needs a module instance
     * that never saw a key; it is driven separately below.
     */
    const vendorFailures: Array<[string, OpenRouterErrorKind, () => FetchStub, string]> = [
        [
            'a non-ok response',
            'http',
            () => respondWith(failureResponse(429, 'rate limited')),
            'OpenRouter returned 429: rate limited',
        ],
        ['an empty completion', 'empty', () => respondWith(completion('')), 'OpenRouter returned an empty completion'],
        ['an aborted request', 'timeout', () => rejectWith(abortError()), 'OpenRouter request timed out'],
        [
            'a transport failure',
            'network',
            () => rejectWith(new TypeError('fetch failed')),
            'OpenRouter request failed: fetch failed',
        ],
        [
            'unreadable content',
            'unparseable',
            () => respondWith(completion('I cannot help with that.')),
            'Model returned unparseable output',
        ],
    ];

    describe('estimateMeal translates every vendor failure without changing its text', () => {
        it.each(vendorFailures)('reports %s', async (_label, _kind, buildStub, expected) => {
            const harness = configuredHarness();
            globalThis.fetch = buildStub();

            const error = asFailedEstimate(await rejectionOf(harness.estimate.estimateMeal('two eggs')), harness);

            expect(error.message).toBe(expected);
            expect(error.name).toBe('EstimateFailedError');
            expect(error).not.toBeInstanceOf(harness.openRouter.OpenRouterError);
        });

        it('reports a missing API key with the shipped message', async () => {
            const harness = loadHarness(undefined);
            globalThis.fetch = respondWith(estimateCompletion({ items: [modelItem()] }));

            const error = asFailedEstimate(await rejectionOf(harness.estimate.estimateMeal('two eggs')), harness);

            expect(error.message).toBe('OPENROUTER_API_KEY is not configured');
            expect(globalStub()).not.toHaveBeenCalled();
        });
    });

    describe('scanLabel translates every vendor failure without changing its text', () => {
        it.each(vendorFailures)('reports %s', async (_label, _kind, buildStub, expected) => {
            const harness = configuredHarness();
            globalThis.fetch = buildStub();

            const error = asFailedEstimate(await rejectionOf(harness.estimate.scanLabel('QUJD')), harness);

            expect(error.message).toBe(expected);
            expect(error.name).toBe('EstimateFailedError');
            expect(error).not.toBeInstanceOf(harness.openRouter.OpenRouterError);
        });

        it('reports a missing API key with the shipped message', async () => {
            const harness = loadHarness(undefined);
            globalThis.fetch = respondWith(completion('{"calories":100}'));

            const error = asFailedEstimate(await rejectionOf(harness.estimate.scanLabel('QUJD')), harness);

            expect(error.message).toBe('OPENROUTER_API_KEY is not configured');
        });

        it('still sends the photo as multimodal content parts', async () => {
            const harness = configuredHarness();
            globalThis.fetch = respondWith(completion('{"calories":210,"confidence":"high"}'));

            await harness.estimate.scanLabel('QUJD');

            expect(sentRequest(globalStub()).body.messages[1].content).toStrictEqual([
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
            ]);
        });
    });

    it('never nests one failure message inside another', async () => {
        const harness = configuredHarness();

        for (const [, , buildStub, expected] of vendorFailures) {
            globalThis.fetch = buildStub();

            const error = asFailedEstimate(await rejectionOf(harness.estimate.estimateMeal('two eggs')), harness);

            expect(error.message).toBe(expected);
            expect(occurrences(error.message, VENDOR_FAILURE_PREFIX)).toBeLessThanOrEqual(1);
            expect(error.message).not.toContain(`${VENDOR_FAILURE_PREFIX} ${VENDOR_FAILURE_PREFIX}`);
        }
    });

    // `Model returned no food items` is the estimate domain's own rule — the
    // model answered successfully and said nothing usable — so it must not
    // migrate into the vendor boundary, where it would become a transport
    // concern and acquire a vendor error kind.
    describe('the estimate services own failure stays its own', () => {
        const emptyItemSets: Array<[string, unknown]> = [
            ['an empty items array', { items: [] }],
            ['no items field', { confidence: 'low' }],
            ['items that is not an array', { items: 'none' }],
            ['items holding only nulls', { items: [null] }],
            ['items holding a nameless object', { items: [{ calories: 100 }] }],
            ['items holding a blank name', { items: [modelItem({ name: '   ' })] }],
            ['items holding a non-object', { items: ['just text'] }],
        ];

        it.each(emptyItemSets)('reports %s as no food items, after a successful vendor call', async (_label, payload) => {
            const harness = configuredHarness();
            globalThis.fetch = respondWith(estimateCompletion(payload));

            const error = asFailedEstimate(await rejectionOf(harness.estimate.estimateMeal('two eggs')), harness);

            expect(error.message).toBe('Model returned no food items');
            expect(error).not.toBeInstanceOf(harness.openRouter.OpenRouterError);
            expect(globalStub()).toHaveBeenCalledTimes(1);
        });

        it('is not a string the vendor boundary can produce', () => {
            expect(codeOf('openrouter.service.ts')).not.toContain('Model returned no food items');
            expect(codeOf('estimate.service.ts')).toContain("'Model returned no food items'");
        });
    });

    describe('grounding', () => {
        const groundableItem = modelItem({ grams: 92, calories: 180 });

        it('makes no second call when ESTIMATE_GROUNDING is off', async () => {
            const harness = configuredHarness();
            process.env.ESTIMATE_GROUNDING = 'off';
            globalThis.fetch = respondWith(estimateCompletion({ items: [groundableItem], confidence: 'high' }));

            const result = await harness.estimate.estimateMeal('two eggs');

            expect(globalStub()).toHaveBeenCalledTimes(1);
            expect(result.items).toStrictEqual([
                {
                    name: 'Scrambled eggs',
                    quantityText: '2',
                    grams: 92,
                    calories: 180,
                    protein: 14,
                    carbs: 2,
                    fat: 16,
                    source: 'estimated',
                    matchedTo: null,
                },
            ]);
        });

        it('is attempted when ESTIMATE_GROUNDING is unset, and still returns the estimate', async () => {
            const harness = configuredHarness();
            delete process.env.ESTIMATE_GROUNDING;
            globalThis.fetch = respondWith(estimateCompletion({ items: [modelItem()], confidence: 'medium' }));

            const result = await harness.estimate.estimateMeal('two eggs');

            expect(globalStub()).toHaveBeenCalledTimes(1);
            expect(result.items[0].source).toBe('estimated');
            expect(result.items[0].matchedTo).toBeNull();
        });

        it('returns the estimate with grounding enabled and USDA unconfigured', async () => {
            const harness = configuredHarness();
            delete process.env.ESTIMATE_GROUNDING;
            delete process.env.USDA_API_KEY;
            globalThis.fetch = respondWith(estimateCompletion({ items: [modelItem()], confidence: 'low' }));

            const result = await harness.estimate.estimateMeal('two eggs');

            expect(result.confidence).toBe('low');
            expect(result.items).toHaveLength(1);
        });

        it('leaves an unrelated ESTIMATE_GROUNDING value meaning enabled', async () => {
            const harness = configuredHarness();
            process.env.ESTIMATE_GROUNDING = 'on';
            globalThis.fetch = respondWith(estimateCompletion({ items: [modelItem()], confidence: 'high' }));

            const result = await harness.estimate.estimateMeal('two eggs');

            expect(globalStub()).toHaveBeenCalledTimes(1);
            expect(result.items).toHaveLength(1);
        });
    });

    // The judge call is the third `callOpenRouter` consumer and the only one
    // that passes a model override. Reaching it needs USDA candidates, which
    // needs the Prisma cache read this suite stays away from — so what is
    // asserted here is the property that makes reaching it unnecessary: there
    // is exactly ONE place where a vendor error becomes an
    // `EstimateFailedError`, so the judge site cannot translate differently
    // from the two sites proven above.
    describe('the judge call site', () => {
        const estimateCode = codeOf('estimate.service.ts');

        it('still defaults to openai/gpt-4o-mini', () => {
            expect(estimateCode).toContain("process.env.ESTIMATE_JUDGE_MODEL || 'openai/gpt-4o-mini'");
        });

        it('reaches the vendor through the single translation point, as every call site does', () => {
            expect(occurrences(estimateCode, 'callOpenRouter(')).toBe(1);
            expect(occurrences(estimateCode, 'callModel(')).toBe(3);
            expect(estimateCode).toContain('new EstimateFailedError(error.message)');
        });
    });

    // `toInt` is reached on every numeric field of both responses. `scanLabel`
    // exercises it without touching grounding at all.
    describe('toInt semantics survive the extraction', () => {
        const scanFor = async (fields: Record<string, unknown>): Promise<Awaited<ReturnType<typeof import('../estimate.service').scanLabel>>> => {
            const harness = configuredHarness();
            globalThis.fetch = respondWith(completion(JSON.stringify(fields)));

            return harness.estimate.scanLabel('QUJD');
        };

        it('floors a negative value at zero', async () => {
            expect((await scanFor({ calories: -5 })).calories).toBe(0);
        });

        it('rounds a fraction to the nearest integer', async () => {
            expect((await scanFor({ protein: 12.4 })).protein).toBe(12);
        });

        it('rounds a half upwards', async () => {
            expect((await scanFor({ fat: 12.5 })).fat).toBe(13);
        });

        it('treats a non-numeric string as zero', async () => {
            expect((await scanFor({ carbs: 'abc' })).carbs).toBe(0);
        });

        it('treats a missing field as zero', async () => {
            expect((await scanFor({ calories: 100 })).protein).toBe(0);
        });

        it('treats null as zero', async () => {
            expect((await scanFor({ calories: null })).calories).toBe(0);
        });

        it('treats a non-finite value as zero', async () => {
            expect((await scanFor({ calories: 1e400 })).calories).toBe(0);
        });

        it('accepts a numeric string', async () => {
            expect((await scanFor({ calories: '7' })).calories).toBe(7);
        });

        it('keeps a positive serving amount and rejects a non-positive one', async () => {
            expect((await scanFor({ servingAmount: 2.5 })).servingAmount).toBe(2.5);
            expect((await scanFor({ servingAmount: 0 })).servingAmount).toBeNull();
            expect((await scanFor({ servingAmount: -1 })).servingAmount).toBeNull();
        });

        it('applies the same rounding to estimate items', async () => {
            const harness = configuredHarness();
            process.env.ESTIMATE_GROUNDING = 'off';
            globalThis.fetch = respondWith(
                estimateCompletion({
                    items: [modelItem({ grams: -3, calories: 220.5, protein: 'abc', carbs: null, fat: 16.4 })],
                }),
            );

            const result = await harness.estimate.estimateMeal('two eggs');

            expect(result.items[0]).toMatchObject({ grams: 0, calories: 221, protein: 0, carbs: 0, fat: 16 });
            expect(result.total).toStrictEqual({ calories: 221, protein: 0, carbs: 0, fat: 16 });
        });
    });
});

