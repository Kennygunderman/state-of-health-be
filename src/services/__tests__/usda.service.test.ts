/**
 * `usda.service.ts` is the USDA FoodData Central vendor boundary. Two shipped
 * endpoints reach it at request time — `GET /api/macros/search-branded-foods`
 * and the USDA grounding inside `POST /api/macros/estimate` — and the offline
 * catalog import (Agent Action Plan §0.7.1 Group 3) reaches it through the
 * three fetchers this feature added. Nothing else in the repository pins its
 * behaviour.
 *
 * What this suite pins, and why each one is a decision someone could break:
 *
 *  - **The `cacheKeyFor` output, byte for byte.** Its result IS
 *    `usda_api_cache.cache_key`, a primary key whose rows are already deployed.
 *    Changing the normalisation, the sort, the separator or the `?` prefix
 *    orphans every warm row, silently turning a warm cache cold and pushing the
 *    running API back through USDA's 1,000-requests-per-hour limit. The worked
 *    example is asserted with `toBe` against a literal, never `toContain`.
 *  - **That a key rotation cannot orphan the cache.** The builder reads no
 *    environment, and `api_key` is appended to the query string *after* the key
 *    is built, so the same params key identically whatever credential is
 *    configured. See the note above that test: the builder does not itself
 *    strip an `api_key` param, so the guarantee is a call-site contract and is
 *    asserted as one.
 *  - **That a `400` is retried.** Deliberately, alongside `429` and `5xx`, and
 *    unlike any normal client. Four physical attempts with 250/500/750 ms
 *    between them, advanced through fake timers so the suite never sleeps.
 *  - **The outbound request.** For a vendor boundary the request IS the
 *    observable contract, so the exact URL, the argument count, the method, the
 *    headers, the body and the attempt count are all asserted. The space in
 *    `Survey (FNDDS)` must arrive as `%20` with the parentheses left literal:
 *    `URLSearchParams` would emit `+` and USDA answers `400` to that, so the
 *    exact query string is what stops the manual builder being "tidied" away.
 *  - **The `/food/` prefix TTL split.** One character decides whether a cached
 *    row lives 90 days or 30: `/food/{id}` is the detail path, `/foods/list`
 *    is not. Both are asserted at their exact boundary.
 *  - **Stale-while-revalidate, including its failure posture.** A cached row is
 *    served at any age, a row past its TTL refreshes off the request path, two
 *    rapid calls issue one refresh, and a rejecting `findUnique` or `upsert`
 *    never fails the caller.
 *  - **Every failure leaves as a `UsdaError`.** A raw `Response`, a bare
 *    `TypeError` from the network, or a `SyntaxError` from an unreadable body
 *    escaping this module would force callers to pattern-match a vendor error
 *    shape (Rule 7 §9).
 *  - **The accessor fails loudly and for free.** A missing key costs no
 *    request at all, asserted as a call count of zero.
 *  - **Per-attempt rate accounting.** `scripts/lib/rateLimiter.ts` wraps
 *    `globalThis.fetch` and charges a token per *physical* attempt, so four
 *    retries are four tokens and a cache hit is none. That arithmetic only
 *    holds if this module keeps reading `fetch` off the global on every
 *    attempt, which the final group asserts.
 *
 * Response shapes come from `data/meal-planning/fixtures/usda-detail-samples.json`
 * rather than from literals invented here, so the per-100 g/per-serving
 * distinction the whole module turns on is taken from one reviewed source.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { parseCanonicalFdcId } from '../catalog.logic';
import {
    MAX_BATCH_FDC_IDS,
    MAX_LIST_PAGE_SIZE,
    USDA_REQUEST_CALL_BUDGET_MS,
    UsdaError,
    cacheKeyFor,
    cacheKeyForRequest,
    clampListPageSize,
    getBrandedFood,
    getFoodDetail,
    getFoodsBatch,
    isRetryableUsdaStatus,
    listFoods,
    normalizeFdcIds,
    searchBrandedFoods,
    searchGenericFoods,
} from '../usda.service';
import type { GenericFoodCandidate, UsdaFoodDetail, UsdaFoodPortion } from '../usda.service';

/**
 * Derived from the boundary's own signature rather than imported from
 * `src/types/nutrition.ts`, so these assertions are bound to what the module
 * promises its callers and cannot drift from it.
 */
type BrandedFoodResponse = NonNullable<Awaited<ReturnType<typeof getBrandedFood>>>;

/**
 * The folder's only `jest.mock`, and the only one that reaches tier 3 of Rule 7
 * §11's preference order (a declared seam, then a `globalThis.fetch` stub, then
 * a module mock). It is here because there is no lower tier available:
 * `usda.service.ts` imports the Prisma singleton at module scope and calls
 * `prisma.usda_api_cache.findUnique` / `.upsert` directly, exposing no
 * parameter to inject a cache through. Replacing the singleton is also what
 * keeps this suite off a database entirely — the real module constructs a
 * `PrismaClient` on import — so the pure cache decisions (key identity,
 * stale-while-revalidate, TTL by path, error posture) are unit-testable here
 * instead of only in an integration suite.
 *
 * The factory may reference nothing but `jest`, because Jest hoists it above
 * every import in this file; the in-memory store behind these two functions is
 * wired up in `beforeEach`.
 */
jest.mock('../../prisma/client', () => ({
    prisma: {
        usda_api_cache: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
    },
}));

/** Obviously fake: nothing here may resemble a real provider credential. */
const API_KEY = 'test-usda-key';
const ROTATED_API_KEY = 'test-usda-key-rotated';

const DEFAULT_BASE_URL = 'https://api.nal.usda.gov/fdc/v1';
const OVERRIDE_BASE_URL = 'https://usda.invalid/fdc/v1';

/** `MAX_ATTEMPTS` and `RETRY_DELAY_MS`, which the module keeps private. */
const MAX_ATTEMPTS = 4;
const BACKOFF_SEQUENCE_MS = [250, 500, 750];
const TOTAL_BACKOFF_MS = BACKOFF_SEQUENCE_MS.reduce((total, delay) => total + delay, 0);

/**
 * The per-attempt deadlines, also private to the module. The call budgets are
 * not restated: the request-path one is exported (`estimate.service.ts` sizes
 * its grounding reserve from it) and the import one is derived below from the
 * attempt count it has to admit.
 */
const REQUEST_ATTEMPT_TIMEOUT_MS = 3_000;
const IMPORT_ATTEMPT_TIMEOUT_MS = 30_000;
const IMPORT_CALL_BUDGET_MS = 120_000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** `SEARCH_TTL_MS` and `DETAIL_TTL_MS`, also private to the module. */
const SEARCH_TTL_MS = 30 * DAY_MS;
const DETAIL_TTL_MS = 90 * DAY_MS;

/** A fixed clock: the module compares `Date.now()` against `fetched_at`. */
const FIXED_NOW = Date.UTC(2026, 8, 12, 12, 0, 0);

const NOT_CONFIGURED_MESSAGE = 'USDA_API_KEY is not configured';
/**
 * `fetchFromUsda` seeds `lastError` with this before its first attempt and
 * overwrites it in both branches of every attempt, so no caller can observe it
 * while `MAX_ATTEMPTS` is above zero. It is named here so the assertion that it
 * never escapes can be written against the real string.
 */
const PLACEHOLDER_MESSAGE = 'USDA request failed';

const statusMessage = (status: number): string => `USDA returned ${status}`;
const vendorFailureMessage = (cause: string): string => `USDA request failed: ${cause}`;
const timedOutMessage = (afterMs: number): string => `USDA request timed out after ${afterMs}ms`;
const invalidFdcIdMessage = (value: string): string => `Invalid USDA FDC id: ${value}`;
const overLengthBatchMessage = (received: number): string =>
    `USDA accepts at most ${MAX_BATCH_FDC_IDS} FDC ids per batch request, received ${received}`;
const notAnArrayMessage = (context: string): string => `USDA ${context} returned a payload that is not an array`;
const notAnObjectMessage = (context: string): string => `USDA ${context} returned a record that is not an object`;
const invalidRecordIdMessage = (context: string, value: string): string =>
    `USDA ${context} returned a record with an invalid fdcId: ${value}`;
const detailIdentityMessage = (requested: number, returned: number): string =>
    `USDA detail for FDC id ${requested} returned fdcId ${returned}`;
const unrequestedIdMessage = (returned: number): string => `USDA batch returned an unrequested fdcId: ${returned}`;

// ---------------------------------------------------------------------------
// The in-memory usda_api_cache
// ---------------------------------------------------------------------------

interface UsdaCacheRow {
    cache_key: string;
    payload: unknown;
    fetched_at: Date;
}

interface FindUniqueArgs {
    where: { cache_key: string };
}

interface UpsertArgs {
    where: { cache_key: string };
    create: { cache_key: string; payload: unknown };
    update: { payload: unknown; fetched_at: Date };
}

/**
 * Only the two delegate methods the module calls, typed to the arguments it
 * passes. Mimicking the generated client's overloads would need casts at every
 * `mockImplementation`; this compiles under `strict` with none.
 */
interface UsdaCacheDouble {
    findUnique: jest.Mock<Promise<UsdaCacheRow | null>, [FindUniqueArgs]>;
    upsert: jest.Mock<Promise<UsdaCacheRow>, [UpsertArgs]>;
}

const { prisma: prismaDouble } = jest.requireMock<{ prisma: { usda_api_cache: UsdaCacheDouble } }>(
    '../../prisma/client',
);

const cache = prismaDouble.usda_api_cache;

const rows = new Map<string, UsdaCacheRow>();

/** A row written `ageMs` before the fixed clock, whatever its key's TTL. */
const seedRow = (cacheKey: string, payload: unknown, ageMs: number): void => {
    rows.set(cacheKey, { cache_key: cacheKey, payload, fetched_at: new Date(FIXED_NOW - ageMs) });
};

const storedRow = (cacheKey: string): UsdaCacheRow => {
    const row = rows.get(cacheKey);
    if (row === undefined) {
        throw new Error(
            `Expected a cache row under ${JSON.stringify(cacheKey)}; the store holds ` +
                `${JSON.stringify(Array.from(rows.keys()))}.`,
        );
    }

    return row;
};

/** Every key the module read, in order — the legacy-key regression guard. */
const readKeys = (): string[] => cache.findUnique.mock.calls.map(([args]) => args.where.cache_key);

const writtenKeys = (): string[] => cache.upsert.mock.calls.map(([args]) => args.where.cache_key);

// ---------------------------------------------------------------------------
// The fetch stub
// ---------------------------------------------------------------------------

type FetchStub = jest.MockedFunction<typeof fetch>;

const REAL_FETCH = globalThis.fetch;

const install = (stub: FetchStub): FetchStub => {
    globalThis.fetch = stub as unknown as typeof fetch;

    return stub;
};

const installedFetch = (): FetchStub => jest.mocked(globalThis.fetch);

const requestCount = (): number => installedFetch().mock.calls.length;

const jsonResponse = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

const failureResponse = (status: number): Response => new Response(`upstream said ${status}`, { status });

/** Answers each request from the queue; an unqueued request is a test defect. */
const respondWith = (...responses: Response[]): FetchStub => {
    const queue = [...responses];

    return install(
        jest.fn(async (): Promise<Response> => {
            const next = queue.shift();
            if (next === undefined) {
                throw new Error('The fetch stub received more requests than it was given responses for.');
            }

            return next;
        }) as unknown as FetchStub,
    );
};

/** A `Response` body can only be read once, so a retried request needs a new one. */
const alwaysRespond = (build: () => Response): FetchStub =>
    install(jest.fn(async (): Promise<Response> => build()) as unknown as FetchStub);

const rejectWith = (error: unknown): FetchStub =>
    install(
        jest.fn(async (): Promise<Response> => {
            throw error;
        }) as unknown as FetchStub,
    );

/** What `fetch` rejects with when the signal it was given aborts. */
const abortError = (): Error => {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';

    return error;
};

/**
 * A stub that never answers, and rejects only when the request's own signal
 * aborts — which is what a stalled DNS lookup, TLS handshake or body read looks
 * like to this module. Before the deadline existed, a call against this stub
 * never settled at all.
 */
