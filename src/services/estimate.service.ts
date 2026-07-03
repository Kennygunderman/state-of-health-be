import { EstimateItem, EstimateResponse, LabelScanResponse } from '../types/nutrition';
import { GenericFoodCandidate, searchGenericFoods } from './usda.service';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 30_000;

// Per-user daily cap across estimate + label-scan combined. This is abuse
// protection for a leaked token, not cost management (calls are ~$0.001).
const DAILY_CALL_CAP = 50;
const callCounts = new Map<string, { day: string; count: number }>();

export class EstimateRateLimitError extends Error {
    constructor() {
        super('Daily estimate limit reached');
        this.name = 'EstimateRateLimitError';
    }
}

export class EstimateFailedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EstimateFailedError';
    }
}

const checkRateLimit = (userId: string): void => {
    const today = new Date().toISOString().slice(0, 10);
    const entry = callCounts.get(userId);
    if (!entry || entry.day !== today) {
        callCounts.set(userId, { day: today, count: 1 });
        return;
    }
    if (entry.count >= DAILY_CALL_CAP) {
        throw new EstimateRateLimitError();
    }
    entry.count += 1;
};

const ESTIMATE_SYSTEM_PROMPT = `You are a nutritionist estimating the calories and macros of a single eating occasion.
Rules:
- Return one item per distinct food or drink.
- Estimate as-eaten portions (what the person actually consumed), not label servings.
- All calorie and gram values are integers.
- "quantityText" is a short human-readable portion line, e.g. "2 · 12g protein" or "12 oz · 5g protein" — quantity first, then protein.
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

type MessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>;

const buildUserContent = (text?: string, imageBase64?: string): MessageContent => {
    if (!imageBase64) return text ?? '';
    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    if (text) parts.push({ type: 'text', text });
    parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } });
    return parts;
};

// Not every routed model honors json_schema strictly — strip code fences and
// parse the first {...} block as a fallback.
const parseModelJson = (raw: string): any => {
    try {
        return JSON.parse(raw);
    } catch {
        const cleaned = raw.replace(/```(?:json)?/g, '');
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end <= start) {
            throw new EstimateFailedError('Model returned unparseable output');
        }
        return JSON.parse(cleaned.slice(start, end + 1));
    }
};

const callOpenRouter = async (
    systemPrompt: string,
    userContent: MessageContent,
    jsonSchema: object,
    modelOverride?: string,
): Promise<any> => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new EstimateFailedError('OPENROUTER_API_KEY is not configured');
    }
    const model = modelOverride || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(OPENROUTER_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                temperature: 0,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent },
                ],
                response_format: { type: 'json_schema', json_schema: jsonSchema },
            }),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new EstimateFailedError(`OpenRouter returned ${response.status}: ${body.slice(0, 300)}`);
        }
        const data = (await response.json()) as any;
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
            throw new EstimateFailedError('OpenRouter returned an empty completion');
        }
        return parseModelJson(content);
    } catch (error) {
        if (error instanceof EstimateFailedError) throw error;
        if ((error as Error).name === 'AbortError') {
            throw new EstimateFailedError('OpenRouter request timed out');
        }
        throw new EstimateFailedError(`OpenRouter request failed: ${(error as Error).message}`);
    } finally {
        clearTimeout(timeout);
    }
};

const toInt = (value: unknown): number => {
    const parsed = Math.round(Number(value));
    return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
};

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

// Ground LLM items in USDA generic-food data: search candidates per item, let
// a judge call pick genuine matches, then scale per-100g values by the LLM's
// gram estimate. Any failure falls back to the raw LLM values — grounding can
// only replace numbers, never lose items or fail the estimate.
const groundItemsInUsda = async (items: EstimateItemWithGrams[]): Promise<EstimateItem[]> => {
    const candidateLists = await Promise.all(
        items.map(async (item) => {
            if (item.grams <= 0) return [];
            try {
                return await searchGenericFoods(item.name);
            } catch (error) {
                console.warn(`USDA candidate search failed for "${item.name}":`, (error as Error).message);
                return [];
            }
        }),
    );
    if (candidateLists.every((candidates) => candidates.length === 0)) return items;

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
    // flip-flops on borderline matches even at temperature 0).
    const judged = await callOpenRouter(
        JUDGE_SYSTEM_PROMPT,
        JSON.stringify(judgeInput, null, 2),
        JUDGE_JSON_SCHEMA,
        process.env.ESTIMATE_JUDGE_MODEL || 'openai/gpt-4o-mini',
    );
    const matches: unknown[] = Array.isArray(judged?.matches) ? judged.matches : [];
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

export const estimateMeal = async (
    userId: string,
    text?: string,
    imageBase64?: string,
): Promise<EstimateResponse> => {
    checkRateLimit(userId);
    const parsed = await callOpenRouter(
        ESTIMATE_SYSTEM_PROMPT,
        buildUserContent(text, imageBase64),
        ESTIMATE_JSON_SCHEMA,
    );

    let items: EstimateItem[] = (Array.isArray(parsed?.items) ? parsed.items : [])
        .filter((item: any) => item && typeof item.name === 'string' && item.name.trim())
        .map((item: any) => ({
            name: item.name.trim(),
            quantityText: typeof item.quantityText === 'string' ? item.quantityText : '',
            grams: toInt(item.grams),
            calories: toInt(item.calories),
            protein: toInt(item.protein),
            carbs: toInt(item.carbs),
            fat: toInt(item.fat),
            source: 'estimated' as const,
            matchedTo: null,
        }));
    if (items.length === 0) {
        throw new EstimateFailedError('Model returned no food items');
    }

    // Ground in USDA unless disabled; never let grounding break the estimate.
    if (process.env.ESTIMATE_GROUNDING !== 'off') {
        try {
            items = await groundItemsInUsda(items as EstimateItemWithGrams[]);
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
        confidence: ['low', 'medium', 'high'].includes(parsed?.confidence) ? parsed.confidence : 'medium',
        notes: typeof parsed?.notes === 'string' && parsed.notes.trim() ? parsed.notes.trim() : null,
    };
};

export const scanLabel = async (userId: string, imageBase64: string): Promise<LabelScanResponse> => {
    checkRateLimit(userId);
    const parsed = await callOpenRouter(
        LABEL_SCAN_SYSTEM_PROMPT,
        buildUserContent(undefined, imageBase64),
        LABEL_SCAN_JSON_SCHEMA,
    );

    const servingAmount = Number(parsed?.servingAmount);
    return {
        name: typeof parsed?.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null,
        servingAmount: Number.isFinite(servingAmount) && servingAmount > 0 ? servingAmount : null,
        servingUnit:
            typeof parsed?.servingUnit === 'string' && parsed.servingUnit.trim() ? parsed.servingUnit.trim() : null,
        calories: toInt(parsed?.calories),
        protein: toInt(parsed?.protein),
        carbs: toInt(parsed?.carbs),
        fat: toInt(parsed?.fat),
        confidence: ['low', 'medium', 'high'].includes(parsed?.confidence) ? parsed.confidence : 'medium',
    };
};
