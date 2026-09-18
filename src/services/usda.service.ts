// The generated namespace, for `Prisma.JsonNull` — the value that spells the
// JSON document `null` for a non-nullable `jsonb` column, which a bare JS
// `null` cannot (Prisma reads that as "clear the column").
// `mealPlanningAction.service.ts` imports it the same way.
import { Prisma } from '../generated/prisma';
import { UsdaRecordedPayload } from '../types/catalog';
import { BrandedFoodResponse } from '../types/nutrition';
import { prisma } from '../prisma/client';
// The sanctioned structured logger: this module records WHAT failed without
// recording the failure's text, because a Prisma message carries the
// connection string and the failing statement's values (Rule
// backend-architecture §8, Agent Action Plan §0.3.2).
import { describeErrorSafely, logSafeEvent } from '../utils/safeLogger';
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

// ---------------------------------------------------------------------------
// Redirects, which this boundary never follows.
//
// `fetch` follows redirects by default, and a 307 or 308 preserves the METHOD
// AND BODY of the request it redirects. Left at the default, anything able to
// answer for `api.nal.usda.gov` — a hijacked record, a compromised CDN edge, a
// resolver in the path — could move one of these requests to another origin and
// be handed the `api_key` this module puts in the query string, along with the
// batch body. `evidence.service.ts` states the same rule for the URLs it
// fetches ("redirects are never followed automatically"), and it binds harder
// here: this module talks to ONE fixed origin, so a hop away from it is never a
// destination this code chose.
//
// Two mechanisms, because only the first of them is ours to rely on:
//
//   - `redirect: 'error'` on every attempt, which makes a conforming `fetch`
//     reject a 3xx before any hop is made. It is a client-side policy, so the
//     request USDA receives is unchanged by it.
//   - The check below, which refuses a redirect that reaches this code anyway.
//     That is not hypothetical: `globalThis.fetch` is deliberately read per
//     attempt so `scripts/lib/rateLimiter.ts` can wrap it, and a wrapper builds
//     its own init. The shape worth naming is a redirect that was FOLLOWED and
//     ended in a 200 — `response.ok` is true and the body is another origin's
//     answer — which is why the refusal is tested before the success branch.
//
// A refusal is TERMINAL. An identical retry is redirected identically, so
// retrying would spend three more of the hour's requests to learn the same
// thing. And because no hop is ever followed, one physical attempt remains one
// charged token: there is no second request for the limiter to miss.
// ---------------------------------------------------------------------------

/** The 3xx range, whatever the particular redirect semantics of the code. */
const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 399;

/**
 * The error a redirected exchange fails with, or `null` when the response is
 * not a redirect at all.
 *
 * `redirected` is read first because it is the more serious answer: it says a
 * hop has already been made, whatever status the chain ended on. A response
 * double that carries no such property reads as `false` and falls through to
 * the status test, which is the same conclusion for the case that matters.
 */
const redirectRefusal = (response: Response): UsdaError | null => {
    if (response.redirected) {
        return new UsdaError('USDA response was redirected to another location, which this boundary does not follow');
    }
    if (response.status >= REDIRECT_STATUS_MIN && response.status <= REDIRECT_STATUS_MAX) {
        return new UsdaError(
            `USDA answered with a redirect (${response.status}), which this boundary does not follow`,
        );
    }

    return null;
};

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
 *
 * `payload` is `unknown` rather than `any`: it is a vendor document this module
 * has not looked at yet, and `any` would let every reader below reach into it
 * with no compiler assistance at all — the one place in this file where that
 * assistance is worth most. Each reader narrows it for itself, and the cache
 * write narrows it through {@link toRecordedPayload}.
 */
