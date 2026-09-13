// OpenRouter (chat completions) — the one vendor boundary for model calls.
// Callers meter before they spend: entitlement.service consumes the AI quota at
// request time, and the offline catalog scripts reserve against their own budget
// ledger. Nothing here is user-aware, so nothing here meters.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * How long one model call may take, and the budget a whole request-time
 * estimate has to fit inside.
 *
 * This number is derived from the client's deadline, not chosen on its own.
 * The mobile app abandons every API request at `HTTP_REQUEST_TIMEOUT_MS`
 * (25 s, `mobile/src/service/http/httpRequest.ts`), and it is the only
 * consumer of the two endpoints that reach this module. A vendor deadline at
 * or above that number cannot produce a usable outcome: the client is already
 * gone when the call gives up, so it never receives the
 * `502 estimation_failed` the controller would have returned, the paid call
 * carries on being paid for, and the user's retry spends a second unit of the
 * daily AI quota for one answer. The gap left here — 7 s — is the request's
 * own overhead: uploading a base64 photo, verifying the Firebase token,
 * metering the call, and serialising the response.
 *
 * It is also the ceiling for a whole request rather than for one call, which
 * matters because `estimate.service.ts` makes up to two sequential calls (the
 * estimate and the grounding judge) plus USDA lookups. That service starts one
 * budget of this size per request and passes the remainder to each call, so the
 * total cannot grow with the number of calls. A caller with no client waiting —
 * the offline catalog scripts — may pass a longer `timeoutMs` explicitly.
 */
export const OPENROUTER_REQUEST_TIMEOUT_MS = 18_000;

const DEFAULT_MODEL = 'google/gemini-2.5-flash';

// The classification model, for callers whose task is "pick the matching row"
// rather than "write the answer": the estimate service's USDA grounding judge
// and the catalog pipeline's advisory review pass. It is vendor configuration
// and not an estimate-domain constant because more than one consumer shares the
// value — AAP §0.4.3 gives the review pass CATALOG_REVIEW_MODEL, which inherits
// ESTIMATE_JUDGE_MODEL when left blank (.env.example) — and because
// backend-architecture §9 requires an integration's configuration to be read
// once here, behind the loud accessor below, rather than branched on deep
// inside business code.
const DEFAULT_JUDGE_MODEL = 'openai/gpt-4o-mini';

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
    // The model for classification calls (ESTIMATE_JUDGE_MODEL): the estimate
    // service's grounding judge and the catalog review pass both read it from
    // here, so neither resolves the precedence for itself.
    judgeModel: string;
}

// Config is read once, when this module is first required, and never again —
// the integration rule for a vendor boundary (backend-architecture §9), and the
// same shape as usda.service's getApiKey(). Both entry points load the
// environment before the service graph is required: src/server.ts calls
// dotenv.config() above `import app from './app'` (CommonJS emits that import
// as a require *after* the dotenv call), and scripts/lib/bootstrap.ts does the
// same for the CLI scripts. The consequence of capturing at import time is that
// mutating OPENROUTER_API_KEY/OPENROUTER_MODEL/ESTIMATE_JUDGE_MODEL after the
// first require has no effect, so a test that varies them must re-import this
// module (jest.resetModules()) rather than assign to process.env in place.
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL;
const ESTIMATE_JUDGE_MODEL = process.env.ESTIMATE_JUDGE_MODEL;

// Absent key → no config at all, so the accessor below is the only place that
// decides what a missing key means. Frozen because every caller shares this one
// instance; both models are resolved here so each precedence lives in one place
// (an explicit per-call override still wins, in callOpenRouter).
const OPENROUTER_CONFIG: Readonly<OpenRouterConfig> | null = OPENROUTER_API_KEY
    ? Object.freeze({
          apiKey: OPENROUTER_API_KEY,
          model: OPENROUTER_MODEL || DEFAULT_MODEL,
          judgeModel: ESTIMATE_JUDGE_MODEL || DEFAULT_JUDGE_MODEL,
      })
    : null;

export const getOpenRouterConfig = (): OpenRouterConfig => {
    if (!OPENROUTER_CONFIG) {
        throw new OpenRouterError('not_configured', 'OPENROUTER_API_KEY is not configured');
    }
    return OPENROUTER_CONFIG;
};

const unparseableError = (message: string): OpenRouterError => new OpenRouterError('unparseable', message);

