import { domainToASCII } from 'url';

/**
 * The pure SSRF policy for identity-evidence retrieval.
 *
 * `scripts/catalog-generate-ai.ts` asks a language model to propose URLs that
 * corroborate a generated catalog food's identity, and then fetches them. A
 * model-proposed URL is attacker-influenced input, so every decision about
 * whether it may be fetched is made here, and the defences apply in this order:
 * an allowlist of *named* hosts, a fail-closed address classifier, DNS pinning
 * (the service resolves once and hands the answers here), and hard fetch limits.
 *
 * This module decides; `evidence.service.ts` acts. Nothing here performs I/O —
 * no `fetch`, no DNS lookup, no filesystem, no `process.env`, no clock — which
 * is what lets the policy be tested exhaustively against the committed IANA
 * table with no network and no mocks.
 *
 * Every predicate returns a verdict carrying a machine-readable reason instead
 * of throwing, so the caller can record *why* a candidate stayed quarantined.
 * Throwing is `evidence.service.ts`'s job.
 */

/**
 * Exactly as the IANA special-purpose registries state it: `true`, `false`, or
 * the literal string `'n/a'`. The three are never collapsed into a boolean —
 * `'n/a'` does not mean "unknown, so probably fine", and the three-way
 * distinction is what makes the committed table auditable line-by-line against
 * the registries. Only `true` permits a fetch; `false` and `'n/a'` both reject.
 */
export type GloballyReachable = boolean | 'n/a';

/**
 * One row of the IANA IPv4/IPv6 Special-Purpose Address Registry (RFC 6890),
 * transcribed into `evidence-allowlist.v1.json` at a recorded snapshot date.
 *
 * `registry` and `name` are provenance for the human reviewing a refresh; the
 * classifier branches on `cidr` and `globallyReachable` only. The address
 * family is taken from the CIDR itself rather than from `registry`, so a
 * mislabelled row cannot smuggle an IPv4 rule onto an IPv6 address.
 */
export interface SpecialPurposeRange {
    readonly cidr: string;
    readonly name: string;
    readonly registry: string;
    readonly globallyReachable: GloballyReachable;
}

/**
 * One hand-curated allowlist entry group: USDA/FDC, government and university
 * nutrition references, and named culinary references. No manufacturer domains
 * appear in it by design — AI generation proposes only generic preparations,
 * and a model-proposed brand domain could never independently verify a
 * model-proposed product.
 *
 * Only `hosts` is required, because only `hosts` is read here. The identifier
 * is optional and accepted under either spelling (`class` in the committed
 * document, `id` in `scripts/lib/manifest.ts`) so that both the raw document
 * and the script loader's declared type satisfy this shape — see
 * {@link evidenceHostClassId}. Requiring a field this module does not use would
 * make one of the two callers fail to compile for no safety gain.
 */
export interface EvidenceHostClass {
    /** Exact hosts (`nal.usda.gov`) and `*.` wildcards (`*.nal.usda.gov`), matched per label. */
    readonly hosts: readonly string[];
    readonly class?: string;
    readonly id?: string;
    readonly description?: string;
    readonly evidenceTypes?: readonly string[];
}

/**
 * The fetch limits as the policy document declares them. Enforcement belongs to
 * `evidence.service.ts`, which owns the socket; this module only declares the
 * shape and resolves it against the canonical ceilings.
 *
 * Every member is optional because the document and the script loader's
 * declared type disagree about which of them are written — a missing member
 * falls back to the reviewed canonical constant rather than to "no limit".
 */
export interface EvidenceFetchLimits {
    readonly schemes?: readonly string[];
    readonly allowedPorts?: readonly number[];
    readonly maxRedirects?: number;
    readonly timeoutMs?: number;
    /** Bytes of the *decompressed* body — a compressed-size cap is a zip-bomb hole. */
    readonly maxBodyBytes?: number;
    readonly allowedContentTypes?: readonly string[];
    readonly maxSnippetChars?: number;
}

/**
 * `evidence-allowlist.v1.json` as loaded by `scripts/lib/manifest.ts` and handed
 * to this module. It is a parameter, never an import: `tsconfig.json` roots the
 * production program at `src/`, and `.dockerignore` keeps `data/` out of the
 * image, so a file under `data/` can be neither compiled into nor read by the
 * running API.
 *
 * `registrySnapshot` and `rowCount` are carried so a refresh of the address
 * table is a reviewed data change — the sibling test asserts both against the
 * values recorded in `docs/meal-planning/catalog-policy.md`.
 */
export interface EvidencePolicy {
    readonly allowlistVersion: string;
    readonly registrySnapshot: string;
    readonly rowCount: number;
    readonly hostClasses: readonly EvidenceHostClass[];
    readonly specialPurposeRanges: readonly SpecialPurposeRange[];
    readonly fetchLimits: EvidenceFetchLimits;
}

/**
 * The audit record `evidence.service.ts` produces per URL actually retrieved,
 * stored in `catalog_validation_records.identity_evidence`.
 *
 * Structurally identical to `CatalogIdentityEvidenceRecord` in
 * `src/types/catalog.ts` so the two are mutually assignable; the duplication is
 * deliberate, because this module imports nothing from the wire-DTO layer.
 * `matchedSnippet` is `null` when the page was fetched but the candidate's name
 * was not found in it — evidence that failed to corroborate, which leaves the
 * candidate quarantined rather than published, and is not the same thing as no
 * evidence at all. The snippet is capped at
 * {@link EVIDENCE_MAX_SNIPPET_CHARS} characters, and its contents are data:
 * fetched bytes are matched against the candidate's name and stored, never fed
 * back into a prompt as instructions.
 */
export interface EvidenceRetrievalRecord {
    readonly url: string;
    readonly finalHost: string;
    readonly status: number;
    readonly bodySha256: string;
    readonly matchedSnippet: string | null;
    readonly fetchedAt: string;
}

/**
 * The closed set of reasons a retrieval may be refused. A caller logs the code
 * rather than a sentence, so the operator report can be counted by cause.
 *
 * The URL and address codes are decided here; the four transport codes
 * (`redirect_limit_exceeded` … `fetch_failed`) are decided by
 * `evidence.service.ts` while enforcing the declared limits, and live in the
 * same set so the service never has to invent a string.
 *
 * `idna_conversion_failed` is reported by {@link classifyEvidenceHost} for a
 * bare host. It is not what a whole URL with such a host yields: the WHATWG
 * parser refuses to parse one at all, so {@link parseEvidenceUrl} answers
 * `unparseable_url` first. Both refuse; only the recorded cause differs.
 */