interface UsdaFetchResult {
    readonly payload: unknown;
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
            // without one, but a GET's init carries nothing except the signal
            // and the redirect policy above: no method, no headers and no body,
            // and neither of the two is a wire value — so the request USDA
            // receives is byte-for-byte the one this module has always sent.
            const response =
                init === undefined
                    ? await fetch(url, { redirect: 'error', signal: controller.signal })
                    : await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
            const refusedRedirect = redirectRefusal(response);
            if (refusedRedirect !== null) {
                // Tested before `response.ok` because a followed redirect can
                // end in a 200: reading the body first would return another
                // origin's answer as this vendor's.
                lastError = refusedRedirect;
                terminal = true;
            } else if (response.ok) {
                // Read the status before the body: an unreadable body throws
                // below and is retried, and the status of a retried attempt is
                // not the status of this call.
                const httpStatus = response.status;

                return { payload: await response.json(), httpStatus };
            } else {
                lastError = new UsdaError(`USDA returned ${response.status}`);
                terminal = !isRetryableUsdaStatus(response.status);
            }
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

// The deepest structure this module will accept into the cache column.
//
// USDA's `format=full` records nest a handful of levels, so the bound is far
// above anything a real response reaches; it is here because the walk below is
// recursive over data this module did not build. It also makes a CYCLE a
// refusal rather than a hang — `JSON.parse` output cannot contain one, and that
// is exactly the assumption a checked conversion must not depend on.
const MAX_RECORDED_PAYLOAD_DEPTH = 64;

/**
 * The own-property shape a `JSON.parse` result has, which is the only shape a
 * container may have to be recorded as it stands.
 *
 * Every own key must be a string naming an ENUMERABLE DATA property, because
 * those are the only properties `JSON.stringify` carries into the column:
 *
 * - a symbol key, and a non-enumerable one, are dropped by the serialiser, so
 *   the row would be missing data the value handed back to the caller still
 *   holds (an array's own `length` is the one non-enumerable property a JSON
 *   array has, and is expected);
 * - an ACCESSOR is refused from the other direction: a getter may answer
 *   differently on each read, so the value inspected here and the value
 *   serialised later need not agree, and one that throws would escape this
 *   boundary as something other than a {@link UsdaError}.
 */
const hasPlainOwnDataProperties = (value: object): boolean => {
    const lengthIsExpected = Array.isArray(value);

    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
            return false;
        }

        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (descriptor === undefined || !('value' in descriptor)) {
            return false;
        }

        if (descriptor.enumerable !== true && !(lengthIsExpected && key === 'length')) {
            return false;
        }
    }

    return true;
};

/**
 * Whether an object is a plain JSON container — an array, or an object with no
 * behaviour of its own — rather than something that merely looks like one to a
 * walk over its values.
 *
 * Its shape is the half a value walk cannot answer: a `Date`, a `Map`, a `Set`,
 * a `Buffer` and a class instance hold few or no own data properties, so
 * walking their values finds nothing to refuse while `JSON.stringify` turns
 * them into something else entirely — an ISO string for a `Date`, `{}` for a
 * `Map`. The other half is {@link hasPlainOwnDataProperties}.
 *
 * THE SHAPE IS TESTED WITHOUT COMPARING PROTOTYPES BY IDENTITY, which is the
 * one thing this check must not do. `response.json()` is implemented by the
 * platform, so the object it returns is built from the prototypes of whatever
 * realm the platform's parser runs in — under Jest that is the Node realm and
 * not the test module's, so `prototype === Object.prototype` answers `false`
 * for an ordinary parsed body and would refuse every real response. What is
 * asked instead holds in any realm: the built-in tag, which names the internal
 * kind (`[object Date]` is a `Date` wherever it was made), and the LENGTH of
 * the prototype chain, which separates a plain object (`Object.prototype`, one
 * link) and an array (`Array.prototype` then `Object.prototype`, two) from a
 * class instance, which carries one link more. Neither prototype in a plain
 * chain defines `toJSON`, so an inherited one cannot slip past; an own one is
 * refused by the walk as a function value when it is an ordinary property and
 * by {@link hasPlainOwnDataProperties} when it is hidden.
 */
const JSON_OBJECT_TAG = '[object Object]';
const JSON_ARRAY_TAG = '[object Array]';
const PLAIN_OBJECT_PROTOTYPE_LINKS = 1;
const PLAIN_ARRAY_PROTOTYPE_LINKS = 2;

const prototypeChainLength = (value: object): number => {
    let links = 0;

    for (let prototype = Object.getPrototypeOf(value) as object | null; prototype !== null; prototype = Object.getPrototypeOf(prototype) as object | null) {
        links += 1;
    }

    return links;
};

const isPlainJsonContainer = (value: object): boolean => {
    const tag = Object.prototype.toString.call(value);
    const links = prototypeChainLength(value);
    const shapeIsPlain = Array.isArray(value)
        ? tag === JSON_ARRAY_TAG && links === PLAIN_ARRAY_PROTOTYPE_LINKS
        : // A `null` prototype is zero links and is JSON data all the same.
          tag === JSON_OBJECT_TAG && links <= PLAIN_OBJECT_PROTOTYPE_LINKS;

    return shapeIsPlain && hasPlainOwnDataProperties(value);
};

