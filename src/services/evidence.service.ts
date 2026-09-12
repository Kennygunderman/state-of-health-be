import { createHash } from 'crypto';
import { promises as dnsPromises } from 'dns';
import * as https from 'https';
import { LookupFunction } from 'net';
import { Readable, Transform } from 'stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib';

import {
    EVIDENCE_FETCH_TIMEOUT_MS,
    EvidencePolicy,
    EvidenceRejectionReason,
    EvidenceRetrievalRecord,
    EvidenceType,
    SpecialPurposeRange,
    classifyAddressSet,
    evaluateEvidenceRedirect,
    evaluateEvidenceUrl,
    isAllowedContentType,
    isWithinBodyCap,
    parseIpAddress,
    resolveEvidenceFetchLimits,
    validateEvidencePolicy,
} from './evidence.logic';

/**
 * Identity-evidence retrieval — the acting half of the pair whose deciding half
 * is `evidence.logic.ts`.
 *
 * `scripts/catalog-generate-ai.ts` asks a language model to propose URLs that
 * corroborate a generated catalog food's identity. This module performs the one
 * network call in the backend whose target a language model chose, which makes
 * every byte of it attacker-influenced input, so the defence is layered and
 * every layer is load-bearing (Agent Action Plan §0.3.2, OWASP SSRF Prevention
 * Cheat Sheet):
 *
 *   1. the policy document is validated before it is believed;
 *   2. the URL is judged — https, port 443, no userinfo, no IP literal, IDNA
 *      normalised — and the *normalized* href it returns is the string fetched;
 *   3. the host must be allowlisted **for the claim being made**;
 *   4. the name is resolved once with `all: true` and the whole answer set must
 *      classify as globally routable, failing closed;
 *   5. the first passing address is **pinned** for the connection, which is
 *      what closes the DNS-rebinding window between the check and the connect;
 *   6. redirects are never followed automatically, at most two are followed by
 *      hand, each re-validated and re-pinned in full, and any cross-host hop
 *      ends the fetch;
 *   7. one total deadline, a cap on the *decompressed* body enforced while
 *      streaming, an allowlisted content type checked before the body is read,
 *      and no outbound credentials of any kind.
 *
 * Remove any one of those and a known bypass class reopens.
 *
 * **This module holds no policy.** Not a CIDR, not a host, not a scheme, not a
 * media type: every decision is `evidence.logic.ts`'s, taken through the two
 * entry points that module documents for this one (`evaluateEvidenceUrl` and
 * `evaluateEvidenceRedirect`, which compose `parseEvidenceUrl`, `isHostAllowed`
 * and the evidence-type authorization), plus `classifyAddressSet` — the
 * reason-carrying form of `areAllAddressesRoutable`. What lives here is
 * sequencing and I/O, which is why the rules it enforces can be tested
 * exhaustively with no network at all (Rule 7 §5, §7.1, §11).
 *
 * Nothing here writes to a database and no Prisma client is imported: this is a
 * retrieval boundary. The record it produces is persisted by its caller into
 * `catalog_validation_records.identity_evidence`, and anything that fails any
 * check returns a refusal so the caller leaves the candidate quarantined.
 *
 * The body is **data**. It is matched against the candidate's name, hashed,
 * excerpted and stored — never fed back into a prompt as instructions. There is
 * no path from a fetched page into `openrouter.service.ts`, which makes this a
 * prompt-injection boundary as much as an SSRF one.
 */

/**
 * Why a retrieval failed, as an error type of our own.
 *
 * `'not_configured'` is the one cause that is not a verdict about a candidate —
 * the module could not read its own configuration — and it is spelled the same
 * way `openrouter.service.ts` spells its equivalent. Every other value is one
 * of `evidence.logic.ts`'s reviewed rejection codes, so a caller logs a code it
 * can count rather than a sentence it has to parse (Rule 7 §8).
 */
export type EvidenceErrorKind = 'not_configured' | EvidenceRejectionReason;

/**
 * The only error type that leaves this module.
 *
 * A caller must never see a bare `fetch` `TypeError`, an `AbortError`, a `dns`
 * `ENOTFOUND` or a zlib failure: each is caught and wrapped here, so nothing
 * downstream pattern-matches a vendor's error shape (Rule 7 §9).
 */