export type EvidenceRejectionReason =
    | 'unparseable_url'
    | 'scheme_not_allowed'
    | 'credentials_present'
    | 'port_not_allowed'
    | 'ip_literal_host'
    | 'idna_conversion_failed'
    | 'malformed_host'
    | 'host_not_allowlisted'
    | 'unresolvable_host'
    | 'address_unparsable'
    | 'address_not_unicast'
    | 'address_not_globally_routable'
    | 'embedded_address_not_globally_routable'
    | 'range_table_unclassifiable'
    | 'cross_host_redirect'
    | 'redirect_limit_exceeded'
    | 'content_type_not_allowed'
    | 'body_too_large'
    | 'fetch_timeout'
    | 'fetch_failed';

/**
 * The verdict on a URL. On success it carries the *normalized* href that the
 * service must fetch, so the string this module judged and the string the
 * socket opens can never differ — the parser-confusion class of bypass is
 * closed by construction rather than by matching two parsers' behaviour.
 */
export type EvidenceUrlVerdict =
    | { readonly allowed: true; readonly url: string; readonly host: string; readonly hostClass: string | null }
    | { readonly allowed: false; readonly reason: EvidenceRejectionReason; readonly detail: string };

/**
 * The verdict on a resolved address, or on the whole answer set for a host.
 * `address` names the member that decided a rejection, which is what makes a
 * mixed answer set diagnosable.
 */
export type EvidenceAddressVerdict =
    | { readonly allowed: true }
    | {
          readonly allowed: false;
          readonly reason: EvidenceRejectionReason;
          readonly detail: string;
          readonly address: string | null;
      };

/** A parsed address as bytes: 4 for IPv4, 16 for IPv6. */
export interface ParsedIpAddress {
    readonly version: 4 | 6;
    readonly bytes: readonly number[];
}

/** A parsed CIDR block: a masked base address plus its prefix length in bits. */
export interface ParsedCidr {
    readonly version: 4 | 6;
    readonly bytes: readonly number[];
    readonly prefixLength: number;
}

// ---------------------------------------------------------------------------
// Canonical policy ceilings.
//
// These are the reviewed values. The policy document may NARROW them and can
// never widen them (see resolveEvidenceFetchLimits), so a tampered or stale
// allowlist cannot unlock a scheme, a port, a content type or a bigger body
// than the code sanctions.
// ---------------------------------------------------------------------------

/** The only scheme an evidence URL may use, stored bare (no trailing colon). */
export const EVIDENCE_ALLOWED_SCHEME = 'https';

/**
 * The only port an evidence URL may reach. An explicit `:443` is accepted
 * because the URL parser normalises it away; every other port is refused, which
 * is what stops `https://` from being pointed at an internal service on 8080.
 */
export const EVIDENCE_ALLOWED_PORT = 443;

export const EVIDENCE_MAX_REDIRECTS = 2;

export const EVIDENCE_FETCH_TIMEOUT_MS = 10_000;

/** 1 MiB, measured on the decompressed body, with the stream aborted at the cap. */
export const EVIDENCE_MAX_BODY_BYTES = 1_048_576;

export const EVIDENCE_ALLOWED_CONTENT_TYPES: readonly string[] = ['text/html', 'application/json', 'text/plain'];

export const EVIDENCE_MAX_SNIPPET_CHARS = 500;

/**
 * A normalized host: lower-case ASCII labels of letters, digits and hyphens,
 * and at least two of them. The two-label minimum is why a bare `localhost`
 * never reaches a lookup.
 */
export const EVIDENCE_HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const WILDCARD_PREFIX = '*.';
const IPV4_BYTES = 4;
const IPV6_BYTES = 16;
const IPV6_GROUPS = 8;
const BITS_PER_BYTE = 8;
const MAX_OCTET = 255;
const MAX_IPV4_PREFIX = 32;
const MAX_IPV6_PREFIX = 128;

const IPV4_OCTET_PATTERN = /^\d{1,3}$/;
const IPV6_GROUP_PATTERN = /^[0-9a-f]{1,4}$/i;
const PREFIX_LENGTH_PATTERN = /^\d{1,3}$/;

/**
 * The declared limits after resolution: fully populated, and with the cross-host
 * redirect rule represented as an unconfigurable literal `false` so no document
 * can turn it on.
 */
export interface ResolvedEvidenceFetchLimits {
    readonly schemes: readonly string[];
    readonly allowedPorts: readonly number[];
    readonly maxRedirects: number;
    readonly timeoutMs: number;
    readonly maxBodyBytes: number;
    readonly allowedContentTypes: readonly string[];
    readonly maxSnippetChars: number;
    readonly allowCrossHostRedirect: false;
}

/** Anything that is not a real array is treated as absent, never as trusted. */
const asList = (value: unknown): readonly unknown[] => (Array.isArray(value) ? (value as readonly unknown[]) : []);

// A declared cap is honoured only when it is stricter than the reviewed one; an
// absent or nonsensical cap falls back to the reviewed value rather than to
// zero, because a zero timeout or a zero-byte body would disable evidence
// retrieval entirely instead of securing it.
const narrowCap = (declared: unknown, ceiling: number, allowZero: boolean): number => {
    if (typeof declared !== 'number' || !isFinite(declared)) {
        return ceiling;
    }
    if (allowZero ? declared < 0 : declared <= 0) {
        return ceiling;
    }
    return Math.min(declared, ceiling);
};

const narrowStrings = (declared: readonly string[] | undefined, ceiling: readonly string[]): readonly string[] => {
    if (declared === undefined) {
        return ceiling;
    }
    const normalized = declared.map((value) => String(value).trim().toLowerCase());
    return ceiling.filter((value) => normalized.indexOf(value) !== -1);
};

const narrowNumbers = (declared: readonly number[] | undefined, ceiling: readonly number[]): readonly number[] => {
    if (declared === undefined) {
        return ceiling;
    }
    return ceiling.filter((value) => declared.indexOf(value) !== -1);
};

/**
 * Resolves the document's declared limits against the canonical ceilings.
 *
 * One rule governs it: **the document may narrow the policy and can never widen
 * it.** Lists are intersected with the ceiling, numeric caps take the smaller of
 * the two, and anything missing or malformed falls back to the canonical
 * constant. A document that declares no `https` scheme therefore yields an empty
 * scheme list and refuses every URL — narrowing to nothing is a legitimate,
 * fail-closed outcome.
 */
