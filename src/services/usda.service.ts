import { BrandedFoodResponse } from '../types/nutrition';
import { prisma } from '../prisma/client';
import { parseCanonicalFdcId } from './catalog.logic';

// USDA FoodData Central (public domain — no retention restrictions, so the
// snapshot-at-log-time model is fully legal for this data source).
// Search results carry per-100g/100ml nutrients that we scale to one serving;
// the detail endpoint's labelNutrients are already per-serving.
const DEFAULT_BASE_URL = 'https://api.nal.usda.gov/fdc/v1';

// Nutrient numbers per USDA's data dictionary.
const NUTRIENT_PROTEIN = '203';
const NUTRIENT_FAT = '204';
const NUTRIENT_CARBS = '205';
const NUTRIENT_CALORIES = '208';

export class UsdaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsdaError';
    }
}

const getApiKey = (): string => {
    const apiKey = process.env.USDA_API_KEY;
    if (!apiKey) {
        throw new UsdaError('USDA_API_KEY is not configured');
    }
    return apiKey;
};

const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 250;

// ---------------------------------------------------------------------------
// Deadlines.
//
// `fetch` imposes no timeout of its own, so a stalled DNS lookup, TLS
// handshake or body read waits for as long as the socket lives — which on the
// request path is an `/api/macros/estimate` or `/api/macros/search-branded-foods`
// call a client is sitting on, and on the import path is a multi-hour run that
// stops making progress without ever failing. Every attempt therefore runs
// under an `AbortController`.
//
// A per-attempt deadline is not sufficient on its own: it multiplies by
// `MAX_ATTEMPTS`, so "3 seconds" for four attempts is a twelve-second call.
// That is the same trap `evidence.service.ts` records for redirect hops ("One
// deadline for the whole operation, not one per hop"), so the retry loop also
// runs under one budget for the whole logical call, and each attempt gets
// whichever of the two is nearer. The budget can only end the loop early —
// `MAX_ATTEMPTS` remains the upper bound that `scripts/lib/rateLimiter.ts`
// charges tokens against.
//
// Two classes of caller need different numbers, and which endpoint is being
// called says which class it is — the same derivation `ttlForPath` makes below:
//
//   - Request path (`/foods/search`, `/food/{id}`): reached while a mobile
//     client waits. `httpRequest.ts` abandons the request at 25 s, and USDA
//     grounding is one of three vendor steps inside `POST /api/macros/estimate`,
//     so this budget is the slice `estimate.service.ts` reserves for grounding
//     (it imports `USDA_REQUEST_CALL_BUDGET_MS` rather than restating it) and
//     is deliberately a small fraction of the client's deadline.
//   - Offline import (`POST /foods`, `/foods/list`): no user is waiting, and a
//     twenty-record `format=full` batch is a large response, so the numbers are
//     generous. They exist to stop a hung socket, not to pace the run — pacing
//     is the rate limiter's job.
// ---------------------------------------------------------------------------

/** One physical attempt, on an endpoint a client is waiting on. */
const REQUEST_ATTEMPT_TIMEOUT_MS = 3_000;

/**
 * Every attempt and backoff of one request-path call, combined.
 *
 * Exported because `estimate.service.ts` sizes its grounding reserve from it:
 * the number has to be the same on both sides or the request budget it belongs
 * to is fiction.
 */
export const USDA_REQUEST_CALL_BUDGET_MS = 6_000;

/** One physical attempt, on a batch or enumeration endpoint. */
const IMPORT_ATTEMPT_TIMEOUT_MS = 30_000;

/** Every attempt and backoff of one import call, combined. */
const IMPORT_CALL_BUDGET_MS = 120_000;

interface UsdaDeadlines {
    attemptMs: number;
    callMs: number;
}

const REQUEST_DEADLINES: UsdaDeadlines = {
    attemptMs: REQUEST_ATTEMPT_TIMEOUT_MS,
    callMs: USDA_REQUEST_CALL_BUDGET_MS,
};

const IMPORT_DEADLINES: UsdaDeadlines = { attemptMs: IMPORT_ATTEMPT_TIMEOUT_MS, callMs: IMPORT_CALL_BUDGET_MS };

// Only the two endpoints the offline pipeline reads are listed, so an endpoint
// added later inherits the request-path deadlines and is bounded by the tighter
// pair until someone decides otherwise. `/food/{id}` is request-path because
// `getBrandedFood` serves it to a waiting client; `getFoodDetail` shares that
// path and, per `scripts/catalog-import-usda.ts`, the import never calls it.
const IMPORT_PATHS = new Set(['/foods', '/foods/list']);

