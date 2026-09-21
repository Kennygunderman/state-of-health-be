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

/**
 * The most of a vendor response this boundary will read into memory.
 *
 * WHY A CEILING EXISTS AT ALL. `fetch` imposes none: `response.json()` and
 * `response.text()` buffer whatever arrives, so the size of this process's
 * allocation was chosen by whatever answered the request. That is a resource
 * bound set by a remote party (CWE-400), and it holds for every caller — the
 * two request-time endpoints, where a large body is paid for in a user's
 * latency, and the offline catalog stages, where a run holding a database
 * transaction is the thing that dies.
 *
 * WHY 2 MiB. The largest legitimate completion any caller here asks for is one
 * catalog generation batch: `CATALOG_BATCH_SIZE` candidates (25, AAP §0.7.3),
 * each a food record of roughly a kilobyte of JSON — tens of kilobytes, with
 * the envelope. A request-time estimate is a fraction of that. 2 MiB is more
 * than an order of magnitude above the worst legitimate case and still a hard
 * cap on what one call can allocate, so it bounds the failure mode without
 * being reachable by a correct response.
 *
 * It is enforced WHILE READING rather than after: a post-hoc length check on
 * `await response.text()` has already allocated the bytes it then objects to.
 */
export const OPENROUTER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type OpenRouterErrorKind =
    | 'not_configured'
    | 'http'
    | 'empty'
    | 'timeout'
    | 'network'
    | 'unparseable'
    /**
     * The response exceeded {@link OPENROUTER_MAX_RESPONSE_BYTES} and the read
     * was abandoned. A new kind rather than a reuse of `http` (the response was
     * fine) or `unparseable` (nothing was parsed): this failure is about the
     * vendor's SIZE, which no existing kind describes, and it did not exist
     * before the ceiling did — so no shipped message string is displaced by it.
     */
    | 'oversized';

// The closed kind set as a runtime value, so `safeMessage` below can be built
// from a membership test rather than from a type annotation. A `kind` is typed,
// but a cast can defeat a type; the description this module promises is
// content-free only if the code — not the compiler — decides what may appear in
// it.
const KNOWN_ERROR_KINDS: ReadonlySet<string> = new Set<OpenRouterErrorKind>([
    'not_configured',
    'http',
    'empty',
    'timeout',
    'network',
    'unparseable',
    'oversized',
]);

const UNKNOWN_ERROR_KIND = 'unknown_kind';

// THE TWO DESCRIPTIONS OF ONE FAILURE, AND WHICH ONE A CALLER MAY LOG.
//
// `message` is vendor-influenced. The `http` branch of callOpenRouter puts the
// first 300 characters of the failed response BODY in it, and the `network`
// branch puts the transport's own description of the thrown value in it. That
// is deliberate and load-bearing in exactly one place: estimate.service.ts
// re-raises the text verbatim as an EstimateFailedError, so these six strings
// are that service's own failure text. Preserving them byte for byte is what
// makes this module's extraction invisible to it (AAP §0.4.3), and
// openrouter.service.test.ts asserts each one with `toBe` for that reason, so
// none of them may change.
//
// It is an INTERNAL diagnostic all the same. Neither endpoint that reaches
// this boundary shows it: /api/macros/estimate and /api/macros/label-scan
// answer `502 {error: 'estimation_failed'}` — a fixed machine code, never this
// text — and nutrition.controller.ts records the failure through
// describeErrorSafely, which emits the error's class name, adds a machine code
// only when the thrown value carries one (the EstimateFailedError built from
// the message below carries none, so the log line names the class alone) and
// never emits the message itself. So the wording above is compatibility with
// one in-process consumer, not a promise to anything outside the request that
// raised it.
//
// `safeMessage` is what everything else uses. A log line, a persisted
// diagnostic, a committed report artefact and a run ledger all outlive the
// request and are read by people who are not the caller, and a vendor or model
// response body in any of them is data exfiltration by another name (CWE-532):
// scripts/lib/logger.ts's scrubSecrets removes credential PATTERNS, and
// arbitrary prose carries no pattern to remove. So this property is assembled
// only from the closed kind set above and the numeric HTTP status — two values
// this module owns end to end — and therefore cannot carry a byte the vendor
// chose.
//
// Both catalog stages translate an OpenRouterError into their own error
// (scripts/catalog-generate-ai.ts::asGenerationFailure,
// scripts/catalog-validate.ts::asReviewFailure) and take `safeMessage`; a
// future caller that logs `message` instead reopens the leak, which is why the
// distinction is stated on the class rather than in a comment at each site.
const describeFailureSafely = (kind: string, status?: number): string => {
    const namedKind = KNOWN_ERROR_KINDS.has(kind) ? kind : UNKNOWN_ERROR_KIND;

    return Number.isInteger(status)
        ? `OpenRouter call failed (${namedKind}, status ${String(status)})`
        : `OpenRouter call failed (${namedKind})`;
};