export class EvidenceError extends Error {
    constructor(
        public readonly kind: EvidenceErrorKind,
        message: string,
    ) {
        super(message);
        this.name = 'EvidenceError';
    }
}

// ---------------------------------------------------------------------------
// Configuration.
//
// Read once, when this module is first required, behind an accessor that fails
// loudly — the integration rule for a boundary module (Rule 7 §9), and the same
// shape as usda.service's getApiKey() and entitlement.service's
// getDailyQuota(). Nothing below the accessor reads the environment again:
// §5 forbids a service branching on process.env inside its flow, and a timeout
// that could change mid-run is not a bound.
//
// Absent or blank means "not stated", which resolves to the reviewed default in
// evidence.logic.ts. Present but unusable THROWS at import: a misspelled
// timeout is a configuration defect, and a silent fallback would hide it behind
// a working default. Only the offline catalog scripts require this module, so
// failing at import cannot take a request path down.
// ---------------------------------------------------------------------------

const RAW_EVIDENCE_FETCH_TIMEOUT_MS = process.env.EVIDENCE_FETCH_TIMEOUT_MS;

const resolveConfiguredTimeoutMs = (raw: string | undefined): number => {
    if (raw === undefined || raw.trim() === '') {
        return EVIDENCE_FETCH_TIMEOUT_MS;
    }

    const parsed = Number(raw);
    if (!isFinite(parsed) || Math.floor(parsed) !== parsed || parsed <= 0) {
        throw new EvidenceError(
            'not_configured',
            `EVIDENCE_FETCH_TIMEOUT_MS must be a positive whole number of milliseconds; received "${raw}"`,
        );
    }

    return parsed;
};

const CONFIGURED_FETCH_TIMEOUT_MS = resolveConfiguredTimeoutMs(RAW_EVIDENCE_FETCH_TIMEOUT_MS);

/**
 * The operator's configured total timeout for one retrieval, in milliseconds.
 *
 * It is the *configured* value, not necessarily the effective one: the deadline
 * a fetch actually runs under is the stricter of this and the policy document's
 * declared `timeoutMs`, which `evidence.logic.ts` has already capped at the
 * reviewed ceiling. An operator can therefore tighten the bound and never widen
 * it past what the code sanctions.
 */
export const getEvidenceFetchTimeoutMs = (): number => CONFIGURED_FETCH_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// The injectable boundary.
//
// The resolver, the transport and the clock are parameters with real defaults,
// because the property this module has to prove is a NEGATIVE one: that no
// connection is attempted when any check fails. That is only assertable if the
// transport can be observed, so it is injected rather than mocked — the
// convention Rule 7 §11 imports from Rule 4 (prefer dependency injection over
// mocking).
// ---------------------------------------------------------------------------

/** One answer from a host lookup, shaped like `dns.LookupAddress`. */
export interface EvidenceResolvedAddress {
    readonly address: string;
    readonly family: number;
}

/**
 * Resolves a host to **every** address it answers with.
 *
 * Every address matters, so this returns the whole set: a name that resolves to
 * one public and one private address is a rebinding attempt, and a
 * single-address lookup would hide the private half.
 */
export type EvidenceHostLookup = (host: string) => Promise<readonly EvidenceResolvedAddress[]>;

/** Response headers as a transport reports them, shaped like `IncomingHttpHeaders`. */
export type EvidenceResponseHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * One GET, already judged and pinned.
 *
 * `url` is the normalized href `evidence.logic.ts` returned, `host` the host it
 * validated, and `pinnedAddress` the address that host resolved to and that the
 * socket must connect to. A transport is handed all three because it must
 * connect to the address while presenting the *host* for SNI and certificate
 * verification — pinning must never be bought by weakening TLS.
 */
export interface EvidenceHttpRequest {
    readonly url: string;
    readonly host: string;
    readonly pinnedAddress: string;
    readonly addressFamily: 4 | 6;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
}

/**
 * A response whose body has **not** been read.
 *
 * The body arrives as a stream so the content type can be judged and the body
 * discarded without reading a byte, and so the size cap can be applied while
 * bytes arrive rather than after they have all been buffered.
 */
export interface EvidenceHttpResponse {
    readonly status: number;
    readonly headers: EvidenceResponseHeaders;
    readonly body: Readable;
}