/**
 * Refuses anything the `usda_api_cache.payload` column cannot hold faithfully.
 *
 * Walks the value rather than asserting about it: `null`, a finite number, a
 * boolean, a string, an array and a plain object are JSON and are accepted as
 * they are; a `bigint`, a function, a symbol, `undefined`, a non-finite number
 * or a structure deeper than {@link MAX_RECORDED_PAYLOAD_DEPTH} is not, and is
 * reported rather than written — `JSON.stringify` renders a non-finite number
 * as `null` and drops the rest, so a row holding one would not be the response
 * it claims to be.
 *
 * "Faithfully" is the whole test, and it is stricter than "serialises without
 * error": a `Date` nested anywhere in the value serialises perfectly well, into
 * an ISO STRING, and the row would then differ from the value this module hands
 * back for digesting. So a container is required to be a plain JSON container
 * ({@link isPlainJsonContainer}) and not merely an object whose values happen to
 * be JSON.
 */
const assertRecordable = (value: unknown, depth: number): void => {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return;
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new UsdaError('USDA response holds a non-finite number, which JSON cannot represent');
        }
        return;
    }

    if (typeof value !== 'object') {
        // `bigint`, `function`, `symbol` and `undefined`. The type is named and
        // the VALUE never is: this message travels to a caller that may log it.
        throw new UsdaError(`USDA response holds a ${typeof value}, which JSON cannot represent`);
    }

    if (depth >= MAX_RECORDED_PAYLOAD_DEPTH) {
        throw new UsdaError(`USDA response nests deeper than ${MAX_RECORDED_PAYLOAD_DEPTH} levels`);
    }

    if (!isPlainJsonContainer(value)) {
        // The KIND of problem is named and neither the value nor its
        // constructor is: this message travels to a caller that may log it.
        throw new UsdaError(
            'USDA response holds an object JSON cannot represent faithfully, such as a Date, a class instance, or a property behind an accessor',
        );
    }

    for (const nested of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
        assertRecordable(nested, depth + 1);
    }
};

/**
 * The one conversion between a fetched vendor document and the value written to
 * `usda_api_cache.payload`.
 *
 * A `response.json()` body always satisfies the check: it is the output of a
 * JSON parse, so every node in it is a plain JSON value by construction and
 * the walk cannot find anything to refuse. The check is here for everything
 * that is not that — a stubbed or future response source, or a caller handing
 * this module a value it built itself — because the payload is handed back to
 * the caller AS WELL as written, and the two must be the same value: a batch
 * caller digests what it is given and publishes the digest beside the cache key
 * naming the row (AAP §0.3.2/§0.5.1), so a row that serialises to something
 * else would make a published record disagree with the row it points at.
 *
 * REFUSAL RATHER THAN NORMALISATION is the choice that keeps that true with one
 * value instead of two. Normalising (round-tripping through `JSON.stringify`)
 * would also work, and would have to return the normalised value for the caller
 * to digest — a second value, a copy of every response on the hot path, and a
 * silent rewrite of a document this module did not build. Refusing instead
 * leaves exactly one value in play: nothing is copied, nothing is repaired, and
 * the value returned is the value inspected and the value recorded.
 */
const toRecordedPayload = (payload: unknown): UsdaRecordedPayload => {
    assertRecordable(payload, 0);

    return payload as UsdaRecordedPayload;
};

// `http_status` is written on every path that writes a payload, including the
// background refresh: the column records the status of the exchange that
// produced the row it sits on, so a refreshed row carries the refresh's status
// rather than the one the replaced payload arrived with.
const upsertCache = async (cacheKey: string, payload: UsdaRecordedPayload, httpStatus: number): Promise<void> => {
    // A JSON `null` document goes in through Prisma's own sentinel: the column
    // is NOT NULL and Prisma reserves a JS `null` for "set the column to
    // database NULL", so passing one through would be refused as ambiguous
    // rather than recorded as the document the vendor actually answered.
    const recorded = payload === null ? Prisma.JsonNull : payload;

    await prisma.usda_api_cache.upsert({
        where: { cache_key: cacheKey },
        create: { cache_key: cacheKey, payload: recorded, http_status: httpStatus },
        update: { payload: recorded, http_status: httpStatus, fetched_at: new Date() },
    });
};