// Every failure leaving this module is an OpenRouterError, so no caller ever
// pattern-matches a vendor error shape. Each caller translates `kind` into its
// own domain error, which is why no domain error is referenced here.
export class OpenRouterError extends Error {
    /**
     * The failure described without a byte of vendor or model content: the
     * `kind`, and the HTTP status when there is one. Safe to log, to persist and
     * to ship in a report — see the reasoning above the class.
     */
    public readonly safeMessage: string;

    constructor(
        public readonly kind: OpenRouterErrorKind,
        message: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = 'OpenRouterError';
        this.safeMessage = describeFailureSafely(kind, status);
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

// How much of a thrown value's own DESCRIPTION a failure message carries — the
// same bound the `http` branch applies to a vendor response body, and for the
// same reason: a transport is free to reject with a value of any size, and an
// unbounded description of one would inflate the OpenRouterError held in
// memory, the EstimateFailedError text the estimate service copies out of it,
// and anything a later diagnostic path does with either.
//
// It bounds `describeThrown` and NOTHING ELSE, which is the half of the rule
// worth stating plainly: a thrown value that has its own `message` — every
// Error, which is what a transport rejection normally is — is carried by that
// message whole and untruncated. That is deliberate rather than an oversight.
// The wording has always been the raw message (the fallback parse in
// parseModelJson surfaces a SyntaxError's message through exactly this path),
// and capping it would change the EstimateFailedError text this extraction has
// to preserve byte-for-byte (AAP §0.4.3). openrouter.service.test.ts asserts
// both halves against each other: a 1,000-character thrown string is cut to
// this limit, a 1,000-character `Error.message` survives whole.
//
// Neither half governs what leaves the process. A log line, a persisted
// diagnostic and a committed artefact all take `safeMessage`, which is
// assembled from the closed kind set and a numeric status alone, so it carries
// no vendor byte and no unbounded length whichever branch built the failure.
const THROWN_DETAIL_LIMIT = 300;

// Used only when every conversion below fails, which needs a value whose
// `toString` throws and which JSON cannot serialise. Constant rather than
// empty, because a failure that names nothing is indistinguishable from a bug
// in this module.
const UNDESCRIBABLE_THROWN_VALUE = 'an unreadable value';

// A property read off a thrown value that cannot itself fail.
//
// `throw` accepts any value, so the catch below may receive null, undefined, a
// primitive, or an object whose accessors throw — and it is the one place that
// guarantees only an OpenRouterError leaves this module. Reading `.name` or
// `.message` through an `as Error` cast breaks that guarantee from inside the
// guarantee: a thrown null makes the read raise a TypeError that escapes
// unwrapped. Optional chaining answers null/undefined with `undefined`, and the
// try/catch answers a throwing getter exactly as it answers an absent property.
const propertyOfThrown = (error: unknown, key: 'name' | 'message'): unknown => {
    try {
        return (error as Record<string, unknown> | null | undefined)?.[key];
    } catch {
        return undefined;
    }
};

// `String()` with the same guard: a `message` is not necessarily a string, and
// a non-string one may carry a `toString` that throws.
const asText = (value: unknown): string => {
    try {
        return String(value);
    } catch {
        return UNDESCRIBABLE_THROWN_VALUE;
    }
};

// Names a thrown value that carries no `message` of its own, so its content
// survives into the failure text instead of the literal word 'undefined'.
//
// A thrown string is returned as it stands rather than JSON-encoded, so the
// quotes and escapes a vendor string may contain are not added to that text.
// Anything else is serialised, because that is what names an object's fields;
// both conversions are guarded because each one fails on a value a
// transport is free to throw — JSON.stringify throws on a BigInt and on a
// circular object, and returns `undefined` for a symbol or a function, while
// `String()` runs a `toString` this module does not own.
const describeThrown = (error: unknown): string => {
    if (typeof error === 'string') {
        return error.slice(0, THROWN_DETAIL_LIMIT);
    }

    let serialised: string | undefined;
    try {
        serialised = JSON.stringify(error);
    } catch {
        // A BigInt or a cycle: unserialisable, but `String()` below still names
        // the value, so the description degrades rather than disappearing.
        serialised = undefined;
    }

    return (serialised ?? asText(error)).slice(0, THROWN_DETAIL_LIMIT);
};

// The single source of the wrapped-failure wording. Two paths carry a caught
// error's own message into an OpenRouterError (the transport catch below and
// the fallback-slice parse failure in parseModelJson), and both have produced
// this exact format since the endpoints shipped, so the format is defined once.
//
// A value that has a `message` is described by it, converted exactly as the
// template literal used to convert it and never truncated, so every message an
// Error has ever produced here — including the empty one, which yields the
// trailing separator and nothing else — is unchanged. Only a value with no
// `message` at all takes the description path.
const vendorFailureMessage = (error: unknown): string => {
    const message = propertyOfThrown(error, 'message');

    return `OpenRouter request failed: ${message === undefined ? describeThrown(error) : asText(message)}`;
};

// Not every routed model honors json_schema strictly — strip code fences and
// parse the first {...} block as a fallback.
//
// The two unparseable outcomes deliberately carry different wording, and that
// difference is behaviour this boundary has always had, not an oversight: text
// with no usable {...} block never reached JSON.parse a second time and has
// always reported 'Model returned unparseable output', while text that *did*
// contain a block let the second JSON.parse's SyntaxError escape to the
// transport catch, which wrapped it as 'OpenRouter request failed: <syntax
// message>'. Both travel verbatim into the EstimateFailedError the estimate
// service raises from them, so neither may be unified with the other. The
// SyntaxError itself is caught here rather than allowed to propagate, because
// OpenRouterError is the only error type that leaves this module.
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

// The message an oversized response is reported with. Content-free by
// construction: it names this module's own ceiling and nothing the vendor sent,
// so it is as safe to log as `safeMessage` and does not depend on a caller
// choosing the right property.
const OVERSIZED_RESPONSE_MESSAGE = `OpenRouter response exceeded ${String(
    OPENROUTER_MAX_RESPONSE_BYTES,
)} bytes and was not read`;

const oversizedError = (): OpenRouterError => new OpenRouterError('oversized', OVERSIZED_RESPONSE_MESSAGE);

/**
 * Reads a response body as text, refusing past {@link OPENROUTER_MAX_RESPONSE_BYTES}.
 *
 * THE STREAMING PATH IS THE POINT. Chunks are measured as they arrive and the
 * reader is cancelled the moment the running total would exceed the ceiling, so
 * a hostile or malfunctioning endpoint cannot make this process allocate more
 * than the cap however much it sends. Cancelling also closes the connection
 * rather than politely draining the rest of a body already known to be
 * unusable.
 *
 * Bytes, not characters, because the ceiling is about memory: a chunk is a
 * `Uint8Array` and `byteLength` is what it costs. The decode happens once, at
 * the end, over a body already known to fit.
 *
 * THE FALLBACK PATH exists for a transport that exposes no readable body —
 * a hand-rolled test double, or a runtime whose `Response` leaves `body` null.
 * It buffers through `response.text()` and then applies the same ceiling, which
 * is weaker (the allocation has already happened) and is why it is the fallback
 * rather than the implementation. Every real `fetch` response, and every
 * `new Response(...)` the suites build, takes the streaming path.
 */
const readBoundedBodyText = async (response: Response, limit: number): Promise<string> => {
    const body = response.body;
    if (body === null || typeof body.getReader !== 'function') {
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > limit) {
            throw oversizedError();
        }
        return text;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (value === undefined) {
                continue;
            }
            total += value.byteLength;
            if (total > limit) {
                throw oversizedError();
            }
            chunks.push(value);
        }
    } finally {
        // Releases the lock on the stream whether the read completed, refused
        // or threw, so a caller retrying on the same response cannot meet a
        // locked body. `cancel` rejects on an already-errored stream, which is
        // not a failure worth replacing the real one with.
        await reader.cancel().catch(() => undefined);
    }