/** The transport seam: one judged, pinned GET in, one unread response out. */
export type EvidenceFetch = (request: EvidenceHttpRequest) => Promise<EvidenceHttpResponse>;

/** A scheduled callback that can be cancelled. */
export interface EvidenceTimer {
    cancel(): void;
}

/**
 * Time, injected. `now()` stamps the record and `schedule` arms the deadline, so
 * a test can pin both instead of waiting on the wall clock (Rule 4).
 */
export interface EvidenceClock {
    now(): Date;
    schedule(onElapsed: () => void, delayMs: number): EvidenceTimer;
}

/** The three seams, each defaulting to its real implementation. */
export interface EvidenceDeps {
    readonly lookup?: EvidenceHostLookup;
    readonly fetch?: EvidenceFetch;
    readonly clock?: EvidenceClock;
}

/**
 * The outcome of a retrieval: a record, or a refusal carrying the reviewed code
 * that explains it.
 *
 * A refusal is returned rather than thrown because it is a *verdict* the caller
 * records — the candidate stays quarantined and the operator report is counted
 * by cause. `error` carries the wrapped vendor failure when there was one, so
 * the cause is inspectable without any vendor type escaping. There is no third
 * shape: a partial record that might be mistaken for a successful corroboration
 * is never produced.
 */
export type EvidenceFetchResult =
    | { readonly ok: true; readonly record: EvidenceRetrievalRecord }
    | {
          readonly ok: false;
          readonly reason: EvidenceRejectionReason;
          readonly detail: string;
          readonly host: string | null;
          readonly error: EvidenceError | null;
      };

// ---------------------------------------------------------------------------
// The real implementations of the three seams.
// ---------------------------------------------------------------------------

/** `dns.promises.lookup` with `all: true`, which is the only form allowed here. */
export const defaultEvidenceLookup: EvidenceHostLookup = (host: string) => dnsPromises.lookup(host, { all: true });

export const defaultEvidenceClock: EvidenceClock = {
    now: (): Date => new Date(),
    schedule: (onElapsed: () => void, delayMs: number): EvidenceTimer => {
        const timer = setTimeout(onElapsed, delayMs);
        // A pending deadline must never be the reason a CLI script stays alive.
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
        return { cancel: (): void => clearTimeout(timer) };
    },
};

const PINNED_HOST_MISMATCH = 'the pinned lookup was asked for a host it did not validate';

/**
 * A `lookup` that answers with the pinned address and never consults DNS.
 *
 * This is the anti-rebinding step, and it is not optional. Validating a name and
 * then handing that *name* to an HTTP client re-resolves it at connect time,
 * which is precisely the window an attacker-controlled record exploits: a public
 * address for the check, a private one for the connection. Supplying the
 * resolved address as the agent's lookup closes the window while leaving the
 * hostname — and therefore SNI, the `Host` header and certificate verification
 * — untouched.
 *
 * Both callback shapes are answered because Node calls a custom lookup either
 * way: with `all: true` when it is selecting an address family for itself, and
 * with a single address otherwise. A request for any other hostname fails
 * closed rather than being resolved, so a redirect or a retry cannot quietly
 * reach a second name on this connection.
 */
const pinnedLookup = (host: string, address: string, family: 4 | 6): LookupFunction => {
    return (hostname, options, callback): void => {
        if (hostname !== host) {
            const error = new Error(PINNED_HOST_MISMATCH) as NodeJS.ErrnoException;
            error.code = 'EAI_FAIL';
            callback(error, '');
            return;
        }

        const wantsEveryAddress =
            typeof options === 'object' && options !== null && (options as { all?: unknown }).all === true;

        if (wantsEveryAddress) {
            callback(null, [{ address, family }]);
            return;
        }

        callback(null, address, family);
    };
};

/**
 * The Node HTTPS transport.
 *
 * A **fresh agent per request**, deliberately: an agent's socket pool is keyed
 * by host and port and knows nothing about the pinned address, so a pooled
 * socket could serve a connection this request never validated. Redirects are
 * not followed — `https.request` never does — which is what leaves the decision
 * to `evaluateEvidenceRedirect`.
 *
 * TLS is left exactly as Node configures it: `rejectUnauthorized` is untouched
 * and `servername` is the original hostname, so the certificate is verified
 * against the name that was validated and not against the address dialled.
 */
