import { EstimateItem, EstimateResponse, LabelScanResponse } from '../types/nutrition';
import { GenericFoodCandidate, USDA_REQUEST_CALL_BUDGET_MS, searchGenericFoods } from './usda.service';
import {
    MessageContent,
    OPENROUTER_REQUEST_TIMEOUT_MS,
    OpenRouterError,
    callOpenRouter,
    getOpenRouterConfig,
} from './openrouter.service';

// Access control (kill switch, daily quota) lives in entitlement.service —
// controllers call assertAndConsumeAiCall before invoking this service.

// ---------------------------------------------------------------------------
// The request's vendor budget.
//
// One estimate is up to three vendor steps — the model call, the USDA
// candidate searches, and the grounding judge call — and each of them used to
// carry its own deadline. Separate deadlines add up: a request could spend 30 s
// on the estimate, then wait on USDA, then spend another 30 s on the judge,
// while the mobile client abandoned it at 25 s and the user retried, paying for
// a second estimate. Bounding one call is therefore not enough; what has to be
// bounded is the request.
//
// So the budget below is started once per estimate and every vendor step draws
// from the remainder: two model calls inside one budget cannot outlast one.
// The size is the vendor boundary's own per-call ceiling, which is already
// derived from the client's 25 s deadline (see
// OPENROUTER_REQUEST_TIMEOUT_MS) — a single call may legitimately use the
// whole request, and nothing may use more.
// ---------------------------------------------------------------------------

const VENDOR_BUDGET_MS = OPENROUTER_REQUEST_TIMEOUT_MS;

/**
 * The least the judge call is worth attempting with.
 *
 * Below this the classification would abort mid-flight, which costs a paid call
 * and returns the ungrounded estimate anyway.
 */
const JUDGE_MIN_BUDGET_MS = 1_500;

/**
 * What grounding needs before it is worth starting: the USDA boundary's own
 * worst case for one call (its attempts and backoff are bounded by that number,
 * and the searches run in parallel, so it is the wall time of the whole
 * candidate lookup) plus a judge call.
 *
 * Imported rather than restated, so the reserve cannot drift from the deadline
 * the USDA boundary actually enforces.
 */
const GROUNDING_MIN_BUDGET_MS = USDA_REQUEST_CALL_BUDGET_MS + JUDGE_MIN_BUDGET_MS;

interface VendorBudget {
    /** Milliseconds left of the request's budget; never negative. */
    remainingMs(): number;
}

const startVendorBudget = (totalMs: number = VENDOR_BUDGET_MS): VendorBudget => {
    const startedAt = Date.now();

    return {
        remainingMs: (): number => Math.max(0, totalMs - (Date.now() - startedAt)),
    };
};

export class EstimateFailedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EstimateFailedError';
    }
}

const ESTIMATE_SYSTEM_PROMPT = `You are a nutritionist estimating the calories and macros of a single eating occasion.
Rules:
- Return one item per distinct food or drink.
- Estimate as-eaten portions (what the person actually consumed), not label servings.
- All calorie and gram values are integers.
- "quantityText" is a short human-readable portion ONLY, e.g. "2", "1 slice", "12 oz", "1 bowl" — never include calories or nutrient values in it.
- "grams" is your best estimate of the item's total as-eaten weight in grams (for drinks, total milliliters).
- Set confidence to "low" when portion sizes are guesses, "high" only when quantities are explicit.
- Never refuse: always give a best-effort estimate, and use "notes" for any assumption worth flagging (e.g. "Assumed whole milk in the latte.").`;