export const resolveEvidenceFetchLimits = (limits?: EvidenceFetchLimits): ResolvedEvidenceFetchLimits => {
    const declared: EvidenceFetchLimits = limits ?? {};

    return {
        schemes: narrowStrings(declared.schemes, [EVIDENCE_ALLOWED_SCHEME]),
        allowedPorts: narrowNumbers(declared.allowedPorts, [EVIDENCE_ALLOWED_PORT]),
        maxRedirects: narrowCap(declared.maxRedirects, EVIDENCE_MAX_REDIRECTS, true),
        timeoutMs: narrowCap(declared.timeoutMs, EVIDENCE_FETCH_TIMEOUT_MS, false),
        maxBodyBytes: narrowCap(declared.maxBodyBytes, EVIDENCE_MAX_BODY_BYTES, false),
        allowedContentTypes: narrowStrings(declared.allowedContentTypes, EVIDENCE_ALLOWED_CONTENT_TYPES),
        maxSnippetChars: narrowCap(declared.maxSnippetChars, EVIDENCE_MAX_SNIPPET_CHARS, false),
        allowCrossHostRedirect: false,
    };
};

// ---------------------------------------------------------------------------
// Host policy.
// ---------------------------------------------------------------------------

const labelsEqual = (left: readonly string[], right: readonly string[]): boolean => {
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
};

/** The two ways a host can be refused on its own shape, before any allowlist check. */
export type EvidenceHostVerdict =
    | { readonly ok: true; readonly host: string }
    | { readonly ok: false; readonly reason: 'idna_conversion_failed' | 'malformed_host' };

/**
 * Normalises a host for comparison and reports why it was refused.
 *
 * The order is what closes the homograph and trailing-dot tricks: IDNA
 * conversion first (`domainToASCII` yields an empty string for a host it cannot
 * convert), then lower-casing, then removal of a *single* trailing dot
 * (`example.gov.` and `example.gov` are the same host, while `example.gov..` is
 * not a host at all and is refused), then the ASCII label check. The label
 * pattern requires two labels, which is why a bare `localhost` never reaches a
 * lookup, and it admits only letters, digits and hyphens, so an underscore host
 * is refused too.
 *
 * The pattern permits a hyphen in any position, so `-bad.gov` normalises
 * successfully even though RFC 1123 would not call it a hostname. That is not a
 * gap: normalisation only decides what a host *is*, and the hand-curated
 * allowlist is what decides whether it may be fetched, so a hyphen-edged host is
 * refused a step later with `host_not_allowlisted`.
 *
 * This is the module's only `domainToASCII` call site, so there is exactly one
 * definition of what a normalized host is.
 */
export const classifyEvidenceHost = (host: string): EvidenceHostVerdict => {
    if (typeof host !== 'string' || host === '') {
        return { ok: false, reason: 'malformed_host' };
    }

    const ascii = domainToASCII(host);
    if (ascii === '') {
        return { ok: false, reason: 'idna_conversion_failed' };
    }

    const lowered = ascii.toLowerCase();
    const withoutTrailingDot = lowered.charAt(lowered.length - 1) === '.' ? lowered.slice(0, -1) : lowered;

    if (!EVIDENCE_HOST_PATTERN.test(withoutTrailingDot)) {
        return { ok: false, reason: 'malformed_host' };
    }

    return { ok: true, host: withoutTrailingDot };
};

/**
 * {@link classifyEvidenceHost} as a normaliser: the normalized host, or `null`
 * for anything that fails, so a caller can never mistake an unconvertible host
 * for a usable one.
 */
export const normalizeEvidenceHost = (host: string): string | null => {
    const verdict = classifyEvidenceHost(host);
    return verdict.ok ? verdict.host : null;
};

/**
 * True for an address written where a name belongs. Evidence must come from a
 * *named* allowlisted host: an IP literal could never match the allowlist, and
 * accepting one would skip the pinning step the service performs on a resolved
 * name.
 *
 * URL syntax brackets an IPv6 literal, so a bracketed host is an address
 * however its contents parse.
 */
export const isIpLiteralHost = (host: string): boolean => {
    if (typeof host !== 'string' || host === '') {
        return false;
    }
    if (host.charAt(0) === '[' || host.charAt(host.length - 1) === ']') {
        return true;
    }
    return parseIpAddress(host) !== null;
};

/**
 * Matches one allowlist entry against a host by comparing **label arrays**.
 *
 * `host.endsWith('.example.gov')` is the bug this function exists to prevent
 * and `host.includes('example.gov')` is worse, so neither string operation is
 * used. An exact entry matches only that host; a `*.` entry matches a host
 * whose trailing labels are the entry's *and* which carries at least one label
 * of its own in front of them. Hence `nutrition.example.gov` matches
 * `*.example.gov`, while `example.gov` (no leading label), `notexample.gov`
 * (different label) and `example.gov.evil.com` (labels in the wrong place) do
 * not.
 */
export const hostMatchesEntry = (host: string, entry: string): boolean => {
    if (typeof entry !== 'string') {
        return false;
    }

    const normalizedHost = normalizeEvidenceHost(host);
    if (normalizedHost === null) {
        return false;
    }

    const isWildcard = entry.slice(0, WILDCARD_PREFIX.length) === WILDCARD_PREFIX;
    const normalizedEntry = normalizeEvidenceHost(isWildcard ? entry.slice(WILDCARD_PREFIX.length) : entry);
    if (normalizedEntry === null) {
        return false;
    }

    const hostLabels = normalizedHost.split('.');
    const entryLabels = normalizedEntry.split('.');

    if (!isWildcard) {
        return labelsEqual(hostLabels, entryLabels);
    }

    if (hostLabels.length <= entryLabels.length) {
        return false;
    }

    return labelsEqual(hostLabels.slice(hostLabels.length - entryLabels.length), entryLabels);
};

/**
 * The allowlist entry group a host belongs to, or `null` when no entry admits
 * it. The group is returned rather than a boolean so the caller can record
 * which class of reference corroborated a candidate.
 */
export const matchEvidenceHostClass = (
    host: string,
    hostClasses: readonly EvidenceHostClass[],
): EvidenceHostClass | null => {
    for (const rawClass of asList(hostClasses)) {
        if (rawClass === null || typeof rawClass !== 'object') {
            continue;
        }
        const hostClass = rawClass as EvidenceHostClass;
        for (const rawEntry of asList(hostClass.hosts)) {
            if (typeof rawEntry === 'string' && hostMatchesEntry(host, rawEntry)) {
                return hostClass;
            }
        }
    }
    return null;
};

export const isHostAllowed = (host: string, hostClasses: readonly EvidenceHostClass[]): boolean =>
    matchEvidenceHostClass(host, hostClasses) !== null;

/**
 * Reconciles the two spellings of a host class's identifier: the committed
 * allowlist writes `class`, while `scripts/lib/manifest.ts` declares `id`. This
 * is the single place that difference is resolved, so neither the document nor
 * the loader has to change for the other to work.
 */