const neverAnswers = (): FetchStub =>
    install(
        jest.fn(
            (_input: unknown, init?: RequestInit): Promise<Response> =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        reject(abortError());
                    });
                }),
        ) as unknown as FetchStub,
    );

/** Stalls the first attempt until it is aborted, then answers every later one. */
const stallThenRespond = (payload: unknown): FetchStub => {
    let stalled = false;

    return install(
        jest.fn((_input: unknown, init?: RequestInit): Promise<Response> => {
            if (stalled) {
                return Promise.resolve(jsonResponse(payload));
            }
            stalled = true;

            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(abortError());
                });
            });
        }) as unknown as FetchStub,
    );
};

interface Deferred {
    stub: FetchStub;
    settle: () => void;
}

/** A stub whose single request stays in flight until `settle()` is called. */
const respondWhenSettled = (payload: unknown): Deferred => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    const stub = install(
        jest.fn(async (): Promise<Response> => {
            await gate;

            return jsonResponse(payload);
        }) as unknown as FetchStub,
    );

    return {
        stub,
        settle: () => {
            release?.();
        },
    };
};

interface SentRequest {
    url: string;
    /** Always 2: every request carries an init, if only to hold the signal. */
    argumentCount: number;
    method: string | undefined;
    headers: unknown;
    body: unknown;
    signal: AbortSignal | null | undefined;
}

const sentRequest = (index = 0): SentRequest => {
    const calls = installedFetch().mock.calls;
    const call = calls[index];
    if (call === undefined) {
        throw new Error(`Expected request ${index + 1}, but ${calls.length} were issued.`);
    }

    const [input, init] = call;
    const rawBody = init === undefined ? undefined : init.body;

    return {
        url: String(input),
        argumentCount: call.length,
        method: init?.method,
        headers: init?.headers,
        body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as unknown) : rawBody,
        signal: init?.signal,
    };
};

/**
 * The GET contract, asserted in one place because six tests depend on it.
 *
 * A GET's init exists only to carry the abort signal every attempt runs under:
 * no method, no headers and no body, so what USDA receives is byte-for-byte the
 * request this module sent before it had a deadline — `fetch(url)` with a
 * default method of GET and no content type. The signal itself is the change,
 * and it is asserted rather than ignored: without it a stalled DNS lookup, TLS
 * handshake or body read waits for the socket's lifetime (the defect this
 * suite's `deadlines` group covers).
 */
const expectSignalOnlyGet = (request: SentRequest): void => {
    expect(request.argumentCount).toBe(2);
    expect(request.method).toBeUndefined();
    expect(request.headers).toBeUndefined();
    expect(request.body).toBeUndefined();
    expect(request.signal).toBeInstanceOf(AbortSignal);
};

// ---------------------------------------------------------------------------
// Error narrowing
// ---------------------------------------------------------------------------

const describeValue = (value: unknown): string =>
    value instanceof Error ? `${value.name}: ${value.message}` : `${typeof value} (${String(value)})`;

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
 * value that left the module is a `UsdaError`. The failure text names what
 * actually arrived, so a leaked `TypeError` reads as such.
 */
const asUsdaError = (error: unknown): UsdaError => {
    if (!(error instanceof UsdaError)) {
        throw new Error(`Expected a UsdaError, received ${describeValue(error)}.`);
    }

    return error;
};

const vendorFailure = async (call: Promise<unknown>): Promise<UsdaError> => asUsdaError(await rejectionOf(call));

const vendorFailureSync = (run: () => unknown): UsdaError => asUsdaError(throwOf(run));

/**
 * Drives a call that exhausts all four attempts: the rejection handler is
 * attached before any timer moves, so the promise is never momentarily
 * unhandled, and the whole backoff is then advanced at once.
 */
const exhaustAttempts = async (call: Promise<unknown>): Promise<UsdaError> => {
    const settled = rejectionOf(call);
    await jest.advanceTimersByTimeAsync(TOTAL_BACKOFF_MS);

    return asUsdaError(await settled);
};

// ---------------------------------------------------------------------------
// The recorded USDA responses
// ---------------------------------------------------------------------------

interface FixtureFile {
    dataTypes: string[];
    searchResponses: Record<string, unknown>;
    detailResponses: Record<string, unknown>;
    portionSamples: Record<string, unknown>;
}

const FIXTURE_PATH = join(__dirname, '..', '..', '..', 'data', 'meal-planning', 'fixtures', 'usda-detail-samples.json');

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixtureFile;

interface SampleEnvelope {
    payload: unknown;
    expectedCandidate?: GenericFoodCandidate;
    expectedBrandedFood?: BrandedFoodResponse;
    expectedBrandedFoods?: BrandedFoodResponse[];
    expectedResultLength?: number;
    expectedAcceptedFdcIds?: string[];
}

/**
 * Fails loudly on a renamed or restructured sample rather than skipping the
 * case: a fixture edit must break the test that depends on it, not quietly
 * remove its coverage.
 */
const sample = (group: Record<string, unknown>, name: string): SampleEnvelope => {
    const envelope = group[name];
    if (typeof envelope !== 'object' || envelope === null || !('payload' in envelope)) {
        throw new Error(`Fixture sample ${JSON.stringify(name)} is missing or carries no payload member.`);
    }

    return envelope as SampleEnvelope;
};

const searchSample = (name: string): SampleEnvelope => sample(fixture.searchResponses, name);
const detailSample = (name: string): SampleEnvelope => sample(fixture.detailResponses, name);
const portionSample = (name: string): SampleEnvelope => sample(fixture.portionSamples, name);

const expectedCandidateOf = (name: string): GenericFoodCandidate => {
    const { expectedCandidate } = searchSample(name);
    if (expectedCandidate === undefined) {
        throw new Error(`Fixture sample ${JSON.stringify(name)} declares no expectedCandidate.`);
    }

    return expectedCandidate;
};

const expectedBrandedFoodOf = (envelope: SampleEnvelope, name: string): BrandedFoodResponse => {
    const { expectedBrandedFood } = envelope;
    if (expectedBrandedFood === undefined) {
        throw new Error(`Fixture sample ${JSON.stringify(name)} declares no expectedBrandedFood.`);
    }

    return expectedBrandedFood;
};

const DATA_TYPES = fixture.dataTypes;

const fdcIdOf = (envelope: SampleEnvelope): number => {
    const payload = envelope.payload as { fdcId?: unknown };
    if (typeof payload.fdcId !== 'number') {
        throw new Error(`Expected a numeric fdcId on the sample, received ${describeValue(payload.fdcId)}.`);
    }

    return payload.fdcId;
};

const portionsOf = (detail: UsdaFoodDetail): UsdaFoodPortion[] => {
    const { foodPortions } = detail;
    if (foodPortions === undefined) {
        throw new Error('Expected the detail record to carry foodPortions.');
    }

    return foodPortions;
};

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Taken at file evaluation, which is after `jestSetup.ts` has deleted
 * `USDA_API_KEY` — so the snapshot correctly records it as absent and
 * `afterEach` restores that state rather than a developer's.
 */
const ENV_SNAPSHOT: NodeJS.ProcessEnv = { ...process.env };

const restoreEnvironment = (): void => {
    for (const key of Object.keys(process.env)) {
        if (!(key in ENV_SNAPSHOT)) {
            delete process.env[key];
        }
    }

    Object.assign(process.env, ENV_SNAPSHOT);
};

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);

    rows.clear();
    // Reinstalled every test because `afterEach` calls `jest.resetAllMocks()`,
    // which drops implementations as well as usage data.
    cache.findUnique.mockImplementation(async ({ where }) => rows.get(where.cache_key) ?? null);
    cache.upsert.mockImplementation(async ({ where, create, update }) => {
        const existing = rows.get(where.cache_key);
        const row: UsdaCacheRow =
            existing === undefined
                ? { cache_key: create.cache_key, payload: create.payload, fetched_at: new Date(Date.now()) }
                : { ...existing, payload: update.payload, fetched_at: update.fetched_at };
        rows.set(where.cache_key, row);

        return row;
    });

    process.env.USDA_API_KEY = API_KEY;
    delete process.env.USDA_BASE_URL;

    // An unqueued request is a defect, so the default stub has nothing queued.
    respondWith();
});

afterEach(async () => {
    // Drains the microtask queue so a background refresh's `finally` runs and
    // releases the module's in-flight key before the next test.
    await jest.advanceTimersByTimeAsync(0);

    jest.useRealTimers();
    jest.resetAllMocks();
    globalThis.fetch = REAL_FETCH;
    restoreEnvironment();
    rows.clear();
});

describe('cacheKeyFor', () => {
    describe('the deployed key format', () => {
        it('builds the worked example byte for byte', () => {
            expect(
                cacheKeyFor('/foods/search', {
                    query: '  Chicken   Breast ',
                    dataType: 'Survey (FNDDS)',
                    pageSize: '6',
                }),
            ).toBe('/foods/search?dataType=Survey (FNDDS)&pageSize=6&query=chicken breast');
        });

        it('does not depend on the order the params were built in', () => {
            const insertionOrder = cacheKeyFor('/foods/search', {
                query: '  Chicken   Breast ',
                dataType: 'Survey (FNDDS)',
                pageSize: '6',
            });
            const reversedOrder = cacheKeyFor('/foods/search', {
                pageSize: '6',
                dataType: 'Survey (FNDDS)',
                query: '  Chicken   Breast ',
            });

            expect(reversedOrder).toBe(insertionOrder);
        });

        it('leaves values un-encoded', () => {
            expect(cacheKeyFor('/foods/search', { dataType: 'Survey (FNDDS),SR Legacy,Foundation' })).toBe(
                '/foods/search?dataType=Survey (FNDDS),SR Legacy,Foundation',
            );
        });

        it('returns the path and a bare separator for empty params', () => {
            expect(cacheKeyFor('/foods/search', {})).toBe('/foods/search?');
        });

        it('keeps the path verbatim, so the detail and list paths never share a key', () => {
            expect(cacheKeyFor('/food/9000301', { format: 'full' })).toBe('/food/9000301?format=full');
            expect(cacheKeyFor('/foods/list', { format: 'full' })).toBe('/foods/list?format=full');
        });
    });

    describe('query normalisation', () => {
        it('strips leading and trailing whitespace', () => {
            expect(cacheKeyFor('/foods/search', { query: '   egg   ' })).toBe('/foods/search?query=egg');
        });

        it('lowercases mixed case', () => {
            expect(cacheKeyFor('/foods/search', { query: 'EGG Whites' })).toBe('/foods/search?query=egg whites');
        });

        it('collapses a run of internal spaces to one', () => {
            expect(cacheKeyFor('/foods/search', { query: 'egg     whites' })).toBe('/foods/search?query=egg whites');
        });

        it('collapses tabs and newlines to one space', () => {
            expect(cacheKeyFor('/foods/search', { query: 'egg\t\twhites\n\nraw' })).toBe(
                '/foods/search?query=egg whites raw',
            );
        });

        it('normalises a whitespace-only query to an empty value without throwing', () => {
            expect(cacheKeyFor('/foods/search', { query: ' \t\n ' })).toBe('/foods/search?query=');
        });

        it('normalises an empty query to an empty value', () => {
            expect(cacheKeyFor('/foods/search', { query: '' })).toBe('/foods/search?query=');
        });
    });

    describe('params other than query', () => {
        it('preserves capitals, the space and the parentheses of a dataType', () => {
            expect(cacheKeyFor('/foods/list', { dataType: 'Survey (FNDDS)' })).toBe(
                '/foods/list?dataType=Survey (FNDDS)',
            );
        });

        it('preserves surrounding whitespace', () => {
            expect(cacheKeyFor('/foods/list', { dataType: '  Survey (FNDDS)  ' })).toBe(
                '/foods/list?dataType=  Survey (FNDDS)  ',
            );
        });

        it('does not collapse internal whitespace', () => {
            expect(cacheKeyFor('/foods/list', { dataType: 'SR    Legacy' })).toBe('/foods/list?dataType=SR    Legacy');
        });
    });

    /**
     * The builder does NOT filter an `api_key` param — it normalises `query`
     * and passes every other entry through — so "no credential in a primary
     * key" is a call-site contract rather than something the builder enforces.
     * Both halves of that contract are asserted instead of the filtering the
     * builder does not do: the key is a pure function of its two arguments, and
     * no shipped call site puts the credential in `params` (`fetchFromUsda`
     * appends it to the query string after the key exists).
     */
    describe('the credential and the key', () => {
        it('reads no environment, so a key rotation cannot change a key', () => {
            process.env.USDA_API_KEY = API_KEY;
            const beforeRotation = cacheKeyFor('/foods/search', { query: 'egg', pageSize: '6' });

            process.env.USDA_API_KEY = ROTATED_API_KEY;
            const afterRotation = cacheKeyFor('/foods/search', { query: 'egg', pageSize: '6' });

            delete process.env.USDA_API_KEY;

            expect(afterRotation).toBe(beforeRotation);
            expect(cacheKeyFor('/foods/search', { query: 'egg', pageSize: '6' })).toBe(beforeRotation);
        });

        it('is never handed the credential by a shipped call site', async () => {
            // `getFoodDetail` reuses `getBrandedFood`'s key for the same id, so
            // it is a cache hit here and consumes no queued response.
            respondWith(
                jsonResponse(searchSample('genericFoundationComplete').payload),
                jsonResponse(searchSample('brandedComplete').payload),
                jsonResponse(detailSample('brandedDetailComplete').payload),
                jsonResponse([portionSample('srLegacyPortions').payload]),
            );

            await searchGenericFoods('egg');
            await searchBrandedFoods('yogurt');
            await getBrandedFood('9000301');
            await getFoodDetail(9000301);
            await listFoods('SR Legacy');

            const keys = [...readKeys(), ...writtenKeys()];

            expect(keys.length).toBeGreaterThan(0);
            for (const key of keys) {
                expect(key).not.toContain('api_key');
                expect(key).not.toContain(API_KEY);
            }
        });
    });
});