// The single source of the wrapped-failure wording. Two paths surface a caught
// error's own message to the client (the transport catch below and the
// fallback-slice parse failure in parseModelJson), and both have returned this
// exact format since the endpoints shipped, so the format is defined once.
const vendorFailureMessage = (error: unknown): string => `OpenRouter request failed: ${(error as Error).message}`;

// Not every routed model honors json_schema strictly — strip code fences and
// parse the first {...} block as a fallback.
//
// The two unparseable outcomes deliberately carry different wording, and that
// difference is a shipped API contract, not an oversight: text with no usable
// {...} block never reached JSON.parse a second time and has always reported
// 'Model returned unparseable output', while text that *did* contain a block
// let the second JSON.parse's SyntaxError escape to the transport catch, which
// wrapped it as 'OpenRouter request failed: <syntax message>'. Both messages
// reach the client verbatim through EstimateFailedError (502), so neither may
// be unified with the other. The SyntaxError itself is caught here rather than
// allowed to propagate, because OpenRouterError is the only error type that
// leaves this module.
export const parseModelJson = (raw: string): unknown => {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        const cleaned = raw.replace(/```(?:json)?/g, '');
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end <= start) {
            throw unparseableError('Model returned unparseable output');
        }
        try {
            return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
        } catch (error) {
            throw unparseableError(vendorFailureMessage(error));
        }
    }
};

// Model-controlled data is never trusted structurally: the response body is
// `unknown` until each level of the envelope has been checked. Arrays and null
// are not records here, so an array payload is "absent" rather than something
// with readable keys.
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

// The minimal OpenRouter envelope this module depends on:
// `{choices: [{message: {content: <non-blank string>}}]}`. Every structural
// deviation — non-object payload, missing or empty choices, a non-object
// choice/message, a non-string or blank content — is reported identically by
// the caller as the single 'empty' failure, which is the behaviour the estimate
// endpoints have always shown the client; no shape check may raise a TypeError.
const readCompletionContent = (payload: unknown): string | undefined => {
    const choices = asRecord(payload)?.choices;
    if (!Array.isArray(choices)) return undefined;
    const content = asRecord(asRecord(choices[0])?.message)?.content;
    return typeof content === 'string' && content.trim() ? content : undefined;
};

// A caller-supplied deadline, or the default when there is none.
//
// Guarded rather than trusted because the value a caller passes is arithmetic —
// `estimate.service.ts` passes what is left of its request budget — and a
// zero, negative or non-finite remainder would arm a timer that fires
// immediately or never. A caller that has genuinely run out of budget is
// expected to skip the call instead of asking for a zero-length one, which is
// what that service does; this is the boundary refusing to send a request it
// cannot bound.
const resolveTimeoutMs = (timeoutMs?: number): number =>
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : OPENROUTER_REQUEST_TIMEOUT_MS;

// Returns the model's parsed JSON as `unknown`: the vendor boundary guarantees
// the transport and the syntax, never the shape, so every caller narrows what
// it reads (see estimate.service's readers) instead of trusting a cast here.
//
// `timeoutMs` is how a caller that makes several calls for one user request
// keeps their total inside one budget (and how an offline caller asks for
// longer than the request-time default); omitted, the call is bounded by
// `OPENROUTER_REQUEST_TIMEOUT_MS`.
export const callOpenRouter = async (
    systemPrompt: string,
    userContent: MessageContent,
    jsonSchema: object,
    modelOverride?: string,
    fetchImpl?: typeof fetch,
    timeoutMs?: number,
): Promise<unknown> => {
    const { apiKey, model: configuredModel } = getOpenRouterConfig();
    const model = modelOverride || configuredModel;
    const doFetch = fetchImpl ?? fetch;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), resolveTimeoutMs(timeoutMs));
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
        const content = readCompletionContent((await response.json()) as unknown);
        if (content === undefined) {
            throw new OpenRouterError('empty', 'OpenRouter returned an empty completion');
        }
        return parseModelJson(content);
    } catch (error) {
        if (error instanceof OpenRouterError) throw error;
        if ((error as Error).name === 'AbortError') {
            throw new OpenRouterError('timeout', 'OpenRouter request timed out');
        }
        throw new OpenRouterError('network', vendorFailureMessage(error));
    } finally {
        clearTimeout(timeout);
    }
};