export const evidenceHostClassId = (hostClass: EvidenceHostClass | null): string | null => {
    if (hostClass === null || typeof hostClass !== 'object') {
        return null;
    }
    if (typeof hostClass.class === 'string' && hostClass.class !== '') {
        return hostClass.class;
    }
    if (typeof hostClass.id === 'string' && hostClass.id !== '') {
        return hostClass.id;
    }
    return null;
};

// ---------------------------------------------------------------------------
// URL policy.
// ---------------------------------------------------------------------------

const rejectUrl = (reason: EvidenceRejectionReason, detail: string): EvidenceUrlVerdict => ({
    allowed: false,
    reason,
    detail,
});

// Keyed by reason rather than chosen with a conditional, so a host rejection
// added to EvidenceHostVerdict cannot ship without its message.
const HOST_REJECTION_DETAIL: Record<'idna_conversion_failed' | 'malformed_host', string> = {
    idna_conversion_failed: 'the host could not be converted to ASCII',
    malformed_host: 'the host is not a dotted ASCII name',
};

// The fragment is never sent to the server, so the URL that is actually fetched
// does not have one; dropping it also stops two records of the same page from
// looking like two different retrievals.
const buildNormalizedUrl = (parsed: URL, host: string): string => {
    const normalized = new URL(parsed.href);
    normalized.hostname = host;
    normalized.hash = '';
    return normalized.href;
};

/**
 * Applies the URL half of the policy and, on success, returns the **normalized
 * href the service must fetch**. Judging one string and opening a socket on
 * another is the parser-confusion class of bypass, and returning the exact
 * string to use closes it by construction.
 *
 * Parsing is delegated to the WHATWG parser — the same one the fetch will use —
 * and the allowlist checks are then applied to its components. Hand-rolling a
 * URL parser here would reintroduce the bug class the OWASP SSRF guidance warns
 * about. The parser also folds obfuscated numeric hosts (`https://2130706433/`)
 * into dotted-quad form, where the IP-literal check refuses them.
 *
 * `hostClass` is `null` on success here because this function does not consult
 * the allowlist; {@link evaluateEvidenceUrl} fills it in.
 */
export const parseEvidenceUrl = (rawUrl: string, limits?: EvidenceFetchLimits): EvidenceUrlVerdict => {
    const resolved = resolveEvidenceFetchLimits(limits);

    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
        return rejectUrl('unparseable_url', 'the URL is empty');
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return rejectUrl('unparseable_url', 'the URL could not be parsed');
    }

    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    if (resolved.schemes.indexOf(scheme) === -1) {
        return rejectUrl('scheme_not_allowed', `scheme "${scheme}" is not permitted`);
    }

    // Credentials in a model-proposed URL are themselves a signal, and
    // `https://allowed.gov@evil.com/` is a classic parser-confusion payload —
    // so userinfo is refused outright rather than stripped and followed.
    if (parsed.username !== '' || parsed.password !== '') {
        return rejectUrl('credentials_present', 'the URL carries userinfo');
    }

    // The parser normalises a scheme's default port away, so an empty `port`
    // means 443 for https and any non-empty value is an explicit other port.
    const port = parsed.port === '' ? EVIDENCE_ALLOWED_PORT : Number(parsed.port);
    if (resolved.allowedPorts.indexOf(port) === -1) {
        return rejectUrl('port_not_allowed', `port ${port} is not permitted`);
    }

    if (isIpLiteralHost(parsed.hostname)) {
        return rejectUrl('ip_literal_host', 'evidence must come from a named host, not an address');
    }

    const hostVerdict = classifyEvidenceHost(parsed.hostname);
    if (!hostVerdict.ok) {
        return rejectUrl(hostVerdict.reason, HOST_REJECTION_DETAIL[hostVerdict.reason]);
    }

    const host = hostVerdict.host;

    return { allowed: true, url: buildNormalizedUrl(parsed, host), host, hostClass: null };
};

/**
 * The entry point for a candidate URL: the full URL policy plus the allowlist.
 * `evidence.service.ts` calls this before resolving anything, and fetches only
 * the `url` it returns.
 */
export const evaluateEvidenceUrl = (rawUrl: string, policy: EvidencePolicy): EvidenceUrlVerdict => {
    const verdict = parseEvidenceUrl(rawUrl, policy.fetchLimits);
    if (!verdict.allowed) {
        return verdict;
    }

    const hostClass = matchEvidenceHostClass(verdict.host, policy.hostClasses);
    if (hostClass === null) {
        return rejectUrl('host_not_allowlisted', `host "${verdict.host}" is not on the evidence allowlist`);
    }

    return { allowed: true, url: verdict.url, host: verdict.host, hostClass: evidenceHostClassId(hostClass) };
};

// ---------------------------------------------------------------------------
// Address parsing.
//
// Addresses are held as byte arrays — four for IPv4, sixteen for IPv6 — and all
// prefix arithmetic is bitwise over those bytes. No big-integer arithmetic is
// used, so this module behaves identically under every `target`/`lib` the
// production, test and script programs choose.
// ---------------------------------------------------------------------------

const IPV6_GAP = '::';

const parseIpv4Bytes = (text: string): number[] | null => {
    const parts = text.split('.');
    if (parts.length !== IPV4_BYTES) {
        return null;
    }

    const bytes: number[] = [];
    for (const part of parts) {
        if (!IPV4_OCTET_PATTERN.test(part)) {
            return null;
        }
        // A leading zero is refused rather than interpreted. Runtimes disagree
        // about whether `010` means 8 or 10, and those are different addresses
        // — a disagreement between the validator and the connector is exactly
        // the bypass this refusal closes.
        if (part.length > 1 && part.charAt(0) === '0') {
            return null;
        }
        const value = Number(part);
        if (value > MAX_OCTET) {
            return null;
        }
        bytes.push(value);
    }

    return bytes;
};

const parseIpv6Side = (text: string, allowIpv4Tail: boolean): number[] | null => {
    if (text === '') {
        return [];
    }

    const parts = text.split(':');
    const groups: number[] = [];

    for (let index = 0; index < parts.length; index++) {
        const part = parts[index];

        if (part.indexOf('.') !== -1) {
            // RFC 4291 allows a dotted quad only at the very end of the
            // address, so `1.2.3.4::` is not an address.
            if (!allowIpv4Tail || index !== parts.length - 1) {
                return null;
            }
            const bytes = parseIpv4Bytes(part);
            if (bytes === null) {
                return null;
            }
            groups.push((bytes[0] << BITS_PER_BYTE) | bytes[1]);
            groups.push((bytes[2] << BITS_PER_BYTE) | bytes[3]);
            continue;
        }

        if (!IPV6_GROUP_PATTERN.test(part)) {
            return null;
        }
        groups.push(parseInt(part, 16));
    }

    return groups;
};