describe('cacheKeyForRequest', () => {
    const SEARCH_PARAMS = { query: '  Chicken   Breast ', dataType: 'Survey (FNDDS)', pageSize: '6' };

    describe('a GET without a body', () => {
        it('returns exactly the cacheKeyFor string, so deployed rows stay reachable', () => {
            expect(cacheKeyForRequest('GET', '/foods/search', SEARCH_PARAMS)).toBe(
                cacheKeyFor('/foods/search', SEARCH_PARAMS),
            );
            expect(cacheKeyForRequest('GET', '/foods/search', SEARCH_PARAMS)).toBe(
                '/foods/search?dataType=Survey (FNDDS)&pageSize=6&query=chicken breast',
            );
        });

        it('carries no method prefix, so no key begins with a verb', () => {
            expect(cacheKeyForRequest('GET', '/foods/list', { dataType: 'Branded' }).startsWith('/foods/list')).toBe(
                true,
            );
        });

        it('normalises the method name and surrounding whitespace', () => {
            expect(cacheKeyForRequest('  get  ', '/foods/search', SEARCH_PARAMS)).toBe(
                cacheKeyFor('/foods/search', SEARCH_PARAMS),
            );
        });

        it('adds a discriminator as soon as a body is present, even on a GET', () => {
            expect(cacheKeyForRequest('GET', '/foods', {}, { fdcIds: [9000101] })).toBe(
                'GET /foods?#{"fdcIds":[9000101]}',
            );
        });
    });

    describe('a batch POST body', () => {
        const BATCH_PATH = '/foods';
        const batchKey = (body: unknown): string => cacheKeyForRequest('POST', BATCH_PATH, {}, body);

        it('does not depend on the order of the fdc ids', () => {
            expect(batchKey({ fdcIds: [9000302, 9000301], format: 'full' })).toBe(
                batchKey({ fdcIds: [9000301, 9000302], format: 'full' }),
            );
        });

        it('collapses duplicate ids', () => {
            expect(batchKey({ fdcIds: [9000301, 9000302, 9000301], format: 'full' })).toBe(
                batchKey({ fdcIds: [9000301, 9000302], format: 'full' }),
            );
        });

        it('keys a string id the same as its number, so a rerun reuses the row', () => {
            expect(batchKey({ fdcIds: ['9000302', ' 9000301 '], format: 'full' })).toBe(
                batchKey({ fdcIds: [9000301, 9000302], format: 'full' }),
            );
        });

        it('distinguishes id sets that a concatenation would collide on', () => {
            expect(batchKey([1, 23])).toBe('POST /foods?#[1,23]');
            expect(batchKey([12, 3])).toBe('POST /foods?#[3,12]');
            expect(batchKey([1, 23])).not.toBe(batchKey([12, 3]));
        });

        it('never collides with the GET key for the same path and params', () => {
            expect(batchKey({ fdcIds: [9000301], format: 'full' })).not.toBe(
                cacheKeyForRequest('GET', BATCH_PATH, {}),
            );
        });

        it('accepts an empty id list without throwing', () => {
            expect(batchKey({ fdcIds: [], format: 'full' })).toBe('POST /foods?#{"fdcIds":[],"format":"full"}');
            expect(batchKey([])).toBe('POST /foods?#[]');
        });

        it('sorts the body keys, so a reordered body is the same request', () => {
            expect(batchKey({ format: 'full', fdcIds: [9000301] })).toBe(
                batchKey({ fdcIds: [9000301], format: 'full' }),
            );
        });

        it('sorts nested object keys too', () => {
            expect(batchKey({ nested: { zeta: 1, alpha: 2 } })).toBe('POST /foods?#{"nested":{"alpha":2,"zeta":1}}');
        });

        it('represents an absent body and a null body identically, as no body', () => {
            expect(batchKey(undefined)).toBe('POST /foods?#null');
            expect(batchKey(null)).toBe('POST /foods?#null');
        });

        it('represents an undefined member as null rather than dropping the key', () => {
            expect(batchKey({ format: undefined })).toBe('POST /foods?#{"format":null}');
        });

        it('canonicalises a body that is not an fdc id list', () => {
            expect(batchKey({ format: 'full' })).toBe('POST /foods?#{"format":"full"}');
            expect(batchKey('plain')).toBe('POST /foods?#"plain"');
            expect(batchKey(7)).toBe('POST /foods?#7');
        });

        it('rejects a top-level array body holding something that is not an fdc id', () => {
            const error = vendorFailureSync(() => batchKey(['not-an-id']));

            expect(error.message).toBe(invalidFdcIdMessage('not-an-id'));
        });

        it('rejects an fdcIds member holding something that is not an fdc id', () => {
            const error = vendorFailureSync(() => batchKey({ fdcIds: [9000301, 0], format: 'full' }));

            expect(error.message).toBe(invalidFdcIdMessage('0'));
        });

        it('emits a deterministic, unhashed key for a full batch', () => {
            const ids = Array.from({ length: MAX_BATCH_FDC_IDS }, (_unused, index) => 9000101 + index);

            const key = batchKey({ fdcIds: ids, format: 'full' });

            expect(key).toBe(
                'POST /foods?#{"fdcIds":[9000101,9000102,9000103,9000104,9000105,9000106,9000107,9000108,9000109,' +
                    '9000110,9000111,9000112,9000113,9000114,9000115,9000116,9000117,9000118,9000119,9000120],' +
                    '"format":"full"}',
            );
            // `usda_api_cache.cache_key` is a Postgres `text` primary key, so
            // the guarantee is not a hash but that the largest batch USDA
            // accepts still produces a short, readable, reproducible key.
            expect(key.length).toBeLessThanOrEqual(256);
            expect(batchKey({ fdcIds: ids, format: 'full' })).toBe(key);
        });
    });
});

describe('normalizeFdcIds', () => {
    it('returns the ids in ascending numeric order', () => {
        expect(normalizeFdcIds([9000103, 9000101, 9000102])).toEqual([9000101, 9000102, 9000103]);
    });

    it('removes duplicates across the string and number forms', () => {
        expect(normalizeFdcIds(['9000101', 9000101, ' 9000101 '])).toEqual([9000101]);
    });

    it('returns an empty array for an empty list', () => {
        expect(normalizeFdcIds([])).toEqual([]);
    });

    it('accepts a decimal string, including one with surrounding whitespace', () => {
        expect(normalizeFdcIds([' 171077 '])).toEqual([171077]);
    });

    /**
     * The parser itself now lives in the pure catalog decision layer and this
     * module imports it, because `usda_api_cache.cache_key` and
     * `catalog_foods.source_key` are two views of ONE identity: the catalog keys
     * every imported row on `usda:<fdcId>`. Two parsers that differed by a
     * single accepted form would fetch one food and file it under another, so
     * the agreement is asserted here from the vendor boundary's side as well as
     * in `catalog.logic.test.ts`.
     */
    describe('parity with the canonical parser the catalog keys its rows on', () => {
        const PARITY_CASES: Array<[string, unknown]> = [
            ['a positive integer', 171077],
            ['the canonical decimal string', '171077'],
            ['a decimal string with surrounding whitespace', '  171077  '],
            ['the largest safe integer', Number.MAX_SAFE_INTEGER],
            ['zero', 0],
            ['a negative number', -1],
            ['a fraction', 1.5],
            ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
            ['NaN', Number.NaN],
            ['Infinity', Number.POSITIVE_INFINITY],
            ['the string zero', '0'],
            ['a leading zero', '007'],
            ['hexadecimal notation', '0x10'],
            ['exponent notation', '1e3'],
            ['a decimal point', '1.5'],
            ['an explicit sign', '+1'],
            ['an empty string', ''],
            ['whitespace only', '   '],
            ['a value past the safe integer range', '9007199254740993'],
            ['null', null],
            ['undefined', undefined],
            ['a nested array that stringifies to a number', [1]],
            ['an object', {}],
            ['a boolean', true],
        ];

        it.each(PARITY_CASES)('reaches the same verdict as the catalog parser for %s', (_label, value) => {
            const canonical = parseCanonicalFdcId(value);

            if (canonical === null) {
                expect(vendorFailureSync(() => normalizeFdcIds([value as string | number])).message).toBe(
                    invalidFdcIdMessage(String(value)),
                );
                return;
            }

            expect(normalizeFdcIds([value as string | number])).toEqual([canonical]);
        });

        it('keeps the vendor boundary error posture, not the catalog one', () => {
            const error = vendorFailureSync(() => normalizeFdcIds(['0x10']));

            expect(error).toBeInstanceOf(UsdaError);
            expect(error.name).toBe('UsdaError');
        });
    });

    describe('a value that is not a canonical positive integer', () => {
        const NON_CANONICAL: Array<[string, unknown]> = [
            ['zero', 0],
            ['a negative number', -1],
            ['a fraction', 1.5],
            ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
            ['NaN', Number.NaN],
            ['Infinity', Number.POSITIVE_INFINITY],
            ['the string zero', '0'],
            ['a leading zero', '007'],
            ['hexadecimal notation', '0x10'],
            ['exponent notation', '1e3'],
            ['a decimal point', '1.5'],
            ['an explicit sign', '+1'],
            ['an empty string', ''],
            ['whitespace only', '   '],
            ['a value past the safe integer range', '9007199254740993'],
            ['null', null],
            ['undefined', undefined],
            ['a nested array that stringifies to a number', [1]],
            ['an object', {}],
            ['a boolean', true],
        ];

        it.each(NON_CANONICAL)('rejects %s', (_label, value) => {
            const error = vendorFailureSync(() => normalizeFdcIds([value as string | number]));

            expect(error.message).toBe(invalidFdcIdMessage(String(value)));
        });
    });
});


/**
 * `fetchFromUsda`, `usdaGet` and `usdaPost` are private, so each is driven
 * through the exported function that reaches it.
 */