/**
 * THE TWO CACHE-WRITE POSTURES, STATED WHERE BOTH OF THEM ARE.
 *
 * This function is the REQUEST-PATH write: best-effort and silent. A client is
 * waiting, the response is already in hand, and nothing on that path claims the
 * row exists — `searchBrandedFoods` answers from the payload itself whether or
 * not the write landed — so a read-only or unreachable database must not turn
 * an answered request into a failed one, and a cache miss that will be retried
 * on the next call past TTL is not an operator event.
 *
 * `usdaPost`'s batch write is the opposite on both counts: mandatory and
 * logged. The cache key it returns is published as the durable location of the
 * raw retrieval evidence every `catalog_validation_records.identity_evidence`
 * record quotes (Agent Action Plan §0.3.2/§0.5.1), so a swallowed failure there
 * would publish a record pointing at a row that does not exist.
 *
 * The difference is a statement about the CALLER — whether anything downstream
 * depends on the row — and not about how likely either write is to fail.
 */
const recordResponse = async (cacheKey: string, payload: unknown, httpStatus: number): Promise<void> => {
    try {
        await upsertCache(cacheKey, toRecordedPayload(payload), httpStatus);
    } catch {
        // Best-effort by the rule above, and `async` so a refusal from
        // `toRecordedPayload` is caught here alongside a rejected write.
    }
};

/**
 * The refreshes that have not finished yet, keyed by the cache key each one
 * will write.
 *
 * A `Map` rather than a set of keys because the promise is the point: the key
 * still gives two readers of one stale row a single shared refresh between
 * them, and holding the promise is what lets a caller WAIT for the work its own
 * read started (see {@link awaitPendingUsdaRefreshes}).
 *
 * An entry is removed by the refresh that owns it, and only ever by that one: a
 * key is occupied for exactly as long as its refresh runs, so no later refresh
 * can be created to be deleted by an earlier one.
 */
const pendingRefreshes = new Map<string, Promise<void>>();

/**
 * Starts the refresh of one stale row, or joins the one already running for it.
 *
 * The returned promise never rejects: a failed refresh leaves the stale row in
 * place to be served, which is the behaviour the callers below depend on
 * whether they wait for it or not.
 */
const startRefresh = (cacheKey: string, path: string, params: Record<string, string>): Promise<void> => {
    const inFlight = pendingRefreshes.get(cacheKey);
    if (inFlight !== undefined) {
        return inFlight;
    }

    const refresh = fetchFromUsda(path, params)
        .then(({ payload, httpStatus }) => recordResponse(cacheKey, payload, httpStatus))
        .catch(() => {
            // Stale row keeps being served; the next request past TTL retries.
        })
        .finally(() => {
            pendingRefreshes.delete(cacheKey);
        });

    pendingRefreshes.set(cacheKey, refresh);

    return refresh;
};

/**
 * Resolves once no refresh this module started is still running.
 *
 * Exported because a stale read on the background posture below answers from
 * the row it already has and leaves the refresh running, which is right while a
 * client is waiting and wrong for a process that is about to finish:
 * `scripts/lib/rateLimiter.ts` restores the `globalThis.fetch` it wrapped when
 * its stage ends, and a request still in flight past that point is one no
 * limiter paced, no token was charged for, and no report mentions. Anything
 * that wraps `fetch`, or that publishes counts of what it fetched, drains here
 * before it reports or restores.
 *
 * The import path needs no such call — `listFoods` and `getFoodDetail` leave
 * nothing in flight (see {@link UsdaReadMode}) — so this is the drain for a
 * process that also reaches the request-path readers, and the assertion a test
 * can make that a reader left nothing behind.
 *
 * The loop is not decoration: a reader can start a refresh while this call is
 * waiting, so "none remain" is re-checked rather than assumed after one pass.
 */
export const awaitPendingUsdaRefreshes = async (): Promise<void> => {
    while (pendingRefreshes.size > 0) {
        await Promise.all(Array.from(pendingRefreshes.values()));
    }
};

