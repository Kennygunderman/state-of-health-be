// OpenRouter (chat completions) — the one vendor boundary for model calls.
// Callers meter before they spend: entitlement.service consumes the AI quota at
// request time, and the offline catalog scripts reserve against their own budget
// ledger. Nothing here is user-aware, so nothing here meters.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = 'google/gemini-2.5-flash';

export type OpenRouterErrorKind =
    | 'not_configured'
    | 'http'
    | 'empty'
    | 'timeout'
    | 'network'
    | 'unparseable';

// Every failure leaving this module is an OpenRouterError, so no caller ever
// pattern-matches a vendor error shape. Each caller translates `kind` into its
// own domain error, which is why no domain error is referenced here.
export class OpenRouterError extends Error {
    constructor(
        public readonly kind: OpenRouterErrorKind,
        message: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = 'OpenRouterError';
    }
}

export type MessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>;

export interface OpenRouterConfig {
    apiKey: string;
    model: string;
}

export const getOpenRouterConfig = (): OpenRouterConfig => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new OpenRouterError('not_configured', 'OPENROUTER_API_KEY is not configured');
    }
    return { apiKey, model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL };
};

const unparseableError = (): OpenRouterError =>
    new OpenRouterError('unparseable', 'Model returned unparseable output');

// Not every routed model honors json_schema strictly — strip code fences and
// parse the first {...} block as a fallback.
export const parseModelJson = (raw: string): any => {
    try {
        return JSON.parse(raw);
    } catch {
        const cleaned = raw.replace(/```(?:json)?/g, '');
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end <= start) {
            throw unparseableError();
        }
        try {
            return JSON.parse(cleaned.slice(start, end + 1));
        } catch {
            throw unparseableError();
        }
    }
};

export const callOpenRouter = async (
    systemPrompt: string,
    userContent: MessageContent,
    jsonSchema: object,
    modelOverride?: string,
    fetchImpl?: typeof fetch,
): Promise<any> => {
    const { apiKey, model: configuredModel } = getOpenRouterConfig();
    const model = modelOverride || configuredModel;
    const doFetch = fetchImpl ?? fetch;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await doFetch(OPENROUTER_URL, {
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
            throw new OpenRouterError(
                'http',
                `OpenRouter returned ${response.status}: ${body.slice(0, 300)}`,
                response.status,
            );
        }
        const data = (await response.json()) as any;
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
            throw new OpenRouterError('empty', 'OpenRouter returned an empty completion');
        }
        return parseModelJson(content);
    } catch (error) {
        if (error instanceof OpenRouterError) throw error;
        if ((error as Error).name === 'AbortError') {
            throw new OpenRouterError('timeout', 'OpenRouter request timed out');
        }
        throw new OpenRouterError('network', `OpenRouter request failed: ${(error as Error).message}`);
    } finally {
        clearTimeout(timeout);
    }
};