const JUDGE_SYSTEM_PROMPT = `You match eaten-food items to USDA database entries.
For each item, pick the index of the candidate that is genuinely the same food as eaten, or -1 if none is a confident match.
Rules:
- Preparation matters: fried vs boiled, cooked vs raw, with-milk vs black.
- A composite item ("toast with peanut butter") should only match a candidate that covers the WHOLE item; component-only candidates are not a match.
- A single plain food SHOULD match its generic database entry: "plain bagel" matches "Bagel" or "Bagels, plain, enriched...". Parenthetical variant lists like "(includes onion, poppy, sesame)" do not disqualify a match.
- Reject candidates whose per-100g values are nutritionally implausible for that food (database entry errors exist).
- Among plausible candidates, prefer the plain/typical/default variant of the food ("Rice, white, cooked" over "Rice, white, cooked, glutinous") unless the item text specifies the variant.
- Return -1 only when preparation clearly differs, the item is composite with no whole-item candidate, or every candidate is a different food.
- Output "matches" as an array of integers aligned with the items, one per item.

Examples:
- item "plain bagel (~100g)", candidates ["Snacks, bagel chips, plain", "Bagels, plain, enriched, with calcium propionate (includes onion, poppy, sesame)", "Bagel"] -> match index 2 (or 1) — a bagel is a bagel; bagel CHIPS are not.
- item "fried eggs (2, ~92g)", candidates ["Egg, whole, cooked, fried", "Egg, whole, raw"] -> match index 0.
- item "toast with peanut butter", candidates ["Bread, toasted", "Peanut butter, smooth"] -> -1 (components only, no whole-item candidate).`;

const LABEL_SCAN_SYSTEM_PROMPT = `You read nutrition-facts labels from photos.
Rules:
- Transcribe the printed PER-SERVING values exactly — do not estimate or adjust.
- Only fill "name" if a product name is clearly visible; otherwise null.
- "servingAmount"/"servingUnit" come from the serving-size line (e.g. "2/3 cup" -> amount 0.67, unit "cup"); null when unreadable.
- All calorie and gram values are integers.
- Set confidence "low" if the label is blurry, cropped, or partially obscured.`;

const ESTIMATE_JSON_SCHEMA = {
    name: 'meal_estimate',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            items: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        quantityText: { type: 'string' },
                        grams: { type: 'integer' },
                        calories: { type: 'integer' },
                        protein: { type: 'integer' },
                        carbs: { type: 'integer' },
                        fat: { type: 'integer' },
                    },
                    required: ['name', 'quantityText', 'grams', 'calories', 'protein', 'carbs', 'fat'],
                    additionalProperties: false,
                },
            },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            notes: { type: ['string', 'null'] },
        },
        required: ['items', 'confidence', 'notes'],
        additionalProperties: false,
    },
};

const LABEL_SCAN_JSON_SCHEMA = {
    name: 'label_scan',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            name: { type: ['string', 'null'] },
            servingAmount: { type: ['number', 'null'] },
            servingUnit: { type: ['string', 'null'] },
            calories: { type: 'integer' },
            protein: { type: 'integer' },
            carbs: { type: 'integer' },
            fat: { type: 'integer' },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['name', 'servingAmount', 'servingUnit', 'calories', 'protein', 'carbs', 'fat', 'confidence'],
        additionalProperties: false,
    },
};

const buildUserContent = (text?: string, imageBase64?: string): MessageContent => {
    if (!imageBase64) return text ?? '';
    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    if (text) parts.push({ type: 'text', text });
    parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } });
    return parts;
};