describe('fetchFromUsda', () => {
    const listKey = (dataType: string): string =>
        cacheKeyFor('/foods/list', { dataType, pageSize: String(MAX_LIST_PAGE_SIZE), pageNumber: '1' });

    const listPayload = (): unknown[] => [portionSample('srLegacyPortions').payload];

    describe('query-string construction', () => {
        it('encodes a space as %20 and leaves the parentheses literal', async () => {
            respondWith(jsonResponse([portionSample('fnddsPortions').payload]));

            await listFoods('Survey (FNDDS)');

            expect(sentRequest().url).toBe(
                'https://api.nal.usda.gov/fdc/v1/foods/list' +
                    '?dataType=Survey%20(FNDDS)&pageSize=200&pageNumber=1&api_key=test-usda-key',
            );
        });

        it('appends api_key as the last parameter', async () => {
            respondWith(jsonResponse(listPayload()));

            await listFoods('Branded');

            expect(sentRequest().url.endsWith(`&api_key=${API_KEY}`)).toBe(true);
        });

        it('uses the documented base URL when USDA_BASE_URL is unset', async () => {
            respondWith(jsonResponse(listPayload()));

            await listFoods('Branded');

            expect(sentRequest().url.startsWith(`${DEFAULT_BASE_URL}/foods/list?`)).toBe(true);
        });

        it('uses USDA_BASE_URL when it is set', async () => {
            process.env.USDA_BASE_URL = OVERRIDE_BASE_URL;
            respondWith(jsonResponse(listPayload()));

            await listFoods('Branded');

            expect(sentRequest().url).toBe(
                `${OVERRIDE_BASE_URL}/foods/list?dataType=Branded&pageSize=200&pageNumber=1&api_key=${API_KEY}`,
            );
        });

        it('sends a GET whose init carries the abort signal and nothing else', async () => {
            respondWith(jsonResponse(listPayload()));

            await listFoods('Branded');

            expectSignalOnlyGet(sentRequest());
        });

        it('sends the search query verbatim even though the cache key normalises it', async () => {
            respondWith(jsonResponse(searchSample('genericFoundationComplete').payload));

            await searchGenericFoods('  Chicken   Breast ');

            expect(sentRequest().url).toBe(
                'https://api.nal.usda.gov/fdc/v1/foods/search' +
                    '?query=%20%20Chicken%20%20%20Breast%20' +
                    '&dataType=Survey%20(FNDDS)%2CSR%20Legacy%2CFoundation' +
                    `&pageSize=6&pageNumber=1&api_key=${API_KEY}`,
            );
            expect(readKeys()).toEqual([
                '/foods/search?dataType=Survey (FNDDS),SR Legacy,Foundation&pageNumber=1&pageSize=6&query=chicken breast',
            ]);
        });
    });

    describe('the loud accessor', () => {
        it('throws UsdaError without issuing a request when the key is absent', async () => {
            delete process.env.USDA_API_KEY;

            const error = await vendorFailure(listFoods('Branded'));

            expect(error.message).toBe(NOT_CONFIGURED_MESSAGE);
            expect(requestCount()).toBe(0);
        });

        it('throws without issuing a request when the key is an empty string', async () => {
            process.env.USDA_API_KEY = '';

            const error = await vendorFailure(searchBrandedFoods('yogurt'));

            expect(error.message).toBe(NOT_CONFIGURED_MESSAGE);
            expect(requestCount()).toBe(0);
        });

        it('does not need a key to serve a cached row, because the cache is read first', async () => {
            seedRow(listKey('Branded'), listPayload(), DAY_MS);
            delete process.env.USDA_API_KEY;

            await expect(listFoods('Branded')).resolves.toHaveLength(1);
            expect(requestCount()).toBe(0);
        });
    });

    describe('retries', () => {
        it.each([429, 500, 503])('makes four attempts for a persistent %i and reports the status', async (status) => {
            alwaysRespond(() => failureResponse(status));

            const error = await exhaustAttempts(listFoods('Branded'));

            expect(error.message).toBe(statusMessage(status));
            expect(requestCount()).toBe(MAX_ATTEMPTS);
        });

        /**
         * Deliberate, and not a bug to "fix": USDA intermittently answers 400
         * to a request that succeeds when retried verbatim, so this boundary
         * retries 400 alongside 429 and 5xx. Making 400 terminal would change
         * live behaviour on `GET /api/macros/search-branded-foods`.
         */
        it('makes four attempts for a persistent 400 as well', async () => {
            alwaysRespond(() => failureResponse(400));

            const error = await exhaustAttempts(searchBrandedFoods('yogurt'));

            expect(error.message).toBe(statusMessage(400));
            expect(requestCount()).toBe(MAX_ATTEMPTS);
        });

        it('waits 250 ms, then 500 ms, then 750 ms, and not a millisecond less', async () => {
            alwaysRespond(() => failureResponse(429));

            const settled = rejectionOf(listFoods('Branded'));
            await jest.advanceTimersByTimeAsync(0);

            expect(requestCount()).toBe(1);

            for (const [index, delay] of BACKOFF_SEQUENCE_MS.entries()) {
                await jest.advanceTimersByTimeAsync(delay - 1);
                expect(requestCount()).toBe(index + 1);

                await jest.advanceTimersByTimeAsync(1);
                expect(requestCount()).toBe(index + 2);
            }

            expect(asUsdaError(await settled).message).toBe(statusMessage(429));
            expect(requestCount()).toBe(MAX_ATTEMPTS);
        });

        it('returns on the second attempt and issues exactly two requests', async () => {
            respondWith(failureResponse(500), jsonResponse(listPayload()));

            const call = listFoods('Branded');
            await jest.advanceTimersByTimeAsync(BACKOFF_SEQUENCE_MS[0]);

            await expect(call).resolves.toHaveLength(1);
            expect(requestCount()).toBe(2);
        });

        it('retries a thrown network error and reports its message', async () => {
            rejectWith(new TypeError('fetch failed'));

            const error = await exhaustAttempts(listFoods('Branded'));

            expect(error.message).toBe(vendorFailureMessage('fetch failed'));
            expect(requestCount()).toBe(MAX_ATTEMPTS);
        });

        it('retries a 200 whose body is not JSON, and reports it as a request failure', async () => {
            alwaysRespond(() => new Response('<html>gateway</html>', { status: 200 }));

            const error = await exhaustAttempts(listFoods('Branded'));

            expect(error.message.startsWith(`${PLACEHOLDER_MESSAGE}: `)).toBe(true);
            expect(requestCount()).toBe(MAX_ATTEMPTS);
        });

        /**
         * `lastError` is seeded with the bare message and overwritten in both
         * branches of every attempt, so it is unreachable while `MAX_ATTEMPTS`
         * is above zero. The assertion is therefore a negative one.
         */
        it('never surfaces the bare placeholder message', async () => {
            alwaysRespond(() => failureResponse(500));
            expect((await exhaustAttempts(listFoods('Branded'))).message).not.toBe(PLACEHOLDER_MESSAGE);

            rejectWith(new TypeError('fetch failed'));
            expect((await exhaustAttempts(listFoods('Foundation'))).message).not.toBe(PLACEHOLDER_MESSAGE);
        });

        it('caches nothing when every attempt fails', async () => {
            alwaysRespond(() => failureResponse(429));

            await exhaustAttempts(listFoods('Branded'));

            expect(writtenKeys()).toEqual([]);
            expect(rows.size).toBe(0);
        });
    });

    /**
     * Which statuses earn a second request, and which end the call.
     *
     * The boundary retries what a retry can change — `400` (USDA's documented
     * intermittent rejection of a valid request), `408`, `429` and every 5xx —
     * and stops on what it cannot. A definitive `401`, `403` or `404` answered
     * four times is the same answer four times: three of the hour's 900 import
     * requests spent on it, three backoffs of latency added before the operator
     * learns the key is wrong, and on the request path three more seconds of a
     * client's deadline burned.
     */
    describe('the retryable-status classification', () => {
        it.each([400, 408, 429, 500, 502, 503, 504])('retries %i', (status) => {
            expect(isRetryableUsdaStatus(status)).toBe(true);
        });

        it.each([401, 403, 404, 405, 410, 413, 415, 422, 451])('does not retry %i', (status) => {
            expect(isRetryableUsdaStatus(status)).toBe(false);
        });

        it.each([401, 403, 404])(
            'issues exactly one request for a definitive %i and reports the status',
            async (status) => {
                alwaysRespond(() => failureResponse(status));

                // No timer is advanced: a terminal status must reject without
                // waiting out a backoff that is never going to be served.
                const error = await vendorFailure(searchBrandedFoods('yogurt'));

                expect(error.message).toBe(statusMessage(status));
                expect(requestCount()).toBe(1);
            },
        );

        it('charges one rate-limiter token for a definitive 4xx, not four', async () => {
            alwaysRespond(() => failureResponse(403));

            await vendorFailure(listFoods('Branded'));

            expect(requestCount()).toBe(1);
        });

        it('caches nothing when the answer is definitive', async () => {
            alwaysRespond(() => failureResponse(404));

            await vendorFailure(getBrandedFood('9000301'));

            expect(writtenKeys()).toEqual([]);
            expect(rows.size).toBe(0);
        });

        it('leaves a retryable status retried, so a definitive answer is the only thing that stops early', async () => {
            alwaysRespond(() => failureResponse(429));

            await exhaustAttempts(listFoods('Branded'));

            expect(requestCount()).toBe(MAX_ATTEMPTS);
        });
    });

    /**
     * The deadlines.
     *
     * `fetch` has no timeout of its own, so before these existed a stalled DNS
     * lookup, TLS handshake or body read never settled: the request path held
     * an `/api/macros/estimate` call open past the mobile client's own 25 s
     * deadline, and an import stopped making progress without ever failing.
     * Every attempt now runs under an `AbortController`, and — because a
     * per-attempt deadline multiplies by `MAX_ATTEMPTS` — the whole logical
     * call runs under one budget, with each attempt taking whichever is nearer.
     *
     * The two endpoint classes are asserted separately because the numbers are
     * chosen for different readers: a request-path call has a client waiting on
     * it, an import call has an operator who would rather wait than re-run.
     */
    describe('deadlines', () => {
        /**
         * When the call settled, on the fake clock. Captured as the rejection
         * is handled rather than read after the advance, because
         * `advanceTimersByTimeAsync` moves the clock to the end of the window
         * it was given whether or not anything was still waiting.
         */
        const settlementOf = (call: Promise<unknown>): Promise<{ error: unknown; elapsedMs: number }> =>
            rejectionOf(call).then((error) => ({ error, elapsedMs: Date.now() - FIXED_NOW }));

        it('aborts a stalled request-path attempt at its deadline and says it timed out', async () => {
            neverAnswers();

            const settled = settlementOf(searchBrandedFoods('yogurt'));
            await jest.advanceTimersByTimeAsync(REQUEST_ATTEMPT_TIMEOUT_MS);

            // The attempt is over; the call itself keeps going into its retry.
            expect(sentRequest().signal?.aborted).toBe(true);

            await jest.advanceTimersByTimeAsync(USDA_REQUEST_CALL_BUDGET_MS);
            const error = asUsdaError((await settled).error);

            expect(error.message.startsWith('USDA request timed out after ')).toBe(true);
        });

        it('does not abort one millisecond before the attempt deadline', async () => {
            neverAnswers();

            const settled = rejectionOf(searchBrandedFoods('yogurt'));
            await jest.advanceTimersByTimeAsync(REQUEST_ATTEMPT_TIMEOUT_MS - 1);

            expect(sentRequest().signal?.aborted).toBe(false);
            expect(requestCount()).toBe(1);

            await jest.advanceTimersByTimeAsync(USDA_REQUEST_CALL_BUDGET_MS);
            await settled;
            expect(sentRequest().signal?.aborted).toBe(true);
        });

        /**
         * A timeout is a transient failure, so it is retried like a 429 — the
         * deadline bounds the wait, it does not give up on the call.
         */
        it('retries after a timed-out attempt and resolves when the next one answers', async () => {
            const envelope = searchSample('brandedComplete');
            stallThenRespond(envelope.payload);

            const call = searchBrandedFoods('yogurt');
            await jest.advanceTimersByTimeAsync(REQUEST_ATTEMPT_TIMEOUT_MS + BACKOFF_SEQUENCE_MS[0]);

            await expect(call).resolves.toEqual([envelope.expectedBrandedFood]);
            expect(requestCount()).toBe(2);
        });

        /**
         * Four attempts of 3 s plus 1.5 s of backoff would be a 13.5 s call on
         * a path whose whole slice of the request is 6 s, so the budget — not
         * the attempt count — is what ends a stalled request-path call, and it
         * ends it at exactly the budget.
         */
        it('stops a stalled request-path call at the call budget, short of four attempts', async () => {
            neverAnswers();

            const settled = rejectionOf(searchBrandedFoods('yogurt'));
            await jest.advanceTimersByTimeAsync(USDA_REQUEST_CALL_BUDGET_MS);

            const error = asUsdaError(await settled);

            // Attempt 1 runs 0 → 3,000 and attempt 2 is handed the 2,750 ms
            // left after the first backoff, which is why the reported deadline
            // is the shortened one.
            expect(error.message).toBe(timedOutMessage(USDA_REQUEST_CALL_BUDGET_MS - REQUEST_ATTEMPT_TIMEOUT_MS - BACKOFF_SEQUENCE_MS[0]));
            expect(requestCount()).toBe(2);
        });

        /**
         * The property `estimate.service.ts` reserves against: one
         * request-path call cannot outlast `USDA_REQUEST_CALL_BUDGET_MS`, so
         * the grounding slice of an estimate request is a known quantity
         * rather than an open-ended wait.
         */
        it('settles a wholly unresponsive request-path call within the budget', async () => {
            neverAnswers();

            const settled = settlementOf(searchBrandedFoods('yogurt'));
            await jest.advanceTimersByTimeAsync(USDA_REQUEST_CALL_BUDGET_MS * 10);

            expect((await settled).elapsedMs).toBeLessThanOrEqual(USDA_REQUEST_CALL_BUDGET_MS);
        });

        it('gives an import attempt the longer deadline, so a large batch response is not cut off', async () => {
            neverAnswers();

            const settled = rejectionOf(getFoodsBatch([9000301]));
            await jest.advanceTimersByTimeAsync(REQUEST_ATTEMPT_TIMEOUT_MS);

            expect(sentRequest().signal?.aborted).toBe(false);

            await jest.advanceTimersByTimeAsync(IMPORT_ATTEMPT_TIMEOUT_MS - REQUEST_ATTEMPT_TIMEOUT_MS);
            expect(sentRequest().signal?.aborted).toBe(true);

            await jest.advanceTimersByTimeAsync(IMPORT_CALL_BUDGET_MS);
            expect(asUsdaError(await settled).name).toBe('UsdaError');
        });

        it('still makes all four attempts on an import path, inside its own budget', async () => {
            neverAnswers();

            const settled = settlementOf(listFoods('Branded'));
            await jest.advanceTimersByTimeAsync(IMPORT_CALL_BUDGET_MS * 2);

            // The import budget is wide enough that MAX_ATTEMPTS, not the
            // budget, is what ends the call — which is the attempt count
            // `scripts/lib/rateLimiter.ts` charges tokens against.
            expect(requestCount()).toBe(MAX_ATTEMPTS);
            expect((await settled).elapsedMs).toBeLessThanOrEqual(IMPORT_CALL_BUDGET_MS);
        });

        it('clears the attempt timer once the request answers, leaving nothing pending', async () => {
            respondWith(jsonResponse([portionSample('srLegacyPortions').payload]));

            await listFoods('Branded');

            // An un-cleared abort timer would hold the event loop open for the
            // rest of its delay after the call has already returned.
            expect(jest.getTimerCount()).toBe(0);
        });

        it('clears the attempt timer when the request fails', async () => {
            alwaysRespond(() => failureResponse(403));

            await vendorFailure(listFoods('Branded'));

            expect(jest.getTimerCount()).toBe(0);
        });

        /**
         * `scripts/catalog-import-usda.ts` reports a vendor failure under its
         * own operator code (`usda_request_failed`) and narrows on
         * `error.name`, not `instanceof`: importing this module's value side at
         * script load would construct a Prisma client, which that file
         * deliberately defers to `main()`. The name is therefore a cross-file
         * contract, asserted here across every failure the import path can
         * actually raise.
         */
        it('names a timeout, a definitive status and a transport failure UsdaError alike', async () => {
            neverAnswers();
            const timedOut = rejectionOf(getFoodsBatch([9000301]));
            await jest.advanceTimersByTimeAsync(IMPORT_CALL_BUDGET_MS);
            expect(asUsdaError(await timedOut).name).toBe('UsdaError');

            alwaysRespond(() => failureResponse(403));
            expect((await vendorFailure(listFoods('Branded'))).name).toBe('UsdaError');

            rejectWith(new TypeError('fetch failed'));
            expect((await exhaustAttempts(listFoods('Foundation'))).name).toBe('UsdaError');
        });
    });

    describe('the cache', () => {
        it('serves a cached row whatever its age', async () => {
            const key = listKey('Branded');
            seedRow(key, listPayload(), 5 * 365 * DAY_MS);
            respondWith(jsonResponse([portionSample('fnddsPortions').payload]));

            const records = await listFoods('Branded');

            expect(records.map((record) => record.fdcId)).toEqual([fdcIdOf(portionSample('srLegacyPortions'))]);
            expect(readKeys()).toEqual([key]);
        });

        it('writes a freshly fetched payload under the key it read', async () => {
            respondWith(jsonResponse(listPayload()));

            await listFoods('Branded');
            await jest.advanceTimersByTimeAsync(0);

            expect(writtenKeys()).toEqual(readKeys());
            expect(storedRow(listKey('Branded')).fetched_at.getTime()).toBe(FIXED_NOW);
        });

        it('refreshes a row past its TTL off the request path and writes it back', async () => {
            const key = listKey('Branded');
            seedRow(key, listPayload(), SEARCH_TTL_MS + DAY_MS);
            respondWith(jsonResponse([portionSample('fnddsPortions').payload]));

            await listFoods('Branded');

            expect(requestCount()).toBe(1);

            await jest.advanceTimersByTimeAsync(0);

            expect(writtenKeys()).toEqual([key]);
            expect(storedRow(key).fetched_at.getTime()).toBe(FIXED_NOW);
            expect((storedRow(key).payload as Array<{ fdcId: number }>).map((record) => record.fdcId)).toEqual([
                fdcIdOf(portionSample('fnddsPortions')),
            ]);
        });

        it('issues one refresh for two rapid calls on the same key', async () => {
            const key = listKey('Branded');
            seedRow(key, listPayload(), SEARCH_TTL_MS + DAY_MS);
            const deferred = respondWhenSettled([portionSample('fnddsPortions').payload]);

            await listFoods('Branded');
            await listFoods('Branded');

            expect(deferred.stub).toHaveBeenCalledTimes(1);

            deferred.settle();
            await jest.advanceTimersByTimeAsync(0);
        });

        it('refreshes again once the in-flight refresh has released the key', async () => {
            const key = listKey('Branded');
            seedRow(key, listPayload(), SEARCH_TTL_MS + DAY_MS);
            const deferred = respondWhenSettled([portionSample('fnddsPortions').payload]);

            await listFoods('Branded');
            deferred.settle();
            await jest.advanceTimersByTimeAsync(0);

            seedRow(key, listPayload(), SEARCH_TTL_MS + DAY_MS);
            await listFoods('Branded');

            expect(deferred.stub).toHaveBeenCalledTimes(2);
        });

        it('keeps serving the stale row when the refresh itself fails', async () => {
            const key = listKey('Branded');
            seedRow(key, listPayload(), SEARCH_TTL_MS + DAY_MS);
            alwaysRespond(() => failureResponse(503));

            const records = await listFoods('Branded');
            await jest.advanceTimersByTimeAsync(TOTAL_BACKOFF_MS);

            expect(records).toHaveLength(1);
            expect(writtenKeys()).toEqual([]);
            expect(storedRow(key).fetched_at.getTime()).toBe(FIXED_NOW - (SEARCH_TTL_MS + DAY_MS));
        });

        it('falls through to a live fetch when findUnique rejects', async () => {
            cache.findUnique.mockRejectedValueOnce(new Error('connection terminated'));
            respondWith(jsonResponse(listPayload()));

            await expect(listFoods('Branded')).resolves.toHaveLength(1);
            expect(requestCount()).toBe(1);
        });

        it('resolves normally when upsert rejects', async () => {
            cache.upsert.mockRejectedValue(new Error('read-only transaction'));
            respondWith(jsonResponse(listPayload()));

            await expect(listFoods('Branded')).resolves.toHaveLength(1);
            await jest.advanceTimersByTimeAsync(0);
        });
    });

    describe('the TTL a path resolves to', () => {
        it('gives /food/{id} ninety days, refreshing only past the boundary', async () => {
            const key = cacheKeyFor('/food/9000301', { format: 'full' });
            const payload = detailSample('brandedDetailComplete').payload;

            seedRow(key, payload, DETAIL_TTL_MS);
            await getFoodDetail(9000301);

            expect(requestCount()).toBe(0);

            seedRow(key, payload, DETAIL_TTL_MS + 1);
            respondWith(jsonResponse(payload));
            await getFoodDetail(9000301);

            expect(requestCount()).toBe(1);
        });

        it('gives /foods/list thirty days, refreshing only past the boundary', async () => {
            const key = listKey('Branded');

            seedRow(key, listPayload(), SEARCH_TTL_MS);
            await listFoods('Branded');

            expect(requestCount()).toBe(0);

            seedRow(key, listPayload(), SEARCH_TTL_MS + 1);
            respondWith(jsonResponse(listPayload()));
            await listFoods('Branded');

            expect(requestCount()).toBe(1);
        });

        it('splits on the singular /food/ prefix, so /foods/list is not a detail path', async () => {
            const detailKey = cacheKeyFor('/food/9000301', { format: 'full' });
            // Thirty-one days: past the search TTL, comfortably inside the
            // detail one, so exactly one of the two rows may refresh.
            const age = SEARCH_TTL_MS + DAY_MS;

            seedRow(detailKey, detailSample('brandedDetailComplete').payload, age);
            seedRow(listKey('Branded'), listPayload(), age);
            respondWith(jsonResponse(listPayload()));

            await getFoodDetail(9000301);
            await listFoods('Branded');

            expect(requestCount()).toBe(1);
            expect(sentRequest().url).toContain('/foods/list?');
        });

        /**
         * The batch POST reads and writes the same table through
         * `cacheKeyForRequest` but has no background-refresh path at all, so
         * `ttlForPath` never applies to it: a stale batch row is served and
         * left alone rather than refreshed at the caller's rate-limit expense.
         */
        it('never background-refreshes the batch path, whatever the age of the row', async () => {
            const key = cacheKeyForRequest('POST', '/foods', {}, { fdcIds: [9000301], format: 'full' });
            seedRow(key, [detailSample('brandedDetailComplete').payload], 5 * 365 * DAY_MS);

            const records = await getFoodsBatch([9000301]);

            expect(records).toHaveLength(1);
            expect(requestCount()).toBe(0);
            expect(writtenKeys()).toEqual([]);
        });
    });
});