const deadlinesForPath = (path: string): UsdaDeadlines =>
    IMPORT_PATHS.has(path) ? IMPORT_DEADLINES : REQUEST_DEADLINES;

// Statuses worth a second request, and nothing else.
//
// `400` is here deliberately and is the surprising one: USDA intermittently
// answers 400 to a request that succeeds when retried verbatim (~1 in 5
// observed), which is why this boundary has always retried it. `408` and `429`
// are the vendor asking to be asked again, and 5xx is its own failure.
//
// Everything absent is definitive: a second identical request to `401`, `403`
// (api.data.gov's answer to a missing, invalid or unauthorised key), `404` or
// any other 4xx returns the same answer, so retrying only spends three more of
// the hour's requests and delays the real error — which on the import path is
// the operator's signal that the key is wrong.
const RETRYABLE_STATUSES = new Set([400, 408, 429]);

export const isRetryableUsdaStatus = (status: number): boolean =>
    status >= 500 || RETRYABLE_STATUSES.has(status);

// Our own abort, always: this module attaches the only signal its requests
// carry. Matches `evidence.service.ts`'s predicate, because an abort surfaces
// as a `DOMException` named `AbortError` on some runtimes and as an
// `ABORT_ERR`-coded error on others.
const isAbortError = (error: unknown): boolean =>
    error instanceof Error && (error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR');

// The batch endpoint is the only non-GET call this module makes; omitting the
// options leaves the request byte-for-byte the GET it has always been.
interface UsdaRequestOptions {
    method?: 'GET' | 'POST';
    body?: unknown;
}

/**
 * One completed USDA exchange: the decoded body and the status the vendor
 * answered it with.
 *
 * The status is carried out of the retry loop rather than dropped because it is
 * a mandatory field of a retrieval record (Agent Action Plan §0.3.2) and the
 * catalog import copies it onto every
 * `catalog_validation_records.identity_evidence` record. It is always the
 * status of the attempt that produced `payload` — the successful one — never an
 * earlier retried `400`/`429`, because only a `response.ok` attempt returns
 * from the loop at all.
 */
interface UsdaFetchResult {
    readonly payload: any;
    readonly httpStatus: number;
}

const fetchFromUsda = async (
    path: string,
    params: Record<string, string>,
    options?: UsdaRequestOptions,
): Promise<UsdaFetchResult> => {
    const baseUrl = process.env.USDA_BASE_URL || DEFAULT_BASE_URL;
    // Spaces must be %20, not URLSearchParams' "+" — USDA 400s on "+" inside
    // dataType values (e.g. "Survey (FNDDS)").
    const query = Object.entries({ ...params, api_key: getApiKey() })
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    const url = `${baseUrl}${path}?${query}`;

    // api_key stays in the query string above whatever the method — USDA
    // authenticates by query parameter, not by header.
    const init: RequestInit | undefined =
        options === undefined
            ? undefined
            : {
                method: options.method ?? 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
            };

    const { attemptMs, callMs } = deadlinesForPath(path);
    const startedAt = Date.now();
    const remainingMs = (): number => callMs - (Date.now() - startedAt);

    let lastError: Error = new UsdaError('USDA request failed');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const budgetLeft = remainingMs();
        if (budgetLeft <= 0) {
            // The call's budget is spent. The attempt that exhausted it has
            // already recorded why, so that error is what the caller hears
            // rather than a second failure invented here.
            break;
        }

        // Each attempt gets whichever deadline is nearer, so a slow first
        // attempt shortens the second rather than extending the call.
        const attemptTimeoutMs = Math.min(attemptMs, budgetLeft);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
        // A definitive answer ends the loop without spending another of the
        // hour's requests on it.
        let terminal = false;
        try {
            // fetch is read from the global on every attempt because
            // scripts/lib/rateLimiter.ts wraps globalThis.fetch to charge a
            // token per physical attempt and must observe all four.
            //
            // The init now always exists because an abort cannot be delivered
            // without one, but a GET's init carries nothing except the signal:
            // no method, no headers and no body, so the request USDA receives
            // is byte-for-byte the one this module has always sent.
            const response =
                init === undefined
                    ? await fetch(url, { signal: controller.signal })
                    : await fetch(url, { ...init, signal: controller.signal });
            if (response.ok) {
                // Read the status before the body: an unreadable body throws
                // below and is retried, and the status of a retried attempt is
                // not the status of this call.
                const httpStatus = response.status;

                return { payload: await response.json(), httpStatus };
            }
            lastError = new UsdaError(`USDA returned ${response.status}`);
            terminal = !isRetryableUsdaStatus(response.status);
        } catch (error) {
            // A timeout is reported as one rather than as the runtime's abort
            // wording: "the vendor did not answer in time" and "the exchange
            // broke" are different things to an operator reading an import log,
            // and only the first is worth waiting longer for.
            lastError = isAbortError(error)
                ? new UsdaError(`USDA request timed out after ${attemptTimeoutMs}ms`)
                : new UsdaError(`USDA request failed: ${(error as Error).message}`);
        } finally {
            // In `finally` because an un-cleared timer holds the event loop
            // open for the rest of its delay after the call has returned.
            clearTimeout(timer);
        }

        if (terminal) {
            break;
        }
        if (attempt < MAX_ATTEMPTS) {
            // Backoff is bounded by the same budget: sleeping past the deadline
            // would spend the remainder of the call doing nothing.
            const backoffMs = Math.min(RETRY_DELAY_MS * attempt, Math.max(remainingMs(), 0));
            if (backoffMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
        }
    }
    throw lastError;
};

// Detail lookups (/food/{id}) are near-immutable; search result lists get a
// shorter TTL only so newly added USDA foods eventually show up.
const SEARCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DETAIL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const ttlForPath = (path: string): number => (path.startsWith('/food/') ? DETAIL_TTL_MS : SEARCH_TTL_MS);

// This output is usda_api_cache.cache_key, a single-column primary key whose
// rows are already deployed: changing the normalisation, the sort, the
// separator or the prefix orphans every cached row and re-triggers live USDA
// traffic against an hourly-capped key.
export const cacheKeyFor = (path: string, params: Record<string, string>): string => {
    const normalized = Object.entries(params)
        .map(([key, value]): [string, string] =>
            key === 'query' ? [key, value.trim().toLowerCase().replace(/\s+/g, ' ')] : [key, value])
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('&');
    return `${path}?${normalized}`;
};

// An FDC id names one specific USDA record, so only a canonical representation
// of it is accepted: `Number()` coercion would read '0x10' as 16, '1e3' as
// 1000 and '9007199254740993' as ...992, each of which fetches and caches a
// different food than the manifest text names.
//
// The rule itself is `parseCanonicalFdcId` in the pure catalog decision layer,
// imported rather than restated here. This module's cache key and
// `catalog_foods.source_key` are two views of one identity — the catalog keys
// every imported row on `usda:<fdcId>` — so a second parser that drifted from
// this one by a single accepted form would file a fetched food under the wrong
// key. One function, one contract, asserted from both sides.

// FDC ids are positive integers, so the same set in any order — or carrying a
// duplicate — must address one cached row and send one request, while a
// different set must never collide with it. Normalising to numbers also means a
// rerun that passes 1 where the first run passed '1' reuses the cached row
// instead of spending another request.
export const normalizeFdcIds = (fdcIds: ReadonlyArray<string | number>): number[] => {
    const unique = new Set<number>();
    for (const fdcId of fdcIds) {
        const parsed = parseCanonicalFdcId(fdcId);
        if (parsed === null) {
            throw new UsdaError(`Invalid USDA FDC id: ${String(fdcId)}`);
        }
        unique.add(parsed);
    }
    return Array.from(unique).sort((a, b) => a - b);
};

const isFdcIdListBody = (
    body: unknown,
): body is Record<string, unknown> & { fdcIds: Array<string | number> } =>
    typeof body === 'object' && body !== null && Array.isArray((body as { fdcIds?: unknown }).fdcIds);

// Object keys are emitted in sorted order so a key never depends on the order
// the caller happened to build the body in.
const canonicalJson = (value: unknown): string => {
    if (value === undefined) {
        return 'null';
    }
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
};

const canonicalBody = (body: unknown): string => {
    if (Array.isArray(body)) {
        return canonicalJson(normalizeFdcIds(body));
    }
    if (isFdcIdListBody(body)) {
        return canonicalJson({ ...body, fdcIds: normalizeFdcIds(body.fdcIds) });
    }
    return canonicalJson(body);
};

// The method- and body-aware sibling of cacheKeyFor. A GET without a body
// delegates to it, so GET keys stay byte-identical whichever builder a call
// site uses; anything else carries a method and canonical-body discriminator,
// which no GET key can collide with because no path begins "POST ".
export const cacheKeyForRequest = (
    method: string,
    path: string,
    params: Record<string, string>,
    body?: unknown,
): string => {
    const normalizedMethod = method.trim().toUpperCase();
    const baseKey = cacheKeyFor(path, params);
    if (normalizedMethod === 'GET' && body === undefined) {
        return baseKey;
    }
    return `${normalizedMethod} ${baseKey}#${canonicalBody(body)}`;
};

// `http_status` is written on every path that writes a payload, including the
// background refresh: the column records the status of the exchange that
// produced the row it sits on, so a refreshed row carries the refresh's status
// rather than the one the replaced payload arrived with.
const upsertCache = async (cacheKey: string, payload: any, httpStatus: number): Promise<void> => {
    await prisma.usda_api_cache.upsert({
        where: { cache_key: cacheKey },
        create: { cache_key: cacheKey, payload, http_status: httpStatus },
        update: { payload, http_status: httpStatus, fetched_at: new Date() },
    });
};

const refreshing = new Set<string>();

const refreshInBackground = (cacheKey: string, path: string, params: Record<string, string>): void => {
    if (refreshing.has(cacheKey)) return;
    refreshing.add(cacheKey);
    fetchFromUsda(path, params)
        .then(({ payload, httpStatus }) => upsertCache(cacheKey, payload, httpStatus))
        .catch(() => {
            // Stale row keeps being served; the next request past TTL retries.
        })
        .finally(() => refreshing.delete(cacheKey));
};

// Stale-while-revalidate over fetchFromUsda: cached rows are served no matter
// their age (a month-old food search is not meaningfully wrong), with rows
// past TTL refreshed off the request path. Cache/DB errors fall through to a
// live USDA call rather than failing the request.
const usdaGet = async (path: string, params: Record<string, string>): Promise<any> => {
    const cacheKey = cacheKeyFor(path, params);

    let cached: { payload: any; fetched_at: Date } | null = null;
    try {
        cached = await prisma.usda_api_cache.findUnique({ where: { cache_key: cacheKey } });
    } catch {
        cached = null;
    }

    if (cached) {
        if (Date.now() - cached.fetched_at.getTime() > ttlForPath(path)) {
            refreshInBackground(cacheKey, path, params);
        }
        return cached.payload;
    }

    const { payload, httpStatus } = await fetchFromUsda(path, params);
    // Deliberately not awaited, unlike the batch path below: a client is
    // waiting on this call, the response is already in hand, and nothing on the
    // request path asks where the payload came from — so the write stays off
    // the latency path exactly as it has been.
    upsertCache(cacheKey, payload, httpStatus).catch(() => {
        // Caching is best-effort; the response is already in hand.
    });
    return payload;
};

/**
 * What one batch call observed about its own retrieval.
 *
 * Every member is a fact the call itself saw, which is the point: once the
 * cache write is awaited (below), the presence of a row no longer tells a
 * caller whether this call fetched or replayed, so the answer has to travel out
 * of the call rather than be re-derived from the table afterwards.
 */
interface UsdaPostResult {
    readonly payload: unknown;
    /** `usda_api_cache.cache_key` this response is filed under. */
    readonly cacheKey: string;
    readonly origin: 'cache' | 'network';
    /** See {@link UsdaBatchRetrievalFacts.httpStatus} for what `null` means. */
    readonly httpStatus: number | null;
    readonly fetchedAt: Date;
}

// The batch POST cannot go through usdaGet — that path is GET-only and its key
// is not body-aware — so it reads and writes the same cache table through
// cacheKeyForRequest, with usdaGet's error posture: cache/DB failures fall
// through to a live call. A cached batch is served whatever its AGE and is
// never refreshed in the background: detail records are near-immutable, and a
// background request would spend one of the hour's requests outside the
// caller's rate accounting.
//
// Age is the only thing that does not invalidate a row. A row with no recorded
// `http_status` is a different matter and is re-fetched — see below.
const usdaPost = async (path: string, params: Record<string, string>, body: unknown): Promise<UsdaPostResult> => {
    const cacheKey = cacheKeyForRequest('POST', path, params, body);

    let cached: { payload: unknown; http_status: number | null; fetched_at: Date } | null = null;
    try {
        cached = await prisma.usda_api_cache.findUnique({ where: { cache_key: cacheKey } });
    } catch {
        cached = null;
    }

    // A ROW WITH NO RECORDED STATUS IS NOT A USABLE REPLAY, and that is the
    // one condition besides absence that sends this call to the vendor.
    //
    // `http_status` is a mandatory field of the retrieval record this response
    // becomes (Agent Action Plan §0.3.2), and a row cached before the column
    // existed carries none. Serving such a row would make it an ABSORBING
    // STATE: every future call would replay it, so the status could never be
    // observed for that batch on any later run, and the evidence would stay
    // null forever while the code that fills it in looked correct. Re-fetching
    // is the only way the field can ever be obtained.
    //
    // NOTHING IS BACKFILLED OR GUESSED. The status written is the one the new
    // exchange answers with, the payload written is that exchange's payload,
    // and `fetched_at` moves to that exchange's time — the upsert below
    // replaces all three together, so the row stops being a pre-ledger row the
    // first time it is read after the migration rather than being annotated
    // with a status that belongs to a different response. The re-fetch goes
    // through the same `globalThis.fetch` the import's limiter wraps, so it is
    // paced and counted like any other attempt.
    //
    // This costs one request per pre-ledger batch, once. Rows this release
    // writes all carry a status, so the condition is self-clearing and no
    // steady-state traffic is added.
    if (cached !== null && cached.http_status !== null) {
        return {
            payload: cached.payload,
            cacheKey,
            origin: 'cache',
            // The status recorded with the row, never a substituted 200.
            httpStatus: cached.http_status,
            // The row's own retrieval time, which is when this payload was
            // obtained from USDA — this call obtained nothing.
            fetchedAt: cached.fetched_at,
        };
    }

    const { payload, httpStatus } = await fetchFromUsda(path, params, { method: 'POST', body });
    const fetchedAt = new Date();
    // Awaited, unlike the request path above: no client is waiting on a batch,
    // and a caller that asks where this response came from must not be able to
    // observe the row arriving after the answer. The guard keeps the write
    // best-effort all the same — a read-only or unreachable database still
    // cannot fail a vendor call whose response is already in hand.
    try {
        await upsertCache(cacheKey, payload, httpStatus);
    } catch (error) {
        console.error('Failed to cache USDA batch response:', (error as Error).message);
    }

    return { payload, cacheKey, origin: 'network', httpStatus, fetchedAt };
};

const titleCase = (value: string): string =>
    value
        .toLowerCase()
        .split(' ')
        .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
        .join(' ');

const round = (value: number): number => Math.round(value);

// Generic (non-branded) foods for grounding AI estimates: FNDDS "Survey"
// foods are as-eaten descriptions ("Bagel, plain"), SR Legacy/Foundation are
// reference foods. All carry per-100g nutrients in search results.
export interface GenericFoodCandidate {
    fdcId: string;
    description: string;
    dataType: string;
    caloriesPer100g: number;
    proteinPer100g: number;
    carbsPer100g: number;
    fatPer100g: number;
}

export const searchGenericFoods = async (query: string, limit: number = 6): Promise<GenericFoodCandidate[]> => {
    const data = await usdaGet('/foods/search', {
        query,
        dataType: 'Survey (FNDDS),SR Legacy,Foundation',
        pageSize: String(limit),
        pageNumber: '1',
    });
    const foods = Array.isArray(data?.foods) ? data.foods : [];

    return foods
        .map((food: any): GenericFoodCandidate | null => {
            if (!food?.fdcId || typeof food?.description !== 'string' || !Array.isArray(food?.foodNutrients)) {
                return null;
            }
            const per100 = (nutrientNumber: string): number | null => {
                const nutrient = food.foodNutrients.find((n: any) => String(n?.nutrientNumber) === nutrientNumber);
                const value = Number(nutrient?.value);
                return Number.isFinite(value) ? value : null;
            };
            const protein = per100(NUTRIENT_PROTEIN);
            const fat = per100(NUTRIENT_FAT);
            const carbs = per100(NUTRIENT_CARBS);
            if (protein === null || fat === null || carbs === null) return null;
            const calories = per100(NUTRIENT_CALORIES) ?? protein * 4 + carbs * 4 + fat * 9;
            return {
                fdcId: String(food.fdcId),
                description: food.description,
                dataType: String(food.dataType ?? ''),
                caloriesPer100g: calories,
                proteinPer100g: protein,
                carbsPer100g: carbs,
                fatPer100g: fat,
            };
        })
        .filter((food: GenericFoodCandidate | null): food is GenericFoodCandidate => food !== null);
};

export const searchBrandedFoods = async (query: string): Promise<BrandedFoodResponse[]> => {
    const data = await usdaGet('/foods/search', {
        query,
        dataType: 'Branded',
        pageSize: '20',
        pageNumber: '1',
    });
    const foods = Array.isArray(data?.foods) ? data.foods : [];

    return foods
        .map((food: any): BrandedFoodResponse | null => {
            const servingSize = Number(food?.servingSize);
            if (
                !food?.fdcId ||
                typeof food?.description !== 'string' ||
                !Number.isFinite(servingSize) ||
                servingSize <= 0 ||
                typeof food?.servingSizeUnit !== 'string' ||
                !Array.isArray(food?.foodNutrients)
            ) {
                return null;
            }

            // Search-result nutrients are per 100g/100ml; scale to one serving.
            const perServing = (nutrientNumber: string): number | null => {
                const nutrient = food.foodNutrients.find((n: any) => String(n?.nutrientNumber) === nutrientNumber);
                const value = Number(nutrient?.value);
                return Number.isFinite(value) ? (value * servingSize) / 100 : null;
            };

            const protein = perServing(NUTRIENT_PROTEIN);
            const fat = perServing(NUTRIENT_FAT);
            const carbs = perServing(NUTRIENT_CARBS);
            if (protein === null || fat === null || carbs === null) return null;
            // Prefer USDA's energy value; fall back to 4/4/9 when it's absent.
            const calories = perServing(NUTRIENT_CALORIES) ?? protein * 4 + carbs * 4 + fat * 9;

            const servingText =
                typeof food.householdServingFullText === 'string' && food.householdServingFullText.trim()
                    ? food.householdServingFullText.trim().toLowerCase()
                    : `${servingSize} ${food.servingSizeUnit.toLowerCase()}`;

            return {
                id: String(food.fdcId),
                name: titleCase(food.description),
                brand: typeof food.brandName === 'string' && food.brandName.trim()
                    ? titleCase(food.brandName)
                    : typeof food.brandOwner === 'string' && food.brandOwner.trim()
                        ? titleCase(food.brandOwner)
                        : null,
                servingText,
                calories: round(calories),
                protein: round(protein),
                carbs: round(carbs),
                fat: round(fat),
            };
        })
        .filter((food: BrandedFoodResponse | null): food is BrandedFoodResponse => food !== null);
};

export const getBrandedFood = async (foodId: string): Promise<BrandedFoodResponse | null> => {
    const data = await usdaGet(`/food/${encodeURIComponent(foodId)}`, { format: 'full' });
    if (!data?.fdcId || typeof data?.description !== 'string') return null;

    // Detail responses carry labelNutrients that are already per-serving.
    const label = data.labelNutrients;
    const toValue = (entry: any): number | null => {
        const value = Number(entry?.value);
        return Number.isFinite(value) ? value : null;
    };
    const protein = toValue(label?.protein);
    const carbs = toValue(label?.carbohydrates);
    const fat = toValue(label?.fat);
    if (protein === null || carbs === null || fat === null) return null;
    const calories = toValue(label?.calories) ?? protein * 4 + carbs * 4 + fat * 9;

    const servingSize = Number(data.servingSize);
    const servingText =
        typeof data.householdServingFullText === 'string' && data.householdServingFullText.trim()
            ? data.householdServingFullText.trim().toLowerCase()
            : Number.isFinite(servingSize) && typeof data.servingSizeUnit === 'string'
                ? `${servingSize} ${data.servingSizeUnit.toLowerCase()}`
                : null;

    return {
        id: String(data.fdcId),
        name: titleCase(data.description),
        brand: typeof data.brandName === 'string' && data.brandName.trim()
            ? titleCase(data.brandName)
            : typeof data.brandOwner === 'string' && data.brandOwner.trim()
                ? titleCase(data.brandOwner)
                : null,
        servingText,
        calories: round(calories),
        protein: round(protein),
        carbs: round(carbs),
        fat: round(fat),
    };
};

// Everything below serves the offline catalog import (backend scripts/), never
// a request path: once the catalog is seeded, plan generation, swaps, grocery
// aggregation, recipe viewing and internal catalog search reach USDA never.
//
// These describe raw vendor payloads — catalog-validate.ts is what decides
// whether a record is publishable — so only fdcId is treated as certain, and
// the index signature keeps dataset-specific extras reachable as `unknown`:
// vendor-controlled fields a caller has not narrowed must not typecheck as
// usable values.
export interface UsdaFoodNutrient {
    nutrientNumber?: string | number;
    nutrientName?: string;
    unitName?: string;
    value?: number;
    // Detail responses nest the descriptor and name the value `amount`, where
    // search results flatten it to nutrientNumber/value.
    amount?: number;
    nutrient?: { number?: string | number; id?: number; name?: string; unitName?: string };
    [key: string]: unknown;
}

// portionDescription is the FNDDS wording; SR Legacy carries modifier + amount.
// gramWeight is what turns a household portion into a mass the planner can use.
export interface UsdaFoodPortion {
    amount?: number;
    gramWeight?: number;
    modifier?: string;
    portionDescription?: string;
    measureUnit?: { name?: string; abbreviation?: string };
    [key: string]: unknown;
}

export interface UsdaFoodSummary {
    fdcId: number;
    description?: string;
    dataType?: string;
    publicationDate?: string;
    foodNutrients?: UsdaFoodNutrient[];
    [key: string]: unknown;
}

export interface UsdaFoodDetail extends UsdaFoodSummary {
    foodPortions?: UsdaFoodPortion[];
    foodCategory?: { id?: number; description?: string } | string;
    servingSize?: number;
    servingSizeUnit?: string;
    householdServingFullText?: string;
    brandName?: string;
    brandOwner?: string;
    ingredients?: string;
    labelNutrients?: Record<string, { value?: number }>;
}

// USDA documents 20 FDC ids as the maximum for one POST /foods call.
export const MAX_BATCH_FDC_IDS = 20;

// USDA caps /foods/list at 200 records per page and rejects a larger pageSize.
export const MAX_LIST_PAGE_SIZE = 200;

export const clampListPageSize = (pageSize: number): number =>
    Number.isFinite(pageSize) ? Math.min(Math.max(1, Math.trunc(pageSize)), MAX_LIST_PAGE_SIZE) : MAX_LIST_PAGE_SIZE;

const clampPageNumber = (pageNumber: number): number =>
    Number.isFinite(pageNumber) ? Math.max(1, Math.trunc(pageNumber)) : 1;

// The catalog keys every imported row on `usda:<fdcId>`, so a record is only
// usable once its id is proven: the payload is a vendor response, not a trusted
// record, until it is a plain object carrying a canonical fdcId. The parsed id
// is written back so the `fdcId: number` claim in UsdaFoodSummary holds even on
// the datasets that stringify it.
const toIdentifiedRecord = <T extends UsdaFoodSummary>(row: unknown, context: string): T => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new UsdaError(`USDA ${context} returned a record that is not an object`);
    }
    const record = row as Record<string, unknown>;
    const fdcId = parseCanonicalFdcId(record.fdcId);
    if (fdcId === null) {
        throw new UsdaError(`USDA ${context} returned a record with an invalid fdcId: ${String(record.fdcId)}`);
    }
    return { ...record, fdcId } as T;
};

