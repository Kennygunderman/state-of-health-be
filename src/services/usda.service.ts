import { BrandedFoodResponse } from '../types/nutrition';
import { prisma } from '../prisma/client';

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

// The batch endpoint is the only non-GET call this module makes; omitting the
// options leaves the request byte-for-byte the GET it has always been.
interface UsdaRequestOptions {
    method?: 'GET' | 'POST';
    body?: unknown;
}

const fetchFromUsda = async (
    path: string,
    params: Record<string, string>,
    options?: UsdaRequestOptions,
): Promise<any> => {
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

    let lastError: Error = new UsdaError('USDA request failed');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            // fetch is read from the global on every attempt because
            // scripts/lib/rateLimiter.ts wraps globalThis.fetch to charge a
            // token per physical attempt and must observe all four.
            const response = init === undefined ? await fetch(url) : await fetch(url, init);
            if (response.ok) {
                return await response.json();
            }
            // USDA's API intermittently 400s on requests that succeed when
            // retried verbatim (~1 in 5 observed) — so unlike a normal client
            // error, 400 is retried here alongside 429/5xx.
            lastError = new UsdaError(`USDA returned ${response.status}`);
        } catch (error) {
            lastError = new UsdaError(`USDA request failed: ${(error as Error).message}`);
        }
        if (attempt < MAX_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
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
// different food than the manifest text names. A number must already be a safe
// positive integer; a string must be decimal digits with no leading zero, sign,
// exponent or fraction. Everything else — including a nested array whose
// String() happens to look numeric — is rejected.
const parseFdcId = (value: unknown): number | null => {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value > 0 ? value : null;
    }
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value.trim())) {
        return null;
    }
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

// FDC ids are positive integers, so the same set in any order — or carrying a
// duplicate — must address one cached row and send one request, while a
// different set must never collide with it. Normalising to numbers also means a
// rerun that passes 1 where the first run passed '1' reuses the cached row
// instead of spending another request.
export const normalizeFdcIds = (fdcIds: ReadonlyArray<string | number>): number[] => {
    const unique = new Set<number>();
    for (const fdcId of fdcIds) {
        const parsed = parseFdcId(fdcId);
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

const upsertCache = async (cacheKey: string, payload: any): Promise<void> => {
    await prisma.usda_api_cache.upsert({
        where: { cache_key: cacheKey },
        create: { cache_key: cacheKey, payload },
        update: { payload, fetched_at: new Date() },
    });
};

const refreshing = new Set<string>();

const refreshInBackground = (cacheKey: string, path: string, params: Record<string, string>): void => {
    if (refreshing.has(cacheKey)) return;
    refreshing.add(cacheKey);
    fetchFromUsda(path, params)
        .then((payload) => upsertCache(cacheKey, payload))
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

    const payload = await fetchFromUsda(path, params);
    upsertCache(cacheKey, payload).catch(() => {
        // Caching is best-effort; the response is already in hand.
    });
    return payload;
};

// The batch POST cannot go through usdaGet — that path is GET-only and its key
// is not body-aware — so it reads and writes the same cache table through
// cacheKeyForRequest, with usdaGet's error posture: cache/DB failures fall
// through to a live call. A cached batch is served whatever its age and is
// never refreshed in the background: detail records are near-immutable, and a
// background request would spend one of the hour's requests outside the
// caller's rate accounting.
const usdaPost = async (path: string, params: Record<string, string>, body: unknown): Promise<unknown> => {
    const cacheKey = cacheKeyForRequest('POST', path, params, body);

    let cached: { payload: unknown } | null = null;
    try {
        cached = await prisma.usda_api_cache.findUnique({ where: { cache_key: cacheKey } });
    } catch {
        cached = null;
    }

    if (cached) {
        return cached.payload;
    }

    const payload = await fetchFromUsda(path, params, { method: 'POST', body });
    upsertCache(cacheKey, payload).catch(() => {
        // Caching is best-effort; the response is already in hand.
    });
    return payload;
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
    const fdcId = parseFdcId(record.fdcId);
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

export const getFoodsBatch = async (fdcIds: ReadonlyArray<string | number>): Promise<UsdaFoodDetail[]> => {
    if (fdcIds.length === 0) {
        return [];
    }
    // Silently truncating to the cap would make the import under-count and its
    // coverage report lie, so an over-length batch is rejected instead.
    if (fdcIds.length > MAX_BATCH_FDC_IDS) {
        throw new UsdaError(
            `USDA accepts at most ${MAX_BATCH_FDC_IDS} FDC ids per batch request, received ${fdcIds.length}`,
        );
    }

    const ids = normalizeFdcIds(fdcIds);
    const payload: unknown = await usdaPost('/foods', {}, { fdcIds: ids, format: 'full' });
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
    return records;
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