// The OpenRouter transport lives in openrouter.service, which raises
// OpenRouterError for every failure mode. The controller only maps
// EstimateFailedError (→ 502), so every model call this service makes goes
// through here: one translation point, not one per call site. The vendor error
// already carries the exact message this endpoint has always returned —
// including the HTTP status and the truncated response body — so it is passed
// through verbatim rather than rebuilt per kind. Anything that is not a vendor
// failure propagates untouched.
//
// The model output is returned as `unknown`: the vendor boundary validates the
// transport and the JSON syntax, never the shape, so each call site below
// narrows the fields it reads instead of trusting model-controlled data.
//
// `resolveModel` is a thunk and not a resolved string because reading the
// vendor configuration can itself fail: an argument expression is evaluated
// BEFORE this function is entered, so a call site that passed
// `getOpenRouterConfig().judgeModel` directly would let an unconfigured key
// raise a raw OpenRouterError outside the try below — past the one translation
// point and out of this service untranslated. Invoked inside the try, that
// failure becomes the same EstimateFailedError as every other vendor failure.
// `fetchImpl` is the transport seam callOpenRouter already declares;
// `undefined` leaves it using the global `fetch`.
//
// `timeoutMs` is what is left of the request's budget. Passing it — rather than
// letting each call take the vendor default — is what makes the budget a
// property of the request instead of a property of one call.
const callModel = async (
    systemPrompt: string,
    userContent: MessageContent,
    jsonSchema: object,
    resolveModel?: () => string,
    fetchImpl?: typeof fetch,
    timeoutMs?: number,
): Promise<unknown> => {
    try {
        return await callOpenRouter(systemPrompt, userContent, jsonSchema, resolveModel?.(), fetchImpl, timeoutMs);
    } catch (error) {
        if (error instanceof OpenRouterError) {
            throw new EstimateFailedError(error.message);
        }
        throw error;
    }
};

const toInt = (value: unknown): number => {
    const parsed = Math.round(Number(value));
    return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
};

// Readers for model-controlled values. They reproduce exactly what the previous
// optional-chained reads did: a non-record (including an array or null) has no
// readable fields, a blank or non-string text field is absent, and an
// unrecognised confidence falls back to 'medium' — a model is free to return
// any of these and the endpoint's response must not change shape because of it.
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

const readNonBlankString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

const CONFIDENCE_LEVELS: readonly EstimateResponse['confidence'][] = ['low', 'medium', 'high'];

const readConfidence = (value: unknown): EstimateResponse['confidence'] =>
    typeof value === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(value)
        ? (value as EstimateResponse['confidence'])
        : 'medium';

const JUDGE_JSON_SCHEMA = {
    name: 'food_matches',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            matches: { type: 'array', items: { type: 'integer' } },
        },
        required: ['matches'],
        additionalProperties: false,
    },
};

interface EstimateItemWithGrams extends EstimateItem {
    grams: number;
}

/**
 * The collaborators an estimate may be given instead of the production ones.
 *
 * Declared for the same reason `callOpenRouter` declares its own `fetchImpl`
 * parameter: the seam is part of the signature, so a unit test reaches the
 * grounding path — including the judge round trip — without a database or a
 * network, and without this module knowing it is under test. Both fields are
 * optional and default to the real collaborator, so the request path
 * (`nutrition.controller`) passes nothing and behaves exactly as before.
 *
 * `searchGenericFoods` is here rather than stubbed at the transport level
 * because it reaches `usdaGet`, which reads the `usda_api_cache` table through
 * Prisma before it ever looks at the USDA API key — a database connection no
 * unit test may open (backend-architecture §11).
 */
export interface EstimateDependencies {
    searchGenericFoods?: typeof searchGenericFoods;
    fetchImpl?: typeof fetch;
}

