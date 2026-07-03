import { EstimateItem, EstimateResponse, LabelScanResponse } from '../types/nutrition';

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
- Set confidence to "low" when portion sizes are guesses, "high" only when quantities are explicit.
- Never refuse: always give a best-effort estimate, and use "notes" for any assumption worth flagging (e.g. "Assumed whole milk in the latte.").`;

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
                        calories: { type: 'integer' },
                        protein: { type: 'integer' },
                        carbs: { type: 'integer' },
                        fat: { type: 'integer' },
                    },
                    required: ['name', 'quantityText', 'calories', 'protein', 'carbs', 'fat'],
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
): Promise<any> => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new EstimateFailedError('OPENROUTER_API_KEY is not configured');
    }
    const model = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

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

    const items: EstimateItem[] = (Array.isArray(parsed?.items) ? parsed.items : [])
        .filter((item: any) => item && typeof item.name === 'string' && item.name.trim())
        .map((item: any) => ({
            name: item.name.trim(),
            quantityText: typeof item.quantityText === 'string' ? item.quantityText : '',
            calories: toInt(item.calories),
            protein: toInt(item.protein),
            carbs: toInt(item.carbs),
            fat: toInt(item.fat),
        }));
    if (items.length === 0) {
        throw new EstimateFailedError('Model returned no food items');
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