export const defaultEvidenceFetch: EvidenceFetch = (request: EvidenceHttpRequest) =>
    new Promise<EvidenceHttpResponse>((resolve, reject) => {
        let parsed: URL;
        try {
            parsed = new URL(request.url);
        } catch (error) {
            reject(error);
            return;
        }

        const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });

        const httpsRequest = https.request(
            {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port === '' ? undefined : Number(parsed.port),
                path: `${parsed.pathname}${parsed.search}`,
                method: 'GET',
                headers: { ...request.headers },
                agent,
                signal: request.signal,
                servername: parsed.hostname,
                family: request.addressFamily,
                lookup: pinnedLookup(request.host, request.pinnedAddress, request.addressFamily),
            },
            (response) => {
                response.on('close', () => agent.destroy());
                resolve({
                    status: response.statusCode ?? 0,
                    headers: response.headers,
                    body: response,
                });
            },
        );

        httpsRequest.on('error', (error) => {
            agent.destroy();
            reject(error);
        });

        httpsRequest.end();
    });

// ---------------------------------------------------------------------------
// Transport mechanics.
//
// HTTP wire details only. Nothing in this section decides whether a URL, a
// host, an address or a media type is acceptable — those answers all come from
// evidence.logic.ts.
// ---------------------------------------------------------------------------

const CONTENT_TYPE_HEADER = 'content-type';
const CONTENT_ENCODING_HEADER = 'content-encoding';
const LOCATION_HEADER = 'location';

const ACCEPT_HEADER = 'accept';
const ACCEPT_ENCODING_HEADER = 'accept-encoding';
const USER_AGENT_HEADER = 'user-agent';

const IDENTITY_ENCODING = 'identity';
const GZIP_ENCODINGS: readonly string[] = ['gzip', 'x-gzip'];
const DEFLATE_ENCODING = 'deflate';
const BROTLI_ENCODING = 'br';

const EVIDENCE_USER_AGENT = 'state-of-health-catalog-evidence/1';

const HTTP_OK = 200;
const HTTP_MULTIPLE_CHOICES = 300;
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

const WHITESPACE_RUN = /\s+/g;

const errorMessage = (error: unknown): string =>
    error instanceof Error && error.message !== '' ? error.message : String(error);

/**
 * The request headers, and the complete list of them.
 *
 * **No credentials, ever** — no `Authorization`, no `Cookie`, no API key. There
 * is nothing to authenticate to on a public reference site, and an outbound
 * credential is what turns a server-side request forgery into credential theft.
 * The header set is built here from a constant and the policy's own media types,
 * so there is no path by which a caller's secret could be attached.
 *
 * `identity` is requested so the bytes on the wire are the bytes of the body;
 * the cap is still applied to decompressed output, because a server may answer
 * with an encoding regardless of what was asked.
 */
const buildRequestHeaders = (allowedContentTypes: readonly string[]): Readonly<Record<string, string>> => {
    const headers: Record<string, string> = {
        [ACCEPT_ENCODING_HEADER]: IDENTITY_ENCODING,
        [USER_AGENT_HEADER]: EVIDENCE_USER_AGENT,
    };

    if (allowedContentTypes.length > 0) {
        headers[ACCEPT_HEADER] = allowedContentTypes.join(', ');
    }

    return headers;
};

/**
 * One header as a single string. A repeated header is joined rather than
 * reduced to its first value: a response carrying two content types or two
 * encodings is malformed, and joining them produces a value that matches
 * nothing, which refuses it instead of quietly honouring half of it.
 */
const headerValue = (headers: EvidenceResponseHeaders, name: string): string | null => {
    const raw = headers[name];

    if (typeof raw === 'string') {
        return raw;
    }
    if (Array.isArray(raw)) {
        return raw.length === 0 ? null : raw.join(', ');
    }

    return null;
};

const isSuccessStatus = (status: number): boolean => status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES;

const redirectLocation = (response: EvidenceHttpResponse): string | null =>
    REDIRECT_STATUSES.indexOf(response.status) === -1 ? null : headerValue(response.headers, LOCATION_HEADER);