// Ground LLM items in USDA generic-food data: search candidates per item, let
// a judge call pick genuine matches, then scale per-100g values by the LLM's
// gram estimate. Any failure falls back to the raw LLM values — grounding can
// only replace numbers, never lose items or fail the estimate.
const groundItemsInUsda = async (
    items: EstimateItemWithGrams[],
    deps: EstimateDependencies,
    budget: VendorBudget,
): Promise<EstimateItem[]> => {
    const searchCandidates = deps.searchGenericFoods ?? searchGenericFoods;
    const candidateLists = await Promise.all(
        items.map(async (item) => {
            if (item.grams <= 0) return [];
            try {
                return await searchCandidates(item.name);
            } catch (error) {
                console.warn(`USDA candidate search failed for "${item.name}":`, (error as Error).message);
                return [];
            }
        }),
    );
    if (candidateLists.every((candidates) => candidates.length === 0)) return items;

    // The searches have spent part of the budget. Starting a judge call with
    // less than it needs would pay for a classification that aborts before it
    // answers, and the outcome either way is the model's own numbers.
    const judgeBudgetMs = budget.remainingMs();
    if (judgeBudgetMs < JUDGE_MIN_BUDGET_MS) {
        console.warn(`Grounding judge skipped: ${judgeBudgetMs}ms of the request budget left`);
        return items;
    }

    const judgeInput = items.map((item, index) => ({
        item: `${item.name} (${item.quantityText}, ~${item.grams}g)`,
        candidates: candidateLists[index].map(
            (candidate) =>
                `${candidate.description} [${candidate.dataType}] ` +
                `(per 100g: ${Math.round(candidate.caloriesPer100g)} cal, ${Math.round(candidate.proteinPer100g)}g P, ` +
                `${Math.round(candidate.carbsPer100g)}g C, ${Math.round(candidate.fatPer100g)}g F)`,
        ),
    }));
    // The judge is a classification task — it gets its own model tuned for
    // consistency (gemini-flash via OpenRouter routes across providers and
    // flip-flops on borderline matches even at temperature 0). Which model that
    // is belongs to the vendor boundary and is asked for here rather than
    // decided here: `getOpenRouterConfig().judgeModel` resolves
    // ESTIMATE_JUDGE_MODEL once at module load for every consumer of it
    // (backend-architecture §9), so this service never branches on the
    // environment.
    const judged = await callModel(
        JUDGE_SYSTEM_PROMPT,
        JSON.stringify(judgeInput, null, 2),
        JUDGE_JSON_SCHEMA,
        () => getOpenRouterConfig().judgeModel,
        deps.fetchImpl,
        judgeBudgetMs,
    );
    const judgedMatches = asRecord(judged)?.matches;
    const matches: unknown[] = Array.isArray(judgedMatches) ? judgedMatches : [];
    if (matches.length !== items.length) {
        console.warn(`Grounding judge returned ${matches.length} matches for ${items.length} items; skipping`);
        return items;
    }

    return items.map((item, index) => {
        const matchIndex = Number(matches[index]);
        const candidate: GenericFoodCandidate | undefined =
            Number.isInteger(matchIndex) && matchIndex >= 0 ? candidateLists[index][matchIndex] : undefined;
        if (!candidate || item.grams <= 0) return item;
        const scale = item.grams / 100;
        const groundedCalories = toInt(candidate.caloriesPer100g * scale);

        // Sanity guard: grounding should refine the LLM's number, not overturn
        // it. USDA has data-entry errors and the judge can pick a plausible-
        // sounding but wrong-density entry — if the grounded calories land
        // outside 0.5–2x of the LLM's own estimate (beyond a small absolute
        // tolerance), distrust the match and keep the estimate.
        const delta = Math.abs(groundedCalories - item.calories);
        const ratio = item.calories > 0 ? groundedCalories / item.calories : 1;
        if (delta > 60 && (ratio < 0.5 || ratio > 2)) {
            console.warn(
                `Grounding rejected for "${item.name}": USDA "${candidate.description}" gives ` +
                    `${groundedCalories} cal vs LLM estimate ${item.calories} cal`,
            );
            return item;
        }

        console.log(
            `Grounded "${item.name}" ⇐ USDA "${candidate.description}" ` +
                `(LLM ${item.calories} → ${groundedCalories} cal @ ${item.grams}g)`,
        );
        return {
            ...item,
            calories: groundedCalories,
            protein: toInt(candidate.proteinPer100g * scale),
            carbs: toInt(candidate.carbsPer100g * scale),
            fat: toInt(candidate.fatPer100g * scale),
            source: 'db_matched' as const,
            matchedTo: candidate.description,
        };
    });
};