// A malformed batch/list payload fails loudly instead of degrading to an empty
// array: the import's coverage report counts what came back, so a silent []
// would be recorded as "USDA holds none of these foods" rather than "USDA's
// answer was unusable", and the missing rows would never be retried. An empty
// array from USDA is a real, valid answer and stays one.
const toIdentifiedRecords = <T extends UsdaFoodSummary>(payload: unknown, context: string): T[] => {
    if (!Array.isArray(payload)) {
        throw new UsdaError(`USDA ${context} returned a payload that is not an array`);
    }
    return payload.map((row) => toIdentifiedRecord<T>(row, context));
};

// The full record rather than the BrandedFoodResponse projection: the catalog
// import needs the foodNutrients and the foodPortions gram weights that DTO
// discards. ttlForPath already gives every /food/ path the 90-day detail TTL,
// so this inherits it with no TTL change.
export const getFoodDetail = async (fdcId: string | number): Promise<UsdaFoodDetail> => {
    // normalizeFdcIds guarantees a positive integer, so — unlike
    // getBrandedFood's client-supplied id — the path needs no escaping.
    const [id] = normalizeFdcIds([fdcId]);
    const payload: unknown = await usdaGet(`/food/${id}`, { format: 'full' });
    const record = toIdentifiedRecord<UsdaFoodDetail>(payload, `detail for FDC id ${id}`);
    // Identity, not just a well-formed id: the import files this payload under
    // the id it asked for, so a response describing a different food would be
    // published under the requested food's name instead of failing.
    if (record.fdcId !== id) {
        throw new UsdaError(`USDA detail for FDC id ${id} returned fdcId ${record.fdcId}`);
    }
    return record;
};