/** Reads nothing and frees the socket — the path taken by every refusal after a response arrives. */
const discardBody = (body: Readable): void => {
    body.destroy();
};

type DecoderChoice =
    | { readonly supported: true; readonly decoder: Transform | null }
    | { readonly supported: false; readonly encoding: string };

/**
 * The decompressor for a response, or a refusal.
 *
 * An encoding this module cannot decompress is refused rather than read: the cap
 * is defined on decompressed bytes, so counting bytes it cannot decompress would
 * be applying the cap to the compressed size — the zip-bomb hole the cap exists
 * to close.
 */
const chooseDecoder = (rawEncoding: string | null): DecoderChoice => {
    const encoding = (rawEncoding ?? '').trim().toLowerCase();

    if (encoding === '' || encoding === IDENTITY_ENCODING) {
        return { supported: true, decoder: null };
    }
    if (GZIP_ENCODINGS.indexOf(encoding) !== -1) {
        return { supported: true, decoder: createGunzip() };
    }
    if (encoding === DEFLATE_ENCODING) {
        return { supported: true, decoder: createInflate() };
    }
    if (encoding === BROTLI_ENCODING) {
        return { supported: true, decoder: createBrotliDecompress() };
    }

    return { supported: false, encoding };
};

// ---------------------------------------------------------------------------
// The total deadline.
//
// One deadline for the whole operation, not one per hop: a per-hop timeout
// multiplies by the redirect count, so three hops under a "10 second" per-hop
// bound is a thirty-second fetch. The signal is handed to every request made
// under it, so a redirect chain shares the one budget.
// ---------------------------------------------------------------------------

interface Deadline {
    readonly signal: AbortSignal;
    expired(): boolean;
    cancel(): void;
}

const startDeadline = (clock: EvidenceClock, timeoutMs: number): Deadline => {
    const controller = new AbortController();
    let expired = false;

    const timer = clock.schedule(() => {
        expired = true;
        controller.abort();
    }, timeoutMs);

    return {
        signal: controller.signal,
        expired: (): boolean => expired,
        cancel: (): void => timer.cancel(),
    };
};

const isAbortError = (error: unknown): boolean =>
    error instanceof Error && (error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR');

interface TransportFailure {
    readonly reason: EvidenceRejectionReason;
    readonly detail: string;
    readonly error: EvidenceError;
}

/**
 * Wraps a transport failure, distinguishing "we ran out of time" from "it broke".
 *
 * The two are separate causes in an operator report — a timeout says the host was
 * slow or unreachable, a failure says the exchange itself went wrong — and the
 * elapsed deadline is the authority on which happened, because an abort raised
 * by the signal surfaces as an ordinary transport error.
 */
const transportFailure = (error: unknown, deadline: Deadline): TransportFailure => {
    const timedOut = deadline.expired() || isAbortError(error);
    const reason: EvidenceRejectionReason = timedOut ? 'fetch_timeout' : 'fetch_failed';
    const detail = timedOut
        ? 'the evidence fetch exceeded its total timeout'
        : `the evidence fetch failed: ${errorMessage(error)}`;

    return { reason, detail, error: new EvidenceError(reason, detail) };
};

// ---------------------------------------------------------------------------
// Reading the body under the cap.
// ---------------------------------------------------------------------------

type BodyOutcome =
    | { readonly ok: true; readonly bytes: Buffer }
    | {
          readonly ok: false;
          readonly reason: EvidenceRejectionReason;
          readonly detail: string;
          readonly error: EvidenceError | null;
      };

/**
 * Streams the body, counting **decompressed** bytes, and destroys the stream the
 * moment the cap is passed.
 *
 * Read incrementally and abort, never buffer and then measure: a `Content-Length`
 * check is worthless on its own because the header can lie, and a cap on the
 * compressed size is the zip-bomb hole. Counting output as it leaves the
 * decompressor is what makes the declared cap a real memory bound.
 *
 * Both ends are destroyed on every failure path, so a refusal never leaves a
 * socket or a decompressor draining in the background, and the settle guard
 * keeps the first outcome: destroying a stream can itself raise, and the reason
 * the read ended must not be overwritten by the consequence of ending it.
 */
const readCappedBody = (
    source: Readable,
    decoder: Transform | null,
    limits: unknown,
    deadline: Deadline,
): Promise<BodyOutcome> =>
    new Promise<BodyOutcome>((resolve) => {
        const chunks: Buffer[] = [];
        let decompressedBytes = 0;
        let settled = false;

        const finish = (outcome: BodyOutcome): void => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(outcome);
        };

        const abandon = (): void => {
            source.destroy();
            if (decoder !== null) {
                decoder.destroy();
            }
        };

        const fail = (error: unknown): void => {
            abandon();
            const failure = transportFailure(error, deadline);
            finish({ ok: false, reason: failure.reason, detail: failure.detail, error: failure.error });
        };

        const sink: Readable = decoder === null ? source : decoder;

        if (decoder !== null) {
            source.on('error', fail);
            source.pipe(decoder);
        }

        sink.on('data', (chunk: Buffer | string) => {
            const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            decompressedBytes += buffer.length;

            if (!isWithinBodyCap(decompressedBytes, limits)) {
                abandon();
                finish({
                    ok: false,
                    reason: 'body_too_large',
                    detail: `the response body passed the declared cap after ${decompressedBytes} decompressed bytes`,
                    error: null,
                });
                return;
            }

            chunks.push(buffer);
        });

        sink.on('end', () => finish({ ok: true, bytes: Buffer.concat(chunks) }));
        sink.on('error', fail);
    });