const groupsToBytes = (groups: readonly number[]): number[] => {
    const bytes: number[] = [];
    for (const group of groups) {
        bytes.push((group >> BITS_PER_BYTE) & MAX_OCTET);
        bytes.push(group & MAX_OCTET);
    }
    return bytes;
};

const parseIpv6Bytes = (text: string): number[] | null => {
    // A zone identifier scopes an address to one interface and is never part of
    // a resolver's answer for a public name, so it is refused as junk.
    if (text.indexOf('%') !== -1) {
        return null;
    }

    const gapIndex = text.indexOf(IPV6_GAP);
    const hasGap = gapIndex !== -1;
    if (hasGap && text.indexOf(IPV6_GAP, gapIndex + 1) !== -1) {
        return null;
    }

    const head = parseIpv6Side(hasGap ? text.slice(0, gapIndex) : text, !hasGap);
    const tail = hasGap ? parseIpv6Side(text.slice(gapIndex + IPV6_GAP.length), true) : [];
    if (head === null || tail === null) {
        return null;
    }

    const present = head.length + tail.length;

    if (!hasGap) {
        return present === IPV6_GROUPS ? groupsToBytes(head) : null;
    }

    // `::` stands for at least one all-zero group, so eight groups around it is
    // one group too many.
    if (present >= IPV6_GROUPS) {
        return null;
    }

    const groups: number[] = [];
    for (const group of head) {
        groups.push(group);
    }
    for (let index = present; index < IPV6_GROUPS; index++) {
        groups.push(0);
    }
    for (const group of tail) {
        groups.push(group);
    }

    return groupsToBytes(groups);
};

/**
 * Parses an IPv4 dotted quad or an RFC 4291 IPv6 text form, including `::`
 * compression and the `::ffff:a.b.c.d` dotted tail. Returns `null` for
 * everything else — decimal-integer and hex forms, octal-looking octets,
 * surrounding whitespace, zone identifiers, trailing junk.
 *
 * Nothing is trimmed or repaired on the way in: a resolver never emits
 * whitespace, and normalising junk would mean classifying one address while the
 * socket connects to another. An address that does not parse is rejected, never
 * assumed benign.
 */
export const parseIpAddress = (text: string): ParsedIpAddress | null => {
    if (typeof text !== 'string' || text === '') {
        return null;
    }

    if (text.indexOf(':') === -1) {
        const bytes = parseIpv4Bytes(text);
        return bytes === null ? null : { version: 4, bytes };
    }

    const bytes = parseIpv6Bytes(text);
    return bytes === null ? null : { version: 6, bytes };
};

/**
 * Renders an address for logs and test names. IPv6 is emitted as all eight
 * groups with leading zeros dropped per group — it round-trips through
 * {@link parseIpAddress}, but it is deliberately not RFC 5952 compressed, since
 * nothing here compares addresses as strings.
 */
export const formatIpAddress = (address: ParsedIpAddress): string => {
    if (address.version === 4) {
        return address.bytes.join('.');
    }

    const groups: string[] = [];
    for (let index = 0; index < IPV6_BYTES; index += 2) {
        groups.push(((address.bytes[index] << BITS_PER_BYTE) | address.bytes[index + 1]).toString(16));
    }
    return groups.join(':');
};

// ---------------------------------------------------------------------------
// CIDR arithmetic.
//
// Exported because the sibling test is registry-derived: it walks the committed
// table and asserts, per row, that the first and last address reject and that
// the neighbours immediately outside the range are accepted unless another
// non-global row covers them. That test needs this arithmetic to be a testable
// part of the module rather than re-implemented beside it.
// ---------------------------------------------------------------------------

const maskByte = (prefixLength: number, byteIndex: number): number => {
    const bitsBefore = byteIndex * BITS_PER_BYTE;
    if (prefixLength >= bitsBefore + BITS_PER_BYTE) {
        return MAX_OCTET;
    }
    if (prefixLength <= bitsBefore) {
        return 0;
    }
    return (MAX_OCTET << (BITS_PER_BYTE - (prefixLength - bitsBefore))) & MAX_OCTET;
};

/**
 * Parses `10.0.0.0/8` or `2001:db8::/32`. The returned base address is masked to
 * the prefix, so a row written with host bits set still classifies correctly.
 * Returns `null` for a malformed CIDR, which the classifier treats as a table it
 * cannot trust rather than a row it can skip.
 */
export const parseCidr = (cidr: string): ParsedCidr | null => {
    if (typeof cidr !== 'string') {
        return null;
    }

    const slashIndex = cidr.indexOf('/');
    if (slashIndex === -1 || cidr.indexOf('/', slashIndex + 1) !== -1) {
        return null;
    }

    const address = parseIpAddress(cidr.slice(0, slashIndex));
    const prefixText = cidr.slice(slashIndex + 1);
    if (address === null || !PREFIX_LENGTH_PATTERN.test(prefixText)) {
        return null;
    }

    const prefixLength = Number(prefixText);
    if (prefixLength > (address.version === 4 ? MAX_IPV4_PREFIX : MAX_IPV6_PREFIX)) {
        return null;
    }

    const bytes: number[] = [];
    for (let index = 0; index < address.bytes.length; index++) {
        bytes.push(address.bytes[index] & maskByte(prefixLength, index));
    }

    return { version: address.version, bytes, prefixLength };
};

/** Whether the block contains the address. Different families never match. */
export const cidrContains = (cidr: ParsedCidr, address: ParsedIpAddress): boolean => {
    if (cidr.version !== address.version) {
        return false;
    }

    for (let index = 0; index < address.bytes.length; index++) {
        const mask = maskByte(cidr.prefixLength, index);
        // Masks only ever narrow, so once one byte contributes no prefix bits
        // neither does any byte after it.
        if (mask === 0) {
            break;
        }
        if ((address.bytes[index] & mask) !== (cidr.bytes[index] & mask)) {
            return false;
        }
    }

    return true;
};

export const firstAddressOfCidr = (cidr: ParsedCidr): ParsedIpAddress => ({
    version: cidr.version,
    bytes: cidr.bytes.slice(),
});

export const lastAddressOfCidr = (cidr: ParsedCidr): ParsedIpAddress => {
    const bytes: number[] = [];
    for (let index = 0; index < cidr.bytes.length; index++) {
        bytes.push((cidr.bytes[index] | (~maskByte(cidr.prefixLength, index) & MAX_OCTET)) & MAX_OCTET);
    }
    return { version: cidr.version, bytes };
};