/**
 * Whether a reader may leave work running after it has answered.
 *
 * `'background'` is the REQUEST-PATH posture and the behaviour that shipped: a
 * stale row is served at once and its refresh — like the cold path's cache
 * write — carries on after the response has gone out, because a mobile client
 * is waiting on the call and neither operation changes the answer.
 *
 * `'awaited'` is the OFFLINE-IMPORT posture: the reader waits for the refresh
 * and for the cold path's cache write before answering, so a run that has
 * finished reading has nothing of this module's left in flight — nothing to
 * outlive the `globalThis.fetch` wrapper the import's rate limiter installs,
 * and nothing to land after the run has written its counts.
 *
 * Waiting changes neither operation's FAILURE posture: a failed refresh still
 * serves the stale row, and a failed cold-path write still returns the fetched
 * payload.
 */
type UsdaReadMode = 'background' | 'awaited';

// Stale-while-revalidate over fetchFromUsda: cached rows are served no matter
// their age (a month-old food search is not meaningfully wrong), with rows
// past TTL refreshed either off the request path or before the call answers,
// per the caller's `mode`. Cache/DB errors fall through to a live USDA call
// rather than failing the request.
//
// The mode is a required argument rather than a defaulted one so that a reader
// added later has to state which posture it belongs to instead of inheriting
// detached work by omission.
const usdaGet = async (path: string, params: Record<string, string>, mode: UsdaReadMode): Promise<unknown> => {
    const cacheKey = cacheKeyFor(path, params);

    let cached: { payload: unknown; fetched_at: Date } | null = null;
    try {
        cached = await prisma.usda_api_cache.findUnique({ where: { cache_key: cacheKey } });
    } catch {
        cached = null;
    }

    if (cached) {
        if (Date.now() - cached.fetched_at.getTime() > ttlForPath(path)) {
            const refresh = startRefresh(cacheKey, path, params);
            if (mode === 'awaited') {
                await refresh;
            }
        }
        // The row that was read, never the refreshed payload: this call's
        // answer is the row it found, and waiting for a refresh is about the
        // work's lifecycle rather than about serving fresher data.
        return cached.payload;
    }

    const { payload, httpStatus } = await fetchFromUsda(path, params);
    const write = recordResponse(cacheKey, payload, httpStatus);
    if (mode === 'awaited') {
        await write;
    }
    return payload;
};

/**
 * What one batch call observed about its own retrieval.
 *
 * Every member is a fact the call itself saw, which is the point: the cache
 * write is awaited (below), so the presence of a row no longer tells a caller
 * whether this call fetched or replayed and the answer has to travel out of the
 * call rather than be re-derived from the table afterwards.
 */
interface UsdaPostResult {
    readonly payload: unknown;
    /**
     * `usda_api_cache.cache_key` this response IS filed under — a row that
     * exists by the time this value is returned, on the replay branch because
     * it was read from there and on the live branch because the call does not
     * return until the write has been recorded. A write that cannot be
     * recorded fails the call instead of returning a key to a row that is not
     * there.
     */
    readonly cacheKey: string;
    readonly origin: 'cache' | 'network';
    /** See {@link UsdaBatchRetrievalFacts.httpStatus} for what `null` means. */
    readonly httpStatus: number | null;
    readonly fetchedAt: Date;
}

