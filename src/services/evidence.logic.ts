import { domainToASCII } from 'url';

/**
 * The pure SSRF policy for identity-evidence retrieval.
 *
 * `scripts/catalog-generate-ai.ts` asks a language model to propose URLs that
 * corroborate a generated catalog food's identity, and then fetches them. A
 * model-proposed URL is attacker-influenced input, so every decision about
 * whether it may be fetched is made here, and the defences apply in this order:
 * the policy document is validated against the reviewed attestation, the host
 * must be allowlisted *for the claim being made*, the address classifier fails
 * closed, DNS is pinned (the service resolves once and hands the answers here),
 * and hard fetch limits bound the transfer.
 *
 * Two of those gates guard the policy data itself rather than the URL, because
 * the document is loaded from disk by a CLI script and could be stale,
 * truncated, hand-edited or swapped:
 *
 * - {@link validateEvidencePolicy} refuses a document that is not the reviewed
 *   one. A table with a row deleted is the dangerous case: an address matching
 *   no row is judged against {@link REVIEWED_GLOBAL_UNICAST_ALLOCATIONS}
 *   instead, and every special-purpose block carved out of unicast space lies
 *   inside an allocated block — so silently losing `169.254.0.0/16` would let
 *   the cloud metadata address satisfy that gate and become a permitted fetch
 *   target. Completeness is therefore established by set equality against
 *   the whole reviewed snapshot in {@link REVIEWED_RANGE_TABLE} — every reviewed
 *   block present with its reviewed reachability, and no block the review never
 *   saw — because a row count alone cannot tell a deletion from a substitution.
 * - Authorization is per {@link EvidenceType}. A host class approved for
 *   identity and preparation claims is not thereby a nutrition or allergen
 *   source, so the requested claim is compared against the class's declared
 *   `evidenceTypes` before any verdict allows a fetch.
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
 * The closed set of claims a retrieved page may be used to corroborate, and the
 * vocabulary `evidence-allowlist.v1.json` writes in each host class's
 * `evidenceTypes`.
 *
 * It is a closed set because authorization compares against it: a value outside
 * this list is not "an unknown type, so probably fine" but a document or a
 * caller asking for something nobody reviewed, and both are refused. The
 * distinction the set exists to draw is that a named culinary reference may
 * establish what a dish *is* and how it is prepared without being an authority
 * on its nutrition or its allergens.
 */