/** The next address, or `null` at the top of the family (no successor exists). */
export const addressAfter = (address: ParsedIpAddress): ParsedIpAddress | null => {
    const bytes = address.bytes.slice();
    for (let index = bytes.length - 1; index >= 0; index--) {
        if (bytes[index] < MAX_OCTET) {
            bytes[index] = bytes[index] + 1;
            return { version: address.version, bytes };
        }
        bytes[index] = 0;
    }
    return null;
};

/** The previous address, or `null` at the bottom of the family. */
export const addressBefore = (address: ParsedIpAddress): ParsedIpAddress | null => {
    const bytes = address.bytes.slice();
    for (let index = bytes.length - 1; index >= 0; index--) {
        if (bytes[index] > 0) {
            bytes[index] = bytes[index] - 1;
            return { version: address.version, bytes };
        }
        bytes[index] = MAX_OCTET;
    }
    return null;
};

/**
 * The **most specific** row covering an address — longest prefix, not first
 * match and not any match — because the registries nest: `2001::/23` is not
 * globally reachable while `2001:3::/32` inside it is, and `192.0.0.0/24` is not
 * while `192.0.0.9/32` inside it is. Taking any other match would misclassify
 * addresses in both directions.
 *
 * Two rows of equal prefix length are resolved in favour of the more
 * restrictive one, so the verdict never depends on the table's row order.
 */
export const findMostSpecificRange = (
    address: ParsedIpAddress,
    ranges: readonly SpecialPurposeRange[],
): SpecialPurposeRange | null => {
    let best: SpecialPurposeRange | null = null;
    let bestPrefix = -1;

    for (const rawRange of asList(ranges)) {
        if (rawRange === null || typeof rawRange !== 'object') {
            continue;
        }

        const range = rawRange as SpecialPurposeRange;
        const cidr = parseCidr(range.cidr);
        if (cidr === null || !cidrContains(cidr, address)) {
            continue;
        }

        if (cidr.prefixLength > bestPrefix) {
            best = range;
            bestPrefix = cidr.prefixLength;
            continue;
        }

        if (cidr.prefixLength === bestPrefix && best !== null && best.globallyReachable === true) {
            best = range;
        }
    }

    return best;
};

// ---------------------------------------------------------------------------
// Embedded IPv4 forms.
//
// An IPv6 address can *carry* an IPv4 address, and the IPv4 rules must be
// applied to the carried address in addition to the IPv6 rules. This is not
// belt-and-braces for the NAT64 well-known prefix: IANA marks 64:ff9b::/96
// globally reachable, so `64:ff9b::7f00:1` is refused only because the address
// it carries is 127.0.0.1.
// ---------------------------------------------------------------------------

const IPV4_MAPPED_PREFIX: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
const NAT64_WELL_KNOWN_PREFIX: readonly number[] = [0x00, 0x64, 0xff, 0x9b];
const NAT64_LOCAL_USE_PREFIX: readonly number[] = [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01];
const SIX_TO_FOUR_PREFIX: readonly number[] = [0x20, 0x02];
const TEREDO_PREFIX: readonly number[] = [0x20, 0x01, 0x00, 0x00];

/** Bits 96-127 — the tail used by IPv4-mapped, IPv4-compatible and NAT64 /96. */
const LOW_32_POSITIONS: readonly number[] = [12, 13, 14, 15];
/** RFC 6052 §2.2: at a /48 prefix the IPv4 sits in bits 48-63 and 72-87, skipping the reserved u-octet. */
const NAT64_LOCAL_USE_POSITIONS: readonly number[] = [6, 7, 9, 10];
/** Bits 16-47. */
const SIX_TO_FOUR_POSITIONS: readonly number[] = [2, 3, 4, 5];
/** Bits 32-63. */
const TEREDO_SERVER_POSITIONS: readonly number[] = [4, 5, 6, 7];

const hasBytePrefix = (bytes: readonly number[], prefix: readonly number[]): boolean => {
    for (let index = 0; index < prefix.length; index++) {
        if (bytes[index] !== prefix[index]) {
            return false;
        }
    }
    return true;
};

const allZero = (bytes: readonly number[], from: number, to: number): boolean => {
    for (let index = from; index < to; index++) {
        if (bytes[index] !== 0) {
            return false;
        }
    }
    return true;
};

const allOctetsEqual = (bytes: readonly number[], value: number): boolean => {
    for (const byte of bytes) {
        if (byte !== value) {
            return false;
        }
    }
    return true;
};

const ipv4At = (bytes: readonly number[], positions: readonly number[]): ParsedIpAddress => ({
    version: 4,
    bytes: positions.map((position) => bytes[position] & MAX_OCTET),
});

// Teredo obfuscates the client's IPv4 by bitwise complement, so it has to be
// un-complemented before the IPv4 rules mean anything.
const ipv4AtComplemented = (bytes: readonly number[], positions: readonly number[]): ParsedIpAddress => ({
    version: 4,
    bytes: positions.map((position) => ~bytes[position] & MAX_OCTET),
});

/**
 * Every IPv4 address an IPv6 address carries, so the caller can apply the full
 * IPv4 ruleset to each. Both the wrapper and the payload must pass.
 *
 * Covers IPv4-mapped `::ffff:0:0/96`, the deprecated IPv4-compatible `::/96`,
 * NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16` and Teredo
 * `2001::/32` (whose server and obfuscated client addresses are both returned).
 * Returns an empty list for an IPv4 address, an unparsable string, or an IPv6
 * address that carries nothing.
 *
 * `::` and `::1` fall inside `::/96` and so yield a carried `0.0.0.0`/`0.0.0.1`;
 * that is never surfaced, because {@link classifyIpAddress} refuses both by
 * their explicit special-address check before it looks at embeddings.
 */