    return Buffer.concat(chunks).toString('utf8');
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

// ---------------------------------------------------------------------------
// Redirects, which this boundary never follows.
//
// This call carries the API key in an `Authorization: Bearer` header and the
// prompt — which on the label-scan path is a user's photograph — in its body.
// `fetch` follows redirects by default, and a 307 or 308 preserves the METHOD
// AND BODY of the request it redirects, so the default would let anything able
// to answer for `openrouter.ai` hand both to an origin this module never chose.
// There is exactly one destination here (`OPENROUTER_URL`), so a hop is never
// legitimate, and `evidence.service.ts` records the same rule for the URLs it
// fetches.
//
// `redirect: 'error'` is the enforcement and a conforming `fetch` rejects the
// 3xx itself — that rejection arrives in the catch below as the `network` kind,
// which is what a transport refusing to complete the exchange should be. The
// check below covers the transport this module does NOT own: `fetchImpl` is a
// declared seam (`estimate.service.ts` passes one through, tests inject
// doubles), and an implementation free to build its own init is free to follow
// a hop and answer with the result. A `redirected` 200 is the shape that
// matters, because the body would otherwise be read as the model's answer.
// ---------------------------------------------------------------------------

const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 399;

/**
 * Whether a response reached this module through a redirect, or is one.
 *
 * `redirected` is read first: it says a hop was already made, whatever status
 * the chain ended on. A response double carrying no such property reads as
 * `false` and falls through to the status test.
 */
const wasRedirected = (response: Response): boolean =>
    response.redirected || (response.status >= REDIRECT_STATUS_MIN && response.status <= REDIRECT_STATUS_MAX);

/**
 * The failure a refused redirect raises.
 *
 * `network` rather than `http`: nothing was completed with the vendor, which is
 * also the kind a conforming `fetch` produces for the same condition by
 * rejecting — so the classification does not depend on which transport
 * enforced the policy. The wording is new because the condition is: until now
 * the hop was followed silently, so no message described it.
 */
const redirectRefusedError = (): OpenRouterError =>
    new OpenRouterError('network', 'OpenRouter request failed: the response was redirected away from the vendor');

/**
 * The completion-token ceiling, and WHY IT IS OPT-IN rather than defaulted.
 *
 * `max_tokens` bounds generation upstream, which is the cheapest place to
 * refuse an unbounded model answer — and it is the one control here that
 * changes the REQUEST. Several providers reject a `max_tokens` above the
 * routed model's own output limit, and OpenRouter routes the same request to
 * different providers over time, so a value defaulted for every caller would
 * put a new vendor-side 400 on the path of `/api/macros/estimate` and
 * `/api/macros/label-scan` — two shipped endpoints whose failure text is an
 * API contract (AAP §0.4.3). A cap that can break a working endpoint on a
 * routing change is not a safeguard.
 *
 * So the request body is byte-identical to the shipped one unless a caller asks
 * for a ceiling, and the callers that ask are the offline catalog stages, whose
 * batch size tells them exactly how large a legitimate answer is. The
 * unconditional protection for every caller — including the two endpoints — is
 * {@link OPENROUTER_MAX_RESPONSE_BYTES}, which needs no vendor cooperation
 * because it is enforced on the way in.
 *
 * A non-integer, zero or negative request is treated as no request at all
 * rather than sent on: the same posture as resolveTimeoutMs, and a `max_tokens`
 * of 0 would ask the vendor for an empty completion.
 */
const resolveMaxOutputTokens = (maxOutputTokens?: number): number | undefined =>
    maxOutputTokens !== undefined && Number.isInteger(maxOutputTokens) && maxOutputTokens > 0
        ? maxOutputTokens
        : undefined;

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
    maxOutputTokens?: number,
): Promise<unknown> => {
    const { apiKey, model: configuredModel } = getOpenRouterConfig();
    const model = modelOverride || configuredModel;
    const doFetch = fetchImpl ?? fetch;
    const outputTokenCeiling = resolveMaxOutputTokens(maxOutputTokens);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), resolveTimeoutMs(timeoutMs));
    try {
        const response = await doFetch(OPENROUTER_URL, {
            method: 'POST',
            // Never follow a hop: the reasoning is above `wasRedirected`. A
            // client-side policy only, so the request the vendor receives is
            // unchanged by it.
            redirect: 'error',
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
                // Omitted entirely when no caller asked, so the body a shipped
                // endpoint sends is unchanged — see resolveMaxOutputTokens.
                ...(outputTokenCeiling === undefined ? {} : { max_tokens: outputTokenCeiling }),
            }),
        });
        // Before `response.ok`, because a followed redirect can end in a 200:
        // reading the body first would parse another origin's answer as the
        // model's completion.
        if (wasRedirected(response)) {
            throw redirectRefusedError();
        }
        if (!response.ok) {
            // Bounded on the way in, like the success body: a failure response
            // is no smaller than a successful one, and this branch used to
            // buffer all of it to keep 300 characters. `.catch(() => '')` keeps
            // the pre-existing behaviour that a body which cannot be read does
            // not replace the status the caller needs — but an OVERSIZED body
            // is reported as itself rather than silently becoming an empty
            // string, because "the vendor sent 40 MiB" and "the vendor sent no
            // body" are different facts.
            const body = await readBoundedBodyText(response, OPENROUTER_MAX_RESPONSE_BYTES).catch(
                (error: unknown) => {
                    if (error instanceof OpenRouterError) throw error;
                    return '';
                },
            );
            throw new OpenRouterError(
                'http',
                `OpenRouter returned ${response.status}: ${body.slice(0, 300)}`,
                response.status,
            );
        }
        // `readBoundedBodyText` + `JSON.parse` rather than `response.json()`,
        // which reads the whole body before anything can object to its size.
        // The parse failure is identical: undici's `json()` is `JSON.parse` over
        // the decoded text, so a non-JSON body still reaches the transport catch
        // below as the same SyntaxError and is still reported as `network` with
        // the same message.
        const payload = JSON.parse(
            await readBoundedBodyText(response, OPENROUTER_MAX_RESPONSE_BYTES),
        ) as unknown;
        const content = readCompletionContent(payload);
        if (content === undefined) {
            throw new OpenRouterError('empty', 'OpenRouter returned an empty completion');
        }
        return parseModelJson(content);
    } catch (error) {
        if (error instanceof OpenRouterError) throw error;
        // `name` is read off the value as thrown, not off a normalised Error.
        // The abort carrier is not one shape: undici raises a DOMException,
        // a caller's own transport raises an Error renamed 'AbortError', and a
        // hand-rolled double may raise a plain object carrying only that name.
        // Rebuilding the value first would keep the first two and silently
        // reclassify the third as `network`.
        if (propertyOfThrown(error, 'name') === 'AbortError') {
            throw new OpenRouterError('timeout', 'OpenRouter request timed out');
        }
        throw new OpenRouterError('network', vendorFailureMessage(error));
    } finally {
        clearTimeout(timeout);
    }
};