// A model item is only usable when it is a record carrying a non-blank name;
// anything else (null, a number, a string, an array, a nameless object) is
// dropped, exactly as the previous name filter did. `quantityText` is passed
// through untrimmed — only a string survives, everything else becomes ''.
const toEstimateItem = (value: unknown): EstimateItemWithGrams | null => {
    const item = asRecord(value);
    if (!item) return null;
    const name = readNonBlankString(item.name);
    if (name === undefined) return null;
    return {
        name,
        quantityText: typeof item.quantityText === 'string' ? item.quantityText : '',
        grams: toInt(item.grams),
        calories: toInt(item.calories),
        protein: toInt(item.protein),
        carbs: toInt(item.carbs),
        fat: toInt(item.fat),
        source: 'estimated' as const,
        matchedTo: null,
    };
};

export const estimateMeal = async (
    text?: string,
    imageBase64?: string,
    deps: EstimateDependencies = {},
): Promise<EstimateResponse> => {
    const budget = startVendorBudget();
    const parsed = asRecord(
        await callModel(
            ESTIMATE_SYSTEM_PROMPT,
            buildUserContent(text, imageBase64),
            ESTIMATE_JSON_SCHEMA,
            undefined,
            deps.fetchImpl,
            budget.remainingMs(),
        ),
    );

    const parsedItems = parsed?.items;
    const modelItems: unknown[] = Array.isArray(parsedItems) ? parsedItems : [];
    let items: EstimateItem[] = modelItems
        .map(toEstimateItem)
        .filter((item): item is EstimateItemWithGrams => item !== null);
    if (items.length === 0) {
        throw new EstimateFailedError('Model returned no food items');
    }

    // Ground in USDA unless disabled; never let grounding break the estimate.
    //
    // The budget check is a third reason to skip, alongside the kill switch and
    // a failure: grounding is a refinement the client is waiting on, so once
    // the estimate itself has consumed the request's budget the honest answer
    // is the estimate the model already produced, delivered in time, rather
    // than a better one the client will never see.
    const groundingBudgetMs = budget.remainingMs();
    if (process.env.ESTIMATE_GROUNDING === 'off') {
        // Disabled: nothing to report.
    } else if (groundingBudgetMs < GROUNDING_MIN_BUDGET_MS) {
        console.warn(`USDA grounding skipped: ${groundingBudgetMs}ms of the request budget left`);
    } else {
        try {
            items = await groundItemsInUsda(items as EstimateItemWithGrams[], deps, budget);
        } catch (error) {
            console.error('USDA grounding failed, using raw LLM estimate:', (error as Error).message);
        }
    }

    return {
        items,
        total: items.reduce(
            (total, item) => ({
                calories: total.calories + item.calories,
                protein: total.protein + item.protein,
                carbs: total.carbs + item.carbs,
                fat: total.fat + item.fat,
            }),
            { calories: 0, protein: 0, carbs: 0, fat: 0 },
        ),
        confidence: readConfidence(parsed?.confidence),
        notes: readNonBlankString(parsed?.notes) ?? null,
    };
};

// One model call and no grounding, so the vendor default is already this
// request's whole budget and there is nothing to share it with — the deadline
// the client is promised holds without any arithmetic here.
export const scanLabel = async (imageBase64: string): Promise<LabelScanResponse> => {
    const parsed = asRecord(
        await callModel(LABEL_SCAN_SYSTEM_PROMPT, buildUserContent(undefined, imageBase64), LABEL_SCAN_JSON_SCHEMA),
    );

    const servingAmount = Number(parsed?.servingAmount);
    return {
        name: readNonBlankString(parsed?.name) ?? null,
        servingAmount: Number.isFinite(servingAmount) && servingAmount > 0 ? servingAmount : null,
        servingUnit: readNonBlankString(parsed?.servingUnit) ?? null,
        calories: toInt(parsed?.calories),
        protein: toInt(parsed?.protein),
        carbs: toInt(parsed?.carbs),
        fat: toInt(parsed?.fat),
        confidence: readConfidence(parsed?.confidence),
    };
};