export const EVIDENCE_TYPES = [
    /** What the food is: its canonical name, its aliases, its identity. */
    'canonical_identity',
    /** How the food is prepared — the cooking method behind a prepared state. */
    'preparation_method',
    /** The nutrient values themselves. Reserved for source-backed references. */
    'nutrition_reference',
    /** A serving description and its gram weight. */
    'portion_reference',
    /** Which of the nine named allergens the food contains. */
    'allergen_composition',
    /** Which category and food group the food belongs to. */
    'food_classification',
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** Whether a loaded or caller-supplied value names one of the reviewed claims. */
export const isEvidenceType = (value: unknown): value is EvidenceType =>
    typeof value === 'string' && (EVIDENCE_TYPES as readonly string[]).indexOf(value) !== -1;

/**
 * One hand-curated allowlist entry group: USDA/FDC, government and university
 * nutrition references, and named culinary references. No manufacturer domains
 * appear in it by design — AI generation proposes only generic preparations,
 * and a model-proposed brand domain could never independently verify a
 * model-proposed product.
 *
 * `class`, `hosts` and `evidenceTypes` are all required, because all three are
 * load-bearing: the identifier is what a validation record names as the source
 * of a corroboration, the hosts are what may be reached, and the evidence types
 * are what those hosts are trusted to attest. A group that omits its evidence
 * types would authorize nothing in particular, which is how a culinary
 * reference ends up standing in for a nutrition authority — so the document is
 * refused rather than read permissively ({@link validateEvidencePolicy}).
 *
 * `description` is optional provenance for the human reviewing a refresh; it is
 * never read as policy.
 */
export interface EvidenceHostClass {
    /** Stable identifier of the reviewed group, e.g. `usda_fdc`. */
    readonly class: string;
    /** Exact hosts (`nal.usda.gov`) and `*.` wildcards (`*.nal.usda.gov`), matched per label. */
    readonly hosts: readonly string[];
    /** The claims a host in this group may corroborate; any other claim is refused. */
    readonly evidenceTypes: readonly EvidenceType[];
    readonly description?: string;
}

/**
 * The fetch limits as the policy document declares them. Enforcement belongs to
 * `evidence.service.ts`, which owns the socket; this module declares the shape,
 * validates it, and resolves it against the canonical ceilings.
 *
 * Every member is required of a *valid document*: the reviewed transport policy
 * is stated in data, so nothing silently relies on a code default that a
 * reviewer cannot see. {@link resolveEvidenceFetchLimits} nonetheless accepts
 * `unknown` and remains total, because it is also the path a partial or
 * malformed document takes — the one place that tolerance belongs.
 */
export interface EvidenceFetchLimits {
    readonly schemes: readonly string[];
    readonly allowedPorts: readonly number[];
    readonly maxRedirects: number;
    readonly timeoutMs: number;
    /** Bytes of the *decompressed* body — a compressed-size cap is a zip-bomb hole. */
    readonly maxBodyBytes: number;
    readonly allowedContentTypes: readonly string[];
    readonly maxSnippetChars: number;
}

/**
 * `evidence-allowlist.v1.json` as loaded by `scripts/lib/manifest.ts` and handed
 * to this module. It is a parameter, never an import: `tsconfig.json` roots the
 * production program at `src/`, and `.dockerignore` keeps `data/` out of the
 * image, so a file under `data/` can be neither compiled into nor read by the
 * running API.
 *
 * `registrySnapshot`, the three row members and the allocation's own row count
 * are carried so a refresh of either address registry is a reviewed data
 * change:
 * {@link validateEvidencePolicy} compares every one of them against the
 * reviewed attestation in this module, and
 * `src/services/__tests__/evidence.logic.test.ts` asserts them three ways —
 * document, JSON and module — against the values recorded in
 * `docs/meal-planning/catalog-policy.md`. A document that does not carry the
 * reviewed set is not read.
 *
 * The split is stated in the document rather than inferred from it because
 * `rowCount` alone cannot say which rows came from a registry: one reviewed row
 * (`::/96`, see {@link REVIEWED_SUPPLEMENTAL_CIDRS}) is carried for hardening
 * and is not a registry entry, so a document reclassifying it — in either
 * direction — changes what a reviewer is being asked to counter-sign, and
 * {@link validateEvidencePolicy} refuses it.
 *
 * Nothing accepts this type on trust. Every entry point validates the document
 * first, reading each member as `unknown`, because a value that parsed as JSON
 * has been shown to be JSON and nothing more.
 */
export interface EvidencePolicy {
    readonly allowlistVersion: string;
    readonly registrySnapshot: string;
    /** Every address row the document carries: registry-derived plus supplemental. */
    readonly rowCount: number;
    /** The rows transcribed from the two IANA registries at `registrySnapshot`. */
    readonly registryRowCount: number;
    /** The rows carried for hardening rather than transcribed from a registry. */
    readonly supplementalRowCount: number;
    /** Which blocks those supplemental rows are, so the classification is reviewable per block. */
    readonly supplementalCidrs: readonly string[];
    /** How many allocation blocks the document carries, as its own statement about them. */
    readonly globalUnicastAllocationRowCount: number;
    /**
     * The address space IANA has allocated to globally routable unicast.
     *
     * The second half of the address policy, and the half the special-purpose
     * registries cannot supply: they enumerate blocks carved out for a purpose
     * and say nothing about space that was never allocated. Carried here, in the
     * document, for the same reason the range rows are — a registry refresh is a
     * reviewed data change — and counter-signed against
     * {@link REVIEWED_GLOBAL_UNICAST_ALLOCATIONS} so a stale or tampered
     * document can neither widen the policy nor quietly narrow it.
     */
    readonly globalUnicastAllocations: readonly GlobalUnicastAllocation[];
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
    /**
     * The URL that **served** the recorded bytes — after a same-host redirect
     * the hop's target, not the URL the model proposed. The status, hash and
     * snippet all came from that response, so this is the location a reviewer
     * re-fetches to check them, and attributing them to a URL that only
     * redirected would make the record unverifiable.
     */
    readonly url: string;
    /** The host of that same URL: the host the bytes actually came from. */
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
 *
 * `policy_invalid` and `range_table_unclassifiable` are refusals of the policy
 * *document* rather than of the URL, and they are deliberately distinct from
 * every URL code: an operator reading them knows the candidate was never
 * judged, because the rules it would have been judged by could not be trusted.
 * `evidence_type_not_authorized` is likewise distinct from
 * `host_not_allowlisted` — the host is allowlisted, for other claims.
 */
export type EvidenceRejectionReason =
    | 'policy_invalid'
    | 'unparseable_url'
    | 'scheme_not_allowed'
    | 'credentials_present'
    | 'port_not_allowed'
    | 'ip_literal_host'
    | 'idna_conversion_failed'
    | 'malformed_host'
    | 'host_not_allowlisted'
    | 'evidence_type_not_authorized'
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

// ---------------------------------------------------------------------------
// The reviewed attestation of the policy document.
//
// Classification itself stays data-driven: no CIDR below is a classification
// rule, and refreshing the IANA tables remains a data change to
// `evidence-allowlist.v1.json`. What these constants add is the
// *counter-signature* — the document must be the table that was reviewed, row
// for row, and not merely a table that looks well formed.
//
// Why the whole table and not a chosen floor: an address matching no row falls
// through to {@link REVIEWED_GLOBAL_UNICAST_ALLOCATIONS}, which answers only
// whether the address is allocated to unicast at all. That makes an omission
// indistinguishable from "nothing special here" — a special-purpose block
// carved out of unicast space sits inside an allocated block, so losing the
// `169.254.0.0/16` row would quietly promote the cloud metadata address to a
// permitted fetch target. Neither a row
// count nor a list of blocks somebody remembered to name catches that, because a
// row can be *substituted* rather than dropped: delete one non-global block, add
// any other canonical block in its place, and the count, the families and every
// per-row integrity property still hold. Only equality with the complete
// reviewed set refuses that document.
//
// Refreshing the registries is therefore three coordinated edits — the JSON, the
// attestation below, and the values recorded in
// `docs/meal-planning/catalog-policy.md` — and any one of them alone fails
// closed and loudly rather than degrading silently.
// ---------------------------------------------------------------------------

/** The `allowlistVersion` this module was written against; matches the filename's `.v1`. */
export const REVIEWED_ALLOWLIST_VERSION = 'v1';

/** The date the committed IANA tables were transcribed. */
export const REVIEWED_REGISTRY_SNAPSHOT = '2026-09-08';

/**
 * One reviewed registry row, reduced to the two facts the classifier acts on:
 * the block, and the reachability the registry states for it. The row's name and
 * registry label are provenance for the reviewer and live only in the document.
 */
export interface ReviewedRange {
    readonly cidr: string;
    readonly globallyReachable: GloballyReachable;
}

/**
 * The **complete** IPv4 and IPv6 special-purpose registries as transcribed at
 * {@link REVIEWED_REGISTRY_SNAPSHOT} — every row, in registry order, with the
 * reachability each states — plus the small supplemental set named in
 * {@link REVIEWED_SUPPLEMENTAL_CIDRS}, which is carried for hardening rather
 * than transcribed from a registry. The two are counted separately
 * ({@link REVIEWED_REGISTRY_ROW_COUNT}, {@link REVIEWED_SUPPLEMENTAL_ROW_COUNT})
 * so neither is ever presented as the other: the registry-derived count is what
 * a reviewer diffs against the registry pages at a refresh, and it would be
 * wrong by one if the supplemental row were counted into it.
 *
 * It is the whole table and not a selected floor on purpose. A subset attests
 * only the rows someone thought to list, and a document can then drop an
 * unlisted non-global row, add any other canonical row in its place, and keep
 * both the row count and every integrity property intact — after which
 * `192.88.99.0/24`, `100:0:0:1::/64` or `5f00::/16` matches nothing, satisfies
 * the allocation it sits inside, and is classified as routable. Set equality is
 * what closes that:
 * {@link validateEvidenceRangeTable} refuses a table with a row missing, a row
 * added, or a reachability changed, so no same-count substitution survives.
 *
 * This is an attestation, not a classification rule. Classification still reads
 * the document's rows — which is where the registry names, the family labels and
 * the review history live — and this list only establishes that those rows are
 * the ones that were reviewed. A registry refresh is therefore still a data
 * change, counter-signed here and recorded in
 * `docs/meal-planning/catalog-policy.md`: three coordinated edits, any one of
 * which alone fails closed and loudly.
 *
 * Included by construction, and worth naming because the classifier depends on
 * them: the nested globally reachable exceptions (`192.0.0.9/32`,
 * `192.0.0.10/32`, `192.31.196.0/24`, `192.52.193.0/24`, `192.175.48.0/24`,
 * `2001:1::1/128`, `2001:1::2/128`, `2001:1::3/128`, `2001:3::/32`,
 * `2001:4:112::/48`, `2001:20::/28`, `2001:30::/28`, `2620:4f:8000::/48`,
 * `64:ff9b::/96`), which longest-prefix matching needs in order to admit
 * legitimate anycast inside a non-global parent; and the embedded-IPv4 prefixes
 * (`::/96`, `::ffff:0:0/96`, `64:ff9b::/96`, `64:ff9b:1::/48`, `2001::/32`,
 * `2002::/16`) that {@link unwrapEmbeddedIpv4} unwraps.
 */
export const REVIEWED_RANGE_TABLE: readonly ReviewedRange[] = [
    // IPv4 Special-Purpose Address Registry
    { cidr: '0.0.0.0/8', globallyReachable: false }, // This network
    { cidr: '0.0.0.0/32', globallyReachable: false }, // This host on this network
    { cidr: '10.0.0.0/8', globallyReachable: false }, // Private-Use
    { cidr: '100.64.0.0/10', globallyReachable: false }, // Shared Address Space
    { cidr: '127.0.0.0/8', globallyReachable: false }, // Loopback
    { cidr: '169.254.0.0/16', globallyReachable: false }, // Link Local
    { cidr: '172.16.0.0/12', globallyReachable: false }, // Private-Use
    { cidr: '192.0.0.0/24', globallyReachable: false }, // IETF Protocol Assignments
    { cidr: '192.0.0.0/29', globallyReachable: false }, // IPv4 Service Continuity Prefix
    { cidr: '192.0.0.8/32', globallyReachable: false }, // IPv4 dummy address
    { cidr: '192.0.0.9/32', globallyReachable: true }, // Port Control Protocol Anycast
    { cidr: '192.0.0.10/32', globallyReachable: true }, // Traversal Using Relays around NAT Anycast
    { cidr: '192.0.0.170/32', globallyReachable: false }, // NAT64/DNS64 Discovery
    { cidr: '192.0.0.171/32', globallyReachable: false }, // NAT64/DNS64 Discovery
    { cidr: '192.0.2.0/24', globallyReachable: false }, // Documentation (TEST-NET-1)
    { cidr: '192.31.196.0/24', globallyReachable: true }, // AS112-v4
    { cidr: '192.52.193.0/24', globallyReachable: true }, // AMT
    { cidr: '192.88.99.0/24', globallyReachable: 'n/a' }, // Deprecated (6to4 Relay Anycast)
    { cidr: '192.88.99.2/32', globallyReachable: false }, // 6a44-relay anycast address
    { cidr: '192.168.0.0/16', globallyReachable: false }, // Private-Use
    { cidr: '192.175.48.0/24', globallyReachable: true }, // Direct Delegation AS112 Service
    { cidr: '198.18.0.0/15', globallyReachable: false }, // Benchmarking
    { cidr: '198.51.100.0/24', globallyReachable: false }, // Documentation (TEST-NET-2)
    { cidr: '203.0.113.0/24', globallyReachable: false }, // Documentation (TEST-NET-3)
    { cidr: '240.0.0.0/4', globallyReachable: false }, // Reserved
    { cidr: '255.255.255.255/32', globallyReachable: false }, // Limited Broadcast
    // IPv6 Special-Purpose Address Registry
    { cidr: '::1/128', globallyReachable: false }, // Loopback Address
    { cidr: '::/128', globallyReachable: false }, // Unspecified Address
    // `::/96` is RFC 4291's deprecated IPv4-Compatible block rather than a row
    // of the current registry. It is carried because `unwrapEmbeddedIpv4`
    // unwraps it, and because `::a9fe:a9fe` must not outflank `169.254.0.0/16`.
    { cidr: '::/96', globallyReachable: false }, // IPv4-Compatible Address (deprecated)
    { cidr: '::ffff:0:0/96', globallyReachable: false }, // IPv4-mapped Address
    { cidr: '64:ff9b::/96', globallyReachable: true }, // IPv4-IPv6 Translat.
    { cidr: '64:ff9b:1::/48', globallyReachable: false }, // IPv4-IPv6 Translat.
    { cidr: '100::/64', globallyReachable: false }, // Discard-Only Address Block
    { cidr: '100:0:0:1::/64', globallyReachable: false }, // Dummy IPv6 Prefix
    { cidr: '2001::/23', globallyReachable: false }, // IETF Protocol Assignments
    { cidr: '2001::/32', globallyReachable: 'n/a' }, // TEREDO
    { cidr: '2001:1::1/128', globallyReachable: true }, // Port Control Protocol Anycast
    { cidr: '2001:1::2/128', globallyReachable: true }, // Traversal Using Relays around NAT Anycast
    { cidr: '2001:1::3/128', globallyReachable: true }, // DNS-SD Service Registration Protocol Anycast
    { cidr: '2001:2::/48', globallyReachable: false }, // Benchmarking
    { cidr: '2001:3::/32', globallyReachable: true }, // AMT
    { cidr: '2001:4:112::/48', globallyReachable: true }, // AS112-v6
    { cidr: '2001:10::/28', globallyReachable: 'n/a' }, // Deprecated (previously ORCHID)
    { cidr: '2001:20::/28', globallyReachable: true }, // ORCHIDv2
    { cidr: '2001:30::/28', globallyReachable: true }, // Drone Remote ID Protocol Entity Tags (DETs) Prefix
    { cidr: '2001:db8::/32', globallyReachable: false }, // Documentation
    { cidr: '2002::/16', globallyReachable: 'n/a' }, // 6to4
    { cidr: '2620:4f:8000::/48', globallyReachable: true }, // Direct Delegation AS112 Service
    { cidr: '3fff::/20', globallyReachable: false }, // Documentation
    { cidr: '5f00::/16', globallyReachable: false }, // Segment Routing (SRv6) SIDs
    { cidr: 'fc00::/7', globallyReachable: false }, // Unique-Local
    { cidr: 'fe80::/10', globallyReachable: false }, // Link-Local Unicast
];

/**
 * The blocks {@link REVIEWED_RANGE_TABLE} carries **for hardening rather than
 * because a registry lists them**, written as the table writes them.
 *
 * Today that is exactly one block, and it is data rather than a number so that
 * the split below is derived from the two lists instead of remembered: `::/96`
 * is RFC 4291's deprecated IPv4-Compatible prefix, which the current IANA IPv6
 * Special-Purpose Address Registry does not list. It is carried because
 * {@link unwrapEmbeddedIpv4} unwraps that form, so an attacker writing
 * `::a9fe:a9fe` must not outflank `169.254.0.0/16`, and because a block the
 * table does not carry matches nothing and is then judged only on whether it is
 * allocated to unicast — which `::/96` is not, but which the IPv4 address it
 * carries generally is.
 *
 * Keeping it in the same table as the registry rows is what makes the
 * classifier's longest-prefix match see it at all; keeping it out of the
 * registry-derived count is what keeps the attestation honest. A block added
 * here must also be added to the table: {@link REVIEWED_ATTESTATION} records a
 * defect otherwise and every address classification then refuses, because a
 * supplemental block the table does not carry is a hardening rule that silently
 * stopped applying.
 */
export const REVIEWED_SUPPLEMENTAL_CIDRS: readonly string[] = ['::/96'];

/** Whether a reviewed row is carried for hardening rather than transcribed from a registry. */
const isSupplementalCidr = (cidr: string): boolean => REVIEWED_SUPPLEMENTAL_CIDRS.indexOf(cidr) !== -1;

/**
 * The reviewed rows that are transcribed registry entries: 26 IPv4 and 25 IPv6.
 *
 * Derived by subtracting the supplemental set from the table rather than
 * written down, so the two cannot disagree — the count a reviewer checks
 * against the registry pages is computed from the rows they are checking.
 */
export const REVIEWED_REGISTRY_ROW_COUNT = REVIEWED_RANGE_TABLE.filter(
    (row) => !isSupplementalCidr(row.cidr),
).length;

/** The reviewed rows carried for hardening: the table's members of {@link REVIEWED_SUPPLEMENTAL_CIDRS}. */
export const REVIEWED_SUPPLEMENTAL_ROW_COUNT = REVIEWED_RANGE_TABLE.length - REVIEWED_REGISTRY_ROW_COUNT;

/**
 * Every row reviewed at that snapshot, registry-derived and supplemental
 * together. It is the number of rows the document must carry, and it is
 * deliberately **not** described as a registry-row count anywhere: the
 * registry-derived figure is {@link REVIEWED_REGISTRY_ROW_COUNT}, and the two
 * differ by {@link REVIEWED_SUPPLEMENTAL_ROW_COUNT}.
 */
export const REVIEWED_RANGE_ROW_COUNT = REVIEWED_RANGE_TABLE.length;

/**
 * One block the IANA address-space registries allocate to globally routable
 * unicast, as the review transcribed it.
 *
 * `allocation` is the registry's own wording for the block and `registry` names
 * the page it was read from, so a reviewer can check the row against its source
 * without leaving this file.
 */
export interface GlobalUnicastAllocation {
    readonly cidr: string;
    readonly allocation: string;
    readonly registry: string;
}

/**
 * The address space IANA has allocated to globally routable unicast — the outer
 * gate for every address the special-purpose table says nothing about.
 *
 * It is an outer gate, not a universal one: a most-specific row marked
 * `globallyReachable: true` is the reviewed exception and decides on its own,
 * which is what keeps `64:ff9b::/96` reachable despite lying outside
 * `2000::/3`. Rows win where they speak; this list answers where they are
 * silent. {@link classifyIpAddress} is where that order is implemented.
 *
 * WHY THIS EXISTS SEPARATELY FROM {@link REVIEWED_RANGE_TABLE}. That table
 * transcribes the two IANA **special-purpose** registries, which enumerate
 * blocks carved out *for a purpose*. They say nothing about space that has
 * never been allocated at all, so "matches no special-purpose row" does not
 * mean "globally routable" — it means "not special-purpose", and the majority
 * of the IPv6 address space is neither. Judging an address on the table alone
 * therefore admits every reserved and unallocated block: with the reviewed rows
 * as they stand, `fe00::/9`, `fec0::/10`, `4000::/3`, `0100::/8`, `1000::/4`,
 * `8000::/3`, `c000::/3`, `f000::/5` and the rest of the "Reserved by IETF"
 * space match nothing and would pass. An operator's resolver can answer with
 * such an address, and the connection then goes wherever the local routing
 * table sends it.
 *
 * This list is the third registry that settles the question, and it is written
 * as a POSITIVE list on purpose: an address is routable only if it falls inside
 * one of these blocks, so a list that fails to parse, loses a family or is
 * emptied refuses everything rather than admitting everything. The direction of
 * the check is the fail-closed property.
 *
 * PROVENANCE, read at the {@link REVIEWED_REGISTRY_SNAPSHOT} snapshot.
 * - IANA IPv6 Address Space (RFC 4291, formerly RFC 3513): `2000::/3` is the
 *   one block designated "Global Unicast". Every other top-level block is
 *   "Reserved by IETF" apart from `fc00::/7` (Unique Local Unicast),
 *   `fe80::/10` (Link-Scoped Unicast) and `ff00::/8` (Multicast) — none of them
 *   globally routable, and the first two are carried as table rows as well.
 * - IANA IPv4 Address Space (RFC 5735, RFC 6890): unicast is everything below
 *   the multicast block, `224.0.0.0/4` (RFC 5771) and `240.0.0.0/4` (RFC 1112)
 *   being the two top-level carve-outs. `0.0.0.0/1 + 128.0.0.0/2 +
 *   192.0.0.0/3` is exactly `0.0.0.0`–`223.255.255.255`, written as three
 *   blocks because that is the range's CIDR form.
 *
 * WHAT THE IPv4 ROWS ADD, stated honestly: `240.0.0.0/4` is already a reviewed
 * table row, so class E rejects through the table today and these three blocks
 * close no open hole on their own. They earn their place by making the verdict
 * independent of the table for the prior question of whether the address is
 * allocated to unicast at all — a row deleted from the table cannot reopen
 * class E — and by keeping one rule for both families instead of a gate that
 * only ever fires on IPv6.
 *
 * WHERE THE POLICY LIVES. The allocation is carried by
 * `data/meal-planning/evidence-allowlist.v1.json` as `globalUnicastAllocations`,
 * the same reviewed data surface that carries the range rows and the host
 * classes, and {@link validateEvidenceAllocationTable} validates it there. This
 * list is the *counter-signature*: the document must be the allocation that was
 * reviewed, block for block, so a stale or tampered document can neither widen
 * the policy by appending a reserved block nor narrow it by dropping one. A
 * refresh is therefore a reviewed data change — the document, this
 * counter-signature and `docs/meal-planning/catalog-policy.md` — and any one of
 * the three alone fails closed and loudly.
 *
 * KNOWN LIMITATION. RFC 3587 §3 warns implementations not to assume `2000::/3`
 * is special, because IANA may be directed to delegate currently unassigned
 * space to global unicast later. That is a reviewed data change of exactly the
 * shape above, and until it happens refusing unallocated space is the only
 * answer that fails closed: an address in it cannot be a public reference page,
 * and it can very easily be an internal service.
 */
export const REVIEWED_GLOBAL_UNICAST_ALLOCATIONS: readonly GlobalUnicastAllocation[] = [
    { cidr: '0.0.0.0/1', allocation: 'unicast', registry: 'ipv4-address-space' },
    { cidr: '128.0.0.0/2', allocation: 'unicast', registry: 'ipv4-address-space' },
    { cidr: '192.0.0.0/3', allocation: 'unicast', registry: 'ipv4-address-space' },
    { cidr: '2000::/3', allocation: 'Global Unicast', registry: 'ipv6-address-space' },
];

/**
 * How many allocation blocks were reviewed, derived from the list rather than
 * written down so the two cannot disagree — the figure a reviewer checks against
 * the registry pages is computed from the rows they are checking.
 */
export const REVIEWED_ALLOCATION_ROW_COUNT = REVIEWED_GLOBAL_UNICAST_ALLOCATIONS.length;

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
const PREFIX_LENGTH_PATTERN = /^(0|[1-9]\d{0,2})$/;

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

/** An object with string keys, which is the only shape a loaded member may be read through. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** No scheme, no port and no content type is permitted — the fail-closed list. */
const NOTHING_PERMITTED: readonly never[] = [];

// A declared cap is honoured only when it is stricter than the reviewed one; an
// absent or nonsensical cap falls back to the reviewed value rather than to
// zero, because a zero timeout or a zero-byte body would disable evidence
// retrieval entirely instead of securing it. A cap grants no access on its own,
// which is why falling back here is safe while falling back on a *list* would
// not be.
const narrowCap = (declared: unknown, ceiling: number, allowZero: boolean): number => {
    if (typeof declared !== 'number' || !isFinite(declared)) {
        return ceiling;
    }
    if (allowZero ? declared < 0 : declared <= 0) {
        return ceiling;
    }
    return Math.min(declared, ceiling);
};

// Every member arrives as `unknown`, because the document is loaded JSON: a
// member the document's own type calls an array of strings can be a number, an
// object or a string at runtime. Three outcomes, and no fourth:
//
//   absent (`undefined` or JSON `null`) -> the reviewed ceiling: the document
//                              said nothing, and the ceiling is what the code
//                              itself sanctions, so this grants nothing extra
//   an array                -> the intersection with the ceiling, non-strings skipped
//   present but not an array -> nothing permitted (the document is malformed)
//
// The third case is the one that used to throw on `.map`, and it is also the one
// where a fallback to the ceiling would be wrong: a malformed declaration is not
// an absent declaration, and resolving it to the full reviewed list would hand a
// corrupt document the widest policy this module allows.
const narrowStrings = (declared: unknown, ceiling: readonly string[]): readonly string[] => {
    if (declared === undefined || declared === null) {
        return ceiling;
    }
    if (!Array.isArray(declared)) {
        return NOTHING_PERMITTED;
    }
    const normalized: string[] = [];
    for (const value of declared) {
        if (typeof value === 'string') {
            normalized.push(value.trim().toLowerCase());
        }
    }
    return ceiling.filter((value) => normalized.indexOf(value) !== -1);
};

const narrowNumbers = (declared: unknown, ceiling: readonly number[]): readonly number[] => {
    if (declared === undefined || declared === null) {
        return ceiling;
    }
    if (!Array.isArray(declared)) {
        return NOTHING_PERMITTED;
    }
    const normalized: number[] = [];
    for (const value of declared) {
        if (typeof value === 'number' && isFinite(value)) {
            normalized.push(value);
        }
    }
    return ceiling.filter((value) => normalized.indexOf(value) !== -1);
};

/**
 * Resolves a document's declared limits against the canonical ceilings.
 *
 * Two rules govern it, and they are what make this function **total**: it
 * accepts `unknown` and it never throws, however corrupt the input, because the
 * only caller that can reach it with a malformed value is a policy document read
 * off disk and a security predicate that raises instead of answering has no
 * verdict to record.
 *
 * 1. **The document may narrow the policy and can never widen it.** Lists are
 *    intersected with the ceiling and numeric caps take the smaller of the two,
 *    so no document can unlock a scheme, a port, a content type, a longer
 *    timeout or a bigger body than the code sanctions.
 * 2. **Malformed is not absent.** A missing member falls back to the reviewed
 *    ceiling; a member that is present but not a list — or a container that is
 *    not an object at all — resolves to *nothing permitted*, which refuses every
 *    URL and every body. Narrowing to nothing is a legitimate, fail-closed
 *    outcome, and it is the outcome a corrupt document gets.
 *
 * A malformed document is additionally refused outright by
 * {@link validateEvidencePolicy}, which is where an operator sees *why*. This
 * function is the last line under it, for the paths that resolve limits without
 * a whole document in hand.
 */
export const resolveEvidenceFetchLimits = (limits?: unknown): ResolvedEvidenceFetchLimits => {
    if (limits !== undefined && limits !== null && !isRecord(limits)) {
        return {
            schemes: NOTHING_PERMITTED,
            allowedPorts: NOTHING_PERMITTED,
            maxRedirects: EVIDENCE_MAX_REDIRECTS,
            timeoutMs: EVIDENCE_FETCH_TIMEOUT_MS,
            maxBodyBytes: EVIDENCE_MAX_BODY_BYTES,
            allowedContentTypes: NOTHING_PERMITTED,
            maxSnippetChars: EVIDENCE_MAX_SNIPPET_CHARS,
            allowCrossHostRedirect: false,
        };
    }

    const declared: Record<string, unknown> = isRecord(limits) ? limits : {};

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
 * Whether an allowlist entry is written in one of the two forms the matcher
 * understands, strictly enough that an entry admitting more than its author
 * intended cannot be written by accident.
 *
 * An entry must already be in normal form — lower-case, no trailing dot, no
 * surrounding whitespace — rather than be normalised on the reviewer's behalf,
 * because an entry that needs repair is an entry nobody read carefully. A URL,
 * a port, userinfo, an IP literal and a bare label all fail, the last because
 * the host pattern requires at least two labels, which is also what stops a
 * wildcard from being written against a bare TLD (`*.gov` is refused).
 *
 * How broad a legitimate multi-label suffix is — `*.co.uk` and its kind —
 * remains a judgement for the human curating the document; this predicate
 * rejects the mechanically wrong entry, not the unwisely wide one.
 */
export const isValidEvidenceHostEntry = (entry: unknown): boolean => {
    if (typeof entry !== 'string' || entry === '' || entry !== entry.trim()) {
        return false;
    }

    const isWildcard = entry.slice(0, WILDCARD_PREFIX.length) === WILDCARD_PREFIX;
    const base = isWildcard ? entry.slice(WILDCARD_PREFIX.length) : entry;

    if (isIpLiteralHost(base)) {
        return false;
    }

    return normalizeEvidenceHost(base) === base;
};

// The one place a loaded host class is viewed through its declared type. The
// conversion is deliberately narrow: every member is still read through a guard
// (`asList` for the lists, `isEvidenceType` for the claims,
// `evidenceHostClassId` for the identifier), so the view is a convenience for
// the caller's types and never an assertion that the document is well-formed —
// establishing that is `validateEvidencePolicy`'s job.
const asHostClassView = (value: unknown): EvidenceHostClass | null =>
    isRecord(value) ? (value as unknown as EvidenceHostClass) : null;

/**
 * The allowlist entry group whose hosts admit this host, **ignoring what the
 * host is trusted to attest**.
 *
 * It exists for diagnosis, not for authorization: it is what lets a refusal say
 * "allowlisted, but not for this claim" instead of "not allowlisted", and those
 * are different operator actions. Authorization is
 * {@link matchEvidenceHostClass}, which no caller can invoke without naming a
 * claim.
 */
export const findEvidenceHostClassForHost = (
    host: string,
    hostClasses: readonly EvidenceHostClass[],
): EvidenceHostClass | null => {
    for (const rawClass of asList(hostClasses)) {
        const hostClass = asHostClassView(rawClass);
        if (hostClass === null) {
            continue;
        }
        for (const rawEntry of asList(hostClass.hosts)) {
            if (typeof rawEntry === 'string' && hostMatchesEntry(host, rawEntry)) {
                return hostClass;
            }
        }
    }
    return null;
};

/**
 * Whether a group is trusted to attest this particular claim.
 *
 * A group whose `evidenceTypes` is absent, empty or not a list authorizes
 * **nothing**: an unstated scope is not an unlimited one, and treating it as one
 * is how a culinary reference comes to stand in for a nutrition authority. A
 * type the reviewed vocabulary does not contain is refused as well, so a
 * document cannot invent a claim class.
 */
export const hostClassAuthorizesEvidenceType = (
    hostClass: EvidenceHostClass | null,
    evidenceType: EvidenceType,
): boolean => {
    if (hostClass === null || !isRecord(hostClass) || !isEvidenceType(evidenceType)) {
        return false;
    }

    for (const declared of asList(hostClass.evidenceTypes)) {
        if (isEvidenceType(declared) && declared === evidenceType) {
            return true;
        }
    }
    return false;
};

/**
 * The allowlist entry group that admits this host **for this claim**, or `null`
 * when none does. The group is returned rather than a boolean so the caller can
 * record which class of reference corroborated a candidate.
 *
 * `evidenceType` is required rather than optional, which is the point: an
 * optional scope is a scope that gets omitted, and an omitted scope authorizes
 * everything. Where a host appears in two groups the first group that admits it
 * *and* authorizes the claim wins, so overlapping entries grant the union of
 * their claims and never more than that.
 */
export const matchEvidenceHostClass = (
    host: string,
    hostClasses: readonly EvidenceHostClass[],
    evidenceType: EvidenceType,
): EvidenceHostClass | null => {
    if (!isEvidenceType(evidenceType)) {
        return null;
    }

    for (const rawClass of asList(hostClasses)) {
        const hostClass = asHostClassView(rawClass);
        if (hostClass === null || !hostClassAuthorizesEvidenceType(hostClass, evidenceType)) {
            continue;
        }
        for (const rawEntry of asList(hostClass.hosts)) {
            if (typeof rawEntry === 'string' && hostMatchesEntry(host, rawEntry)) {
                return hostClass;
            }
        }
    }
    return null;
};

export const isHostAllowed = (
    host: string,
    hostClasses: readonly EvidenceHostClass[],
    evidenceType: EvidenceType,
): boolean => matchEvidenceHostClass(host, hostClasses, evidenceType) !== null;

/**
 * A group's `class` identifier, or `null` when the value is missing or empty.
 *
 * A validated document always carries one ({@link validateEvidencePolicy}
 * refuses a group without it), so the `null` case exists for the paths that
 * match against a raw document — a verdict must still be able to say it does
 * not know which group corroborated a candidate rather than invent a name.
 */
export const evidenceHostClassId = (hostClass: EvidenceHostClass | null): string | null => {
    if (hostClass === null || !isRecord(hostClass)) {
        return null;
    }
    return typeof hostClass.class === 'string' && hostClass.class !== '' ? hostClass.class : null;
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

/** A WHATWG scheme: an ASCII letter followed by letters, digits, `+`, `-` or `.`. */
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+\-.]*$/i;

/** Where an authority ends. `\` is deliberately absent — see {@link rawUserinfoInAuthority}. */
const AUTHORITY_TERMINATOR_PATTERN = /[/?#]/;

/** Every ASCII tab and newline, which WHATWG parsing removes from anywhere in the input. */
const TAB_OR_NEWLINE_PATTERN = /[\t\n\r]/g;

/** The highest code point WHATWG strips from both ends of an input: C0 controls and space. */
const C0_OR_SPACE_MAX = 0x20;

/**
 * Whether the reference carries a userinfo delimiter in the position where a
 * host is named — read from the RAW text, before any parser normalizes it.
 *
 * WHY THE RAW TEXT. `URL` does not preserve an **empty** userinfo component: it
 * removes it. `https://@host/`, `https://:@host/`, `https:@host/`,
 * `https:/@host/`, `https:///@host/` and `https:\\@host/` all parse to
 * `https://host/` with `username` and `password` both `''`, so a check that
 * reads only those two fields accepts every one of them while the policy says
 * userinfo is refused unconditionally. The delimiter is the whole point: it is
 * what makes a reader — and a parser that disagrees with this one — take the
 * wrong side of the `@` for the host, and it carries no legitimate meaning in a
 * URL naming a public reference page.
 *
 * WHAT IT MIRRORS. The scan reproduces the front of WHATWG basic URL parsing so
 * that it sees what the parser will see: leading and trailing C0 controls and
 * spaces are stripped, every ASCII tab and newline is removed from anywhere in
 * the input, an optional scheme is dropped, and the slashes introducing the
 * authority are skipped. A special scheme's authority state tolerates none, one
 * or many slashes — which is why `https:@host/` and `https:/@host/` still name
 * `host` — so an absolute reference always has an authority, while a
 * scheme-relative one needs the conventional two.
 *
 * A PATH-RELATIVE REFERENCE HAS NO AUTHORITY, and this is why the function
 * takes a reference rather than a URL: a redirect to `/@handle` is an ordinary
 * path whose first character happens to be `@`, and refusing it would refuse
 * legitimate pages. Only text in authority position is scanned.
 *
 * `\` IS SCANNED, NOT TREATED AS A TERMINATOR. In `https://host\@evil.com/`
 * this parser reads `host` and puts `\@evil.com/` in the path; others read
 * `evil.com`. Rather than pick a side on model-proposed input, the whole run up
 * to the first `/`, `?` or `#` is scanned, so that form is refused. It costs
 * nothing: a backslash cannot appear in a real host, and one later in the path
 * is never reached because the authority has already ended.
 */
const rawUserinfoInAuthority = (reference: string): boolean => {
    if (typeof reference !== 'string') {
        return false;
    }

    let start = 0;
    let end = reference.length;
    while (start < end && reference.charCodeAt(start) <= C0_OR_SPACE_MAX) {
        start++;
    }
    while (end > start && reference.charCodeAt(end - 1) <= C0_OR_SPACE_MAX) {
        end--;
    }

    let rest = reference.slice(start, end).replace(TAB_OR_NEWLINE_PATTERN, '');

    // A colon only introduces a scheme when what precedes it is shaped like
    // one, so the port colon in `//host:8080/` is not mistaken for a scheme.
    const colon = rest.indexOf(':');
    const hasScheme = colon > 0 && URL_SCHEME_PATTERN.test(rest.slice(0, colon));
    if (hasScheme) {
        rest = rest.slice(colon + 1);
    }

    let slashes = 0;
    while (slashes < rest.length && (rest[slashes] === '/' || rest[slashes] === '\\')) {
        slashes++;
    }

    if (!hasScheme && slashes < 2) {
        return false;
    }

    const authority = rest.slice(slashes);
    const terminator = authority.search(AUTHORITY_TERMINATOR_PATTERN);

    return (terminator === -1 ? authority : authority.slice(0, terminator)).indexOf('@') !== -1;
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
 *
 * `limits` is `unknown` for the reason given on {@link resolveEvidenceFetchLimits}:
 * it may be a member of a document read off disk, so it is guarded rather than
 * trusted, and a malformed value narrows the policy to nothing instead of
 * raising.
 */
export const parseEvidenceUrl = (rawUrl: string, limits?: unknown): EvidenceUrlVerdict => {
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
    //
    // The policy is unconditional, so the RAW text decides it: the parser
    // removes an *empty* userinfo component entirely, and a check on
    // `username`/`password` alone therefore accepts `https://@host/` and every
    // obfuscation of it (see {@link rawUserinfoInAuthority}). Both checks are
    // kept — the parsed fields answer for anything the raw scan cannot see, and
    // they are the reference this scan is written against.
    if (rawUserinfoInAuthority(rawUrl) || parsed.username !== '' || parsed.password !== '') {
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
 *
 * The prefix length must be plain decimal: `/8` parses and `/008` does not, for
 * the same reason {@link parseIpAddress} refuses a zero-padded octet — padded
 * numerals are read differently by different tools, and a validator and a
 * connector disagreeing about what a string means is the bypass class this
 * module refuses throughout.
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
 *
 * This is a lookup, not a permission decision: it answers "which row covers
 * this address", and `null` means "no row in the rows you handed me", never
 * "safe to fetch". It therefore validates nothing, and the rows it is given are
 * always the validated rows {@link validateEvidenceRangeTable} returned —
 * {@link classifyIpAddress} is the only caller in this module and passes
 * `table.rows`. It is exported because the registry-derived test walks the
 * committed table row by row, and that test wants the lookup on its own,
 * separately from the verdict built on top of it.
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

/**
 * The verdict on the address table. On success it carries the **normalized
 * rows**, so an address is only ever compared against rows that passed every
 * check — the caller cannot accidentally classify against the raw input it
 * handed in.
 */
export type EvidenceRangeTableVerdict =
    | { readonly ok: true; readonly rows: readonly SpecialPurposeRange[] }
    | { readonly ok: false; readonly detail: string };

/** A value rendered for an operator-facing detail string, without ever throwing. */
const describeValue = (value: unknown): string => {
    if (typeof value === 'string') {
        return `"${value}"`;
    }
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return Array.isArray(value) ? 'a list' : typeof value;
};

/** A block's identity, independent of how its text was written. */
const cidrKey = (cidr: ParsedCidr): string => `${cidr.version}|${cidr.bytes.join('.')}|${cidr.prefixLength}`;

const bytesEqual = (left: readonly number[], right: readonly number[]): boolean => {
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

type CheckedRow =
    | { readonly ok: true; readonly row: SpecialPurposeRange; readonly cidr: ParsedCidr }
    | { readonly ok: false; readonly detail: string };

/**
 * One row, checked the way a reviewer checks it against the registry page.
 *
 * The CIDR must parse **and be written in canonical registry text**: in lower
 * case, without surrounding whitespace, on its own network address with no host
 * bits set, and with a plain decimal prefix length — `/8`, never `/008`, which
 * {@link parseCidr} refuses outright. None of these is a classification hole on
 * its own: `10.0.0.1/8` is masked to the same block, and a padded prefix does
 * not parse at all. Each is instead evidence that the row was edited by hand
 * rather than transcribed from the registry, and the whole point of an
 * attestation is to notice that while it can still be fixed — a table nobody can
 * diff against the registry page is a table nobody can review.
 *
 * `registry` must name the family its CIDR actually belongs to. The classifier
 * takes the family from the CIDR, so a mislabelled row could never smuggle an
 * IPv4 rule onto an IPv6 address — but a row whose own two fields disagree is a
 * transcription error, and a transcription error in this table is exactly the
 * failure this validation exists to catch.
 */
const checkRangeRow = (rawRow: unknown, index: number): CheckedRow => {
    if (!isRecord(rawRow)) {
        return { ok: false, detail: `special-purpose row ${index} is ${describeValue(rawRow)}, not an object` };
    }

    const cidrText = rawRow.cidr;
    if (typeof cidrText !== 'string' || cidrText.trim() === '') {
        return { ok: false, detail: `special-purpose row ${index} declares no CIDR` };
    }
    if (cidrText !== cidrText.trim() || cidrText !== cidrText.toLowerCase()) {
        return {
            ok: false,
            detail: `special-purpose row "${cidrText}" is not written in canonical lower-case registry text`,
        };
    }

    const cidr = parseCidr(cidrText);
    if (cidr === null) {
        return { ok: false, detail: `special-purpose row "${cidrText}" is not a valid CIDR` };
    }

    const slashIndex = cidrText.indexOf('/');
    const written = parseIpAddress(cidrText.slice(0, slashIndex));
    if (written === null || !bytesEqual(written.bytes, cidr.bytes)) {
        return {
            ok: false,
            detail: `special-purpose row "${cidrText}" is not written on its own network address`,
        };
    }

    const name = rawRow.name;
    if (typeof name !== 'string' || name.trim() === '') {
        return { ok: false, detail: `special-purpose row "${cidrText}" carries no registry name` };
    }

    const registry = rawRow.registry;
    const family = cidr.version === 4 ? 'ipv4' : 'ipv6';
    if (registry !== 'ipv4' && registry !== 'ipv6') {
        return {
            ok: false,
            detail: `special-purpose row "${cidrText}" declares the registry ${describeValue(registry)}`,
        };
    }
    if (registry !== family) {
        return {
            ok: false,
            detail:
                `special-purpose row "${cidrText}" is filed under the ${registry} registry ` +
                `but is an ${family} block`,
        };
    }

    const reachable = rawRow.globallyReachable;
    if (reachable !== true && reachable !== false && reachable !== 'n/a') {
        return {
            ok: false,
            detail:
                `special-purpose row "${cidrText}" declares the unrecognised ` +
                `globallyReachable value ${describeValue(reachable)}`,
        };
    }

    return { ok: true, row: { cidr: cidrText, name, registry, globallyReachable: reachable }, cidr };
};

/** One reviewed row resolved to the block identity the comparison keys on. */
interface AttestedRange {
    readonly key: string;
    readonly cidr: string;
    readonly globallyReachable: GloballyReachable;
}

/** The reviewed table resolved to block identities, plus any defect found in it. */
interface ReviewedAttestation {
    readonly rows: readonly AttestedRange[];
    readonly keys: ReadonlySet<string>;
    /**
     * {@link REVIEWED_SUPPLEMENTAL_CIDRS} resolved to block identity, keyed by
     * that identity and carrying the reviewed text as its value. Keyed for the
     * same reason the rows are — a document may write a block in any equivalent
     * text, and the comparison is about the block — and the text is kept so a
     * refusal can name the missing block as the review writes it.
     */
    readonly supplementalBlocks: ReadonlyMap<string, string>;
    readonly defects: readonly string[];
}

/**
 * The reviewed table, resolved to block identities once at module load.
 *
 * Resolving it per classified address would repeat one CIDR parse per reviewed
 * row on every candidate URL, for a value that cannot change at runtime. A
 * defect in the attestation — an entry that does not parse, or one block
 * written twice, which would make it cover fewer blocks than its row count
 * claims — is recorded rather than thrown: it would be a typing mistake in this
 * file, and the honest response is for every table to stop validating, loudly
 * and through the ordinary verdict, rather than for the attestation to silently
 * attest less than it appears to.
 *
 * The supplemental set is checked the same way and for the same reason. Its
 * counts are derived by subtracting it from the table, so an entry the table
 * does not carry **as written** would leave
 * {@link REVIEWED_REGISTRY_ROW_COUNT} overstated by one while the hardening
 * rule it names quietly stopped applying — the two drifting apart is exactly
 * what the reviewed split exists to prevent, so it is a defect, not a warning.
 */
const REVIEWED_ATTESTATION: ReviewedAttestation = (() => {
    const rows: AttestedRange[] = [];
    const keys = new Set<string>();
    const supplementalBlocks = new Map<string, string>();
    const defects: string[] = [];

    for (const reviewed of REVIEWED_RANGE_TABLE) {
        const cidr = parseCidr(reviewed.cidr);
        if (cidr === null) {
            defects.push(`the reviewed entry "${reviewed.cidr}" is not a valid CIDR`);
            continue;
        }

        const key = cidrKey(cidr);
        if (keys.has(key)) {
            defects.push(`the reviewed entry "${reviewed.cidr}" names a block already attested`);
            continue;
        }

        rows.push({ key, cidr: reviewed.cidr, globallyReachable: reviewed.globallyReachable });
        keys.add(key);
    }

    const carriedByTable = new Set<string>(REVIEWED_RANGE_TABLE.map((reviewed) => reviewed.cidr));

    for (const supplemental of REVIEWED_SUPPLEMENTAL_CIDRS) {
        const cidr = parseCidr(supplemental);
        if (cidr === null) {
            defects.push(`the reviewed supplemental entry "${supplemental}" is not a valid CIDR`);
            continue;
        }

        // Text identity, not block identity, because both lists are literals in
        // this file transcribed side by side, and it is the text match the two
        // row counts above are derived from.
        if (!carriedByTable.has(supplemental)) {
            defects.push(
                `the reviewed supplemental entry "${supplemental}" is not carried by the reviewed table as written`,
            );
            continue;
        }

        const key = cidrKey(cidr);
        if (supplementalBlocks.has(key)) {
            defects.push(`the reviewed supplemental entry "${supplemental}" names a block already supplemental`);
            continue;
        }

        supplementalBlocks.set(key, supplemental);
    }

    return { rows, keys, supplementalBlocks, defects };
})();

/** {@link REVIEWED_GLOBAL_UNICAST_ALLOCATIONS} resolved to parsed blocks once at module load. */
interface ReviewedAllocation {
    /** Each reviewed block, parsed, carrying the reviewed text for refusal messages. */
    readonly blocks: readonly { readonly cidr: ParsedCidr; readonly text: string }[];
    readonly defects: readonly string[];
}

/**
 * The reviewed global-unicast allocation, resolved once at module load for the
 * same reason the table is: it cannot change at runtime, and re-parsing it per
 * address would repeat the work on every candidate URL.
 *
 * A defect is recorded rather than thrown, matching
 * {@link REVIEWED_ATTESTATION}: it could only be a typing mistake in this file,
 * and the honest response is for every classification to refuse loudly through
 * the ordinary verdict. A family with no block is a defect in its own right —
 * without it, losing the IPv6 line would silently refuse every IPv6 address as
 * "unallocated", which is the correct direction but the wrong reason, and an
 * operator reading the refusal would go looking at the registries instead of at
 * this list.
 */
const REVIEWED_ALLOCATION: ReviewedAllocation = (() => {
    const blocks: { cidr: ParsedCidr; text: string }[] = [];
    const keys = new Set<string>();
    const families = new Set<number>();
    const defects: string[] = [];

    for (const reviewed of REVIEWED_GLOBAL_UNICAST_ALLOCATIONS) {
        const cidr = parseCidr(reviewed.cidr);
        if (cidr === null) {
            defects.push(`the reviewed allocation entry "${reviewed.cidr}" is not a valid CIDR`);
            continue;
        }

        const key = cidrKey(cidr);
        if (keys.has(key)) {
            defects.push(`the reviewed allocation entry "${reviewed.cidr}" names a block already allocated`);
            continue;
        }

        blocks.push({ cidr, text: reviewed.cidr });
        keys.add(key);
        families.add(cidr.version);
    }

    for (const version of [4, 6]) {
        if (!families.has(version)) {
            defects.push(
                `the reviewed allocation carries no IPv${version} block, so no IPv${version} address could be judged routable`,
            );
        }
    }

    return { blocks, defects };
})();

/**
 * The defect message the reviewed allocation carries, or `null` when it is
 * usable. Joined into one sentence so a refusal names every defect at once
 * rather than one per run.
 */
const reviewedAllocationDefect = (): string | null =>
    REVIEWED_ALLOCATION.defects.length === 0
        ? null
        : `the reviewed global-unicast allocation is unusable: ${REVIEWED_ALLOCATION.defects.join('; ')}`;

/**
 * Whether the address falls inside space IANA has allocated to globally
 * routable unicast.
 *
 * Exported because it is the one part of the address policy that must be
 * checkable without a table: {@link validateEvidenceRangeTable} compares the
 * table against the reviewed snapshot as a set, so a test cannot reach this
 * rule through {@link classifyIpAddress} while holding a table with a row
 * removed — that table refuses first, for a different reason. Proving the gate
 * is independent of the table means asking it directly.
 *
 * Fails closed on a defective allocation, so a direct caller reaches the same
 * verdict as one going through {@link classifyIpAddress}, which reports the
 * defect explicitly.
 */
export const isGloballyAllocatedUnicast = (
    address: ParsedIpAddress,
    allocations?: readonly GlobalUnicastAllocation[],
): boolean => {
    const resolved = resolveAllocationBlocks(allocations);
    if (!resolved.ok) {
        return false;
    }

    return isWithinAllocationBlocks(address, resolved.blocks);
};

/** An allocation block resolved for classification: the parsed block and the text it was written as. */
interface ResolvedAllocationBlock {
    readonly cidr: ParsedCidr;
    readonly text: string;
}

/**
 * The verdict on a document's allocation list. On success it carries the
 * **resolved blocks**, for the reason {@link EvidenceRangeTableVerdict} carries
 * normalized rows: an address is then only ever compared against blocks that
 * passed every check, and a caller cannot accidentally classify against the raw
 * input it handed in.
 */
export type EvidenceAllocationTableVerdict =
    | {
          readonly ok: true;
          readonly blocks: readonly ResolvedAllocationBlock[];
          /** The validated rows, so a caller can hand the checked data back in. */
          readonly rows: readonly GlobalUnicastAllocation[];
      }
    | { readonly ok: false; readonly detail: string };

/**
 * The document's allocation list must be trustworthy **and** be the reviewed one
 * before any address is judged against it.
 *
 * Integrity first: an empty list, a non-object row, an unparsable or
 * non-canonical CIDR, a row missing its registry or allocation wording, a block
 * declared twice, or a family with no block at all all reject.
 *
 * Then set equality with {@link REVIEWED_GLOBAL_UNICAST_ALLOCATIONS}, in both
 * directions, because both failure modes are dangerous and they are dangerous in
 * opposite ways. A document that ADDS a block widens the policy — appending
 * `4000::/3` would restore exactly the hole this gate exists to close. A document
 * that DROPS one narrows it, which is safe for traffic but means the code and the
 * reviewed data no longer describe the same policy, and the next reviewer diffing
 * the document against the registry pages would be checking a list the classifier
 * is not using. Neither is accepted: the document must be the reviewed
 * allocation, exactly.
 *
 * Blocks are compared by identity rather than by the text they are written in,
 * the way the range table's own set equality compares them, so an equivalent
 * spelling of the same block is accepted and a different block never is.
 */
export const validateEvidenceAllocationTable = (allocations: unknown): EvidenceAllocationTableVerdict => {
    if (!Array.isArray(allocations)) {
        return { ok: false, detail: `globalUnicastAllocations is ${describeValue(allocations)}, not a list` };
    }
    if (allocations.length === 0) {
        return { ok: false, detail: 'globalUnicastAllocations is empty, so no address could be judged routable' };
    }

    const blocks: ResolvedAllocationBlock[] = [];
    const rows: GlobalUnicastAllocation[] = [];
    const seen = new Set<string>();
    const families = new Set<number>();

    for (const entry of allocations) {
        if (!isRecord(entry)) {
            return { ok: false, detail: `an allocation row is ${describeValue(entry)}, not an object` };
        }

        const { cidr: rawCidr, allocation, registry } = entry;
        if (typeof rawCidr !== 'string' || rawCidr.trim() === '') {
            return { ok: false, detail: `an allocation row declares the block ${describeValue(rawCidr)}` };
        }

        // Canonical registry text, checked the way `checkRangeRow` checks it and
        // for the same reason: none of these is a classification hole on its
        // own, but each is evidence the row was hand-edited rather than
        // transcribed, and a list nobody can diff against the registry page is a
        // list nobody can review.
        if (rawCidr !== rawCidr.trim() || rawCidr !== rawCidr.toLowerCase()) {
            return {
                ok: false,
                detail: `the allocation row "${rawCidr}" is not written in canonical lower-case registry text`,
            };
        }

        const parsed = parseCidr(rawCidr);
        if (parsed === null) {
            return { ok: false, detail: `the allocation row "${rawCidr}" is not a valid CIDR` };
        }

        const slashIndex = rawCidr.indexOf('/');
        const written = parseIpAddress(rawCidr.slice(0, slashIndex));
        if (written === null || !bytesEqual(written.bytes, parsed.bytes)) {
            return {
                ok: false,
                detail: `the allocation row "${rawCidr}" is not written on its own network address`,
            };
        }

        if (typeof allocation !== 'string' || allocation.trim() === '') {
            return {
                ok: false,
                detail: `the allocation row "${rawCidr}" declares the allocation ${describeValue(allocation)}`,
            };
        }
        if (typeof registry !== 'string' || registry.trim() === '') {
            return {
                ok: false,
                detail: `the allocation row "${rawCidr}" declares the registry ${describeValue(registry)}`,
            };
        }

        const key = cidrKey(parsed);
        if (seen.has(key)) {
            return { ok: false, detail: `the allocation row "${rawCidr}" names a block already declared` };
        }

        blocks.push({ cidr: parsed, text: rawCidr });
        rows.push({ cidr: rawCidr, allocation, registry });
        seen.add(key);
        families.add(parsed.version);
    }

    for (const version of [4, 6]) {
        if (!families.has(version)) {
            return {
                ok: false,
                detail:
                    `globalUnicastAllocations carries no IPv${version} block, ` +
                    `so no IPv${version} address could be judged routable`,
            };
        }
    }

    const reviewedDefect = reviewedAllocationDefect();
    if (reviewedDefect !== null) {
        return { ok: false, detail: reviewedDefect };
    }

    const reviewedKeys = new Map<string, string>();
    for (const block of REVIEWED_ALLOCATION.blocks) {
        reviewedKeys.set(cidrKey(block.cidr), block.text);
    }

    for (const [key, text] of reviewedKeys) {
        if (!seen.has(key)) {
            return {
                ok: false,
                detail: `globalUnicastAllocations is missing the reviewed block "${text}"`,
            };
        }
    }

    for (const block of blocks) {
        if (!reviewedKeys.has(cidrKey(block.cidr))) {
            return {
                ok: false,
                detail:
                    `globalUnicastAllocations declares "${block.text}", which the ` +
                    `${REVIEWED_REGISTRY_SNAPSHOT} review did not allocate to global unicast`,
            };
        }
    }

    return { ok: true, blocks, rows };
};

/**
 * The blocks an address is judged against: the document's, once validated, or
 * the counter-signed reviewed list when a caller supplies none.
 *
 * The parameter is optional so that every existing call site keeps compiling and
 * keeps its behaviour, while a caller holding a validated policy document can
 * have the classifier judge against the document's own data. Both paths resolve
 * to the same blocks for the committed document, because the validator above
 * refuses any other.
 */
const resolveAllocationBlocks = (
    allocations: readonly GlobalUnicastAllocation[] | undefined,
):
    | { readonly ok: true; readonly blocks: readonly ResolvedAllocationBlock[] }
    | { readonly ok: false; readonly detail: string } => {
    if (allocations === undefined) {
        const defect = reviewedAllocationDefect();
        return defect === null ? { ok: true, blocks: REVIEWED_ALLOCATION.blocks } : { ok: false, detail: defect };
    }

    return validateEvidenceAllocationTable(allocations);
};

/** Whether the address falls inside one of the given allocation blocks. */
const isWithinAllocationBlocks = (
    address: ParsedIpAddress,
    blocks: readonly ResolvedAllocationBlock[],
): boolean => {
    for (const block of blocks) {
        if (cidrContains(block.cidr, address)) {
            return true;
        }
    }

    return false;
};

/** The blocks of one family, as they are written, for a refusal message. */
const allocatedBlocksFor = (version: 4 | 6, blocks: readonly ResolvedAllocationBlock[]): string =>
    blocks
        .filter((block) => block.cidr.version === version)
        .map((block) => block.text)
        .join(', ');

/**
 * The table itself must be trustworthy **and complete** before any address is
 * judged against it.
 *
 * Integrity comes first, over every row rather than only the rows covering the
 * address in hand: a table that has drifted from the registries cannot be
 * relied on for the row that happens to match either. So an empty table, a
 * non-object row, an unparsable or non-canonical CIDR, a row filed under the
 * wrong family, a row without its registry name, a `globallyReachable` outside
 * the three permitted values and a block declared twice all reject.
 *
 * Completeness comes second, and it is the check whose absence is invisible.
 * "Matches no row" sends an address on to
 * {@link REVIEWED_GLOBAL_UNICAST_ALLOCATIONS}, and that gate cannot stand in
 * for a missing row: every special-purpose block carved out of unicast space
 * lies *inside* an allocated block, so deleting `169.254.0.0/16` makes
 * `169.254.169.254` match no row, fall through to an allocation it satisfies,
 * and pass. The allocation answers what the registries are silent about; only
 * this check answers for a row that went missing. So the table is compared with
 * {@link REVIEWED_RANGE_TABLE} as a **set**, in both directions: every reviewed
 * block must be present with exactly the reachability the registries state, and
 * no block outside the reviewed snapshot may appear. A row deleted, a row
 * substituted for another at the same count, or a reachability flipped all
 * refuse, and a table that is not the reviewed snapshot classifies nothing at
 * all rather than classifying part of it wrongly.
 *
 * This is also what ties classification to the attestation. Every
 * address-classification entry point runs through here, so no caller can
 * classify against a hand-assembled subset of the table, whatever else about it
 * is well-formed.
 */
export const validateEvidenceRangeTable = (ranges: unknown): EvidenceRangeTableVerdict => {
    if (!Array.isArray(ranges)) {
        return { ok: false, detail: `the special-purpose address table is ${describeValue(ranges)}, not a list` };
    }
    if (ranges.length === 0) {
        return { ok: false, detail: 'the special-purpose address table is empty' };
    }

    const rows: SpecialPurposeRange[] = [];
    const declaredKeys: { key: string; cidr: string }[] = [];
    const declaredByBlock = new Map<string, GloballyReachable>();

    for (let index = 0; index < ranges.length; index++) {
        const checked = checkRangeRow(ranges[index], index);
        if (!checked.ok) {
            return { ok: false, detail: checked.detail };
        }

        const key = cidrKey(checked.cidr);
        if (declaredByBlock.has(key)) {
            return { ok: false, detail: `the special-purpose block "${checked.row.cidr}" is declared twice` };
        }

        declaredByBlock.set(key, checked.row.globallyReachable);
        declaredKeys.push({ key, cidr: checked.row.cidr });
        rows.push(checked.row);
    }

    if (REVIEWED_ATTESTATION.defects.length > 0) {
        return {
            ok: false,
            detail: `the reviewed attestation is unusable: ${REVIEWED_ATTESTATION.defects[0]}`,
        };
    }

    for (const reviewed of REVIEWED_ATTESTATION.rows) {
        const declared = declaredByBlock.get(reviewed.key);
        if (declared === undefined) {
            return {
                ok: false,
                detail: `the address table omits the reviewed block ${reviewed.cidr}`,
            };
        }
        if (declared !== reviewed.globallyReachable) {
            return {
                ok: false,
                detail:
                    `the address table marks the reviewed block ${reviewed.cidr} ${String(declared)}, ` +
                    `but the ${REVIEWED_REGISTRY_SNAPSHOT} snapshot states ${String(reviewed.globallyReachable)}`,
            };
        }
    }

    for (const declared of declaredKeys) {
        if (!REVIEWED_ATTESTATION.keys.has(declared.key)) {
            return {
                ok: false,
                detail:
                    `the address table carries "${declared.cidr}", which is not part of the ` +
                    `${REVIEWED_REGISTRY_SNAPSHOT} reviewed snapshot`,
            };
        }
    }

    return { ok: true, rows };
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
 * An address is routable only if all of these hold: the table is trustworthy
 * **and complete**, the address parses, it is unicast and not one of the
 * explicitly refused special addresses, every IPv4 address it carries passes the
 * same IPv4 rules, and the **most specific** row covering it is either absent or
 * marked `globallyReachable: true`.
 *
 * It **fails closed without exception**. An empty, malformed or incomplete
 * table, an unparsable address, a mis-sized address object, a non-unicast
 * address, a row marked `false` or `'n/a'`, or a bad embedded address all
 * reject. No branch returns "routable" because a check could not be performed.
 *
 * Matching no row is **not** a positive answer. The special-purpose registries
 * enumerate blocks carved out *for a purpose*; they say nothing about space
 * that was never allocated, and most of the IPv6 address space is exactly that.
 * So an address no row covers is judged against
 * {@link REVIEWED_GLOBAL_UNICAST_ALLOCATIONS} — the third registry, which
 * states what IANA has allocated to globally routable unicast — and an address
 * outside every allocated block refuses. Without that gate `fe00::/9`,
 * `fec0::/10`, `4000::/3` and the rest of the reserved space match nothing and
 * pass, which is how a resolver answer can reach an internal service.
 *
 * A row the registries mark `globallyReachable: true` is the reviewed exception
 * and is not re-judged against the allocation: `64:ff9b::/96` is such a row and
 * lies outside `2000::/3`, so re-judging it would refuse the blocks the
 * registries explicitly declare reachable. Rows win where they speak; the
 * allocation answers only where they are silent.
 *
 * Both halves are only as good as the data behind them, so both are established
 * before any address is judged. {@link validateEvidenceRangeTable} proves the
 * table is the reviewed snapshot, and classification runs against the rows it
 * returns rather than against the argument. The allocation is resolved the same
 * way: `allocations` is validated by
 * {@link validateEvidenceAllocationTable} when a caller supplies the document's
 * own list, and falls back to the counter-signed reviewed list when none is
 * given; either way an unusable list refuses every address through
 * `range_table_unclassifiable`, and classification runs against the blocks the
 * check returned.
 *
 * Neither half is a range hard-coded as a classification rule. Both are
 * reviewed data in `data/meal-planning/evidence-allowlist.v1.json`,
 * counter-signed in this module, so refreshing either registry stays a reviewed
 * data change.
 */
export const classifyIpAddress = (
    ip: ParsedIpAddress | string,
    ranges: readonly SpecialPurposeRange[],
    allocations?: readonly GlobalUnicastAllocation[],
): EvidenceAddressVerdict => {
    const asText = typeof ip === 'string' ? ip : null;

    const table = validateEvidenceRangeTable(ranges);
    if (!table.ok) {
        return rejectAddress('range_table_unclassifiable', table.detail, asText);
    }

    // The allocation is the other half of the policy, so it is established here
    // for the same reason and reported with the same code: an address cannot be
    // judged against half a policy, and a list that is unusable — whether it
    // came from the document or from the reviewed constant — must refuse every
    // address rather than quietly widen what counts as routable.
    const allocation = resolveAllocationBlocks(allocations);
    if (!allocation.ok) {
        return rejectAddress('range_table_unclassifiable', allocation.detail, asText);
    }

    const allocatedBlocks = allocation.blocks;
    const rows = table.rows;
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

        const carriedRow = findMostSpecificRange(carried, rows);
        if (carriedRow !== null) {
            if (carriedRow.globallyReachable !== true) {
                return rejectAddress(
                    'embedded_address_not_globally_routable',
                    `${wrapperText} carries ${carriedText}, which falls in ${carriedRow.cidr} (${carriedRow.name})`,
                    wrapperText,
                );
            }
        } else if (!isWithinAllocationBlocks(carried, allocatedBlocks)) {
            return rejectAddress(
                'embedded_address_not_globally_routable',
                `${wrapperText} carries ${carriedText}, which falls in no block IANA allocates to global ` +
                    `unicast (${allocatedBlocksFor(carried.version, allocatedBlocks)})`,
                wrapperText,
            );
        }
    }

    const row = findMostSpecificRange(address, rows);
    if (row !== null) {
        if (row.globallyReachable !== true) {
            return rejectAddress(
                'address_not_globally_routable',
                `${wrapperText} falls in ${row.cidr} (${row.name}), globallyReachable ${String(row.globallyReachable)}`,
                wrapperText,
            );
        }

        // A row the registries mark globally reachable IS the reviewed
        // exception, and it stands on its own: `64:ff9b::/96` is such a row and
        // sits in `::/8`, outside the allocated `2000::/3`, so re-judging a
        // `true` row against the allocation would refuse the very blocks the
        // registries went out of their way to declare reachable. The allocation
        // is the answer for the addresses the registries say nothing about,
        // which is why it is reached only when no row matched.
    } else if (!isWithinAllocationBlocks(address, allocatedBlocks)) {
        return rejectAddress(
            'address_not_globally_routable',
            `${wrapperText} falls in no block IANA allocates to global unicast ` +
                `(${allocatedBlocksFor(address.version, allocatedBlocks)})`,
            wrapperText,
        );
    }

    return { allowed: true };
};

/** {@link classifyIpAddress} as a predicate, for callers that need no reason. */
export const isGloballyRoutable = (
    ip: ParsedIpAddress | string,
    ranges: readonly SpecialPurposeRange[],
    allocations?: readonly GlobalUnicastAllocation[],
): boolean => classifyIpAddress(ip, ranges, allocations).allowed;

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
    allocations?: readonly GlobalUnicastAllocation[],
): EvidenceAddressVerdict => {
    const entries = asList(addresses);
    if (entries.length === 0) {
        return rejectAddress('unresolvable_host', 'the host resolved to no addresses', null);
    }

    for (const entry of entries) {
        const verdict = classifyIpAddress(entry as ParsedIpAddress | string, ranges, allocations);
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
    allocations?: readonly GlobalUnicastAllocation[],
): boolean => classifyAddressSet(addresses, ranges, allocations).allowed;

// ---------------------------------------------------------------------------
// Policy document validation.
//
// The document is hand-curated and reviewed, and it is still read as untrusted
// input here: it arrives from disk through a CLI script, so it can be stale,
// truncated, partially edited or swapped, and none of those states announce
// themselves. Every member is read as `unknown`, every check answers with a
// verdict instead of throwing, and the verdict carries the *validated* document
// so a caller cannot use the unvalidated one by accident.
// ---------------------------------------------------------------------------

/**
 * The verdict on a whole policy document. On success it carries a rebuilt
 * {@link EvidencePolicy} containing only validated members — assembled field by
 * field rather than cast, so nothing downstream is typed as something it was
 * merely asserted to be.
 */
export type EvidencePolicyVerdict =
    | { readonly ok: true; readonly policy: EvidencePolicy }
    | {
          readonly ok: false;
          readonly reason: 'policy_invalid' | 'range_table_unclassifiable';
          readonly detail: string;
      };

type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

const invalidPolicy = (detail: string): EvidencePolicyVerdict => ({ ok: false, reason: 'policy_invalid', detail });

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isPositiveInteger = (value: unknown): value is number =>
    typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value > 0;

/**
 * One host class, checked and rebuilt.
 *
 * All three load-bearing members are required: a group without an identifier
 * cannot be named in a validation record, a group without hosts admits nothing,
 * and a group without evidence types authorizes nothing in particular — which
 * is the state {@link hostClassAuthorizesEvidenceType} refuses at match time and
 * this refuses at load time, so a document can never quietly widen a class by
 * leaving its scope unstated.
 */
const checkHostClass = (rawClass: unknown, index: number): Checked<EvidenceHostClass> => {
    if (!isRecord(rawClass)) {
        return { ok: false, detail: `host class ${index} is ${describeValue(rawClass)}, not an object` };
    }

    const className = rawClass.class;
    if (typeof className !== 'string' || className.trim() === '') {
        return { ok: false, detail: `host class ${index} declares no class identifier` };
    }

    const rawHosts = rawClass.hosts;
    if (!Array.isArray(rawHosts) || rawHosts.length === 0) {
        return { ok: false, detail: `host class "${className}" declares no hosts` };
    }

    const hosts: string[] = [];
    for (const entry of rawHosts) {
        if (!isValidEvidenceHostEntry(entry)) {
            return {
                ok: false,
                detail: `host class "${className}" declares the unusable host entry ${describeValue(entry)}`,
            };
        }
        const host = entry as string;
        if (hosts.indexOf(host) !== -1) {
            return { ok: false, detail: `host class "${className}" declares "${host}" twice` };
        }
        hosts.push(host);
    }

    const rawTypes = rawClass.evidenceTypes;
    if (!Array.isArray(rawTypes) || rawTypes.length === 0) {
        return { ok: false, detail: `host class "${className}" authorizes no evidence type` };
    }

    const evidenceTypes: EvidenceType[] = [];
    for (const declared of rawTypes) {
        if (!isEvidenceType(declared)) {
            return {
                ok: false,
                detail: `host class "${className}" declares the unknown evidence type ${describeValue(declared)}`,
            };
        }
        if (evidenceTypes.indexOf(declared) !== -1) {
            return { ok: false, detail: `host class "${className}" declares "${declared}" twice` };
        }
        evidenceTypes.push(declared);
    }

    const description = rawClass.description;
    if (description !== undefined && (typeof description !== 'string' || description.trim() === '')) {
        return { ok: false, detail: `host class "${className}" declares an empty description` };
    }

    return {
        ok: true,
        value:
            description === undefined
                ? { class: className, hosts, evidenceTypes }
                : { class: className, hosts, evidenceTypes, description },
    };
};

// A declared list must be non-empty and every member must sit inside the
// reviewed ceiling. Narrowing is welcome — a document may permit only
// `text/html` — but a member outside the ceiling is an attempt to widen the
// policy, and the right answer to that is to refuse the document rather than to
// silently drop the member and carry on with the rest of it.
const checkStringList = (value: unknown, ceiling: readonly string[], member: string): Checked<readonly string[]> => {
    if (!Array.isArray(value) || value.length === 0) {
        return { ok: false, detail: `fetchLimits.${member} is ${describeValue(value)}, not a non-empty list` };
    }

    const values: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') {
            return { ok: false, detail: `fetchLimits.${member} contains ${describeValue(entry)}, not a string` };
        }
        const normalized = entry.trim().toLowerCase();
        if (ceiling.indexOf(normalized) === -1) {
            return {
                ok: false,
                detail: `fetchLimits.${member} declares "${entry}", which the reviewed policy does not permit`,
            };
        }
        if (values.indexOf(normalized) !== -1) {
            return { ok: false, detail: `fetchLimits.${member} declares "${normalized}" twice` };
        }
        values.push(normalized);
    }

    return { ok: true, value: values };
};

const checkNumberList = (value: unknown, ceiling: readonly number[], member: string): Checked<readonly number[]> => {
    if (!Array.isArray(value) || value.length === 0) {
        return { ok: false, detail: `fetchLimits.${member} is ${describeValue(value)}, not a non-empty list` };
    }

    const values: number[] = [];
    for (const entry of value) {
        if (typeof entry !== 'number' || !isFinite(entry)) {
            return { ok: false, detail: `fetchLimits.${member} contains ${describeValue(entry)}, not a number` };
        }
        if (ceiling.indexOf(entry) === -1) {
            return {
                ok: false,
                detail: `fetchLimits.${member} declares ${entry}, which the reviewed policy does not permit`,
            };
        }
        if (values.indexOf(entry) !== -1) {
            return { ok: false, detail: `fetchLimits.${member} declares ${entry} twice` };
        }
        values.push(entry);
    }

    return { ok: true, value: values };
};

const checkCap = (value: unknown, ceiling: number, member: string, allowZero: boolean): Checked<number> => {
    const isInteger = typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
    if (!isInteger || (allowZero ? (value as number) < 0 : (value as number) <= 0)) {
        return {
            ok: false,
            detail:
                `fetchLimits.${member} is ${describeValue(value)}, not ` +
                `${allowZero ? 'a non-negative' : 'a positive'} integer`,
        };
    }
    if ((value as number) > ceiling) {
        return {
            ok: false,
            detail: `fetchLimits.${member} declares ${value}, above the reviewed ceiling of ${ceiling}`,
        };
    }
    return { ok: true, value: value as number };
};

/**
 * The transport policy, checked and rebuilt.
 *
 * The document must state the whole of it, so that what a fetch is permitted to
 * do is visible to the reviewer reading the JSON rather than resolved against a
 * code default they would have to go and find. The one exception is
 * `maxSnippetChars`, which bounds what is *stored* rather than what is reached
 * and may be left to the reviewed ceiling.
 */
const checkDeclaredFetchLimits = (raw: unknown): Checked<EvidenceFetchLimits> => {
    if (!isRecord(raw)) {
        return { ok: false, detail: `fetchLimits is ${describeValue(raw)}, not an object` };
    }

    const schemes = checkStringList(raw.schemes, [EVIDENCE_ALLOWED_SCHEME], 'schemes');
    if (!schemes.ok) {
        return schemes;
    }

    const allowedPorts = checkNumberList(raw.allowedPorts, [EVIDENCE_ALLOWED_PORT], 'allowedPorts');
    if (!allowedPorts.ok) {
        return allowedPorts;
    }

    const allowedContentTypes = checkStringList(
        raw.allowedContentTypes,
        EVIDENCE_ALLOWED_CONTENT_TYPES,
        'allowedContentTypes',
    );
    if (!allowedContentTypes.ok) {
        return allowedContentTypes;
    }

    const maxRedirects = checkCap(raw.maxRedirects, EVIDENCE_MAX_REDIRECTS, 'maxRedirects', true);
    if (!maxRedirects.ok) {
        return maxRedirects;
    }

    const timeoutMs = checkCap(raw.timeoutMs, EVIDENCE_FETCH_TIMEOUT_MS, 'timeoutMs', false);
    if (!timeoutMs.ok) {
        return timeoutMs;
    }

    const maxBodyBytes = checkCap(raw.maxBodyBytes, EVIDENCE_MAX_BODY_BYTES, 'maxBodyBytes', false);
    if (!maxBodyBytes.ok) {
        return maxBodyBytes;
    }

    let maxSnippetChars = EVIDENCE_MAX_SNIPPET_CHARS;
    if (raw.maxSnippetChars !== undefined) {
        const checked = checkCap(raw.maxSnippetChars, EVIDENCE_MAX_SNIPPET_CHARS, 'maxSnippetChars', false);
        if (!checked.ok) {
            return checked;
        }
        maxSnippetChars = checked.value;
    }

    return {
        ok: true,
        value: {
            schemes: schemes.value,
            allowedPorts: allowedPorts.value,
            maxRedirects: maxRedirects.value,
            timeoutMs: timeoutMs.value,
            maxBodyBytes: maxBodyBytes.value,
            allowedContentTypes: allowedContentTypes.value,
            maxSnippetChars,
        },
    };
};

/** The reviewed split of the address table, as a validated document states it. */
interface ReviewedRowSplit {
    readonly registryRowCount: number;
    readonly supplementalRowCount: number;
    readonly supplementalCidrs: readonly string[];
}

/** A declared row's CIDR text, or `null` for anything that is not a row carrying one. */
const declaredBlockText = (row: unknown): string | null =>
    isRecord(row) && typeof row.cidr === 'string' ? row.cidr : null;

/**
 * Whether the declared table carries a block.
 *
 * Read from the *declared* rows rather than the validated ones, because this
 * runs before {@link validateEvidenceRangeTable}: it answers "did the hardening
 * row survive this edit", and it has to answer that for a table which may be
 * about to be refused for some other reason as well. Nothing here trusts the
 * rows — each is read as `unknown` and a row that carries no CIDR text simply
 * does not match.
 *
 * Text first, block identity second: the committed document writes each block
 * in the canonical registry text, so the string comparison answers without
 * parsing anything, and the parse pass only runs for a document that wrote an
 * equivalent-but-different text — which is worth a look, not worth refusing a
 * semantically identical table over.
 */
const tableCarriesBlock = (ranges: readonly unknown[], cidr: string, key: string): boolean => {
    for (const row of ranges) {
        if (declaredBlockText(row) === cidr) {
            return true;
        }
    }

    for (const row of ranges) {
        const text = declaredBlockText(row);
        const parsed = text === null ? null : parseCidr(text);
        if (parsed !== null && cidrKey(parsed) === key) {
            return true;
        }
    }

    return false;
};

/**
 * The reviewed row split, checked and rebuilt.
 *
 * `rowCount` alone is not an attestation of the registries, because one row of
 * the reviewed table is not a registry entry: `::/96`
 * ({@link REVIEWED_SUPPLEMENTAL_CIDRS}) is carried so that `::a9fe:a9fe` cannot
 * outflank `169.254.0.0/16`. So the document states the two sets separately and
 * every one of those statements is checked, in this order:
 *
 * 1. **Each count is a positive integer.** A zero, a fraction or a string is a
 *    document that was edited by something other than a reviewer.
 * 2. **They add up to the rows carried.** This is the internal consistency a
 *    half-merged document fails: bump one count and the sum stops matching.
 * 3. **Each equals the reviewed count**, which the document cannot edit — the
 *    same reason `rowCount` is compared with {@link REVIEWED_RANGE_ROW_COUNT}
 *    and not only with the rows carried. Steps 2 and 3 together are what refuse
 *    a document that moved a real registry row into the supplemental set, or
 *    `::/96` out of it: the sum still holds, but the halves no longer match the
 *    review.
 * 4. **The supplemental list is exactly the reviewed supplemental set**, block
 *    for block, because the counts alone cannot tell a reclassification from a
 *    substitution — one block out, another in, and both counts are intact.
 *    Equality is established as a set: the list is as long as the declared
 *    supplemental count, every member is a block the review classes as
 *    supplemental, and no block appears twice. This is what makes the
 *    *identity* of the hardening rows reviewable rather than just their number.
 * 5. **Every supplemental block is actually in the table.** A supplemental row
 *    the table does not carry is a hardening rule that stopped applying:
 *    nothing would match `::/96`, and the longest-prefix answer for an embedded
 *    address would come from whatever row covers it instead. Blocks are matched
 *    by identity and not by the
 *    text they happen to be written in, the way the table's own set equality
 *    matches them.
 */
const checkReviewedRowSplit = (
    policy: Record<string, unknown>,
    rowCount: number,
    ranges: readonly unknown[],
): Checked<ReviewedRowSplit> => {
    const registryRowCount = policy.registryRowCount;
    if (!isPositiveInteger(registryRowCount)) {
        return {
            ok: false,
            detail: `the policy document declares the registry row count ${describeValue(registryRowCount)}`,
        };
    }

    const supplementalRowCount = policy.supplementalRowCount;
    if (!isPositiveInteger(supplementalRowCount)) {
        return {
            ok: false,
            detail: `the policy document declares the supplemental row count ${describeValue(supplementalRowCount)}`,
        };
    }

    if (registryRowCount + supplementalRowCount !== rowCount) {
        return {
            ok: false,
            detail:
                `the policy document declares ${registryRowCount} registry rows and ` +
                `${supplementalRowCount} supplemental rows, which do not add up to the ${rowCount} rows it carries`,
        };
    }

    if (registryRowCount !== REVIEWED_REGISTRY_ROW_COUNT) {
        return {
            ok: false,
            detail:
                `the policy document declares ${registryRowCount} registry-derived rows, not the ` +
                `${REVIEWED_REGISTRY_ROW_COUNT} reviewed at ${REVIEWED_REGISTRY_SNAPSHOT}`,
        };
    }

    if (supplementalRowCount !== REVIEWED_SUPPLEMENTAL_ROW_COUNT) {
        return {
            ok: false,
            detail:
                `the policy document declares ${supplementalRowCount} supplemental rows, not the ` +
                `${REVIEWED_SUPPLEMENTAL_ROW_COUNT} reviewed at ${REVIEWED_REGISTRY_SNAPSHOT}`,
        };
    }

    const declared = policy.supplementalCidrs;
    if (!Array.isArray(declared) || declared.length === 0) {
        return { ok: false, detail: `supplementalCidrs is ${describeValue(declared)}, not a non-empty list` };
    }

    const supplementalCidrs: string[] = [];
    const declaredKeys = new Set<string>();

    for (const entry of declared) {
        if (typeof entry !== 'string' || entry.trim() === '') {
            return { ok: false, detail: `supplementalCidrs declares ${describeValue(entry)}, not a CIDR` };
        }

        const cidr = parseCidr(entry);
        if (cidr === null) {
            return { ok: false, detail: `supplementalCidrs declares "${entry}", which is not a valid CIDR` };
        }

        const key = cidrKey(cidr);
        if (declaredKeys.has(key)) {
            return { ok: false, detail: `supplementalCidrs declares the block "${entry}" twice` };
        }
        declaredKeys.add(key);

        if (!REVIEWED_ATTESTATION.supplementalBlocks.has(key)) {
            return {
                ok: false,
                detail:
                    `supplementalCidrs declares "${entry}", which the ${REVIEWED_REGISTRY_SNAPSHOT} review ` +
                    'does not class as a supplemental block',
            };
        }

        if (!tableCarriesBlock(ranges, entry, key)) {
            return {
                ok: false,
                detail: `the supplemental block "${entry}" is not carried by the address table`,
            };
        }

        supplementalCidrs.push(entry);
    }

    // The closing leg of the set-equality argument, and the only one that can
    // catch an *omission*: every member above is a distinct reviewed
    // supplemental block, so a list of `supplementalRowCount` of them can only
    // be the whole reviewed set. With a single supplemental block reviewed the
    // two lengths cannot differ once the checks above have passed — this is
    // what keeps the reasoning sound when a second block is added rather than
    // something that fires today. The reviewed set's own size is trustworthy
    // here because a duplicate or unparsable entry in it, or one the reviewed
    // table does not carry, is a load-time defect over which
    // {@link validateEvidenceRangeTable} refuses every table — and no document
    // is accepted without passing it — so a defective reviewed set cannot
    // approve anything, whichever of the two checks runs first.
    if (supplementalCidrs.length !== supplementalRowCount) {
        return {
            ok: false,
            detail:
                `supplementalCidrs names ${supplementalCidrs.length} of the ${supplementalRowCount} ` +
                'supplemental blocks the document declares',
        };
    }

    return { ok: true, value: { registryRowCount, supplementalRowCount, supplementalCidrs } };
};

/**
 * Validates a loaded policy document and returns it rebuilt, or says why it
 * cannot be used. **Nothing is judged against an unvalidated document**: both
 * policy-level entry points call this first, and a failure is reported as a
 * refusal of the policy rather than of the candidate.
 *
 * What is checked, and why each one earns its place:
 *
 * - **The reviewed attestation.** `allowlistVersion` and `registrySnapshot`
 *   must be the ones this module was written against, and `rowCount` must equal
 *   both the number of rows carried and the reviewed count. A stale or swapped
 *   document is then a refusal rather than a quiet change of policy, and a
 *   truncation that also rewrote `rowCount` is caught by the reviewed count that
 *   the document cannot edit.
 * - **The reviewed row split**, through {@link checkReviewedRowSplit}:
 *   `registryRowCount`, `supplementalRowCount` and `supplementalCidrs` must add
 *   up to the rows carried, equal the reviewed counts, and name exactly the
 *   reviewed supplemental blocks — each of which must be present in the table.
 *   `rowCount` on its own would let `::/96`, which is not a registry entry, be
 *   counted as one, and it is the registry-derived figure that a reviewer diffs
 *   against the registry pages at a refresh.
 * - **The address table**, through {@link validateEvidenceRangeTable}: per-row
 *   integrity plus set equality with the complete reviewed snapshot, which is
 *   what keeps the fall-through to the allocation gate safe. Set equality is the
 *   check that matters here: a subset floor would accept a document that dropped
 *   a non-global block and replaced it with an unrelated one, keeping `rowCount`
 *   intact while leaving the dropped block to be judged on allocation alone —
 *   which it satisfies, because it was carved out of allocated unicast space.
 * - **The host classes.** Each needs an identifier, at least one usable host
 *   entry and at least one reviewed evidence type. Identifiers must be unique,
 *   and no host entry may appear in two classes — overlapping entries would make
 *   the authorization of that host depend on the order the classes happen to be
 *   written in, and a security answer that depends on document order is a
 *   security answer nobody can review.
 * - **The transport policy**, complete and never wider than the ceilings.
 */
export const validateEvidencePolicy = (policy: unknown): EvidencePolicyVerdict => {
    if (!isRecord(policy)) {
        return invalidPolicy(`the evidence policy document is ${describeValue(policy)}, not an object`);
    }

    const allowlistVersion = policy.allowlistVersion;
    if (typeof allowlistVersion !== 'string' || allowlistVersion !== REVIEWED_ALLOWLIST_VERSION) {
        return invalidPolicy(
            `the policy document declares version ${describeValue(allowlistVersion)}, ` +
                `not the reviewed "${REVIEWED_ALLOWLIST_VERSION}"`,
        );
    }

    const registrySnapshot = policy.registrySnapshot;
    if (typeof registrySnapshot !== 'string' || !ISO_DATE_PATTERN.test(registrySnapshot)) {
        return invalidPolicy(
            `the policy document declares the registry snapshot ${describeValue(registrySnapshot)}, ` +
                'which is not a YYYY-MM-DD date',
        );
    }
    if (registrySnapshot !== REVIEWED_REGISTRY_SNAPSHOT) {
        return invalidPolicy(
            `the address table is dated ${registrySnapshot}, not the reviewed ${REVIEWED_REGISTRY_SNAPSHOT}`,
        );
    }

    const ranges = policy.specialPurposeRanges;
    if (!Array.isArray(ranges)) {
        return invalidPolicy(`specialPurposeRanges is ${describeValue(ranges)}, not a list`);
    }

    const rowCount = policy.rowCount;
    if (!isPositiveInteger(rowCount)) {
        return invalidPolicy(`the policy document declares the row count ${describeValue(rowCount)}`);
    }
    if (rowCount !== ranges.length) {
        return invalidPolicy(
            `the policy document declares ${rowCount} address rows and carries ${ranges.length}`,
        );
    }
    if (ranges.length !== REVIEWED_RANGE_ROW_COUNT) {
        return invalidPolicy(
            `the address table carries ${ranges.length} rows, not the ` +
                `${REVIEWED_RANGE_ROW_COUNT} reviewed at ${REVIEWED_REGISTRY_SNAPSHOT}`,
        );
    }

    // Before the table walk, because it is the document's own statement about
    // that table: a substitution that kept the row count intact is reported as
    // the hardening row it lost rather than as a table that failed set
    // equality for some reason the operator then has to work out.
    const split = checkReviewedRowSplit(policy, rowCount, ranges);
    if (!split.ok) {
        return invalidPolicy(split.detail);
    }

    const table = validateEvidenceRangeTable(ranges);
    if (!table.ok) {
        return { ok: false, reason: 'range_table_unclassifiable', detail: table.detail };
    }

    // The allocation half of the address policy. Checked here so a document that
    // carries a stale, widened or missing allocation is refused as a document,
    // before any candidate is judged against it — the same treatment the range
    // table gets, and reported under the same code so an operator reading the
    // refusal sees one class of "the address policy is not the reviewed one".
    const allocations = policy.globalUnicastAllocations;
    const allocationTable = validateEvidenceAllocationTable(allocations);
    if (!allocationTable.ok) {
        return { ok: false, reason: 'range_table_unclassifiable', detail: allocationTable.detail };
    }

    // The document's own statement about its allocation, compared with what it
    // carries and with what was reviewed — a count that disagrees with either is
    // a document nobody has actually checked against the registry pages.
    const allocationRowCount = policy.globalUnicastAllocationRowCount;
    if (!isPositiveInteger(allocationRowCount)) {
        return invalidPolicy(
            `the policy document declares the allocation row count ${describeValue(allocationRowCount)}`,
        );
    }
    if (allocationRowCount !== allocationTable.blocks.length) {
        return invalidPolicy(
            `the policy document declares ${allocationRowCount} allocation rows and ` +
                `carries ${allocationTable.blocks.length}`,
        );
    }
    if (allocationRowCount !== REVIEWED_ALLOCATION_ROW_COUNT) {
        return invalidPolicy(
            `the allocation carries ${allocationRowCount} rows, not the ` +
                `${REVIEWED_ALLOCATION_ROW_COUNT} reviewed at ${REVIEWED_REGISTRY_SNAPSHOT}`,
        );
    }

    const rawClasses = policy.hostClasses;
    if (!Array.isArray(rawClasses) || rawClasses.length === 0) {
        return invalidPolicy('the policy document declares no host classes');
    }

    const hostClasses: EvidenceHostClass[] = [];
    const seenClassIds: string[] = [];
    const seenHostEntries: string[] = [];

    for (let index = 0; index < rawClasses.length; index++) {
        const checked = checkHostClass(rawClasses[index], index);
        if (!checked.ok) {
            return invalidPolicy(checked.detail);
        }

        if (seenClassIds.indexOf(checked.value.class) !== -1) {
            return invalidPolicy(`host class "${checked.value.class}" is declared twice`);
        }
        seenClassIds.push(checked.value.class);

        for (const entry of checked.value.hosts) {
            if (seenHostEntries.indexOf(entry) !== -1) {
                return invalidPolicy(
                    `host entry "${entry}" appears in more than one class, so what it may attest is ambiguous`,
                );
            }
            seenHostEntries.push(entry);
        }

        hostClasses.push(checked.value);
    }

    const fetchLimits = checkDeclaredFetchLimits(policy.fetchLimits);
    if (!fetchLimits.ok) {
        return invalidPolicy(fetchLimits.detail);
    }

    return {
        ok: true,
        policy: {
            allowlistVersion,
            registrySnapshot,
            rowCount,
            registryRowCount: split.value.registryRowCount,
            supplementalRowCount: split.value.supplementalRowCount,
            supplementalCidrs: split.value.supplementalCidrs,
            globalUnicastAllocationRowCount: allocationRowCount,
            // The validated rows, for the reason `specialPurposeRanges` carries
            // the normalized rows: a caller handing these back to the classifier
            // is passing data that has already been through every check above.
            globalUnicastAllocations: allocationTable.rows,
            hostClasses,
            specialPurposeRanges: table.rows,
            fetchLimits: fetchLimits.value,
        },
    };
};

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
export const isAllowedContentType = (headerValue: string | null | undefined, limits?: unknown): boolean => {
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
export const isWithinBodyCap = (decompressedBytes: number, limits?: unknown): boolean => {
    if (typeof decompressedBytes !== 'number' || !isFinite(decompressedBytes) || decompressedBytes < 0) {
        return false;
    }
    return decompressedBytes <= resolveEvidenceFetchLimits(limits).maxBodyBytes;
};

// ---------------------------------------------------------------------------
// Policy-level entry points.
//
// These are what `evidence.service.ts` calls, and they sit last because they
// compose everything above: the document validation, the URL policy, the
// allowlist and the evidence-type authorization. Both require a claim, so there
// is no way to ask "may I fetch this?" without saying what the fetch would be
// used to establish.
// ---------------------------------------------------------------------------

// The host half of the URL policy, applied to an already-validated document so
// that the redirect path does not revalidate the same document on every hop.
const evaluateValidatedEvidenceUrl = (
    rawUrl: string,
    policy: EvidencePolicy,
    evidenceType: EvidenceType,
): EvidenceUrlVerdict => {
    const verdict = parseEvidenceUrl(rawUrl, policy.fetchLimits);
    if (!verdict.allowed) {
        return verdict;
    }

    const authorized = matchEvidenceHostClass(verdict.host, policy.hostClasses, evidenceType);
    if (authorized === null) {
        // Allowlisted for other claims, or not allowlisted at all: two different
        // defects, and the operator's next move differs, so the causes stay apart.
        const admittedBy = findEvidenceHostClassForHost(verdict.host, policy.hostClasses);
        if (admittedBy === null) {
            return rejectUrl('host_not_allowlisted', `host "${verdict.host}" is not on the evidence allowlist`);
        }
        return rejectUrl(
            'evidence_type_not_authorized',
            `host "${verdict.host}" is allowlisted as ${String(evidenceHostClassId(admittedBy))} ` +
                `but is not a source of ${evidenceType} evidence`,
        );
    }

    return { allowed: true, url: verdict.url, host: verdict.host, hostClass: evidenceHostClassId(authorized) };
};

/**
 * The entry point for a candidate URL: the policy document, the full URL policy,
 * the allowlist and the requested claim. `evidence.service.ts` calls this before
 * resolving anything, and fetches only the `url` it returns.
 *
 * `evidenceType` names what the page would be used to corroborate, and it is
 * required: a host class states which claims it may support, and a check that
 * can be skipped by omitting an argument is not a check. A host on the allowlist
 * for identity and preparation claims is therefore refused as a source of
 * nutrition or allergen evidence, with `evidence_type_not_authorized` rather
 * than `host_not_allowlisted` so the cause is not mistaken for a missing entry.
 *
 * The document is validated first. A stale, truncated or tampered policy yields
 * `policy_invalid` or `range_table_unclassifiable` — the candidate is refused
 * because the rules could not be trusted, which is a different fact about the
 * world than the candidate being disallowed, and is recorded as one.
 */
export const evaluateEvidenceUrl = (
    rawUrl: string,
    policy: EvidencePolicy,
    evidenceType: EvidenceType,
): EvidenceUrlVerdict => {
    const validated = validateEvidencePolicy(policy);
    if (!validated.ok) {
        return rejectUrl(validated.reason, validated.detail);
    }

    if (!isEvidenceType(evidenceType)) {
        return rejectUrl(
            'evidence_type_not_authorized',
            `${describeValue(evidenceType)} is not one of the reviewed evidence types`,
        );
    }

    return evaluateValidatedEvidenceUrl(rawUrl, validated.policy, evidenceType);
};

/**
 * Whether a redirect may be followed, and to exactly what URL.
 *
 * `redirectCount` is how many have already been followed, so the check is
 * `>=` against the cap and at most {@link EVIDENCE_MAX_REDIRECTS} hops happen.
 * A `Location` header may be relative, so it is resolved against the URL that
 * produced it and then **re-validated from the URL step onward** — scheme, port,
 * userinfo, IP literal, host shape, allowlist and evidence-type authorization
 * all apply again, which is what stops a redirect to `http://`, to another port,
 * to a host nobody allowlisted, or to a host allowlisted for some other claim.
 * Finally, any change of host ends the fetch: the pinned address belongs to the
 * original host, so following the hop would abandon the pin.
 */
export const evaluateEvidenceRedirect = (
    currentUrl: string,
    location: string,
    redirectCount: number,
    policy: EvidencePolicy,
    evidenceType: EvidenceType,
): EvidenceUrlVerdict => {
    const validated = validateEvidencePolicy(policy);
    if (!validated.ok) {
        return rejectUrl(validated.reason, validated.detail);
    }

    if (!isEvidenceType(evidenceType)) {
        return rejectUrl(
            'evidence_type_not_authorized',
            `${describeValue(evidenceType)} is not one of the reviewed evidence types`,
        );
    }

    const resolved = resolveEvidenceFetchLimits(validated.policy.fetchLimits);

    if (typeof redirectCount !== 'number' || !isFinite(redirectCount) || redirectCount < 0) {
        return rejectUrl('redirect_limit_exceeded', 'the redirect count is not a usable number');
    }
    if (redirectCount >= resolved.maxRedirects) {
        return rejectUrl('redirect_limit_exceeded', `more than ${resolved.maxRedirects} redirects were required`);
    }

    const current = parseEvidenceUrl(currentUrl, validated.policy.fetchLimits);
    if (!current.allowed) {
        return current;
    }

    if (typeof location !== 'string' || location.trim() === '') {
        return rejectUrl('unparseable_url', 'the redirect target is empty');
    }

    // The raw `Location` is the only place a hop's userinfo is still visible.
    // Resolving it against the current URL normalizes an empty userinfo
    // component away — `//@host/x` resolves to `https://host/x` — so by the
    // time the absolute href reaches {@link parseEvidenceUrl} there is nothing
    // left to refuse. Scanning the header text is what keeps the redirect path
    // held to the same unconditional rule as the first URL.
    //
    // It runs ahead of resolution deliberately, which means a hop that is both
    // off-scheme and carries userinfo is reported as userinfo: the stronger
    // statement about a target nobody should follow either way.
    if (rawUserinfoInAuthority(location)) {
        return rejectUrl('credentials_present', 'the URL carries userinfo');
    }

    let absolute: string;
    try {
        absolute = new URL(location, current.url).href;
    } catch {
        return rejectUrl('unparseable_url', 'the redirect target could not be parsed');
    }

    const target = evaluateValidatedEvidenceUrl(absolute, validated.policy, evidenceType);
    if (!target.allowed) {
        return target;
    }

    if (!resolved.allowCrossHostRedirect && target.host !== current.host) {
        return rejectUrl('cross_host_redirect', `a redirect from "${current.host}" to "${target.host}" is not followed`);
    }

    return target;
};