// The batch POST cannot go through usdaGet — that path is GET-only and its key
// is not body-aware — so it reads and writes the same cache table through
// cacheKeyForRequest. It shares usdaGet's READ posture, where a failed cache
// read falls through to a live call, and not its write posture: this path's
// write is mandatory, for the reason stated with both of them at
// `recordResponse`. A cached batch is served whatever its AGE and is never
// refreshed in the background: detail records are near-immutable, and a
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
    // replaces all three together, so the row stops being a pre-ledger row
    // rather than being annotated with a status that belongs to a different
    // response. The re-fetch goes through the same `globalThis.fetch` the
    // import's limiter wraps, so it is paced and counted like any other
    // attempt.
    //
    // THE CONDITION CLEARS WHEN THE RESPONSE IS RECORDED, not when it is
    // fetched, and that is the whole of the rule: a recorded replacement
    // carries a status, so the next call replays it and adds no steady-state
    // traffic. One re-fetch per pre-ledger batch, once.
    //
    // A write that cannot be recorded clears nothing, and the honest reading of
    // that is worth stating. The upsert is a single statement: it either
    // replaces the row or leaves it untouched, so a failed write leaves the
    // pre-ledger row exactly as it was — still statusless — and the next call
    // reads the same row, re-fetches and tries to record again. That repeats
    // for as long as the cache refuses writes. What bounds the cost is not the
    // row going away but the failure being visible: this path RAISES instead of
    // returning (below), so a cache that has stopped accepting writes shows up
    // as a reported outage on every affected call, never as ordinary success
    // sitting on top of a silent re-fetch loop.
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
    // Narrowed BEFORE the write and outside the guard below, so that "this
    // body is not something the column can hold" and "the database refused the
    // write" stay distinguishable: both fail the call, and only the second is
    // an operational fault worth an event. `toRecordedPayload`'s own refusal
    // names a type and never a value, so it is safe to hand to a caller.
    const recordable = toRecordedPayload(payload);
    // AWAITED AND MANDATORY, unlike the request path's best-effort write (see
    // `recordResponse` above for both postures side by side). No client is
    // waiting on a batch; what waits on it is a published evidence record that
    // names `cacheKey` as the location of this raw response, so returning
    // success with no row would make that record point at nothing.
    try {
        await upsertCache(cacheKey, recordable, httpStatus);
    } catch (error) {
        // ONE structured event, and everything in it is a value this module
        // chose: the endpoint, the key, the error's class name and its machine
        // code (Prisma's `P2002`). `describeErrorSafely` is the only reader of
        // the thrown value, so the message, stack, cause and Prisma `meta` —
        // which carry the connection string and the failing statement's values
        // — are not reachable from here at all (Rule backend-architecture §8,
        // Agent Action Plan §0.3.2).
        logSafeEvent('error', 'usda_batch_cache_write_failed', {
            path,
            cacheKey,
            ...describeErrorSafely(error),
        });
        // Then the failure crosses the boundary as this module's own typed
        // error (Rule backend-architecture §9), because the caller cannot
        // publish evidence it does not have and must not be told otherwise.
        // The driver error is deliberately NOT attached as a `cause`: it would
        // travel out of this module carrying exactly the text the event above
        // exists to keep out of a log.
        throw new UsdaError(
            'USDA batch response could not be recorded in usda_api_cache, so the retrieval evidence its cache ' +
                'key names does not exist',
        );
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

// Vendor data is never trusted structurally: a property is read only after the
// value it sits on has been proven to be a record, which is what keeps a
// `payload` of `unknown` honest instead of an `any` that typechecks every
// mistake. Arrays and `null` are not records here, so an array or null document
// reads as "absent" rather than as something with keys —
// `openrouter.service.ts::asRecord` is the same predicate for the same reason.
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

// A search envelope whose `foods` member is absent or is not an array carries
// no results, which is what these paths have always answered for one.
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);

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

/**
 * Reads one nutrient's per-100 value out of a search result's `foodNutrients`.
 *
 * The FIRST row matching the nutrient number decides the answer, including when
 * its `value` is unusable — a second row for the same nutrient is not consulted
 * — because a search result carries one row per nutrient and a duplicate would
 * be a response this module should not quietly repair.
 */
const readPer100Nutrient = (nutrients: readonly unknown[], nutrientNumber: string): number | null => {
    for (const entry of nutrients) {
        const nutrient = asRecord(entry);
        if (nutrient === undefined || String(nutrient.nutrientNumber) !== nutrientNumber) {
            continue;
        }

        const value = Number(nutrient.value);

        return Number.isFinite(value) ? value : null;
    }

    return null;
};

export const searchGenericFoods = async (query: string, limit: number = 6): Promise<GenericFoodCandidate[]> => {
    const data = asRecord(
        await usdaGet(
            '/foods/search',
            {
                query,
                dataType: 'Survey (FNDDS),SR Legacy,Foundation',
                pageSize: String(limit),
                pageNumber: '1',
            },
            'background',
        ),
    );
    const foods = asArray(data?.foods);

    return foods
        .map((entry: unknown): GenericFoodCandidate | null => {
            const food = asRecord(entry);
            if (food === undefined) return null;
            const description = food.description;
            const nutrients = food.foodNutrients;
            if (!food.fdcId || typeof description !== 'string' || !Array.isArray(nutrients)) {
                return null;
            }
            const per100 = (nutrientNumber: string): number | null =>
                readPer100Nutrient(nutrients as unknown[], nutrientNumber);
            const protein = per100(NUTRIENT_PROTEIN);
            const fat = per100(NUTRIENT_FAT);
            const carbs = per100(NUTRIENT_CARBS);
            if (protein === null || fat === null || carbs === null) return null;
            const calories = per100(NUTRIENT_CALORIES) ?? protein * 4 + carbs * 4 + fat * 9;
            return {
                fdcId: String(food.fdcId),
                description,
                dataType: String(food.dataType ?? ''),
                caloriesPer100g: calories,
                proteinPer100g: protein,
                carbsPer100g: carbs,
                fatPer100g: fat,
            };
        })
        .filter((food: GenericFoodCandidate | null): food is GenericFoodCandidate => food !== null);
};