// ---------------------------------------------------------------------------
// Resolving and pinning.
// ---------------------------------------------------------------------------

type PinOutcome =
    | { readonly ok: true; readonly address: string; readonly family: 4 | 6 }
    | {
          readonly ok: false;
          readonly reason: EvidenceRejectionReason;
          readonly detail: string;
          readonly error: EvidenceError | null;
      };

/** One answer's address, or `null` when the answer is not an address at all. */
const readResolvedAddress = (entry: unknown): string | null => {
    if (entry === null || typeof entry !== 'object') {
        return null;
    }

    const address = (entry as { address?: unknown }).address;
    return typeof address === 'string' ? address : null;
};

/**
 * Resolves the host, classifies the **whole** answer set, and pins one address.
 *
 * Three properties, in order, and all three fail closed. An answer that is not an
 * address is refused rather than skipped, because skipping it would classify a
 * subset and call that a pass. The set is judged by `evidence.logic.ts`, where an
 * empty answer is a rejection and one bad member fails every member. The pinned
 * address is the resolver's own string, never a re-rendered one — classifying one
 * spelling and dialling another is the confusion this whole module exists to
 * avoid — and its family comes from the policy module's parser rather than from
 * the resolver's own claim about it.
 */
const resolveAndPin = async (
    host: string,
    ranges: readonly SpecialPurposeRange[],
    lookup: EvidenceHostLookup,
    deadline: Deadline,
): Promise<PinOutcome> => {
    let answers: readonly EvidenceResolvedAddress[];
    try {
        answers = await lookup(host);
    } catch (error) {
        if (deadline.expired() || isAbortError(error)) {
            const failure = transportFailure(error, deadline);
            return { ok: false, reason: failure.reason, detail: failure.detail, error: failure.error };
        }
        const detail = `the evidence host could not be resolved: ${errorMessage(error)}`;
        return { ok: false, reason: 'unresolvable_host', detail, error: new EvidenceError('unresolvable_host', detail) };
    }

    if (!Array.isArray(answers)) {
        return {
            ok: false,
            reason: 'unresolvable_host',
            detail: 'the resolver did not answer with a set of addresses',
            error: null,
        };
    }

    const addresses: string[] = [];
    for (const answer of answers as readonly unknown[]) {
        const address = readResolvedAddress(answer);
        if (address === null) {
            return {
                ok: false,
                reason: 'address_unparsable',
                detail: 'the resolver returned an answer that is not an address',
                error: null,
            };
        }
        addresses.push(address);
    }

    const verdict = classifyAddressSet(addresses, ranges);
    if (!verdict.allowed) {
        return { ok: false, reason: verdict.reason, detail: verdict.detail, error: null };
    }

    const pinned = addresses[0];
    const parsed = parseIpAddress(pinned);
    if (parsed === null) {
        return {
            ok: false,
            reason: 'address_unparsable',
            detail: 'the address selected for the connection could not be parsed',
            error: null,
        };
    }

    return { ok: true, address: pinned, family: parsed.version };
};