/**
 * How one `POST /foods` batch was actually obtained.
 *
 * This exists because the status of a USDA exchange is a mandatory field of a
 * retrieval record (Agent Action Plan §0.3.2) and
 * `catalog_validation_records.identity_evidence` IS such a record (§0.5.1): the
 * catalog import has to state the upstream status of the response each food
 * record came from, and it can only state what this boundary observed.
 *
 * Every member is observed by the call that returns it, never re-derived
 * afterwards. In particular {@link origin} is not "is there a row under
 * {@link cacheKey}" — the live path awaits its own cache write, so by the time
 * a caller looks there is always a row.
 */
export interface UsdaBatchRetrievalFacts {
    /** `normalizeFdcIds` output: canonical, de-duplicated and ascending. */
    readonly requestedFdcIds: readonly number[];
    /**
     * `usda_api_cache.cache_key` for this request — the single-column primary
     * key of the row holding {@link payload}, so a reader can look the response
     * up and recompute a digest of it.
     */
    readonly cacheKey: string;
    /** `'network'` when this call reached USDA, `'cache'` when it replayed a recorded response. */
    readonly origin: 'cache' | 'network';
    /**
     * The upstream HTTP status of the exchange that produced {@link payload}:
     * this call's observed status on a live fetch, and the status recorded on
     * the row on a replay.
     *
     * `null` means **the recorded response predates the status ledger** — it
     * was cached before `usda_api_cache.http_status` existed, so no status was
     * ever observed for it. It never means "unknown, probably 200": a
     * downstream artefact quotes this value as retrieval evidence, and
     * substituting a status nobody saw is the defect the column was added to
     * end.
     *
     * In practice this function no longer returns `null`. A live fetch always
     * carries a number because only a `response.ok` attempt returns a payload,
     * and a cached row without a status is re-fetched rather than replayed
     * (see `usdaPost`) precisely so the field can be obtained. The `null` stays
     * REPRESENTABLE rather than being typed away, because a consumer that
     * publishes this value must refuse the case explicitly instead of relying
     * on a type to prove it cannot happen — `catalog-import-usda.ts` quarantines
     * such a record rather than publishing a mandatory field it never observed.
     */
    readonly httpStatus: number | null;
    /**
     * When {@link payload} was obtained from USDA: the row's `fetched_at` on a
     * replay (the vendor retrieval time), this call's clock on a live fetch.
     */
    readonly fetchedAt: Date;
    /**
     * The whole response payload the details were read from — the same value
     * recorded under {@link cacheKey} — so a caller can digest it rather than
     * re-reading the row and hoping it still holds this response.
     */
    readonly payload: unknown;
}