export const unwrapEmbeddedIpv4 = (ip: ParsedIpAddress | string): readonly ParsedIpAddress[] => {
    const address = typeof ip === 'string' ? parseIpAddress(ip) : ip;
    if (address === null || address.version !== 6 || address.bytes.length !== IPV6_BYTES) {
        return [];
    }

    const bytes = address.bytes;

    if (hasBytePrefix(bytes, IPV4_MAPPED_PREFIX)) {
        return [ipv4At(bytes, LOW_32_POSITIONS)];
    }
    if (allZero(bytes, 0, 12)) {
        return [ipv4At(bytes, LOW_32_POSITIONS)];
    }
    if (hasBytePrefix(bytes, NAT64_LOCAL_USE_PREFIX)) {
        return [ipv4At(bytes, NAT64_LOCAL_USE_POSITIONS)];
    }
    if (hasBytePrefix(bytes, NAT64_WELL_KNOWN_PREFIX) && allZero(bytes, 4, 12)) {
        return [ipv4At(bytes, LOW_32_POSITIONS)];
    }
    if (hasBytePrefix(bytes, SIX_TO_FOUR_PREFIX)) {
        return [ipv4At(bytes, SIX_TO_FOUR_POSITIONS)];
    }
    if (hasBytePrefix(bytes, TEREDO_PREFIX)) {
        return [ipv4At(bytes, TEREDO_SERVER_POSITIONS), ipv4AtComplemented(bytes, LOW_32_POSITIONS)];
    }

    return [];
};

// ---------------------------------------------------------------------------
// The fail-closed classifier.
// ---------------------------------------------------------------------------

const IPV4_MULTICAST_MASK = 0xf0;
const IPV4_MULTICAST_NETWORK = 0xe0;
const IPV6_MULTICAST_BYTE = 0xff;

const rejectAddress = (
    reason: EvidenceRejectionReason,
    detail: string,
    address: string | null,
): EvidenceAddressVerdict => ({ allowed: false, reason, detail, address });

type RangeTableVerdict = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/**
 * The table itself must be trustworthy before any address is judged against it.
 *
 * An empty table rejects: a table that did not load is not a clean bill of
 * health. A row whose CIDR does not parse, or whose `globallyReachable` is not
 * one of the three permitted values, also rejects — every row, not merely the
 * ones covering this address, because a table that has drifted from the
 * registries cannot be relied on for the row that happens to match either.
 */
const validateRangeTable = (ranges: readonly SpecialPurposeRange[]): RangeTableVerdict => {
    const rows = asList(ranges);
    if (rows.length === 0) {
        return { ok: false, detail: 'the special-purpose address table is empty' };
    }

    for (const rawRange of rows) {
        if (rawRange === null || typeof rawRange !== 'object') {
            return { ok: false, detail: 'a special-purpose address row is not an object' };
        }

        const range = rawRange as SpecialPurposeRange;
        if (parseCidr(range.cidr) === null) {
            return { ok: false, detail: `special-purpose row "${String(range.cidr)}" is not a valid CIDR` };
        }

        const reachable: unknown = range.globallyReachable;
        if (reachable !== true && reachable !== false && reachable !== 'n/a') {
            return {
                ok: false,
                detail: `special-purpose row "${range.cidr}" declares an unrecognised globallyReachable value`,
            };
        }
    }

    return { ok: true };
};

// Guards against a hand-built address object: a wrong byte count or an
// out-of-range byte would make every prefix comparison meaningless.
const isWellFormedAddress = (address: ParsedIpAddress): boolean => {
    if (address === null || typeof address !== 'object') {
        return false;
    }

    const version: number = address.version;
    if (version !== 4 && version !== 6) {
        return false;
    }
    if (!Array.isArray(address.bytes) || address.bytes.length !== (version === 4 ? IPV4_BYTES : IPV6_BYTES)) {
        return false;
    }

    for (const byte of address.bytes) {
        if (typeof byte !== 'number' || !isFinite(byte) || byte < 0 || byte > MAX_OCTET || Math.floor(byte) !== byte) {
            return false;
        }
    }

    return true;
};

/**
 * The unicast and special-address checks that do not come from the table.
 *
 * They are load-bearing rather than redundant: neither IPv4 multicast
 * (`224.0.0.0/4`) nor IPv6 multicast (`ff00::/8`) appears in the special-purpose
 * registries, so an address there would match no row. `255.255.255.255`, `::`
 * and `::1` are also refused here explicitly, independently of the rows that
 * happen to cover them.
 */
const classifySpecialAddress = (address: ParsedIpAddress): EvidenceAddressVerdict => {
    const text = formatIpAddress(address);

    if (address.version === 4) {
        if ((address.bytes[0] & IPV4_MULTICAST_MASK) === IPV4_MULTICAST_NETWORK) {
            return rejectAddress('address_not_unicast', `${text} is IPv4 multicast (224.0.0.0/4)`, text);
        }
        if (allOctetsEqual(address.bytes, MAX_OCTET)) {
            return rejectAddress('address_not_unicast', 'the IPv4 limited broadcast address is not a host', text);
        }
        return { allowed: true };
    }

    if (address.bytes[0] === IPV6_MULTICAST_BYTE) {
        return rejectAddress('address_not_unicast', `${text} is IPv6 multicast (ff00::/8)`, text);
    }
    if (allOctetsEqual(address.bytes, 0)) {
        return rejectAddress('address_not_globally_routable', 'the unspecified address :: is not routable', text);
    }
    if (allZero(address.bytes, 0, IPV6_BYTES - 1) && address.bytes[IPV6_BYTES - 1] === 1) {
        return rejectAddress('address_not_globally_routable', 'the IPv6 loopback ::1 is not routable', text);
    }

    return { allowed: true };
};

/**
 * Judges one resolved address against the committed registry table, and reports
 * why it was refused.
 *
 * An address is routable only if all of these hold: the table is trustworthy,
 * the address parses, it is unicast and not one of the explicitly refused
 * special addresses, every IPv4 address it carries passes the same IPv4 rules,
 * and the **most specific** row covering it is either absent or marked
 * `globallyReachable: true`.
 *
 * It **fails closed without exception**. An empty or malformed table, an
 * unparsable address, a mis-sized address object, a non-unicast address, a row
 * marked `false` or `'n/a'`, or a bad embedded address all reject. No branch
 * returns "routable" because a check could not be performed.
 *
 * Matching no row *is* a positive answer rather than a skipped check: the
 * registries enumerate the special-purpose blocks, so an address outside all of
 * them is ordinary global unicast. The blocks they omit — the two multicast
 * ranges — are refused above, which is why that omission is not a hole. No
 * range is hard-coded here beyond those explicit checks, so refreshing the
 * table stays a reviewed data change rather than a code edit.
 */