// ---------------------------------------------------------------------------
// The record.
// ---------------------------------------------------------------------------

/** Lower-cased with whitespace runs collapsed — the one projection both sides of the match share. */
const normalizeForMatch = (text: string): string => text.replace(WHITESPACE_RUN, ' ').trim().toLowerCase();

/**
 * The excerpt that corroborates the candidate's name, or `null` when the page
 * does not contain it.
 *
 * A plain containment check over a whitespace-collapsed, lower-cased projection
 * of the body: corroboration, not parsing. No markup is interpreted, so a name
 * broken across tags does not match — which is the honest answer for a check
 * this simple, and far better than a parser guessing at attacker-supplied HTML.
 *
 * A blank name yields `null` rather than a match at position zero. Every string
 * contains the empty string, so the alternative is a page that corroborates
 * anything.
 */
const findMatchedSnippet = (body: Buffer, expectedName: string, maxChars: number): string | null => {
    if (typeof expectedName !== 'string' || maxChars <= 0) {
        return null;
    }

    const needle = normalizeForMatch(expectedName);
    if (needle === '') {
        return null;
    }

    const haystack = normalizeForMatch(body.toString('utf8'));
    const matchIndex = haystack.indexOf(needle);
    if (matchIndex === -1) {
        return null;
    }

    const context = Math.max(0, Math.floor((maxChars - needle.length) / 2));
    const start = Math.max(0, matchIndex - context);

    return haystack.slice(start, start + maxChars);
};

const refuse = (
    reason: EvidenceRejectionReason,
    detail: string,
    host: string | null,
    error: EvidenceError | null = null,
): EvidenceFetchResult => {
    // Host granularity, and nothing else: never the full URL (its query string is
    // model-supplied), never a header, never a byte of the body.
    console.warn(`Evidence retrieval refused (${reason}) for host ${host ?? 'unknown'}`);

    return { ok: false, reason, detail, host, error };
};

/**
 * Retrieves one identity-evidence page, or refuses to.
 *
 * @param url the URL a language model proposed — untrusted input throughout
 * @param expectedName the candidate food's name, the page is searched for it
 * @param policy `evidence-allowlist.v1.json` as loaded by `scripts/lib/manifest.ts`.
 *   A **parameter, never an import**: `tsconfig.json` roots the production
 *   program at `src/` and `.dockerignore` keeps `data/` out of the image, so a
 *   file under `data/` can be neither compiled into nor read by the running API.
 * @param evidenceType the claim the page would corroborate. Required, and not
 *   defaulted here: a host class states which claims it may support, an omitted
 *   scope authorizes everything, and choosing one on a caller's behalf would be
 *   this module inventing policy. (The Agent Action Plan's sketch of this
 *   signature omits it; `evidence.logic.ts` requires it, so it is threaded
 *   through rather than assumed.)
 * @param deps the resolver, transport and clock, each defaulting to the real
 *   implementation
 *
 * Every check runs before the network is touched, in the order that makes the
 * order itself the security property, and the first failure short-circuits. A
 * page that is fetched but does not mention the candidate returns a record whose
 * `matchedSnippet` is `null`: evidence that failed to corroborate, which leaves
 * the candidate quarantined, and which is a different fact from no evidence at
 * all.
 */