describe('the new fetchers', () => {
    const fetchDetailFrom = async (envelope: SampleEnvelope): Promise<UsdaFoodDetail> => {
        respondWith(jsonResponse(envelope.payload));

        return getFoodDetail(fdcIdOf(envelope));
    };

    /** Reads the detail-response nutrient shape: `nutrient.number` + `amount`. */
    const detailAmount = (detail: UsdaFoodDetail, nutrientNumber: string): number | undefined =>
        (detail.foodNutrients ?? []).find((nutrient) => String(nutrient.nutrient?.number) === nutrientNumber)?.amount;

    describe('getFoodDetail', () => {
        it('requests the detail path with format=full', async () => {
            await fetchDetailFrom(detailSample('brandedDetailComplete'));

            const request = sentRequest();

            expect(request.url).toBe(`${DEFAULT_BASE_URL}/food/9000301?format=full&api_key=${API_KEY}`);
            expectSignalOnlyGet(request);
        });

        it('accepts a string id and needs no path escaping, the id being a proven integer', async () => {
            respondWith(jsonResponse(detailSample('brandedDetailComplete').payload));

            await getFoodDetail('9000301');

            expect(sentRequest().url).toBe(`${DEFAULT_BASE_URL}/food/9000301?format=full&api_key=${API_KEY}`);
        });

        it('rejects an id that is not a canonical positive integer before requesting anything', async () => {
            const error = await vendorFailure(getFoodDetail('0x10'));

            expect(error.message).toBe(invalidFdcIdMessage('0x10'));
            expect(requestCount()).toBe(0);
        });

        it('returns the record with its fdcId normalised to a number', async () => {
            respondWith(jsonResponse({ fdcId: '9000301', description: 'Fixture granola bar, almond' }));

            const detail = await getFoodDetail(9000301);

            expect(detail.fdcId).toBe(9000301);
            expect(typeof detail.fdcId).toBe('number');
        });

        it('returns the full record rather than the BrandedFoodResponse projection', async () => {
            const detail = await fetchDetailFrom(detailSample('brandedDetailComplete'));

            expect(detail.description).toBe('Fixture granola bar, almond');
            expect(detail.servingSize).toBe(60);
            expect(detail.labelNutrients?.calories?.value).toBe(230);
        });

        it('shares its cache key with getBrandedFood for the same id', async () => {
            respondWith(jsonResponse(detailSample('brandedDetailComplete').payload));

            await getBrandedFood('9000301');
            await getFoodDetail(9000301);

            expect(readKeys()).toEqual(['/food/9000301?format=full', '/food/9000301?format=full']);
            expect(requestCount()).toBe(1);
        });

        it('throws when the response describes a different food', async () => {
            respondWith(jsonResponse(detailSample('detailMissingCaloriesFallback').payload));

            const error = await vendorFailure(getFoodDetail(9000301));

            expect(error.message).toBe(detailIdentityMessage(9000301, 9000302));
        });

        it('throws when the payload is not an object', async () => {
            respondWith(jsonResponse([detailSample('brandedDetailComplete').payload]));

            const error = await vendorFailure(getFoodDetail(9000301));

            expect(error.message).toBe(notAnObjectMessage('detail for FDC id 9000301'));
        });

        it('throws when the payload carries no usable fdcId', async () => {
            respondWith(jsonResponse(detailSample('detailMissingFdcIdReturnsNull').payload));

            const error = await vendorFailure(getFoodDetail(9000301));

            expect(error.message).toBe(invalidRecordIdMessage('detail for FDC id 9000301', 'undefined'));
        });

        /**
         * `usdaGet` caches before the identity check runs, so an unusable
         * payload occupies its row until the 90-day detail TTL expires and
         * every repeat call re-throws from the cache without a new request.
         * Pinned as observed behaviour: the boundary trades a poisoned row for
         * never spending a rate-limited request on a known-bad id.
         */
        it('caches an unusable payload, so a repeat call re-throws without a new request', async () => {
            respondWith(jsonResponse(detailSample('detailMissingFdcIdReturnsNull').payload));

            await vendorFailure(getFoodDetail(9000301));
            const repeated = await vendorFailure(getFoodDetail(9000301));

            expect(repeated.message).toBe(invalidRecordIdMessage('detail for FDC id 9000301', 'undefined'));
            expect(requestCount()).toBe(1);
        });

        describe('the payload the catalog import reads', () => {
            it('carries per-100 g nutrients in the detail shape, by nutrient.number and amount', async () => {
                const detail = await fetchDetailFrom(detailSample('genericDetailWithoutLabelNutrientsReturnsNull'));

                expect(detailAmount(detail, '203')).toBe(3.1);
                expect(detailAmount(detail, '204')).toBe(0.3);
                expect(detailAmount(detail, '205')).toBe(3.3);
                expect(detailAmount(detail, '208')).toBe(22);
            });

            it('keeps a nutrient label-group row that has no amount rather than dropping it', async () => {
                const detail = await fetchDetailFrom(detailSample('genericDetailWithoutLabelNutrientsReturnsNull'));

                expect(detailAmount(detail, '951')).toBeUndefined();
                expect(detail.foodNutrients).toHaveLength(5);
            });

            it('carries no labelNutrients for a generic record, which is why getBrandedFood returns null', async () => {
                const envelope = detailSample('genericDetailWithoutLabelNutrientsReturnsNull');
                respondWith(jsonResponse(envelope.payload));

                const detail = await getFoodDetail(fdcIdOf(envelope));

                expect(detail.labelNutrients).toBeUndefined();
                await expect(getBrandedFood('9000312')).resolves.toBeNull();
            });
        });

        describe('foodPortions, whose gram weights the planner depends on', () => {
            it('carries a Survey (FNDDS) portion with its label in portionDescription and no amount', async () => {
                const portions = portionsOf(await fetchDetailFrom(portionSample('fnddsPortions')));

                expect(portions.map((portion) => portion.gramWeight)).toEqual([70, 10, 45]);
                expect(portions[0].portionDescription).toBe('1 cup, sliced');
                expect(portions[0].amount).toBeUndefined();
                expect(portions[0].modifier).toBe('10205');
            });

            it('carries an SR Legacy portion with its label in modifier and its count in amount', async () => {
                const portions = portionsOf(await fetchDetailFrom(portionSample('srLegacyPortions')));

                expect(
                    portions.map((portion) => ({
                        amount: portion.amount,
                        modifier: portion.modifier,
                        gramWeight: portion.gramWeight,
                    })),
                ).toEqual([
                    { amount: 1, modifier: 'small', gramWeight: 10 },
                    { amount: 1, modifier: 'cup, pieces or slices', gramWeight: 70 },
                    { amount: 0.5, modifier: 'cup, pieces or slices', gramWeight: 35 },
                ]);
            });

            it('carries a Foundation portion with its unit in measureUnit.name', async () => {
                const portions = portionsOf(await fetchDetailFrom(portionSample('foundationPortions')));

                expect(portions.map((portion) => portion.measureUnit?.name)).toEqual(['cup', 'RACC']);
                expect(portions.map((portion) => portion.gramWeight)).toEqual([76, 85]);
            });

            /**
             * `UsdaFoodPortion.gramWeight` is typed `number` but describes
             * vendor data the boundary does not validate, so the string and the
             * zero arrive as they were sent. That is deliberate: quarantining a
             * candidate is `catalog-validate.ts`'s decision, and inventing a
             * gram weight here would fabricate a number the planner would then
             * treat as sourced.
             */
            it('surfaces an unusable gram weight exactly as it arrived', async () => {
                const portions = portionsOf(await fetchDetailFrom(portionSample('portionsWithoutUsableGramWeight')));

                expect(portions.map((portion): unknown => portion.gramWeight)).toEqual([undefined, 0, 'unknown']);
            });

            it('leaves foodPortions absent when the response carries no such key', async () => {
                const detail = await fetchDetailFrom(portionSample('noFoodPortionsKey'));

                expect(detail.foodPortions).toBeUndefined();
            });

            it('distinguishes an empty portion array from an absent key', async () => {
                const detail = await fetchDetailFrom(portionSample('emptyFoodPortionsArray'));

                expect(detail.foodPortions).toEqual([]);
            });
        });
    });

    describe('getFoodsBatch', () => {
        const BATCH_IDS = [9000302, 9000301];
        const batchResponse = (): Response =>
            jsonResponse([
                detailSample('brandedDetailComplete').payload,
                detailSample('detailMissingCaloriesFallback').payload,
            ]);

        it('posts the sorted ids to the batch path with format=full', async () => {
            respondWith(batchResponse());

            await getFoodsBatch(BATCH_IDS);

            const request = sentRequest();

            expect(request.url).toBe(`${DEFAULT_BASE_URL}/foods?api_key=${API_KEY}`);
            expect(request.argumentCount).toBe(2);
            expect(request.method).toBe('POST');
            expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
            expect(request.body).toEqual({ fdcIds: [9000301, 9000302], format: 'full' });
        });

        it('returns every requested record', async () => {
            respondWith(batchResponse());

            const records = await getFoodsBatch(BATCH_IDS);

            expect(records.map((record) => record.fdcId)).toEqual([9000301, 9000302]);
        });

        it('returns an empty array for an empty id list without issuing a request', async () => {
            await expect(getFoodsBatch([])).resolves.toEqual([]);

            expect(requestCount()).toBe(0);
            expect(cache.findUnique).not.toHaveBeenCalled();
        });

        it('accepts the documented maximum of twenty ids', async () => {
            const ids = Array.from({ length: MAX_BATCH_FDC_IDS }, (_unused, index) => 9000101 + index);
            respondWith(jsonResponse([]));

            await expect(getFoodsBatch(ids)).resolves.toEqual([]);
            expect(sentRequest().body).toEqual({ fdcIds: ids, format: 'full' });
        });

        /**
         * Rejecting rather than truncating or chunking is the point: a silent
         * truncation would make the import's coverage report under-count and
         * the missing ids would never be retried.
         */
        it('rejects twenty-one ids instead of truncating or chunking', async () => {
            const ids = Array.from({ length: MAX_BATCH_FDC_IDS + 1 }, (_unused, index) => 9000101 + index);

            const error = await vendorFailure(getFoodsBatch(ids));

            expect(error.message).toBe(overLengthBatchMessage(MAX_BATCH_FDC_IDS + 1));
            expect(requestCount()).toBe(0);
            expect(cache.findUnique).not.toHaveBeenCalled();
        });

        it('rejects an id that is not a canonical positive integer', async () => {
            const error = await vendorFailure(getFoodsBatch([9000301, '1e3']));

            expect(error.message).toBe(invalidFdcIdMessage('1e3'));
            expect(requestCount()).toBe(0);
        });

        it('caches under a body-aware key no GET could reach', async () => {
            respondWith(batchResponse());

            await getFoodsBatch(BATCH_IDS);
            await jest.advanceTimersByTimeAsync(0);

            const key = 'POST /foods?#{"fdcIds":[9000301,9000302],"format":"full"}';

            expect(readKeys()).toEqual([key]);
            expect(writtenKeys()).toEqual([key]);
        });

        it('serves a repeat batch from the cache however the ids are ordered', async () => {
            respondWith(batchResponse());

            await getFoodsBatch([9000301, 9000302]);
            await jest.advanceTimersByTimeAsync(0);
            const records = await getFoodsBatch([9000302, 9000301, 9000302]);

            expect(records.map((record) => record.fdcId)).toEqual([9000301, 9000302]);
            expect(requestCount()).toBe(1);
        });

        it('accepts an empty array from USDA as a real answer', async () => {
            respondWith(jsonResponse([]));

            await expect(getFoodsBatch(BATCH_IDS)).resolves.toEqual([]);
        });

        it('falls through to a live request when findUnique rejects, as the GET path does', async () => {
            cache.findUnique.mockRejectedValueOnce(new Error('connection terminated'));
            respondWith(batchResponse());

            await expect(getFoodsBatch(BATCH_IDS)).resolves.toHaveLength(2);
            expect(sentRequest().method).toBe('POST');
        });

        it('resolves normally when upsert rejects, as the GET path does', async () => {
            cache.upsert.mockRejectedValue(new Error('read-only transaction'));
            respondWith(batchResponse());

            await expect(getFoodsBatch(BATCH_IDS)).resolves.toHaveLength(2);
            await jest.advanceTimersByTimeAsync(0);
        });

        it('throws when the payload is not an array, rather than degrading to no results', async () => {
            respondWith(jsonResponse(detailSample('brandedDetailComplete').payload));

            const error = await vendorFailure(getFoodsBatch(BATCH_IDS));

            expect(error.message).toBe(notAnArrayMessage('batch'));
        });

        it('throws when a returned record was never requested', async () => {
            respondWith(jsonResponse([detailSample('detailNoServingFieldsServingTextNull').payload]));

            const error = await vendorFailure(getFoodsBatch(BATCH_IDS));

            expect(error.message).toBe(unrequestedIdMessage(9000310));
        });

        it('throws when an element of the array is not an object', async () => {
            respondWith(jsonResponse([9000301]));

            const error = await vendorFailure(getFoodsBatch(BATCH_IDS));

            expect(error.message).toBe(notAnObjectMessage('batch'));
        });
    });

    describe('listFoods', () => {
        const listResponse = (): Response => jsonResponse([portionSample('srLegacyPortions').payload]);

        it('requests the list path with the dataType, page size and page number', async () => {
            respondWith(listResponse());

            await listFoods('SR Legacy', 50, 3);

            expect(sentRequest().url).toBe(
                `${DEFAULT_BASE_URL}/foods/list?dataType=SR%20Legacy&pageSize=50&pageNumber=3&api_key=${API_KEY}`,
            );
        });

        it('defaults to the documented maximum page size and the first page', async () => {
            respondWith(listResponse());

            await listFoods('Branded');

            expect(sentRequest().url).toContain(`pageSize=${MAX_LIST_PAGE_SIZE}&pageNumber=1`);
        });

        it('clamps a page size above the documented maximum instead of letting USDA reject it', async () => {
            respondWith(listResponse());

            await listFoods('Branded', MAX_LIST_PAGE_SIZE + 1);

            expect(sentRequest().url).toContain(`pageSize=${MAX_LIST_PAGE_SIZE}&`);
        });

        it('clamps a page size below one', async () => {
            respondWith(listResponse());

            await listFoods('Branded', 0);

            expect(sentRequest().url).toContain('pageSize=1&');
        });

        it('truncates a fractional page size', async () => {
            respondWith(listResponse());

            await listFoods('Branded', 25.9);

            expect(sentRequest().url).toContain('pageSize=25&');
        });

        it('falls back to the maximum for a non-finite page size', async () => {
            respondWith(listResponse());

            await listFoods('Branded', Number.NaN);

            expect(sentRequest().url).toContain(`pageSize=${MAX_LIST_PAGE_SIZE}&`);
        });

        it('clamps a page number below one and truncates a fractional one', async () => {
            respondWith(listResponse(), listResponse());

            await listFoods('Branded', 200, 0);
            expect(sentRequest(0).url).toContain('pageNumber=1');

            await listFoods('Foundation', 200, 2.7);
            expect(sentRequest(1).url).toContain('pageNumber=2');
        });

        it('falls back to the first page for a non-finite page number', async () => {
            respondWith(listResponse());

            await listFoods('Branded', 200, Number.NaN);

            expect(sentRequest().url).toContain('pageNumber=1');
        });

        it('trims the dataType, so a padded manifest value keys and requests the same', async () => {
            respondWith(listResponse());

            await listFoods('  Branded  ');

            expect(sentRequest().url).toContain('dataType=Branded&');
            expect(readKeys()).toEqual([cacheKeyFor('/foods/list', {
                dataType: 'Branded',
                pageSize: '200',
                pageNumber: '1',
            })]);
        });

        it('is exercised against all four dataType values USDA accepts', () => {
            expect(DATA_TYPES).toEqual(['Foundation', 'SR Legacy', 'Survey (FNDDS)', 'Branded']);
        });

        it.each(DATA_TYPES)('accepts the dataType %s', async (dataType) => {
            respondWith(listResponse());

            await listFoods(dataType);

            expect(sentRequest().url).toBe(
                `${DEFAULT_BASE_URL}/foods/list?dataType=${encodeURIComponent(dataType)}` +
                    `&pageSize=200&pageNumber=1&api_key=${API_KEY}`,
            );
        });

        it('accepts an empty array as a real answer', async () => {
            respondWith(jsonResponse([]));

            await expect(listFoods('Branded')).resolves.toEqual([]);
        });

        it('throws when the payload is not an array', async () => {
            respondWith(jsonResponse({ foods: [] }));

            const error = await vendorFailure(listFoods('Branded'));

            expect(error.message).toBe(notAnArrayMessage('list'));
        });

        it('throws when a record carries no usable fdcId', async () => {
            respondWith(jsonResponse([{ description: 'Fixture vegetable, leafy, raw' }]));

            const error = await vendorFailure(listFoods('Branded'));

            expect(error.message).toBe(invalidRecordIdMessage('list', 'undefined'));
        });

        it('normalises a stringified fdcId to a number', async () => {
            respondWith(jsonResponse([{ fdcId: '9000101', description: 'Fixture vegetable, leafy, raw' }]));

            const [record] = await listFoods('Branded');

            expect(record.fdcId).toBe(9000101);
        });
    });

    describe('clampListPageSize', () => {
        const CASES: Array<[string, number, number]> = [
            ['the documented maximum unchanged', MAX_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE],
            ['one above the maximum down to the maximum', MAX_LIST_PAGE_SIZE + 1, MAX_LIST_PAGE_SIZE],
            ['far above the maximum down to the maximum', 10_000, MAX_LIST_PAGE_SIZE],
            ['the minimum unchanged', 1, 1],
            ['zero up to one', 0, 1],
            ['a negative value up to one', -5, 1],
            ['a fraction above one down to its integer part', 25.9, 25],
            ['a fraction below one up to one', 0.9, 1],
            ['NaN to the maximum', Number.NaN, MAX_LIST_PAGE_SIZE],
            ['Infinity to the maximum', Number.POSITIVE_INFINITY, MAX_LIST_PAGE_SIZE],
        ];

        it.each(CASES)('resolves %s', (_label, pageSize, expected) => {
            expect(clampListPageSize(pageSize)).toBe(expected);
        });
    });
});