export const classifyIpAddress = (
    ip: ParsedIpAddress | string,
    ranges: readonly SpecialPurposeRange[],
): EvidenceAddressVerdict => {
    const asText = typeof ip === 'string' ? ip : null;

    const table = validateRangeTable(ranges);
    if (!table.ok) {
        return rejectAddress('range_table_unclassifiable', table.detail, asText);
    }

    const address = typeof ip === 'string' ? parseIpAddress(ip) : ip;
    if (address === null || !isWellFormedAddress(address)) {
        return rejectAddress('address_unparsable', 'the address could not be parsed', asText);
    }

    const special = classifySpecialAddress(address);
    if (!special.allowed) {
        return special;
    }

    const wrapperText = formatIpAddress(address);

    for (const carried of unwrapEmbeddedIpv4(address)) {
        const carriedText = formatIpAddress(carried);

        const carriedSpecial = classifySpecialAddress(carried);
        if (!carriedSpecial.allowed) {
            return rejectAddress(
                'embedded_address_not_globally_routable',
                `${wrapperText} carries the non-unicast IPv4 address ${carriedText}`,
                wrapperText,
            );
        }

        const carriedRow = findMostSpecificRange(carried, ranges);
        if (carriedRow !== null && carriedRow.globallyReachable !== true) {
            return rejectAddress(
                'embedded_address_not_globally_routable',
                `${wrapperText} carries ${carriedText}, which falls in ${carriedRow.cidr} (${carriedRow.name})`,
                wrapperText,
            );
        }
    }

    const row = findMostSpecificRange(address, ranges);
    if (row !== null && row.globallyReachable !== true) {
        return rejectAddress(
            'address_not_globally_routable',
            `${wrapperText} falls in ${row.cidr} (${row.name}), globallyReachable ${String(row.globallyReachable)}`,
            wrapperText,
        );
    }

    return { allowed: true };
};

/** {@link classifyIpAddress} as a predicate, for callers that need no reason. */
export const isGloballyRoutable = (ip: ParsedIpAddress | string, ranges: readonly SpecialPurposeRange[]): boolean =>
    classifyIpAddress(ip, ranges).allowed;

/**
 * Judges a host's whole answer set, which is the unit that matters: the service
 * resolves the name once and pins the address it connects to, so every answer
 * has to be acceptable.
 *
 * An empty answer set rejects — a lookup that returned nothing is a failure,
 * not an absence of objections. If any single address fails, the whole set
 * fails: a name resolving to one public and one private address is a DNS
 * rebinding attempt, not a partial success.
 */
export const classifyAddressSet = (
    addresses: readonly (ParsedIpAddress | string)[],
    ranges: readonly SpecialPurposeRange[],
): EvidenceAddressVerdict => {
    const entries = asList(addresses);
    if (entries.length === 0) {
        return rejectAddress('unresolvable_host', 'the host resolved to no addresses', null);
    }

    for (const entry of entries) {
        const verdict = classifyIpAddress(entry as ParsedIpAddress | string, ranges);
        if (!verdict.allowed) {
            return verdict;
        }
    }

    return { allowed: true };
};

/** {@link classifyAddressSet} as a predicate. */
export const areAllAddressesRoutable = (
    addresses: readonly (ParsedIpAddress | string)[],
    ranges: readonly SpecialPurposeRange[],
): boolean => classifyAddressSet(addresses, ranges).allowed;

// ---------------------------------------------------------------------------
// Limits this module declares and `evidence.service.ts` enforces.
//
// The service owns the socket, so it applies these; they live here as pure
// predicates so the boundary values are pinned by unit tests rather than
// discovered in production.
// ---------------------------------------------------------------------------

/**
 * Whether a `Content-Type` header names a permitted media type. Parameters are
 * not part of the media type, so `text/html; charset=utf-8` is `text/html`. A
 * missing or non-string header is refused: an unlabelled body is not a
 * permitted one.
 */
export const isAllowedContentType = (headerValue: string | null | undefined, limits?: EvidenceFetchLimits): boolean => {
    if (typeof headerValue !== 'string') {
        return false;
    }

    const resolved = resolveEvidenceFetchLimits(limits);
    const semicolonIndex = headerValue.indexOf(';');
    const mediaType = (semicolonIndex === -1 ? headerValue : headerValue.slice(0, semicolonIndex)).trim().toLowerCase();

    return resolved.allowedContentTypes.indexOf(mediaType) !== -1;
};

/**
 * Whether a body is still within the cap. The count must be of **decompressed**
 * bytes — a cap applied to the compressed size is a zip-bomb hole — and the
 * service aborts the stream at the moment this turns false. The cap is
 * inclusive: exactly {@link EVIDENCE_MAX_BODY_BYTES} bytes is within it, one
 * more is not.
 */
export const isWithinBodyCap = (decompressedBytes: number, limits?: EvidenceFetchLimits): boolean => {
    if (typeof decompressedBytes !== 'number' || !isFinite(decompressedBytes) || decompressedBytes < 0) {
        return false;
    }
    return decompressedBytes <= resolveEvidenceFetchLimits(limits).maxBodyBytes;
};

/**
 * Whether a redirect may be followed, and to exactly what URL.
 *
 * `redirectCount` is how many have already been followed, so the check is
 * `>=` against the cap and at most {@link EVIDENCE_MAX_REDIRECTS} hops happen.
 * A `Location` header may be relative, so it is resolved against the URL that
 * produced it and then **re-validated from the URL step onward** — scheme, port,
 * userinfo, IP literal, host shape and allowlist all apply again, which is what
 * stops a redirect to `http://`, to another port, or to a host nobody
 * allowlisted. Finally, any change of host ends the fetch: the pinned address
 * belongs to the original host, so following the hop would abandon the pin.
 */
export const evaluateEvidenceRedirect = (
    currentUrl: string,
    location: string,
    redirectCount: number,
    policy: EvidencePolicy,
): EvidenceUrlVerdict => {
    const resolved = resolveEvidenceFetchLimits(policy.fetchLimits);

    if (typeof redirectCount !== 'number' || !isFinite(redirectCount) || redirectCount < 0) {
        return rejectUrl('redirect_limit_exceeded', 'the redirect count is not a usable number');
    }
    if (redirectCount >= resolved.maxRedirects) {
        return rejectUrl('redirect_limit_exceeded', `more than ${resolved.maxRedirects} redirects were required`);
    }

    const current = parseEvidenceUrl(currentUrl, policy.fetchLimits);
    if (!current.allowed) {
        return current;
    }

    if (typeof location !== 'string' || location.trim() === '') {
        return rejectUrl('unparseable_url', 'the redirect target is empty');
    }

    let absolute: string;
    try {
        absolute = new URL(location, current.url).href;
    } catch {
        return rejectUrl('unparseable_url', 'the redirect target could not be parsed');
    }

    const target = evaluateEvidenceUrl(absolute, policy);
    if (!target.allowed) {
        return target;
    }

    if (!resolved.allowCrossHostRedirect && target.host !== current.host) {
        return rejectUrl('cross_host_redirect', `a redirect from "${current.host}" to "${target.host}" is not followed`);
    }

    return target;
};