// A branded food's display brand: `brandName` when it has one, `brandOwner`
// when it does not, and null when neither is a non-blank string. Shared by the
// search and detail paths, which resolve it identically.
const resolveBrand = (record: Record<string, unknown>): string | null => {
    const brandName = record.brandName;
    if (typeof brandName === 'string' && brandName.trim()) {
        return titleCase(brandName);
    }

    const brandOwner = record.brandOwner;

    return typeof brandOwner === 'string' && brandOwner.trim() ? titleCase(brandOwner) : null;
};

export const searchBrandedFoods = async (query: string): Promise<BrandedFoodResponse[]> => {
    const data = asRecord(
        await usdaGet(
            '/foods/search',
            {
                query,
                dataType: 'Branded',
                pageSize: '20',
                pageNumber: '1',
            },
            'background',
        ),
    );
    const foods = asArray(data?.foods);

    return foods
        .map((entry: unknown): BrandedFoodResponse | null => {
            const food = asRecord(entry);
            if (food === undefined) return null;
            const servingSize = Number(food.servingSize);
            const description = food.description;
            const servingSizeUnit = food.servingSizeUnit;
            const nutrients = food.foodNutrients;
            if (
                !food.fdcId ||
                typeof description !== 'string' ||
                !Number.isFinite(servingSize) ||
                servingSize <= 0 ||
                typeof servingSizeUnit !== 'string' ||
                !Array.isArray(nutrients)
            ) {
                return null;
            }

            // Search-result nutrients are per 100g/100ml; scale to one serving.
            const perServing = (nutrientNumber: string): number | null => {
                const per100 = readPer100Nutrient(nutrients as unknown[], nutrientNumber);

                return per100 === null ? null : (per100 * servingSize) / 100;
            };

            const protein = perServing(NUTRIENT_PROTEIN);
            const fat = perServing(NUTRIENT_FAT);
            const carbs = perServing(NUTRIENT_CARBS);
            if (protein === null || fat === null || carbs === null) return null;
            // Prefer USDA's energy value; fall back to 4/4/9 when it's absent.
            const calories = perServing(NUTRIENT_CALORIES) ?? protein * 4 + carbs * 4 + fat * 9;

            const householdServingText = food.householdServingFullText;
            const servingText =
                typeof householdServingText === 'string' && householdServingText.trim()
                    ? householdServingText.trim().toLowerCase()
                    : `${servingSize} ${servingSizeUnit.toLowerCase()}`;

            return {
                id: String(food.fdcId),
                name: titleCase(description),
                brand: resolveBrand(food),
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
    const data = asRecord(await usdaGet(`/food/${encodeURIComponent(foodId)}`, { format: 'full' }, 'background'));
    const description = data?.description;
    if (data === undefined || !data.fdcId || typeof description !== 'string') return null;

    // Detail responses carry labelNutrients that are already per-serving.
    const label = asRecord(data.labelNutrients);
    const toValue = (entry: unknown): number | null => {
        const value = Number(asRecord(entry)?.value);
        return Number.isFinite(value) ? value : null;
    };
    const protein = toValue(label?.protein);
    const carbs = toValue(label?.carbohydrates);
    const fat = toValue(label?.fat);
    if (protein === null || carbs === null || fat === null) return null;
    const calories = toValue(label?.calories) ?? protein * 4 + carbs * 4 + fat * 9;

    const servingSize = Number(data.servingSize);
    const householdServingText = data.householdServingFullText;
    const servingSizeUnit = data.servingSizeUnit;
    const servingText =
        typeof householdServingText === 'string' && householdServingText.trim()
            ? householdServingText.trim().toLowerCase()
            : Number.isFinite(servingSize) && typeof servingSizeUnit === 'string'
                ? `${servingSize} ${servingSizeUnit.toLowerCase()}`
                : null;

    return {
        id: String(data.fdcId),
        name: titleCase(description),
        brand: resolveBrand(data),
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

/**
 * `{}` exactly — a plain object carrying no own enumerable key.
 *
 * Declared as a predicate of its own, rather than inlined, because it is the
 * one payload shape that means something instead of being wrong: it is how
 * `GET /foods/list` reports that the requested page lies past the end of its
 * dataset (see `listFoods`). Keeping it beside `toIdentifiedRecords` is what
 * makes the pair readable together — the loud refusal and the single measured
 * exception to it — and keeping it this narrow is what stops the exception
 * spreading: an object with any key at all fails the predicate and goes to
 * `toIdentifiedRecords` to be refused, as does an array, `null` and every
 * scalar.
 */
const isEmptyJsonObject = (payload: unknown): boolean =>
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    Object.keys(payload as Record<string, unknown>).length === 0;

// A malformed batch/list payload fails loudly instead of degrading to an empty
// array: the import's coverage report counts what came back, so a silent []
// would be recorded as "USDA holds none of these foods" rather than "USDA's
// answer was unusable", and the missing rows would never be retried. An empty
// array from USDA is a real, valid answer and stays one. The one measured
// exception is the end-of-dataset `{}` of `GET /foods/list`, which `listFoods`
// screens off with `isEmptyJsonObject` above before reaching here.
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
//
// Read in the `'awaited'` posture, unlike getBrandedFood on the same path: this
// function serves offline runs, which must not leave a refresh or a cache write
// running past the point where their rate limiter is uninstalled and their
// counts are written.
export const getFoodDetail = async (fdcId: string | number): Promise<UsdaFoodDetail> => {
    // normalizeFdcIds guarantees a positive integer, so — unlike
    // getBrandedFood's client-supplied id — the path needs no escaping.
    const [id] = normalizeFdcIds([fdcId]);
    const payload: unknown = await usdaGet(`/food/${id}`, { format: 'full' }, 'awaited');
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
     *
     * The row is there when this value is returned, on either branch: a replay
     * read it, and a live fetch does not return until its write has been
     * recorded. A write that cannot be recorded fails the call with a
     * `UsdaError` rather than handing back a key a published evidence record
     * would quote for a row that does not exist.
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
//
// The import's enumeration step, and the reason the `'awaited'` posture exists:
// a sweep reads hundreds of pages, so a detached refresh per stale page is
// hundreds of requests that can still be in flight when the run restores the
// `fetch` it wrapped and reports how many requests it made. Awaiting them makes
// those numbers the run's own.
export const listFoods = async (
    dataType: string,
    pageSize: number = MAX_LIST_PAGE_SIZE,
    pageNumber: number = 1,
): Promise<UsdaFoodSummary[]> => {
    const payload: unknown = await usdaGet(
        '/foods/list',
        {
            dataType: dataType.trim(),
            pageSize: String(clampListPageSize(pageSize)),
            pageNumber: String(clampPageNumber(pageNumber)),
        },
        'awaited',
    );
    // PAST THE END OF A DATASET, THIS ENDPOINT ANSWERS `{}` AND NOT `[]`, and
    // translating that into the empty page it means is this boundary's job
    // rather than every caller's. Measured against the live API on 2026-09-18,
    // at pageSize 200 with HTTP 200 and a two-byte body, for every dataset the
    // catalog sweeps: Foundation page 3 (twice) and page 9, SR Legacy page 40,
    // Survey (FNDDS) page 29 — the first page after each sweep's
    // `observedLastNonEmptyPage` in data/meal-planning/usda-manifest.v1.json.
    //
    // WHAT IT COST WHILE THIS WAS ABSENT. `toIdentifiedRecords` refuses a
    // non-array loudly and is right to: a malformed batch degraded to `[]`
    // would be recorded as "USDA holds none of these foods". But an
    // end-of-dataset marker is not a malformed payload, and the sweep in
    // scripts/catalog-import-usda.ts stops on `rows.length === 0` — a
    // stopping condition the vendor's real answer could never reach. So the
    // full import died with `usda_request_failed` on the first page after the
    // data of its FIRST sweep, and no environment could build a catalog from
    // the manifest at all.
    //
    // NARROW BY CONSTRUCTION, so nothing else relaxes. Only the list context,
    // only a plain object, and only one with no own enumerable keys: a
    // populated object here is still a payload shape this endpoint must not
    // return, `null` and every scalar are still refused, and the batch and
    // detail contexts are untouched. An empty ARRAY remains a real, valid
    // answer with the same meaning.
    if (isEmptyJsonObject(payload)) {
        return [];
    }
    return toIdentifiedRecords<UsdaFoodSummary>(payload, 'list');
};