/**
 * The three functions that were already in production. Everything asserted
 * here is behaviour the two shipped endpoints depend on, so it must survive the
 * extraction unchanged.
 */
describe('unchanged behaviour', () => {
    const genericKeyFor = (query: string, limit = 6): string =>
        cacheKeyFor('/foods/search', {
            query,
            dataType: 'Survey (FNDDS),SR Legacy,Foundation',
            pageSize: String(limit),
            pageNumber: '1',
        });

    const brandedKeyFor = (query: string): string =>
        cacheKeyFor('/foods/search', { query, dataType: 'Branded', pageSize: '20', pageNumber: '1' });

    const searchGeneric = async (name: string, query = 'fixture'): Promise<GenericFoodCandidate[]> => {
        respondWith(jsonResponse(searchSample(name).payload));

        return searchGenericFoods(query);
    };

    const searchBranded = async (name: string, query = 'fixture'): Promise<BrandedFoodResponse[]> => {
        respondWith(jsonResponse(searchSample(name).payload));

        return searchBrandedFoods(query);
    };

    const fetchBranded = async (name: string, foodId = '9000301'): Promise<BrandedFoodResponse | null> => {
        respondWith(jsonResponse(detailSample(name).payload));

        return getBrandedFood(foodId);
    };

    const expectedResultLengthOf = (name: string): number => {
        const { expectedResultLength } = searchSample(name);
        if (expectedResultLength === undefined) {
            throw new Error(`Fixture sample ${JSON.stringify(name)} declares no expectedResultLength.`);
        }

        return expectedResultLength;
    };

    describe('searchGenericFoods', () => {
        it('requests the three generic data types, the given limit and the first page', async () => {
            respondWith(jsonResponse(searchSample('genericFoundationComplete').payload));

            await searchGenericFoods('leafy greens', 4);

            const request = sentRequest();

            expect(request.url).toBe(
                `${DEFAULT_BASE_URL}/foods/search?query=leafy%20greens` +
                    '&dataType=Survey%20(FNDDS)%2CSR%20Legacy%2CFoundation' +
                    `&pageSize=4&pageNumber=1&api_key=${API_KEY}`,
            );
            expectSignalOnlyGet(request);
        });

        it('defaults the limit to six', async () => {
            respondWith(jsonResponse(searchSample('genericFoundationComplete').payload));

            await searchGenericFoods('leafy greens');

            expect(sentRequest().url).toContain('pageSize=6&');
        });

        it('reads through the legacy cache key, not the method-aware one', async () => {
            await searchGeneric('genericFoundationComplete', 'leafy greens');

            expect(readKeys()).toEqual([genericKeyFor('leafy greens')]);
        });

        it.each(['genericFoundationComplete', 'genericSrLegacyComplete', 'genericSurveyFnddsComplete'])(
            'maps %s to the per-100 g candidate shape',
            async (name) => {
                await expect(searchGeneric(name)).resolves.toEqual([expectedCandidateOf(name)]);
            },
        );

        it('returns the fdcId as a string and does not round the per-100 g values', async () => {
            const [candidate] = await searchGeneric('genericSurveyFnddsComplete');

            expect(candidate.fdcId).toBe('9000103');
            expect(candidate.caloriesPer100g).toBe(275);
            expect(candidate.proteinPer100g).toBe(9.4);
        });

        it('selects nutrients 203, 204, 205 and 208, ignoring the rest of the row', async () => {
            const [candidate] = await searchGeneric('genericFoundationComplete');

            expect(candidate).toEqual({
                fdcId: '9000101',
                description: 'Fixture vegetable, leafy, raw',
                dataType: 'Foundation',
                proteinPer100g: 2.5,
                fatPer100g: 0.4,
                carbsPer100g: 4.6,
                caloriesPer100g: 31,
            });
        });

        it('matches a nutrientNumber sent as a JSON number as well as a string', async () => {
            await expect(searchGeneric('genericNumericNutrientNumbers')).resolves.toEqual([
                expectedCandidateOf('genericNumericNutrientNumbers'),
            ]);
        });

        it('falls back to 4P + 4C + 9F per 100 g when nutrient 208 is absent', async () => {
            const [candidate] = await searchGeneric('genericMissingCaloriesFallback');

            expect(candidate.caloriesPer100g).toBe(118);
            expect(candidate.caloriesPer100g).toBe(
                candidate.proteinPer100g * 4 + candidate.carbsPer100g * 4 + candidate.fatPer100g * 9,
            );
        });

        it.each([
            'genericMissingProteinDropped',
            'genericMissingFoodNutrientsKeyDropped',
            'genericEmptyFoodNutrientsDropped',
            'genericNonNumericNutrientValueDropped',
            'genericNonStringDescriptionDropped',
            'genericZeroFdcIdDropped',
        ])('drops %s', async (name) => {
            await expect(searchGeneric(name)).resolves.toHaveLength(expectedResultLengthOf(name));
        });

        it.each(['emptyFoodsArray', 'missingFoodsKey'])('returns no results for %s', async (name) => {
            await expect(searchGeneric(name)).resolves.toEqual([]);
        });

        it('keeps the usable foods of a mixed envelope and drops only the rest', async () => {
            const { expectedAcceptedFdcIds } = searchSample('mixedGenericEnvelope');
            const candidates = await searchGeneric('mixedGenericEnvelope');

            expect(candidates).toHaveLength(expectedResultLengthOf('mixedGenericEnvelope'));
            expect(candidates.map((candidate) => candidate.fdcId)).toEqual(expectedAcceptedFdcIds);
        });
    });

    describe('searchBrandedFoods', () => {
        it('requests the Branded data type, twenty results and the first page', async () => {
            respondWith(jsonResponse(searchSample('brandedComplete').payload));

            await searchBrandedFoods('yogurt');

            const request = sentRequest();

            expect(request.url).toBe(
                `${DEFAULT_BASE_URL}/foods/search?query=yogurt&dataType=Branded` +
                    `&pageSize=20&pageNumber=1&api_key=${API_KEY}`,
            );
            expectSignalOnlyGet(request);
        });

        it('reads through the legacy cache key, not the method-aware one', async () => {
            await searchBranded('brandedComplete', 'yogurt');

            expect(readKeys()).toEqual([brandedKeyFor('yogurt')]);
        });

        it('scales the per-100 g nutrients to one serving and rounds once', async () => {
            await expect(searchBranded('brandedComplete')).resolves.toEqual([
                expectedBrandedFoodOf(searchSample('brandedComplete'), 'brandedComplete'),
            ]);
        });

        it('rounds after scaling, so 0.4 g of fat per 100 g becomes 1 g on a 170 g serving', async () => {
            const [food] = await searchBranded('brandedComplete');

            expect(food.fat).toBe(1);
            expect(food.protein).toBe(17);
            expect(food.carbs).toBe(6);
            expect(food.calories).toBe(100);
        });

        it('falls back to 4P + 4C + 9F on the already-scaled per-serving values', async () => {
            const [food] = await searchBranded('brandedMissingCaloriesFallback');

            expect(food.calories).toBe(130);
            expect(food.calories).toBe(food.protein * 4 + food.carbs * 4 + food.fat * 9);
        });

        it('prefers householdServingFullText, trimmed and lowercased', async () => {
            const [food] = await searchBranded('brandedComplete');

            expect(food.servingText).toBe('1 container');
        });

        it('falls back to the serving size and unit when there is no household text', async () => {
            await expect(searchBranded('brandedWithoutHouseholdServingText')).resolves.toEqual([
                expectedBrandedFoodOf(
                    searchSample('brandedWithoutHouseholdServingText'),
                    'brandedWithoutHouseholdServingText',
                ),
            ]);
        });

        it.each(['brandedBrandOwnerOnlyAndUppercaseHouseholdServing', 'brandedBlankBrandNameFallsBackToOwner'])(
            'resolves the brand for %s',
            async (name) => {
                await expect(searchBranded(name)).resolves.toEqual([
                    expectedBrandedFoodOf(searchSample(name), name),
                ]);
            },
        );

        it('resolves the brand to null when neither brand field is present', async () => {
            const [food] = await searchBranded('brandedNoBrandFieldsResolvesToNull');

            expect(food.brand).toBeNull();
        });

        it.each([
            'brandedZeroServingSizeDropped',
            'brandedNegativeServingSizeDropped',
            'brandedNonNumericServingSizeDropped',
            'brandedMissingServingSizeUnitDropped',
            'brandedMissingCarbsDropped',
        ])('drops %s rather than scaling it', async (name) => {
            await expect(searchBranded(name)).resolves.toHaveLength(expectedResultLengthOf(name));
        });

        it.each(['emptyFoodsArray', 'missingFoodsKey'])('returns no results for %s', async (name) => {
            await expect(searchBranded(name)).resolves.toEqual([]);
        });

        it('keeps the usable foods of a mixed envelope and drops only the rest', async () => {
            const { expectedBrandedFoods } = searchSample('mixedBrandedEnvelope');

            await expect(searchBranded('mixedBrandedEnvelope')).resolves.toEqual(expectedBrandedFoods);
        });
    });

    describe('getBrandedFood', () => {
        it('requests the detail path with format=full and escapes the client-supplied id', async () => {
            respondWith(jsonResponse(detailSample('brandedDetailComplete').payload));

            await getBrandedFood('9000301 x');

            const request = sentRequest();

            expect(request.url).toBe(`${DEFAULT_BASE_URL}/food/9000301%20x?format=full&api_key=${API_KEY}`);
            expectSignalOnlyGet(request);
        });

        it('reads through the legacy cache key, not the method-aware one', async () => {
            await fetchBranded('brandedDetailComplete');

            expect(readKeys()).toEqual([cacheKeyFor('/food/9000301', { format: 'full' })]);
        });

        it('takes labelNutrients as already per serving and never scales them', async () => {
            const food = await fetchBranded('brandedDetailComplete');

            expect(food).toEqual(expectedBrandedFoodOf(detailSample('brandedDetailComplete'), 'brandedDetailComplete'));
            // servingSize is 60 g, so a wrongly applied value * servingSize /
            // 100 would have turned 230 kcal into 138.
            expect(food?.calories).toBe(230);
        });

        it('falls back to 4P + 4C + 9F on the per-serving label values', async () => {
            const food = await fetchBranded('detailMissingCaloriesFallback', '9000302');

            expect(food?.calories).toBe(222);
        });

        it.each([
            'detailServingTextFromServingSize',
            'detailBlankHouseholdServingFallsBackToServingSize',
            'detailServingSizeWithoutUnitServingTextNull',
            'detailNoServingFieldsServingTextNull',
        ])('resolves the serving text for %s', async (name) => {
            const envelope = detailSample(name);
            respondWith(jsonResponse(envelope.payload));

            await expect(getBrandedFood(String(fdcIdOf(envelope)))).resolves.toEqual(
                expectedBrandedFoodOf(envelope, name),
            );
        });

        it.each([
            'detailMissingProteinReturnsNull',
            'detailEmptyLabelNutrientsReturnsNull',
            'detailNonNumericLabelValueReturnsNull',
            'detailLabelNutrientWithoutValueMemberReturnsNull',
            'detailMissingFdcIdReturnsNull',
            'detailNonStringDescriptionReturnsNull',
            'genericDetailWithoutLabelNutrientsReturnsNull',
        ])('returns null for %s', async (name) => {
            respondWith(jsonResponse(detailSample(name).payload));

            await expect(getBrandedFood('9000301')).resolves.toBeNull();
        });
    });

    /**
     * Structural shapes the fixture does not model, because they are not
     * recordings of anything USDA documents: a JSON `null` in place of a
     * document, a `null` element inside an array, an absent `dataType`. Each
     * payload is a structural variation on a reviewed fixture sample, so every
     * number in it remains sourced.
     */
    describe('a payload the fixture does not model', () => {
        const baseGenericFood = (): Record<string, unknown> => {
            const { foods } = searchSample('genericFoundationComplete').payload as {
                foods: Array<Record<string, unknown>>;
            };

            return { ...foods[0] };
        };

        const baseBrandedFood = (): Record<string, unknown> => {
            const { foods } = searchSample('brandedComplete').payload as { foods: Array<Record<string, unknown>> };

            return { ...foods[0] };
        };

        const baseDetailFood = (): Record<string, unknown> => ({
            ...(detailSample('brandedDetailComplete').payload as Record<string, unknown>),
        });

        const envelope = (food: unknown): unknown => ({ totalHits: 1, currentPage: 1, totalPages: 1, foods: [food] });

        it.each([
            ['searchGenericFoods', async () => searchGenericFoods('fixture')],
            ['searchBrandedFoods', async () => searchBrandedFoods('fixture')],
        ])('returns no results from %s when the document itself is null', async (_name, call) => {
            respondWith(jsonResponse(null));

            await expect(call()).resolves.toEqual([]);
        });

        it('returns null from getBrandedFood when the document itself is null', async () => {
            respondWith(jsonResponse(null));

            await expect(getBrandedFood('9000301')).resolves.toBeNull();
        });

        it.each([
            ['searchGenericFoods', async () => searchGenericFoods('fixture')],
            ['searchBrandedFoods', async () => searchBrandedFoods('fixture')],
        ])('drops a null element of the foods array in %s', async (_name, call) => {
            respondWith(jsonResponse(envelope(null)));

            await expect(call()).resolves.toEqual([]);
        });

        it('tolerates a null entry inside foodNutrients in the generic path', async () => {
            const food = baseGenericFood();
            respondWith(jsonResponse(envelope({ ...food, foodNutrients: [null, ...(food.foodNutrients as unknown[])] })));

            const [candidate] = await searchGenericFoods('fixture');

            expect(candidate.proteinPer100g).toBe(2.5);
            expect(candidate.caloriesPer100g).toBe(31);
        });

        it('tolerates a null entry inside foodNutrients in the branded path', async () => {
            const food = baseBrandedFood();
            respondWith(jsonResponse(envelope({ ...food, foodNutrients: [null, ...(food.foodNutrients as unknown[])] })));

            const [branded] = await searchBrandedFoods('fixture');

            expect(branded.protein).toBe(17);
            expect(branded.calories).toBe(100);
        });

        it('reports an absent dataType as an empty string rather than the word undefined', async () => {
            const food = baseGenericFood();
            delete food.dataType;
            respondWith(jsonResponse(envelope(food)));

            const [candidate] = await searchGenericFoods('fixture');

            expect(candidate.dataType).toBe('');
        });

        it('keeps a doubled space in a title-cased name', async () => {
            respondWith(jsonResponse(envelope({ ...baseBrandedFood(), description: 'Fixture  yogurt, plain' })));

            const [branded] = await searchBrandedFoods('fixture');

            expect(branded.name).toBe('Fixture  Yogurt, Plain');
        });

        it('falls back to brandOwner on a detail record carrying no brandName', async () => {
            const food = baseDetailFood();
            delete food.brandName;
            respondWith(jsonResponse(food));

            const branded = await getBrandedFood('9000301');

            expect(branded?.brand).toBe('Fixture Nutrition Holdings');
        });

        it('resolves the brand to null when both brand fields are blank', async () => {
            respondWith(jsonResponse({ ...baseDetailFood(), brandName: '   ', brandOwner: '  ' }));

            const branded = await getBrandedFood('9000301');

            expect(branded?.brand).toBeNull();
        });
    });

    describe('the optional request argument', () => {
        it('is omitted by every shipped function, leaving their requests as they were', async () => {
            respondWith(
                jsonResponse(searchSample('genericFoundationComplete').payload),
                jsonResponse(searchSample('brandedComplete').payload),
                jsonResponse(detailSample('brandedDetailComplete').payload),
            );

            await searchGenericFoods('leafy greens');
            await searchBrandedFoods('yogurt');
            await getBrandedFood('9000301');

            for (let index = 0; index < 3; index += 1) {
                expectSignalOnlyGet(sentRequest(index));
            }
        });
    });
});