export const fetchEvidence = async (
    url: string,
    expectedName: string,
    policy: EvidencePolicy,
    evidenceType: EvidenceType,
    deps: EvidenceDeps = {},
): Promise<EvidenceFetchResult> => {
    const lookup = deps.lookup ?? defaultEvidenceLookup;
    const fetch = deps.fetch ?? defaultEvidenceFetch;
    const clock = deps.clock ?? defaultEvidenceClock;

    // The document first. A stale, truncated or tampered policy means the
    // candidate was never judged, because the rules it would have been judged by
    // could not be trusted — so it is refused before anything else is read.
    const validated = validateEvidencePolicy(policy);
    if (!validated.ok) {
        return refuse(validated.reason, validated.detail, null);
    }

    const document = validated.policy;
    const limits = resolveEvidenceFetchLimits(document.fetchLimits);
    const requestHeaders = buildRequestHeaders(limits.allowedContentTypes);

    // Scheme, port, userinfo, IP literal, IDNA, host allowlist and evidence-type
    // authorization, all of them before a socket exists. The verdict carries the
    // normalized href, and that is the string fetched: judging one spelling and
    // opening another is the parser-confusion bypass.
    const approved = evaluateEvidenceUrl(url, document, evidenceType);
    if (!approved.allowed) {
        return refuse(approved.reason, approved.detail, null);
    }

    const deadline = startDeadline(clock, Math.min(getEvidenceFetchTimeoutMs(), limits.timeoutMs));

    try {
        let target = approved;
        let redirectsFollowed = 0;

        // The initial request plus at most `maxRedirects` hops. The bound is
        // stated here as well as enforced by `evaluateEvidenceRedirect` so the
        // loop cannot spin even if a policy document were ever read as permitting
        // it.
        for (let attempt = 0; attempt <= limits.maxRedirects; attempt++) {
            if (deadline.expired()) {
                return refuse('fetch_timeout', 'the evidence fetch exceeded its total timeout', target.host);
            }

            const pinned = await resolveAndPin(target.host, document.specialPurposeRanges, lookup, deadline);
            if (!pinned.ok) {
                return refuse(pinned.reason, pinned.detail, target.host, pinned.error);
            }

            let response: EvidenceHttpResponse;
            try {
                response = await fetch({
                    url: target.url,
                    host: target.host,
                    pinnedAddress: pinned.address,
                    addressFamily: pinned.family,
                    headers: requestHeaders,
                    signal: deadline.signal,
                });
            } catch (error) {
                const failure = transportFailure(error, deadline);
                return refuse(failure.reason, failure.detail, target.host, failure.error);
            }

            const location = redirectLocation(response);
            if (location !== null) {
                discardBody(response.body);

                // Re-validated from the URL step onward and re-pinned on the next
                // pass, because a hop is a new fetch: a redirect to `http://`, to
                // another port, to a host nobody allowlisted, or off this host
                // entirely is refused here rather than followed.
                const hop = evaluateEvidenceRedirect(target.url, location, redirectsFollowed, document, evidenceType);
                if (!hop.allowed) {
                    return refuse(hop.reason, hop.detail, target.host);
                }

                redirectsFollowed += 1;
                target = hop;
                continue;
            }

            if (!isSuccessStatus(response.status)) {
                discardBody(response.body);
                return refuse('fetch_failed', `the evidence host answered ${response.status}`, target.host);
            }

            // Judged before a byte is read, and the body is dropped unread when it
            // is refused: an unlisted type is never worth the transfer.
            const contentType = headerValue(response.headers, CONTENT_TYPE_HEADER);
            if (!isAllowedContentType(contentType, document.fetchLimits)) {
                discardBody(response.body);
                const declared = contentType === null ? 'no content type' : `content type "${contentType}"`;
                return refuse('content_type_not_allowed', `the response declared ${declared}`, target.host);
            }

            const decoder = chooseDecoder(headerValue(response.headers, CONTENT_ENCODING_HEADER));
            if (!decoder.supported) {
                discardBody(response.body);
                return refuse(
                    'fetch_failed',
                    `the response used the unsupported content encoding "${decoder.encoding}"`,
                    target.host,
                );
            }

            const body = await readCappedBody(response.body, decoder.decoder, document.fetchLimits, deadline);
            if (!body.ok) {
                return refuse(body.reason, body.detail, target.host, body.error);
            }

            return {
                ok: true,
                record: {
                    // The URL is the normalized one the candidate proposed, which
                    // stays the retrieval's identity across a same-host redirect;
                    // `finalHost` is the host that actually served these bytes.
                    url: approved.url,
                    finalHost: target.host,
                    status: response.status,
                    bodySha256: createHash('sha256').update(body.bytes).digest('hex'),
                    matchedSnippet: findMatchedSnippet(body.bytes, expectedName, limits.maxSnippetChars),
                    fetchedAt: clock.now().toISOString(),
                },
            };
        }

        return refuse(
            'redirect_limit_exceeded',
            `more than ${limits.maxRedirects} redirects were required`,
            target.host,
        );
    } finally {
        deadline.cancel();
    }
};