/**
 * Rejects an over-length batch instead of truncating it: silently dropping ids
 * would make the import under-count and its coverage report lie.
 */
const assertBatchWithinCap = (count: number): void => {
    if (count > MAX_BATCH_FDC_IDS) {
        throw new UsdaError(`USDA accepts at most ${MAX_BATCH_FDC_IDS} FDC ids per batch request, received ${count}`);
    }
};

/**
 * `getFoodsBatch` plus the retrieval facts of the call that served it.
 *
 * The records are identical to what `getFoodsBatch` returns for the same ids —
 * it delegates here — so a caller needing the provenance pays nothing extra and
 * cannot end up describing a different request than the one it read.
 *
 * An empty id list throws rather than answering: `getFoodsBatch([])` makes no
 * request and reads no row, so there are no retrieval facts to state, and
 * inventing a shape for them is what this whole interface exists to stop.
 */
export const getFoodsBatchWithRetrieval = async (
    fdcIds: ReadonlyArray<string | number>,
): Promise<{ details: UsdaFoodDetail[]; retrieval: UsdaBatchRetrievalFacts }> => {
    if (fdcIds.length === 0) {
        throw new UsdaError(
            'USDA batch retrieval requires at least one FDC id: an empty batch makes no request, so there is ' +
                'nothing to describe',
        );
    }
    assertBatchWithinCap(fdcIds.length);

    const ids = normalizeFdcIds(fdcIds);
    const { payload, cacheKey, origin, httpStatus, fetchedAt } = await usdaPost(
        '/foods',
        {},
        { fdcIds: ids, format: 'full' },
    );
    const requested = new Set(ids);
    const records = toIdentifiedRecords<UsdaFoodDetail>(payload, 'batch');
    for (const record of records) {
        // Same identity rule as getFoodDetail, applied per row: the batch
        // response is unordered, so membership in the requested set is the only
        // thing tying a row back to the id the manifest named.
        if (!requested.has(record.fdcId)) {
            throw new UsdaError(`USDA batch returned an unrequested fdcId: ${record.fdcId}`);
        }
    }

    return {
        details: records,
        retrieval: { requestedFdcIds: ids, cacheKey, origin, httpStatus, fetchedAt, payload },
    };
};

export const getFoodsBatch = async (fdcIds: ReadonlyArray<string | number>): Promise<UsdaFoodDetail[]> => {
    // The empty case is answered here rather than delegated: it issues no
    // request, so the delegate has no retrieval to describe and refuses it.
    // Everything else — the twenty-id cap, id canonicalisation, the cache, the
    // identity checks — is the delegate's, so the two cannot diverge.
    if (fdcIds.length === 0) {
        return [];
    }

    const { details } = await getFoodsBatchWithRetrieval(fdcIds);

    return details;
};

// dataType takes the same values searchGenericFoods passes ('Foundation',
// 'SR Legacy', 'Survey (FNDDS)', 'Branded'), which is why fetchFromUsda must
// keep encoding spaces as %20.
export const listFoods = async (
    dataType: string,
    pageSize: number = MAX_LIST_PAGE_SIZE,
    pageNumber: number = 1,
): Promise<UsdaFoodSummary[]> => {
    const payload: unknown = await usdaGet('/foods/list', {
        dataType: dataType.trim(),
        pageSize: String(clampListPageSize(pageSize)),
        pageNumber: String(clampPageNumber(pageNumber)),
    });
    return toIdentifiedRecords<UsdaFoodSummary>(payload, 'list');
};