/**
 * `scripts/lib/rateLimiter.ts` wraps `globalThis.fetch` for
 * `api.nal.usda.gov` with a token bucket sized by
 * `USDA_IMPORT_RATE_LIMIT_PER_HOUR`, and charges one token per *physical*
 * attempt. Its arithmetic is only correct if this module reads `fetch` off the
 * global on every attempt and issues no request a limiter cannot see, so the
 * observable invocation count is the contract.
 */
describe('rate limiter accounting', () => {
    const listPayload = (): unknown[] => [portionSample('srLegacyPortions').payload];
    const listKey = cacheKeyFor('/foods/list', { dataType: 'Branded', pageSize: '200', pageNumber: '1' });

    it('charges four tokens for a call that retries three times', async () => {
        alwaysRespond(() => failureResponse(429));

        await exhaustAttempts(listFoods('Branded'));

        expect(requestCount()).toBe(MAX_ATTEMPTS);
    });

    it('charges two tokens for a call that succeeds on its second attempt', async () => {
        respondWith(failureResponse(500), jsonResponse(listPayload()));

        const call = listFoods('Branded');
        await jest.advanceTimersByTimeAsync(BACKOFF_SEQUENCE_MS[0]);
        await call;

        expect(requestCount()).toBe(2);
    });

    it('charges nothing for a cache hit', async () => {
        seedRow(listKey, listPayload(), DAY_MS);

        await listFoods('Branded');

        expect(requestCount()).toBe(0);
    });

    it('charges nothing when the key is missing, because no request is issued', async () => {
        delete process.env.USDA_API_KEY;

        await vendorFailure(listFoods('Branded'));

        expect(requestCount()).toBe(0);
    });

    it('charges a background refresh as its own token, on top of the served hit', async () => {
        seedRow(listKey, listPayload(), SEARCH_TTL_MS + DAY_MS);
        respondWith(jsonResponse(listPayload()));

        await listFoods('Branded');
        await jest.advanceTimersByTimeAsync(0);

        expect(requestCount()).toBe(1);
    });

    it('charges a retrying background refresh once per attempt', async () => {
        seedRow(listKey, listPayload(), SEARCH_TTL_MS + DAY_MS);
        alwaysRespond(() => failureResponse(503));

        await listFoods('Branded');
        await jest.advanceTimersByTimeAsync(TOTAL_BACKOFF_MS);

        expect(requestCount()).toBe(MAX_ATTEMPTS);
    });

    it('reads fetch off the global on every attempt, so a late wrapper still sees the retries', async () => {
        const first = alwaysRespond(() => failureResponse(429));
        const settled = rejectionOf(listFoods('Branded'));
        await jest.advanceTimersByTimeAsync(0);

        expect(first).toHaveBeenCalledTimes(1);

        const second = alwaysRespond(() => failureResponse(429));
        await jest.advanceTimersByTimeAsync(TOTAL_BACKOFF_MS);

        expect(asUsdaError(await settled).message).toBe(statusMessage(429));
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
    });
});

