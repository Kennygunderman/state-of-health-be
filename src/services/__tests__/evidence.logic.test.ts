/**
 * `evidence.logic.ts` is the pure SSRF policy for identity-evidence retrieval
 * (Agent Action Plan §0.3.2). Its inputs are attacker-influenced — a language
 * model proposes the URLs — so this suite is written the way §0.3.2 specifies,
 * as a **registry-derived** suite rather than a handful of hand-picked
 * addresses:
 *
 * > it iterates the committed `specialPurposeRanges` table and, for every row
 * > not marked `true`, asserts the first and last address of the CIDR are
 * > rejected and the addresses immediately below and above the range are
 * > accepted unless they fall in another non-global row
 *
 * Three properties make that loop a real test rather than a restatement of the
 * implementation:
 *
 *  1. **The data is loaded, not transcribed.** The loop reads
 *     `data/meal-planning/evidence-allowlist.v1.json` off disk — the same file
 *     `scripts/lib/manifest.ts` hands the generator — so a registry refresh
 *     changes what the suite asserts.
 *  2. **The expectation comes from an independent classifier.** The addresses
 *     under test are produced by the module's own CIDR arithmetic (which is
 *     what §0.3.2 wants exercised), but whether each one *should* be routable is
 *     decided by `oracleIsRoutable` below, which works on binary strings and
 *     longest-prefix string comparison instead of the module's byte masks. Every
 *     row additionally asserts that the module's `parseCidr` agrees with an
 *     independently written text parser, so the two derivations cannot drift
 *     together.
 *  3. **Three sources counter-sign each other.** The JSON's
 *     `allowlistVersion`, `registrySnapshot` and row set are asserted against
 *     `REVIEWED_ALLOWLIST_VERSION`, `REVIEWED_REGISTRY_SNAPSHOT` and
 *     `REVIEWED_RANGE_TABLE`, in both directions and per row; and both are
 *     asserted against the values transcribed independently into
 *     `docs/meal-planning/catalog-policy.md`, which §0.3.2 names as the third
 *     place the snapshot date and the row counts are recorded. The document is
 *     read off disk and its attestation block parsed strictly — a missing
 *     document, an absent marker, an unknown key or an unparsable count fails
 *     loudly rather than skipping the cross-check — and every comparison prints
 *     all three values labelled by their file, so a red run says which source
 *     disagreed. Refreshing the registries is therefore three coordinated
 *     edits, any one of which alone turns this suite red.
 *
 * Everything in the module is pure, so nothing below is mocked: each predicate
 * takes its policy data as an argument, and the tests hand it real or
 * deliberately corrupted data.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
    EVIDENCE_ALLOWED_CONTENT_TYPES,
    EVIDENCE_ALLOWED_PORT,
    EVIDENCE_ALLOWED_SCHEME,
    EVIDENCE_FETCH_TIMEOUT_MS,
    EVIDENCE_HOST_PATTERN,
    EVIDENCE_MAX_BODY_BYTES,
    EVIDENCE_MAX_REDIRECTS,
    EVIDENCE_MAX_SNIPPET_CHARS,
    EVIDENCE_TYPES,
    EvidenceHostClass,
    EvidencePolicy,
    EvidenceType,
    GloballyReachable,
    ParsedIpAddress,
    REVIEWED_ALLOCATION_ROW_COUNT,
    REVIEWED_ALLOWLIST_VERSION,
    REVIEWED_GLOBAL_UNICAST_ALLOCATIONS,
    REVIEWED_RANGE_ROW_COUNT,
    REVIEWED_RANGE_TABLE,
    REVIEWED_REGISTRY_ROW_COUNT,
    REVIEWED_REGISTRY_SNAPSHOT,
    REVIEWED_SUPPLEMENTAL_CIDRS,
    REVIEWED_SUPPLEMENTAL_ROW_COUNT,
    SpecialPurposeRange,
    addressAfter,
    addressBefore,
    areAllAddressesRoutable,
    cidrContains,
    classifyAddressSet,
    classifyEvidenceHost,
    classifyIpAddress,
    evaluateEvidenceRedirect,
    evaluateEvidenceUrl,
    evidenceHostClassId,
    findEvidenceHostClassForHost,
    findMostSpecificRange,
    firstAddressOfCidr,
    formatIpAddress,
    hostClassAuthorizesEvidenceType,
    hostMatchesEntry,
    isAllowedContentType,
    isEvidenceType,
    isGloballyAllocatedUnicast,
    isGloballyRoutable,
    isHostAllowed,
    isIpLiteralHost,
    isValidEvidenceHostEntry,
    isWithinBodyCap,
    lastAddressOfCidr,
    matchEvidenceHostClass,
    normalizeEvidenceHost,
    parseCidr,
    parseEvidenceUrl,
    parseIpAddress,
    resolveEvidenceFetchLimits,
    unwrapEmbeddedIpv4,
    validateEvidencePolicy,
    validateEvidenceAllocationTable,
    validateEvidenceRangeTable,
} from '../evidence.logic';

// ---------------------------------------------------------------------------
// The committed policy document.
// ---------------------------------------------------------------------------

const POLICY_PATH = join(__dirname, '..', '..', '..', 'data', 'meal-planning', 'evidence-allowlist.v1.json');
const POLICY_JSON = readFileSync(POLICY_PATH, 'utf8');

/** A fresh deep copy per test, so a mutation case cannot leak into the next. */
const cloneDocument = (): Record<string, unknown> => JSON.parse(POLICY_JSON) as Record<string, unknown>;

const committedDocument: unknown = JSON.parse(POLICY_JSON) as unknown;

/**
 * The committed document, validated once. A failure here is reported as the
 * reason the whole suite cannot run, rather than as fifty confusing assertion
 * failures against a document nothing accepted.
 */
const committedPolicy: EvidencePolicy = (() => {
    const verdict = validateEvidencePolicy(committedDocument);
    if (!verdict.ok) {
        throw new Error(`the committed evidence policy document does not validate: ${verdict.detail}`);
    }
    return verdict.policy;
})();

const committedRows: readonly SpecialPurposeRange[] = committedPolicy.specialPurposeRanges;
const committedHostClasses: readonly EvidenceHostClass[] = committedPolicy.hostClasses;

// ---------------------------------------------------------------------------
// The reviewed policy record.
//
// `docs/meal-planning/catalog-policy.md` carries the snapshot date and the row
// counts transcribed by the reviewer, independently of both the JSON and this
// module. That is the third signature §0.3.2 asks for, and the reason it has to
// exist: the JSON and the module can be edited together in one commit, and two
// signatures that always move together are one signature.
//
// Everything below is read off disk and parsed strictly. A document that is
// missing, or whose block cannot be parsed, fails this suite rather than
// quietly reducing the cross-check to JSON ↔ module — which is the exact state
// this attestation existed to leave behind.
// ---------------------------------------------------------------------------

const POLICY_DOC_RELATIVE_PATH = 'docs/meal-planning/catalog-policy.md';
const POLICY_DOC_PATH = join(__dirname, '..', '..', '..', 'docs', 'meal-planning', 'catalog-policy.md');

const ATTESTATION_BEGIN = '<!-- BEGIN EVIDENCE ALLOWLIST ATTESTATION -->';
const ATTESTATION_END = '<!-- END EVIDENCE ALLOWLIST ATTESTATION -->';

/** One supplemental block as the record states it: the block, and why it is carried. */
interface RecordedSupplementalBlock {
    readonly cidr: string;
    readonly reason: string;
}

/** The attestation block of `catalog-policy.md`, parsed. */
interface RecordedAttestation {
    readonly allowlistVersion: string;
    readonly registrySnapshot: string;
    readonly totalRows: number;
    readonly registryRows: number;
    readonly supplementalRows: number;
    readonly supplementalBlocks: readonly RecordedSupplementalBlock[];
}

const recordError = (detail: string): Error =>
    new Error(
        `${POLICY_DOC_RELATIVE_PATH} ${detail}. It is the third signature of the evidence allowlist ` +
            'attestation (Agent Action Plan §0.3.2): without it, data/meal-planning/evidence-allowlist.v1.json ' +
            'and src/services/evidence.logic.ts counter-sign only each other, and a refresh of one can be ' +
            'matched by an edit to the other with this suite staying green.',
    );

/**
 * The record, read off disk. Takes its path so the absent-document failure is
 * exercised below against a path that really is absent, rather than asserted
 * about code nothing ever runs.
 */
const readPolicyRecord = (path: string = POLICY_DOC_PATH): string => {
    try {
        return readFileSync(path, 'utf8');
    } catch (error) {
        throw recordError(`could not be read (${(error as Error).message})`);
    }
};

/** The keys the block states exactly once. */
const RECORD_SINGLE_KEYS: readonly string[] = [
    'allowlist-version',
    'registry-snapshot',
    'reviewed-rows-total',
    'registry-derived-rows',
    'supplemental-rows',
];

const RECORD_BLOCK_KEY = 'supplemental-block';
const RECORD_LINE_PATTERN = /^([a-z][a-z-]*):[ \t]*(\S.*)$/;
const RECORD_COUNT_PATTERN = /^(0|[1-9]\d*)$/;
const RECORD_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const recordedCount = (key: string, value: string): number => {
    if (!RECORD_COUNT_PATTERN.test(value)) {
        throw recordError(`states "${key}: ${value}", which is not a plain non-negative integer`);
    }
    return Number(value);
};

/**
 * The attestation block, parsed the way the document says it is written:
 * delimited by the two HTML comment markers, blank and fence lines ignored,
 * every other line `key: value`, the five single-value keys exactly once, and
 * `supplemental-block` once per block as `<cidr> | <reason>`.
 *
 * Strict on purpose, and never lenient in the direction of "carry on with what
 * parsed": an unknown key or a missing one means the reviewer wrote something
 * this cross-check does not understand, and reading it permissively would
 * amount to attesting a value nobody signed.
 */
const parseRecordedAttestation = (markdown: string): RecordedAttestation => {
    const begin = markdown.indexOf(ATTESTATION_BEGIN);
    const end = markdown.indexOf(ATTESTATION_END);

    if (begin === -1 || end === -1) {
        throw recordError(`carries no ${begin === -1 ? 'BEGIN' : 'END'} EVIDENCE ALLOWLIST ATTESTATION marker`);
    }
    if (end < begin) {
        throw recordError('carries its END EVIDENCE ALLOWLIST ATTESTATION marker before its BEGIN marker');
    }
    if (markdown.indexOf(ATTESTATION_BEGIN, begin + 1) !== -1 || markdown.indexOf(ATTESTATION_END, end + 1) !== -1) {
        throw recordError('carries more than one attestation block, so which one is the attestation is ambiguous');
    }

    const single = new Map<string, string>();
    const supplementalBlocks: RecordedSupplementalBlock[] = [];

    for (const rawLine of markdown.slice(begin + ATTESTATION_BEGIN.length, end).split('\n')) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('```')) {
            continue;
        }

        const matched = RECORD_LINE_PATTERN.exec(line);
        if (matched === null) {
            throw recordError(`states the unreadable attestation line "${line}"`);
        }

        const [, key, value] = matched;

        if (key === RECORD_BLOCK_KEY) {
            const separator = value.indexOf('|');
            if (separator === -1) {
                throw recordError(`states the supplemental block "${value}" without the "|" that precedes its reason`);
            }
            const cidr = value.slice(0, separator).trim();
            const reason = value.slice(separator + 1).trim();
            if (cidr === '' || reason === '') {
                throw recordError(`states a supplemental block with an empty ${cidr === '' ? 'CIDR' : 'reason'}`);
            }
            supplementalBlocks.push({ cidr, reason });
            continue;
        }

        if (RECORD_SINGLE_KEYS.indexOf(key) === -1) {
            throw recordError(`states the unknown attestation key "${key}"`);
        }
        if (single.has(key)) {
            throw recordError(`states "${key}" more than once`);
        }
        single.set(key, value.trim());
    }

    for (const key of RECORD_SINGLE_KEYS) {
        if (!single.has(key)) {
            throw recordError(`does not state "${key}"`);
        }
    }

    const registrySnapshot = single.get('registry-snapshot') as string;
    if (!RECORD_DATE_PATTERN.test(registrySnapshot)) {
        throw recordError(`states the registry snapshot "${registrySnapshot}", which is not a YYYY-MM-DD date`);
    }

    return {
        allowlistVersion: single.get('allowlist-version') as string,
        registrySnapshot,
        totalRows: recordedCount('reviewed-rows-total', single.get('reviewed-rows-total') as string),
        registryRows: recordedCount('registry-derived-rows', single.get('registry-derived-rows') as string),
        supplementalRows: recordedCount('supplemental-rows', single.get('supplemental-rows') as string),
        supplementalBlocks,
    };
};

const recordedAttestation: RecordedAttestation = parseRecordedAttestation(readPolicyRecord());

/**
 * One attested value from all three sources, labelled by the file it came from,
 * so a mismatch prints which source disagreed instead of two anonymous values.
 */
const threeWay = <T>(record: T, json: T, code: T): Record<string, T> => ({
    [POLICY_DOC_RELATIVE_PATH]: record,
    'data/meal-planning/evidence-allowlist.v1.json': json,
    'src/services/evidence.logic.ts': code,
});

/** What agreement looks like: the same value from all three. */
const agreedOn = <T>(value: T): Record<string, T> => threeWay(value, value, value);

// ---------------------------------------------------------------------------
// The independent oracle.
//
// Deliberately a different derivation from the module's: addresses are compared
// as fixed-width binary strings and containment is a prefix string comparison,
// where the module masks bytes. Written from the registry semantics in §0.3.2,
// not from the module's source.
// ---------------------------------------------------------------------------

const IPV4_BIT_WIDTH = 32;
const IPV6_BIT_WIDTH = 128;

const binary = (value: number, width: number): string => {
    const bits = value.toString(2);
    if (bits.length > width) {
        throw new Error(`${value} does not fit in ${width} bits`);
    }
    return `${'0'.repeat(width - bits.length)}${bits}`;
};

const bitWidthFor = (version: 4 | 6): number => (version === 4 ? IPV4_BIT_WIDTH : IPV6_BIT_WIDTH);

const bitsOfBytes = (bytes: readonly number[]): string => bytes.map((byte) => binary(byte, 8)).join('');

const bitsOf = (address: ParsedIpAddress): string => bitsOfBytes(address.bytes);

/** An IPv6 group, or the dotted quad that may end an address (32 bits). */
const groupBits = (group: string): string => {
    if (group.indexOf('.') !== -1) {
        const octets = group.split('.');
        if (octets.length !== 4) {
            throw new Error(`"${group}" is not a dotted quad`);
        }
        return octets.map((octet) => binary(Number(octet), 8)).join('');
    }
    return binary(parseInt(group, 16), 16);
};

const sideBits = (side: string): string =>
    side === '' ? '' : side.split(':').map(groupBits).join('');

/**
 * An address text to its bits, parsed independently of the module: dotted quad,
 * full IPv6, `::`-compressed IPv6 and the `::ffff:a.b.c.d` tail. Throws on
 * anything else, because it is only ever handed the canonical registry text and
 * addresses this suite wrote itself.
 */
const independentAddressBits = (text: string): string => {
    if (text.indexOf(':') === -1) {
        const octets = text.split('.');
        if (octets.length !== 4) {
            throw new Error(`"${text}" is not a dotted quad`);
        }
        return octets.map((octet) => binary(Number(octet), 8)).join('');
    }

    const sides = text.split('::');
    if (sides.length === 1) {
        const bits = sideBits(text);
        if (bits.length !== IPV6_BIT_WIDTH) {
            throw new Error(`"${text}" is not a full IPv6 address`);
        }
        return bits;
    }
    if (sides.length !== 2) {
        throw new Error(`"${text}" carries more than one "::"`);
    }

    const head = sideBits(sides[0]);
    const tail = sideBits(sides[1]);
    const gap = IPV6_BIT_WIDTH - head.length - tail.length;
    if (gap <= 0) {
        throw new Error(`"${text}" leaves no room for its "::"`);
    }
    return `${head}${'0'.repeat(gap)}${tail}`;
};

interface OracleRow {
    readonly cidr: string;
    readonly version: 4 | 6;
    readonly prefixLength: number;
    readonly networkBits: string;
    readonly globallyReachable: GloballyReachable;
}

/** The committed rows, re-derived from their text by the parser above. */
const oracleRows: readonly OracleRow[] = committedRows.map((row) => {
    const slashIndex = row.cidr.indexOf('/');
    const text = row.cidr.slice(0, slashIndex);
    const version: 4 | 6 = text.indexOf(':') === -1 ? 4 : 6;
    return {
        cidr: row.cidr,
        version,
        prefixLength: Number(row.cidr.slice(slashIndex + 1)),
        networkBits: independentAddressBits(text),
        globallyReachable: row.globallyReachable,
    };
});

/**
 * The longest-prefix row covering an address. The committed table cannot
 * contain two rows of equal prefix covering one address — set equality plus the
 * duplicate-block refusal in `validateEvidenceRangeTable` forbids it — so the
 * module's equal-prefix tie-break is exercised separately, against a synthetic
 * table, rather than modelled here.
 */
const oracleMostSpecific = (address: ParsedIpAddress): OracleRow | null => {
    const bits = bitsOf(address);
    let best: OracleRow | null = null;

    for (const row of oracleRows) {
        if (row.version !== address.version) {
            continue;
        }
        if (bits.slice(0, row.prefixLength) !== row.networkBits.slice(0, row.prefixLength)) {
            continue;
        }
        if (best === null || row.prefixLength > best.prefixLength) {
            best = row;
        }
    }

    return best;
};

/** The non-unicast and special addresses §0.3.2 refuses outside the table. */
const oracleIsSpecialAddress = (address: ParsedIpAddress): boolean => {
    const bytes = address.bytes;
    if (address.version === 4) {
        const isMulticast = bytes[0] >= 224 && bytes[0] <= 239;
        const isBroadcast = bytes.every((byte) => byte === 255);
        return isMulticast || isBroadcast;
    }
    const isMulticast = bytes[0] === 255;
    const isUnspecified = bytes.every((byte) => byte === 0);
    const isLoopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
    return isMulticast || isUnspecified || isLoopback;
};

/**
 * Whether IANA has allocated the address's block to globally routable unicast —
 * the question the special-purpose registries do not answer.
 *
 * Derived here from the registry pages in binary-prefix form, deliberately
 * without reading the module's own block list or its CIDR parser, so that the
 * neighbour sweep below compares two independent derivations of the rule rather
 * than one implementation with itself.
 *
 * - IANA IPv6 Address Space (RFC 4291, formerly RFC 3513): `2000::/3` — the
 *   addresses whose top three bits are `001` — is the only block designated
 *   "Global Unicast". Everything else is "Reserved by IETF", unique-local
 *   (`fc00::/7`), link-scoped (`fe80::/10`) or multicast (`ff00::/8`).
 * - IANA IPv4 Address Space (RFC 5735, RFC 6890): unicast is everything below
 *   `224.0.0.0`. The two blocks above it, `224.0.0.0/4` multicast and
 *   `240.0.0.0/4` reserved, are together exactly the addresses whose top three
 *   bits are `111`.
 */
const oracleIsAllocatedUnicast = (address: ParsedIpAddress): boolean => {
    const prefix = bitsOf(address).slice(0, 3);
    return address.version === 4 ? prefix !== '111' : prefix === '001';
};

/**
 * Whether the committed policy should consider an address routable.
 *
 * The embedded-IPv4 extraction is taken from the module (`unwrapEmbeddedIpv4`),
 * which is pinned independently with named expected values below; the *verdict*
 * on the wrapper and on every carried address is this oracle's own.
 *
 * A row wins wherever one covers the address, including a row the registries
 * mark globally reachable — those are the reviewed exceptions, and `64:ff9b::/96`
 * is one of them despite lying outside `2000::/3`. The allocation decides only
 * the addresses no row covers.
 */
const oracleIsRoutable = (address: ParsedIpAddress): boolean => {
    if (oracleIsSpecialAddress(address)) {
        return false;
    }

    for (const carried of unwrapEmbeddedIpv4(address)) {
        if (oracleIsSpecialAddress(carried)) {
            return false;
        }
        const carriedRow = oracleMostSpecific(carried);
        if (carriedRow !== null) {
            if (carriedRow.globallyReachable !== true) {
                return false;
            }
        } else if (!oracleIsAllocatedUnicast(carried)) {
            return false;
        }
    }

    const row = oracleMostSpecific(address);
    return row !== null ? row.globallyReachable === true : oracleIsAllocatedUnicast(address);
};

const parseOrThrow = (text: string): ParsedIpAddress => {
    const address = parseIpAddress(text);
    if (address === null) {
        throw new Error(`the suite wrote the unparsable address "${text}"`);
    }
    return address;
};

const parseCidrOrThrow = (cidr: string) => {
    const parsed = parseCidr(cidr);
    if (parsed === null) {
        throw new Error(`the committed table carries the unparsable CIDR "${cidr}"`);
    }
    return parsed;
};

const rowsByReachability = (reachable: GloballyReachable): readonly SpecialPurposeRange[] =>
    committedRows.filter((row) => row.globallyReachable === reachable);

const nonGlobalRows: readonly SpecialPurposeRange[] = committedRows.filter((row) => row.globallyReachable !== true);
const globalRows: readonly SpecialPurposeRange[] = rowsByReachability(true);

const asCase = (rows: readonly SpecialPurposeRange[]): [string, SpecialPurposeRange][] =>
    rows.map((row) => [row.cidr, row]);

// ---------------------------------------------------------------------------
// The document ↔ code counter-signature.
// ---------------------------------------------------------------------------

describe('the committed evidence allowlist and the reviewed attestation', () => {
    it('declares the reviewed allowlist version', () => {
        expect(committedPolicy.allowlistVersion).toBe(REVIEWED_ALLOWLIST_VERSION);
        expect(committedPolicy.allowlistVersion).toBe('v1');
    });

    it('declares the reviewed registry snapshot date', () => {
        // The pair (snapshot, row set) is the reviewed data change §0.3.2
        // describes: refreshing the JSON without re-reviewing the module's
        // attestation must fail, and this is where it fails.
        expect(committedPolicy.registrySnapshot).toBe(REVIEWED_REGISTRY_SNAPSHOT);
        expect(committedPolicy.registrySnapshot).toBe('2026-09-08');
    });

    it('carries exactly the reviewed number of address rows, and says so in rowCount', () => {
        // 52 is the whole reviewed table — registry-derived rows plus the
        // supplemental hardening rows — and not a count of registry entries.
        // The two halves are asserted independently below.
        expect(committedRows.length).toBe(REVIEWED_RANGE_ROW_COUNT);
        expect(committedPolicy.rowCount).toBe(REVIEWED_RANGE_ROW_COUNT);
        expect(committedPolicy.rowCount).toBe(52);
    });

    it('states the registry-derived and supplemental counts separately, and they add up', () => {
        // The distinction is load-bearing for a refresh: the registry-derived
        // figure is what a reviewer diffs against the two IANA registry pages,
        // and it would be wrong by one if `::/96` — which the registries do not
        // list — were counted into it.
        expect(committedPolicy.registryRowCount).toBe(REVIEWED_REGISTRY_ROW_COUNT);
        expect(committedPolicy.registryRowCount).toBe(51);
        expect(committedPolicy.supplementalRowCount).toBe(REVIEWED_SUPPLEMENTAL_ROW_COUNT);
        expect(committedPolicy.supplementalRowCount).toBe(1);
        expect(committedPolicy.registryRowCount + committedPolicy.supplementalRowCount).toBe(
            committedPolicy.rowCount,
        );
    });

    it('names the supplemental blocks, and carries every one of them in the table', () => {
        // Exactly `::/96`: RFC 4291's deprecated IPv4-Compatible prefix, carried
        // because `unwrapEmbeddedIpv4` unwraps it and `::a9fe:a9fe` must not
        // outflank `169.254.0.0/16`.
        expect(committedPolicy.supplementalCidrs).toStrictEqual(['::/96']);
        expect(REVIEWED_SUPPLEMENTAL_CIDRS).toStrictEqual(['::/96']);

        for (const cidr of committedPolicy.supplementalCidrs) {
            expect(committedRows.map((row) => row.cidr)).toContain(cidr);
        }
    });

    it('counts the registry-derived rows as the table minus the supplemental ones', () => {
        // Derived from the document, not from a remembered number: whichever
        // rows the supplemental list names, the rest are registry-derived.
        const supplemental = committedRows.filter(
            (row) => committedPolicy.supplementalCidrs.indexOf(row.cidr) !== -1,
        );
        const registryDerived = committedRows.filter(
            (row) => committedPolicy.supplementalCidrs.indexOf(row.cidr) === -1,
        );

        expect(supplemental).toHaveLength(committedPolicy.supplementalRowCount);
        expect(registryDerived).toHaveLength(committedPolicy.registryRowCount);
        // 26 IPv4 registry rows and 25 IPv6 ones, every supplemental block
        // being IPv6 today.
        expect(registryDerived.filter((row) => row.registry === 'ipv4')).toHaveLength(26);
        expect(registryDerived.filter((row) => row.registry === 'ipv6')).toHaveLength(25);
    });

    it.each(asCase(committedRows))('states the reviewed reachability for %s', (_cidr, row) => {
        const reviewed = REVIEWED_RANGE_TABLE.filter((entry) => entry.cidr === row.cidr);

        expect(reviewed).toHaveLength(1);
        expect(row.globallyReachable).toBe(reviewed[0].globallyReachable);
    });

    it('attests every block the document carries, and no block it does not', () => {
        const documentBlocks = committedRows.map((row) => row.cidr).sort();
        const reviewedBlocks = REVIEWED_RANGE_TABLE.map((row) => row.cidr).sort();

        expect(documentBlocks).toStrictEqual(reviewedBlocks);
    });

    it('files every row under the registry its CIDR belongs to', () => {
        for (const row of committedRows) {
            const family = row.cidr.indexOf(':') === -1 ? 'ipv4' : 'ipv6';
            expect(row.registry).toBe(family);
        }
    });

    it.each(asCase(committedRows))('states a complete, three-valued row for %s', (cidr, row) => {
        // Asserted against the document on disk rather than the rows the
        // validator already normalized, because the mistyped refresh is the case
        // this catches: `"false"`, `0`, `null` and an absent name all parse as
        // JSON, and a fourth reachability value would be read by nothing.
        const raw = mutableRows().filter((entry) => entry.cidr === cidr)[0];

        expect(Object.keys(raw).sort()).toStrictEqual(['cidr', 'globallyReachable', 'name', 'registry']);

        for (const member of [raw.cidr, raw.name, raw.registry]) {
            expect(typeof member).toBe('string');
            expect((member as string).trim()).not.toBe('');
        }

        expect([true, false, 'n/a']).toContain(raw.globallyReachable);
        expect(raw.globallyReachable).toBe(row.globallyReachable);
    });

    it('splits the reviewed snapshot into the three registry reachability values', () => {
        // Read off the document rather than asserted as a remembered total: the
        // three counts must add up to the reviewed row count, and 'n/a' must
        // never have been collapsed into false on the way in.
        const counts = {
            global: globalRows.length,
            nonGlobal: rowsByReachability(false).length,
            notApplicable: rowsByReachability('n/a').length,
        };

        expect(counts.global + counts.nonGlobal + counts.notApplicable).toBe(REVIEWED_RANGE_ROW_COUNT);
        expect(counts.notApplicable).toBeGreaterThan(0);
        expect(nonGlobalRows.length).toBe(counts.nonGlobal + counts.notApplicable);
    });

    it('declares the transport policy at the reviewed ceilings', () => {
        expect(committedPolicy.fetchLimits).toStrictEqual({
            schemes: ['https'],
            allowedPorts: [443],
            maxRedirects: 2,
            timeoutMs: 10_000,
            maxBodyBytes: 1_048_576,
            allowedContentTypes: ['text/html', 'application/json', 'text/plain'],
            maxSnippetChars: 500,
        });
    });

    it('names every host class and authorizes only reviewed evidence types', () => {
        expect(committedHostClasses.map((hostClass) => hostClass.class)).toStrictEqual([
            'usda_fdc',
            'government_nutrition_reference',
            'university_nutrition_reference',
            'named_culinary_reference',
        ]);

        for (const hostClass of committedHostClasses) {
            expect(hostClass.evidenceTypes.length).toBeGreaterThan(0);
            for (const evidenceType of hostClass.evidenceTypes) {
                expect(EVIDENCE_TYPES).toContain(evidenceType);
            }
        }
    });

    it('consults no manufacturer or brand domain', () => {
        // AI generation proposes generic preparations only, never branded
        // products, so a model-proposed manufacturer domain could never
        // independently corroborate a model-proposed product. Every entry is
        // therefore a government, academic or named reference-work host. Each
        // suffix begins with a dot, so the label boundary is explicit and
        // `evilgov.com` cannot satisfy `.gov`.
        const GOVERNMENT_OR_ACADEMIC_SUFFIXES = [
            '.gov',
            '.edu',
            '.gov.uk',
            '.gov.au',
            '.canada.ca',
            '.europa.eu',
            '.fao.org',
        ];
        const REVIEWED_REFERENCE_WORKS = ['www.oxfordreference.com', 'www.britannica.com', 'www.larousse.fr'];

        for (const hostClass of committedHostClasses) {
            for (const entry of hostClass.hosts) {
                const host = entry.slice(0, 2) === '*.' ? entry.slice(2) : entry;
                const isReferenceWork = REVIEWED_REFERENCE_WORKS.indexOf(host) !== -1;
                const isGovernmentOrAcademic = GOVERNMENT_OR_ACADEMIC_SUFFIXES.some((suffix) =>
                    host.endsWith(suffix),
                );

                expect(isGovernmentOrAcademic || isReferenceWork).toBe(true);
                if (isReferenceWork) {
                    expect(hostClass.class).toBe('named_culinary_reference');
                }
            }
        }
    });

    it('trusts no commercial reference work with nutrition or allergen claims', () => {
        // The one class carrying commercial (`.com`/`.fr`) hosts may say what a
        // dish is and how it is prepared, and must never stand in as an
        // authority on its nutrients or on which of the nine allergens it
        // contains — that is the whole reason authorization is per evidence type.
        const culinary = committedHostClasses.filter(
            (hostClass) => hostClass.class === 'named_culinary_reference',
        )[0];

        expect(culinary.evidenceTypes).not.toContain('nutrition_reference');
        expect(culinary.evidenceTypes).not.toContain('allergen_composition');
        expect(culinary.evidenceTypes).toContain('canonical_identity');
    });
});

// ---------------------------------------------------------------------------
// The three-way counter-signature: record ↔ document ↔ module.
// ---------------------------------------------------------------------------

describe('the reviewed policy record, the committed document and this module', () => {
    it('agree on the allowlist version', () => {
        expect(
            threeWay(recordedAttestation.allowlistVersion, committedPolicy.allowlistVersion, REVIEWED_ALLOWLIST_VERSION),
        ).toStrictEqual(agreedOn('v1'));
    });

    it('agree on the registry snapshot date', () => {
        // §0.3.2: "a registry refresh is a reviewed data change, not a code
        // edit". Three transcriptions of one date is what makes that true —
        // refreshing the JSON and the module together still fails here until
        // the reviewer has recorded the new date.
        expect(
            threeWay(
                recordedAttestation.registrySnapshot,
                committedPolicy.registrySnapshot,
                REVIEWED_REGISTRY_SNAPSHOT,
            ),
        ).toStrictEqual(agreedOn('2026-09-08'));
    });

    it('agree on the total number of reviewed address rows', () => {
        expect(
            threeWay(recordedAttestation.totalRows, committedPolicy.rowCount, REVIEWED_RANGE_ROW_COUNT),
        ).toStrictEqual(agreedOn(52));
        expect(committedRows.length).toBe(recordedAttestation.totalRows);
    });

    it('agree on how many of those rows are registry-derived', () => {
        expect(
            threeWay(recordedAttestation.registryRows, committedPolicy.registryRowCount, REVIEWED_REGISTRY_ROW_COUNT),
        ).toStrictEqual(agreedOn(51));
    });

    it('agree on how many are supplemental', () => {
        expect(
            threeWay(
                recordedAttestation.supplementalRows,
                committedPolicy.supplementalRowCount,
                REVIEWED_SUPPLEMENTAL_ROW_COUNT,
            ),
        ).toStrictEqual(agreedOn(1));
    });

    it('agree on which blocks are supplemental', () => {
        const recorded = recordedAttestation.supplementalBlocks.map((block) => block.cidr).sort();

        expect(
            threeWay(
                recorded,
                committedPolicy.supplementalCidrs.slice().sort(),
                REVIEWED_SUPPLEMENTAL_CIDRS.slice().sort(),
            ),
        ).toStrictEqual(agreedOn(['::/96']));
    });

    it('records the counts consistently within the document itself', () => {
        // The record is a transcription, so it is also checked against itself:
        // a reviewer who updated one count and not the other is caught here
        // rather than by arithmetic somebody has to do by hand.
        expect(recordedAttestation.registryRows + recordedAttestation.supplementalRows).toBe(
            recordedAttestation.totalRows,
        );
        expect(recordedAttestation.supplementalBlocks).toHaveLength(recordedAttestation.supplementalRows);
    });

    it('gives a reason for every supplemental block it records', () => {
        // A block carried without a recorded reason is a hardening rule nobody
        // reviewed, which is the state the supplemental set exists to prevent.
        for (const block of recordedAttestation.supplementalBlocks) {
            expect(block.reason.length).toBeGreaterThan(20);
            expect(committedPolicy.supplementalCidrs).toContain(block.cidr);
        }

        expect(recordedAttestation.supplementalBlocks[0].reason).toContain('169.254.0.0/16');
    });
});

describe('the parser that reads that record', () => {
    /** The committed record with its attestation block replaced. */
    const documentWithBlock = (body: string): string =>
        `# heading\n\n${ATTESTATION_BEGIN}\n${body}\n${ATTESTATION_END}\n\nprose after the block\n`;

    const wellFormedBody = [
        '```text',
        'allowlist-version: v1',
        'registry-snapshot: 2026-09-08',
        'reviewed-rows-total: 52',
        'registry-derived-rows: 51',
        'supplemental-rows: 1',
        'supplemental-block: ::/96 | carried so an embedded form cannot outflank 169.254.0.0/16',
        '```',
    ].join('\n');

    const bodyWithout = (key: string): string =>
        wellFormedBody
            .split('\n')
            .filter((line) => !line.startsWith(`${key}:`))
            .join('\n');

    const recordDetail = (markdown: string): string => {
        try {
            parseRecordedAttestation(markdown);
        } catch (error) {
            return (error as Error).message;
        }
        throw new Error('expected the attestation block to be refused, but it parsed');
    };

    it('reads a well-formed block, ignoring blank and fence lines', () => {
        const parsed = parseRecordedAttestation(documentWithBlock(`\n${wellFormedBody}\n\n`));

        expect(parsed).toStrictEqual({
            allowlistVersion: 'v1',
            registrySnapshot: '2026-09-08',
            totalRows: 52,
            registryRows: 51,
            supplementalRows: 1,
            supplementalBlocks: [
                {
                    cidr: '::/96',
                    reason: 'carried so an embedded form cannot outflank 169.254.0.0/16',
                },
            ],
        });
    });

    it('reads nothing outside the markers', () => {
        // Prose elsewhere in the document — including a sentence that mentions
        // a row count — is not the attestation.
        const parsed = parseRecordedAttestation(
            `reviewed-rows-total: 9\n${documentWithBlock(wellFormedBody)}\nsupplemental-rows: 9\n`,
        );

        expect(parsed.totalRows).toBe(52);
        expect(parsed.supplementalRows).toBe(1);
    });

    it.each([
        ['no markers at all', '# heading\n\nno attestation here\n', 'carries no BEGIN'],
        [
            'no END marker',
            `# heading\n\n${ATTESTATION_BEGIN}\n${wellFormedBody}\n`,
            'carries no END EVIDENCE ALLOWLIST ATTESTATION marker',
        ],
        [
            'its markers the wrong way round',
            `${ATTESTATION_END}\n${wellFormedBody}\n${ATTESTATION_BEGIN}\n`,
            'carries its END EVIDENCE ALLOWLIST ATTESTATION marker before its BEGIN marker',
        ],
        [
            'two blocks',
            `${documentWithBlock(wellFormedBody)}\n${documentWithBlock(wellFormedBody)}`,
            'carries more than one attestation block',
        ],
    ])('refuses a record with %s', (_case, markdown, detail) => {
        expect(recordDetail(markdown)).toContain(detail);
    });

    it.each(RECORD_SINGLE_KEYS)('refuses a record that does not state %s', (key) => {
        expect(recordDetail(documentWithBlock(bodyWithout(key)))).toContain(`does not state "${key}"`);
    });

    it('refuses a record that states one key twice', () => {
        expect(recordDetail(documentWithBlock(`${wellFormedBody}\nsupplemental-rows: 2`))).toContain(
            'states "supplemental-rows" more than once',
        );
    });

    it('refuses a record that states a key nothing here understands', () => {
        expect(recordDetail(documentWithBlock(`${wellFormedBody}\nregistry-derived-row: 51`))).toContain(
            'states the unknown attestation key "registry-derived-row"',
        );
    });

    it('refuses a line that is not a labelled value', () => {
        expect(recordDetail(documentWithBlock(`${wellFormedBody}\nfifty two rows were reviewed`))).toContain(
            'states the unreadable attestation line "fifty two rows were reviewed"',
        );
    });

    it.each(['fifty two', '52 rows', '+52', '52.0', '052', '-52', ''])(
        'refuses the count "%s"',
        (value) => {
            const body = `${bodyWithout('reviewed-rows-total')}\nreviewed-rows-total: ${value}`;

            // An empty value is not a labelled value at all, so it is refused a
            // line earlier — by the shape of the line rather than by the shape
            // of the number. Both refuse.
            expect(recordDetail(documentWithBlock(body))).toContain(
                value === '' ? 'states the unreadable attestation line' : 'which is not a plain non-negative integer',
            );
        },
    );

    it.each(['yesterday', '2026-9-8', '2026-09-08T00:00:00Z'])('refuses the snapshot date "%s"', (date) => {
        const body = `${bodyWithout('registry-snapshot')}\nregistry-snapshot: ${date}`;

        expect(recordDetail(documentWithBlock(body))).toContain(
            `states the registry snapshot "${date}", which is not a YYYY-MM-DD date`,
        );
    });

    it('refuses a supplemental block recorded without its reason', () => {
        const body = `${bodyWithout('supplemental-block')}\nsupplemental-block: ::/96`;

        expect(recordDetail(documentWithBlock(body))).toContain('without the "|" that precedes its reason');
    });

    it.each([
        ['an empty reason', 'supplemental-block: ::/96 |', 'an empty reason'],
        ['an empty CIDR', 'supplemental-block: | carried for hardening', 'an empty CIDR'],
    ])('refuses a supplemental block with %s', (_case, line, detail) => {
        expect(recordDetail(documentWithBlock(`${bodyWithout('supplemental-block')}\n${line}`))).toContain(detail);
    });

    it('refuses to fall back to a JSON-to-module cross-check when the record is absent', () => {
        // The state this attestation was added to leave behind: with no record
        // on disk the suite fails loudly instead of silently checking two of
        // the three sources.
        let detail = 'the absent record was read without complaint';
        try {
            readPolicyRecord(join(__dirname, 'catalog-policy.md.absent'));
        } catch (error) {
            detail = (error as Error).message;
        }

        expect(detail).toContain('could not be read');
        expect(detail).toContain('ENOENT');
        expect(detail).toContain('third signature');
    });

    it('reads the record that is actually committed', () => {
        expect(readPolicyRecord()).toContain(ATTESTATION_BEGIN);
    });

    it('says what the document is for in every refusal', () => {
        // The failure has to be legible to whoever refreshed the registries, so
        // it names the file, what went wrong, and why the file exists.
        const detail = recordDetail('# heading\n');

        expect(detail).toContain('docs/meal-planning/catalog-policy.md');
        expect(detail).toContain('third signature');
        expect(detail).toContain('data/meal-planning/evidence-allowlist.v1.json');
        expect(detail).toContain('src/services/evidence.logic.ts');
    });
});

// ---------------------------------------------------------------------------
// The registry-derived loop (§0.3.2).
// ---------------------------------------------------------------------------

describe('every row of the committed special-purpose table', () => {
    it.each(asCase(committedRows))('parses %s to the block an independent parser reads', (_cidr, row) => {
        const cidr = parseCidrOrThrow(row.cidr);
        const oracle = oracleRows.filter((entry) => entry.cidr === row.cidr)[0];

        expect(cidr.version).toBe(oracle.version);
        expect(cidr.prefixLength).toBe(oracle.prefixLength);
        // The written text is already the network address, so the parsed base
        // must equal it bit for bit — a masking bug would show up here before it
        // could shift a classification.
        expect(bitsOf(firstAddressOfCidr(cidr))).toBe(oracle.networkBits);
        expect(bitsOf(lastAddressOfCidr(cidr))).toBe(
            `${oracle.networkBits.slice(0, oracle.prefixLength)}${'1'.repeat(
                bitWidthFor(oracle.version) - oracle.prefixLength,
            )}`,
        );
        expect(cidrContains(cidr, firstAddressOfCidr(cidr))).toBe(true);
        expect(cidrContains(cidr, lastAddressOfCidr(cidr))).toBe(true);
    });
});

describe('a row the registries do not mark globally reachable', () => {
    it('is the majority of the committed table, so this loop is not vacuous', () => {
        expect(nonGlobalRows.length).toBeGreaterThan(30);
    });

    it.each(asCase(nonGlobalRows))('refuses the first and last address of %s', (_cidr, row) => {
        const cidr = parseCidrOrThrow(row.cidr);
        const first = firstAddressOfCidr(cidr);
        const last = lastAddressOfCidr(cidr);

        // The invariant §0.3.2 names, stated without an expected value: a block
        // the registries do not call globally reachable has no routable edge.
        expect(isGloballyRoutable(first, committedRows)).toBe(false);
        expect(isGloballyRoutable(last, committedRows)).toBe(false);

        const verdict = classifyIpAddress(first, committedRows);
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            // Never refused because the table could not be read: that would mean
            // the loop was proving something about its own fixture.
            expect(verdict.reason).not.toBe('range_table_unclassifiable');
            expect([
                'address_not_unicast',
                'address_not_globally_routable',
                'embedded_address_not_globally_routable',
            ]).toContain(verdict.reason);
        }
    });

    it.each(asCase(nonGlobalRows))('judges the addresses either side of %s on their own rows', (_cidr, row) => {
        const cidr = parseCidrOrThrow(row.cidr);
        const below = addressBefore(firstAddressOfCidr(cidr));
        const above = addressAfter(lastAddressOfCidr(cidr));

        for (const neighbour of [below, above]) {
            if (neighbour === null) {
                // The bottom of `0.0.0.0/8` and the top of `240.0.0.0/4` have no
                // neighbour to judge; `null` is the module saying so.
                continue;
            }

            // Genuinely outside the block, which is what makes the next
            // assertion about "the addresses immediately below and above".
            expect(cidrContains(cidr, neighbour)).toBe(false);

            // Accepted unless another non-global row (or a non-unicast rule, or
            // an address it carries) refuses it — the expectation comes from the
            // independent oracle, so this passes only when both derivations agree.
            expect(isGloballyRoutable(neighbour, committedRows)).toBe(oracleIsRoutable(neighbour));
        }
    });

    it('has neighbours of both kinds across the table, so the oracle is exercised both ways', () => {
        let accepted = 0;
        let refused = 0;

        for (const row of nonGlobalRows) {
            const cidr = parseCidrOrThrow(row.cidr);
            for (const neighbour of [addressBefore(firstAddressOfCidr(cidr)), addressAfter(lastAddressOfCidr(cidr))]) {
                if (neighbour === null) {
                    continue;
                }
                if (isGloballyRoutable(neighbour, committedRows)) {
                    accepted += 1;
                } else {
                    refused += 1;
                }
            }
        }

        // Both branches must occur: an all-accepted sweep would pass against a
        // classifier that never refuses, and an all-refused one against a
        // classifier that never accepts.
        expect(accepted).toBeGreaterThan(0);
        expect(refused).toBeGreaterThan(0);
    });
});

describe('a row the registries do mark globally reachable', () => {
    it.each(asCase(globalRows))('is not excluded by the non-global row enclosing %s', (_cidr, row) => {
        const cidr = parseCidrOrThrow(row.cidr);
        const first = firstAddressOfCidr(cidr);
        const last = lastAddressOfCidr(cidr);

        expect(isGloballyRoutable(first, committedRows)).toBe(oracleIsRoutable(first));
        expect(isGloballyRoutable(last, committedRows)).toBe(oracleIsRoutable(last));

        // The row itself is what longest-prefix matching must select for its own
        // addresses; an enclosing non-global row must not win.
        expect(findMostSpecificRange(first, committedRows)).toStrictEqual(row);
        expect(findMostSpecificRange(last, committedRows)).toStrictEqual(row);
    });

    it.each([
        ['192.0.0.9', 'Port Control Protocol Anycast inside 192.0.0.0/24'],
        ['192.0.0.10', 'TURN anycast inside 192.0.0.0/24'],
        ['192.31.196.1', 'AS112-v4'],
        ['192.52.193.1', 'AMT'],
        ['192.175.48.1', 'Direct Delegation AS112'],
        ['2001:1::1', 'PCP anycast inside 2001::/23'],
        ['2001:1::2', 'TURN anycast inside 2001::/23'],
        ['2001:1::3', 'DNS-SD anycast inside 2001::/23'],
        ['2001:3::1', 'AMT inside 2001::/23'],
        ['2001:4:112::1', 'AS112-v6 inside 2001::/23'],
        ['2001:20::1', 'ORCHIDv2 inside 2001::/23'],
        ['2001:30::1', 'DET prefix inside 2001::/23'],
        ['2620:4f:8000::1', 'Direct Delegation AS112 v6'],
    ])('accepts %s (%s)', (address) => {
        expect(isGloballyRoutable(address, committedRows)).toBe(true);
    });

    it('accepts an address that matches no row at all', () => {
        // "Matches no row" is a positive answer, not a skipped check: the
        // registries enumerate the special-purpose blocks exhaustively.
        expect(findMostSpecificRange(parseOrThrow('93.184.216.34'), committedRows)).toBeNull();
        expect(isGloballyRoutable('93.184.216.34', committedRows)).toBe(true);
        expect(isGloballyRoutable('2606:2800:220:1:248:1893:25c8:1946', committedRows)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Address parsing and CIDR arithmetic.
// ---------------------------------------------------------------------------

describe('parseIpAddress', () => {
    it.each([
        ['0.0.0.0', [0, 0, 0, 0]],
        ['10.0.0.1', [10, 0, 0, 1]],
        ['127.0.0.1', [127, 0, 0, 1]],
        ['169.254.169.254', [169, 254, 169, 254]],
        ['255.255.255.255', [255, 255, 255, 255]],
    ])('reads the dotted quad %s', (text, bytes) => {
        expect(parseIpAddress(text)).toStrictEqual({ version: 4, bytes });
    });

    it.each([
        ['a leading-zero octet', '010.0.0.1'],
        ['a zero-padded final octet', '10.0.0.01'],
        ['three octets', '1.2.3'],
        ['five octets', '1.2.3.4.5'],
        ['an octet above 255', '256.0.0.1'],
        ['a four-digit octet', '1.2.3.4444'],
        ['a negative octet', '1.2.3.-1'],
        ['a hexadecimal literal', '0x7f000001'],
        ['a decimal integer', '2130706433'],
        ['a letter in an octet', '1.2.3.a'],
        ['a trailing space', '1.2.3.4 '],
        ['a leading space', ' 1.2.3.4'],
        ['an empty octet', '1.2..4'],
        ['a zone identifier', '1.2.3.4%eth0'],
        ['an empty string', ''],
    ])('refuses %s', (_case, text) => {
        // Nothing is trimmed or reinterpreted: `010` is 8 to one runtime and 10
        // to another, and a validator disagreeing with the connector about which
        // address a string names is the bypass this refusal closes.
        expect(parseIpAddress(text)).toBeNull();
    });

    it('refuses a non-string', () => {
        expect(parseIpAddress(null as unknown as string)).toBeNull();
        expect(parseIpAddress(undefined as unknown as string)).toBeNull();
        expect(parseIpAddress(42 as unknown as string)).toBeNull();
    });

    it.each([
        ['::', '0:0:0:0:0:0:0:0'],
        ['::1', '0:0:0:0:0:0:0:1'],
        ['2001:db8::1', '2001:db8:0:0:0:0:0:1'],
        ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8:0:0:0:0:0:1'],
        ['FE80::1', 'fe80:0:0:0:0:0:0:1'],
        ['fe80:0:0:0:0:0:0:0', 'fe80:0:0:0:0:0:0:0'],
        ['::ffff:10.0.0.1', '0:0:0:0:0:ffff:a00:1'],
        ['64:ff9b::7f00:1', '64:ff9b:0:0:0:0:7f00:1'],
        ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
    ])('reads the IPv6 form %s as %s', (text, formatted) => {
        const address = parseOrThrow(text);

        expect(address.version).toBe(6);
        expect(address.bytes).toHaveLength(16);
        expect(formatIpAddress(address)).toBe(formatted);
    });

    it('reads ::ffff:10.0.0.1 as the sixteen bytes of an IPv4-mapped address', () => {
        expect(parseIpAddress('::ffff:10.0.0.1')).toStrictEqual({
            version: 6,
            bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 10, 0, 0, 1],
        });
    });

    it.each([
        ['a zone identifier', 'fe80::1%eth0'],
        ['two "::" runs', '::1::2'],
        ['a triple colon', '2001:db8:::1'],
        ['a five-digit group', '12345::'],
        ['too few groups without a gap', '2001:db8'],
        ['nine groups', '1:2:3:4:5:6:7:8:9'],
        ['eight groups around a gap', '1:2:3:4::5:6:7:8'],
        ['a non-hex digit', '2001:db8::g'],
        ['a dotted quad that is not last', '::1.2.3.4:5'],
        ['a dotted quad with five octets', '::ffff:1.2.3.4.5'],
        ['a dotted quad before a gap', '1.2.3.4::'],
        ['a bare colon', ':'],
        ['a trailing single colon', '2001:db8:'],
        ['URL brackets around a loopback', '[::1]'],
        ['URL brackets around a public address', '[2606:2800:220:1::]'],
        ['a half-open bracket', '[::1'],
    ])('refuses the IPv6 form with %s', (_case, text) => {
        expect(parseIpAddress(text)).toBeNull();
    });

    it('round-trips every form it accepts through formatIpAddress', () => {
        for (const text of ['10.0.0.1', '::1', '2001:db8::1', '::ffff:10.0.0.1', 'fe80::1', '64:ff9b::7f00:1']) {
            const once = parseOrThrow(text);
            const twice = parseOrThrow(formatIpAddress(once));

            expect(twice).toStrictEqual(once);
        }
    });
});

describe('formatIpAddress', () => {
    it('joins an IPv4 address with dots', () => {
        expect(formatIpAddress({ version: 4, bytes: [192, 0, 2, 1] })).toBe('192.0.2.1');
    });

    it('emits all eight IPv6 groups with per-group leading zeros dropped', () => {
        // Deliberately not RFC 5952 compressed: nothing in the module compares
        // addresses as strings, and an uncompressed form is unambiguous in a log.
        expect(formatIpAddress(parseOrThrow('2001:0db8:0000:0000:0000:0000:0000:0001'))).toBe('2001:db8:0:0:0:0:0:1');
        expect(formatIpAddress(parseOrThrow('::'))).toBe('0:0:0:0:0:0:0:0');
    });
});

describe('parseCidr', () => {
    it.each([
        ['10.0.0.0/8', 4, [10, 0, 0, 0], 8],
        ['0.0.0.0/0', 4, [0, 0, 0, 0], 0],
        ['192.0.0.9/32', 4, [192, 0, 0, 9], 32],
        ['198.18.0.0/15', 4, [198, 18, 0, 0], 15],
    ])('parses %s', (cidr, version, bytes, prefixLength) => {
        expect(parseCidr(cidr)).toStrictEqual({ version, bytes, prefixLength });
    });

    it('masks host bits off the declared network address', () => {
        // A row written with host bits still classifies as its block, which is
        // why `checkRangeRow` has to refuse the sloppy text separately.
        expect(parseCidr('10.1.2.3/8')).toStrictEqual({ version: 4, bytes: [10, 0, 0, 0], prefixLength: 8 });
        expect(parseCidr('192.168.5.7/16')).toStrictEqual({ version: 4, bytes: [192, 168, 0, 0], prefixLength: 16 });
    });

    it('parses an IPv6 block and masks it to its prefix', () => {
        const parsed = parseCidr('2001:db8:1234::/32');

        expect(parsed).not.toBeNull();
        expect(parsed?.version).toBe(6);
        expect(parsed?.prefixLength).toBe(32);
        expect(formatIpAddress({ version: 6, bytes: parsed?.bytes ?? [] })).toBe('2001:db8:0:0:0:0:0:0');
    });

    it.each([
        ['no prefix at all', '10.0.0.0'],
        ['two slashes', '10.0.0.0/8/16'],
        ['a zero-padded prefix', '10.0.0.0/008'],
        ['an IPv4 prefix above 32', '10.0.0.0/33'],
        ['an IPv6 prefix above 128', '::/129'],
        ['a four-digit prefix', '10.0.0.0/1234'],
        ['a non-numeric prefix', '10.0.0.0/abc'],
        ['an empty prefix', '10.0.0.0/'],
        ['a negative prefix', '10.0.0.0/-8'],
        ['an unparsable address', 'not-an-ip/8'],
        ['an empty string', ''],
    ])('refuses a CIDR with %s', (_case, cidr) => {
        expect(parseCidr(cidr)).toBeNull();
    });

    it('refuses a non-string', () => {
        expect(parseCidr(null as unknown as string)).toBeNull();
        expect(parseCidr(24 as unknown as string)).toBeNull();
    });

    it('accepts the whole-family prefixes /0 and ::/0', () => {
        expect(parseCidr('0.0.0.0/0')?.prefixLength).toBe(0);
        expect(parseCidr('::/0')?.prefixLength).toBe(0);
    });
});

describe('cidrContains', () => {
    const ipv4Block = parseCidrOrThrow('10.0.0.0/8');
    const ipv6Block = parseCidrOrThrow('2001:db8::/32');

    it('contains the first and last address of the block and nothing either side', () => {
        expect(cidrContains(ipv4Block, parseOrThrow('10.0.0.0'))).toBe(true);
        expect(cidrContains(ipv4Block, parseOrThrow('10.255.255.255'))).toBe(true);
        expect(cidrContains(ipv4Block, parseOrThrow('9.255.255.255'))).toBe(false);
        expect(cidrContains(ipv4Block, parseOrThrow('11.0.0.0'))).toBe(false);
    });

    it('never matches across address families', () => {
        expect(cidrContains(ipv4Block, parseOrThrow('::1'))).toBe(false);
        expect(cidrContains(ipv6Block, parseOrThrow('10.0.0.1'))).toBe(false);
    });

    it('matches every same-family address at prefix 0 and only one at the full prefix', () => {
        const everything = parseCidrOrThrow('0.0.0.0/0');
        const single = parseCidrOrThrow('192.0.0.9/32');

        expect(cidrContains(everything, parseOrThrow('203.0.113.7'))).toBe(true);
        expect(cidrContains(single, parseOrThrow('192.0.0.9'))).toBe(true);
        expect(cidrContains(single, parseOrThrow('192.0.0.10'))).toBe(false);
    });

    it('respects a prefix that ends mid-byte', () => {
        const block = parseCidrOrThrow('198.18.0.0/15');

        expect(cidrContains(block, parseOrThrow('198.19.255.255'))).toBe(true);
        expect(cidrContains(block, parseOrThrow('198.20.0.0'))).toBe(false);
    });
});

describe('firstAddressOfCidr and lastAddressOfCidr', () => {
    it.each([
        ['10.0.0.0/8', '10.0.0.0', '10.255.255.255'],
        ['192.0.0.9/32', '192.0.0.9', '192.0.0.9'],
        ['0.0.0.0/0', '0.0.0.0', '255.255.255.255'],
        ['198.18.0.0/15', '198.18.0.0', '198.19.255.255'],
    ])('spans %s from %s to %s', (cidr, first, last) => {
        const parsed = parseCidrOrThrow(cidr);

        expect(formatIpAddress(firstAddressOfCidr(parsed))).toBe(first);
        expect(formatIpAddress(lastAddressOfCidr(parsed))).toBe(last);
    });

    it('spans an IPv6 block to its all-ones host part', () => {
        const parsed = parseCidrOrThrow('2001:db8::/32');

        expect(formatIpAddress(firstAddressOfCidr(parsed))).toBe('2001:db8:0:0:0:0:0:0');
        expect(formatIpAddress(lastAddressOfCidr(parsed))).toBe('2001:db8:ffff:ffff:ffff:ffff:ffff:ffff');
    });
});

describe('addressAfter and addressBefore', () => {
    it('carries across an octet boundary in both directions', () => {
        expect(formatIpAddress(addressAfter(parseOrThrow('10.0.0.255')) as ParsedIpAddress)).toBe('10.0.1.0');
        expect(formatIpAddress(addressBefore(parseOrThrow('10.0.1.0')) as ParsedIpAddress)).toBe('10.0.0.255');
        expect(formatIpAddress(addressAfter(parseOrThrow('10.255.255.255')) as ParsedIpAddress)).toBe('11.0.0.0');
    });

    it('answers null at the top and bottom of each family', () => {
        expect(addressAfter(parseOrThrow('255.255.255.255'))).toBeNull();
        expect(addressBefore(parseOrThrow('0.0.0.0'))).toBeNull();
        expect(addressBefore(parseOrThrow('::'))).toBeNull();
        expect(addressAfter(parseOrThrow('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'))).toBeNull();
    });

    it('carries across an IPv6 group boundary', () => {
        expect(formatIpAddress(addressAfter(parseOrThrow('::ffff')) as ParsedIpAddress)).toBe('0:0:0:0:0:0:1:0');
        expect(formatIpAddress(addressBefore(parseOrThrow('::1:0')) as ParsedIpAddress)).toBe('0:0:0:0:0:0:0:ffff');
    });

    it('leaves the address it was given untouched', () => {
        const address = parseOrThrow('10.0.0.255');

        addressAfter(address);
        addressBefore(address);

        expect(address.bytes).toStrictEqual([10, 0, 0, 255]);
    });
});

describe('findMostSpecificRange', () => {
    it('prefers the longest prefix over the first or any match', () => {
        // 2001::/23 is not globally reachable while 2001:3::/32 inside it is.
        // Taking any match would misclassify addresses in both directions.
        expect(findMostSpecificRange(parseOrThrow('2001:3::1'), committedRows)?.cidr).toBe('2001:3::/32');
        expect(findMostSpecificRange(parseOrThrow('2001:2::1'), committedRows)?.cidr).toBe('2001:2::/48');
        expect(findMostSpecificRange(parseOrThrow('2001:9::1'), committedRows)?.cidr).toBe('2001::/23');
        expect(findMostSpecificRange(parseOrThrow('192.0.0.9'), committedRows)?.cidr).toBe('192.0.0.9/32');
        expect(findMostSpecificRange(parseOrThrow('192.0.0.5'), committedRows)?.cidr).toBe('192.0.0.0/29');
        expect(findMostSpecificRange(parseOrThrow('192.0.0.100'), committedRows)?.cidr).toBe('192.0.0.0/24');
    });

    it('answers null when no row covers the address', () => {
        expect(findMostSpecificRange(parseOrThrow('93.184.216.34'), committedRows)).toBeNull();
        expect(findMostSpecificRange(parseOrThrow('2606:2800:220:1:248:1893:25c8:1946'), committedRows)).toBeNull();
    });

    it('resolves two rows of equal prefix in favour of the more restrictive one', () => {
        // Whichever order the rows are written in, the verdict must be the same
        // — a security answer that depends on row order is not reviewable.
        const globalFirst: SpecialPurposeRange[] = [
            { cidr: '10.0.0.0/8', name: 'permissive duplicate', registry: 'ipv4', globallyReachable: true },
            { cidr: '10.0.0.0/8', name: 'restrictive duplicate', registry: 'ipv4', globallyReachable: false },
        ];
        const restrictiveFirst = [globalFirst[1], globalFirst[0]];

        expect(findMostSpecificRange(parseOrThrow('10.1.2.3'), globalFirst)?.globallyReachable).toBe(false);
        expect(findMostSpecificRange(parseOrThrow('10.1.2.3'), restrictiveFirst)?.globallyReachable).toBe(false);
    });

    it('skips a row that is not an object or whose CIDR does not parse', () => {
        const ranges = [
            null,
            'not-a-row',
            42,
            { cidr: '10.0.0.0/999', name: 'unparsable', registry: 'ipv4', globallyReachable: false },
            { cidr: '10.0.0.0/8', name: 'Private-Use', registry: 'ipv4', globallyReachable: false },
        ] as unknown as SpecialPurposeRange[];

        expect(findMostSpecificRange(parseOrThrow('10.1.2.3'), ranges)?.name).toBe('Private-Use');
    });

    it('answers null for a range argument that is not a list at all', () => {
        expect(findMostSpecificRange(parseOrThrow('10.1.2.3'), null as unknown as SpecialPurposeRange[])).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Embedded and translated IPv6 forms.
// ---------------------------------------------------------------------------

describe('unwrapEmbeddedIpv4', () => {
    const carried = (text: string): string[] => unwrapEmbeddedIpv4(text).map(formatIpAddress);

    it.each([
        ['an IPv4-mapped address', '::ffff:10.0.0.1', ['10.0.0.1']],
        ['an IPv4-mapped address in hex form', '::ffff:0102:0304', ['1.2.3.4']],
        ['a deprecated IPv4-compatible address', '::7f00:1', ['127.0.0.1']],
        ['a NAT64 well-known-prefix address', '64:ff9b::7f00:1', ['127.0.0.1']],
        ['a NAT64 address carrying a private host', '64:ff9b::c0a8:1', ['192.168.0.1']],
        ['a NAT64 local-use /48 address', '64:ff9b:1:a00:0:100::', ['10.0.0.1']],
        ['a 6to4 address', '2002:c0a8:101::', ['192.168.1.1']],
    ])('unwraps %s', (_case, text, expected) => {
        expect(carried(text)).toStrictEqual(expected);
    });

    it('unwraps both the server and the obfuscated client address of a Teredo address', () => {
        // RFC 4380: the server IPv4 sits in bits 32-63 and the client's is the
        // bitwise complement of the low 32 bits. Un-complementing it is what
        // makes the IPv4 rules mean anything for the client address.
        expect(carried('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toStrictEqual(['65.54.227.120', '192.0.2.45']);
    });

    it.each([
        ['an IPv4 address', '10.0.0.1'],
        ['an unparsable string', 'not-an-address'],
        ['an ordinary global IPv6 address', '2606:2800:220:1:248:1893:25c8:1946'],
        ['a documentation IPv6 address', '2001:db8::1'],
        ['a link-local IPv6 address', 'fe80::1'],
    ])('carries nothing for %s', (_case, text) => {
        expect(unwrapEmbeddedIpv4(text)).toStrictEqual([]);
    });

    it('carries nothing for a mis-sized address object', () => {
        expect(unwrapEmbeddedIpv4({ version: 6, bytes: [0, 0, 0, 0] })).toStrictEqual([]);
        expect(unwrapEmbeddedIpv4({ version: 4, bytes: [10, 0, 0, 1] })).toStrictEqual([]);
    });

    it('accepts a parsed address as well as text', () => {
        expect(unwrapEmbeddedIpv4(parseOrThrow('::ffff:10.0.0.1')).map(formatIpAddress)).toStrictEqual(['10.0.0.1']);
    });
});

describe('isGloballyRoutable on an IPv6 address that carries an IPv4 address', () => {
    const reasonFor = (text: string): string | null => {
        const verdict = classifyIpAddress(text, committedRows);
        return verdict.allowed ? null : verdict.reason;
    };

    it.each([
        ['an IPv4-mapped private address', '::ffff:10.0.0.1'],
        ['an IPv4-mapped loopback', '::ffff:127.0.0.1'],
        ['an IPv4-mapped link-local address', '::ffff:169.254.169.254'],
        ['an IPv4-compatible loopback', '::7f00:1'],
        ['an IPv4-compatible link-local address', '::a9fe:a9fe'],
        ['a NAT64 loopback', '64:ff9b::7f00:1'],
        ['a NAT64 link-local address', '64:ff9b::a9fe:a9fe'],
        ['a NAT64 local-use /48 private address', '64:ff9b:1:a00:0:100::'],
        ['a 6to4 private address', '2002:c0a8:101::'],
        ['a Teredo address whose client address is documentation space', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
    ])('refuses %s', (_case, text) => {
        expect(isGloballyRoutable(text, committedRows)).toBe(false);
    });

    it('names the carried address as the cause rather than the wrapper', () => {
        const verdict = classifyIpAddress('64:ff9b::7f00:1', committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('embedded_address_not_globally_routable');
            expect(verdict.detail).toContain('127.0.0.1');
            expect(verdict.detail).toContain('127.0.0.0/8');
        }
    });

    it('refuses a wrapper carrying a non-unicast IPv4 address', () => {
        expect(reasonFor('::ffff:224.0.0.1')).toBe('embedded_address_not_globally_routable');
        expect(reasonFor('::ffff:255.255.255.255')).toBe('embedded_address_not_globally_routable');
    });

    it('still refuses an IPv4-mapped public address, because the mapped block itself is not global', () => {
        // IANA marks ::ffff:0:0/96 not globally reachable, so the wrapper decides
        // even when the address it carries is ordinary global unicast.
        expect(reasonFor('::ffff:93.184.216.34')).toBe('address_not_globally_routable');
    });

    it('accepts a NAT64 address carrying a public IPv4 address', () => {
        // The one case that proves the unwrapping is not a blanket refusal:
        // 64:ff9b::/96 is marked globally reachable, so the verdict turns
        // entirely on the address it carries.
        expect(unwrapEmbeddedIpv4('64:ff9b::5db8:d822').map(formatIpAddress)).toStrictEqual(['93.184.216.34']);
        expect(isGloballyRoutable('64:ff9b::5db8:d822', committedRows)).toBe(true);
    });

    it('refuses a 6to4 address carrying a public IPv4 address, because 2002::/16 is n/a', () => {
        expect(reasonFor('2002:5db8:d822::')).toBe('address_not_globally_routable');
    });
});

// ---------------------------------------------------------------------------
// Non-unicast and explicitly refused addresses.
// ---------------------------------------------------------------------------

describe('classifyIpAddress on addresses no registry row covers', () => {
    it.each([
        ['224.0.0.1', 'IPv4 multicast'],
        ['224.0.0.0', 'the base of 224.0.0.0/4'],
        ['239.255.255.255', 'the top of 224.0.0.0/4'],
        ['232.1.2.3', 'source-specific multicast'],
    ])('refuses %s as not unicast (%s)', (address) => {
        const verdict = classifyIpAddress(address, committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('address_not_unicast');
            expect(verdict.detail).toContain('224.0.0.0/4');
        }
    });

    it('accepts the address immediately below the multicast block', () => {
        expect(isGloballyRoutable('223.255.255.255', committedRows)).toBe(true);
    });

    it('refuses the IPv4 limited broadcast address before consulting any row', () => {
        const verdict = classifyIpAddress('255.255.255.255', committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('address_not_unicast');
            expect(verdict.detail).toContain('broadcast');
        }
    });

    it.each([
        ['ff00::', 'the base of ff00::/8'],
        ['ff02::1', 'the all-nodes link-local group'],
        ['ff05::1:3', 'a site-local group'],
    ])('refuses the IPv6 multicast address %s (%s)', (address) => {
        const verdict = classifyIpAddress(address, committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('address_not_unicast');
            expect(verdict.detail).toContain('ff00::/8');
        }
    });

    it('refuses the unspecified address and the IPv6 loopback by name', () => {
        const unspecified = classifyIpAddress('::', committedRows);
        const loopback = classifyIpAddress('::1', committedRows);

        expect(unspecified.allowed).toBe(false);
        expect(loopback.allowed).toBe(false);
        if (!unspecified.allowed) {
            expect(unspecified.reason).toBe('address_not_globally_routable');
            expect(unspecified.detail).toContain('::');
        }
        if (!loopback.allowed) {
            expect(loopback.reason).toBe('address_not_globally_routable');
            expect(loopback.detail).toContain('::1');
        }
    });

    /**
     * `fe00::/9` and `fec0::/10` are the case the special-purpose table cannot
     * answer on its own: neither is multicast, neither is inside `fe80::/10`,
     * and neither appears in either IANA special-purpose registry — so on the
     * table alone they match nothing and read as routable. The IPv6 address
     * space registry is what settles them: both are "Reserved by IETF", and
     * `fec0::/10` is specifically the site-local prefix RFC 3879 deprecated,
     * which is exactly the kind of address an internal resolver still answers
     * with.
     */
    it('refuses fe00:: and fec0:: addresses, which no registry row covers and IANA has not allocated', () => {
        expect(isGloballyRoutable('fe00::1', committedRows)).toBe(false);
        expect(isGloballyRoutable('fec0::1', committedRows)).toBe(false);

        // The neighbouring blocks that a row does cover keep answering from
        // their rows, so the gate has not displaced the table.
        expect(isGloballyRoutable('fe80::1', committedRows)).toBe(false);
        expect(isGloballyRoutable('febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', committedRows)).toBe(false);
    });

    it('names the allocation, not a row, when it refuses an unallocated address', () => {
        const verdict = classifyIpAddress('fec0::1', committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('address_not_globally_routable');
            expect(verdict.detail).toContain('no block IANA allocates to global unicast');
            expect(verdict.detail).toContain('2000::/3');
            // The verdict reports the address in the expanded form the module
            // judged, not the text the caller wrote.
            expect(verdict.address).toBe('fec0:0:0:0:0:0:0:1');
        }
    });

    /**
     * Every top-level IPv6 block the address-space registry marks "Reserved by
     * IETF". None is covered by a special-purpose row, so before the allocation
     * gate every one of these passed.
     */
    it.each([
        // 0100::1 itself falls in the 100::/64 Discard-Only row, so a row
        // answers it; 0101::1 is in the same reserved block and outside every row.
        ['0101::1', '0100::/8'],
        ['0200::1', '0200::/7'],
        ['0400::1', '0400::/6'],
        ['0800::1', '0800::/5'],
        ['1000::1', '1000::/4'],
        ['4000::1', '4000::/3'],
        ['6000::1', '6000::/3'],
        ['8000::1', '8000::/3'],
        ['a000::1', 'a000::/3'],
        ['c000::1', 'c000::/3'],
        ['e000::1', 'e000::/4'],
        ['f000::1', 'f000::/5'],
        ['f800::1', 'f800::/6'],
        ['fe00::1', 'fe00::/9'],
        ['fec0::1', 'fec0::/10'],
    ])('refuses %s, which sits in the reserved block %s', (address) => {
        const verdict = classifyIpAddress(address, committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('address_not_globally_routable');
            expect(verdict.detail).toContain('no block IANA allocates to global unicast');
        }
    });

    it('still accepts an ordinary address inside the allocated 2000::/3', () => {
        expect(isGloballyRoutable('2606:2800:220:1:248:1893:25c8:1946', committedRows)).toBe(true);
        expect(isGloballyRoutable('2000::1', committedRows)).toBe(true);
        expect(isGloballyRoutable('3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', committedRows)).toBe(true);
    });

    /**
     * A row marked globally reachable is the reviewed exception and must survive
     * the gate. `64:ff9b::/96` is the one that proves it: NAT64 lives in `::/8`,
     * outside the allocated `2000::/3`, so a gate applied over the top of every
     * row — rather than only where no row matched — would refuse the very block
     * the registry went out of its way to declare reachable.
     */
    it.each([
        ['64:ff9b::5db8:d822', '64:ff9b::/96, outside 2000::/3'],
        ['2001:1::1', '2001:1::1/128'],
        ['2001:3::1', '2001:3::/32'],
        ['2620:4f:8000::1', '2620:4f:8000::/48'],
        ['192.0.0.9', '192.0.0.9/32'],
        ['192.175.48.1', '192.175.48.0/24'],
    ])('keeps accepting %s, whose row (%s) the registries mark globally reachable', (address) => {
        expect(isGloballyRoutable(address, committedRows)).toBe(true);
    });
});

/**
 * The allocation gate, asked directly.
 *
 * `validateEvidenceRangeTable` compares the table against the reviewed snapshot
 * as a set, so a table with a row removed refuses before any address is judged.
 * That makes `classifyIpAddress` the wrong instrument for proving the gate does
 * not depend on the table — the proof has to ask the gate itself.
 */
/**
 * The allocation as the document carries it.
 *
 * `globalUnicastAllocations` is the reviewed policy surface, so it gets the
 * treatment the range table gets: its shape is validated, and it is
 * counter-signed against the reviewed list in both directions. A document that
 * widens the policy is the dangerous case — appending `4000::/3` restores
 * exactly the hole the gate closes — and a document that narrows it is a
 * reviewability failure, because the list a reviewer diffs against the registry
 * pages would no longer be the list the classifier uses.
 */
describe('validateEvidenceAllocationTable', () => {
    const committedAllocations = (): unknown[] =>
        (cloneDocument().globalUnicastAllocations as unknown[]).slice();

    it('accepts the committed allocation and returns its rows and blocks', () => {
        const verdict = validateEvidenceAllocationTable(committedAllocations());

        expect(verdict.ok).toBe(true);
        if (verdict.ok) {
            expect(verdict.rows.map((row) => row.cidr)).toStrictEqual([
                '0.0.0.0/1',
                '128.0.0.0/2',
                '192.0.0.0/3',
                '2000::/3',
            ]);
            expect(verdict.blocks).toHaveLength(REVIEWED_ALLOCATION_ROW_COUNT);
            expect(verdict.rows.every((row) => row.registry.length > 0 && row.allocation.length > 0)).toBe(true);
        }
    });

    it('refuses a document that widens the allocation', () => {
        const widened = committedAllocations();
        widened.push({ cidr: '4000::/3', allocation: 'Global Unicast', registry: 'ipv6-address-space' });

        const verdict = validateEvidenceAllocationTable(widened);

        expect(verdict.ok).toBe(false);
        if (!verdict.ok) {
            expect(verdict.detail).toContain('4000::/3');
            expect(verdict.detail).toContain('did not allocate to global unicast');
        }
    });

    it('refuses a document that drops a reviewed block', () => {
        const narrowed = committedAllocations().filter(
            (row) => (row as Record<string, unknown>).cidr !== '128.0.0.0/2',
        );

        const verdict = validateEvidenceAllocationTable(narrowed);

        expect(verdict.ok).toBe(false);
        if (!verdict.ok) {
            expect(verdict.detail).toContain('missing the reviewed block');
            expect(verdict.detail).toContain('128.0.0.0/2');
        }
    });

    it('refuses a document that substitutes one block for another at the same count', () => {
        const substituted = committedAllocations().map((row) =>
            (row as Record<string, unknown>).cidr === '2000::/3'
                ? { cidr: '4000::/3', allocation: 'Global Unicast', registry: 'ipv6-address-space' }
                : row,
        );

        expect(substituted).toHaveLength(REVIEWED_ALLOCATION_ROW_COUNT);
        expect(validateEvidenceAllocationTable(substituted).ok).toBe(false);
    });

    it.each([
        ['not a list', 'not a list'],
        ['an empty list', []],
        ['a list of non-objects', ['2000::/3']],
    ])('refuses %s', (_case, value) => {
        expect(validateEvidenceAllocationTable(value).ok).toBe(false);
    });

    it.each([
        ['a missing CIDR', { allocation: 'Global Unicast', registry: 'ipv6-address-space' }],
        ['an unparsable CIDR', { cidr: 'nope/3', allocation: 'u', registry: 'r' }],
        ['host bits set', { cidr: '2001::/3', allocation: 'u', registry: 'r' }],
        ['a blank allocation wording', { cidr: '2000::/3', allocation: '   ', registry: 'r' }],
        ['a blank registry name', { cidr: '2000::/3', allocation: 'u', registry: '' }],
    ])('refuses a row with %s', (_case, row) => {
        const rows = committedAllocations().filter(
            (existing) => (existing as Record<string, unknown>).cidr !== '2000::/3',
        );
        rows.push(row);

        expect(validateEvidenceAllocationTable(rows).ok).toBe(false);
    });

    /**
     * The canonical-text check has to fire before set equality, or a hand-edited
     * row would be reported as an unreviewed block rather than as the
     * transcription error it is. No reviewed block contains a hex letter, so the
     * case rule is isolated with a lettered block and asserted on its detail:
     * reported as non-canonical text, not as a set mismatch.
     */
    it('refuses upper-case registry text as a transcription error, not a set mismatch', () => {
        const rows = committedAllocations();
        rows.push({ cidr: 'FEC0::/10', allocation: 'Reserved by IETF', registry: 'ipv6-address-space' });

        const verdict = validateEvidenceAllocationTable(rows);

        expect(verdict.ok).toBe(false);
        if (!verdict.ok) {
            expect(verdict.detail).toContain('canonical lower-case registry text');
            expect(verdict.detail).not.toContain('did not allocate');
        }
    });

    it('refuses a block declared twice', () => {
        const duplicated = committedAllocations();
        duplicated.push({ cidr: '2000::/3', allocation: 'Global Unicast', registry: 'ipv6-address-space' });

        const verdict = validateEvidenceAllocationTable(duplicated);

        expect(verdict.ok).toBe(false);
        if (!verdict.ok) {
            expect(verdict.detail).toContain('already declared');
        }
    });

    it('refuses an allocation carrying only one family', () => {
        const ipv6Only = committedAllocations().filter(
            (row) => ((row as Record<string, unknown>).cidr as string).indexOf(':') !== -1,
        );

        const verdict = validateEvidenceAllocationTable(ipv6Only);

        expect(verdict.ok).toBe(false);
        if (!verdict.ok) {
            // Reported as the missing family rather than as a set mismatch: the
            // operator needs to know no IPv4 address could be judged at all.
            expect(verdict.detail).toContain('IPv4');
        }
    });
});

describe('validateEvidencePolicy on the allocation member', () => {
    const policyWithout = (mutate: (document: Record<string, unknown>) => void): unknown => {
        const document = cloneDocument();
        mutate(document);
        return document;
    };

    it('accepts the committed document and carries the validated allocation through', () => {
        expect(committedPolicy.globalUnicastAllocationRowCount).toBe(REVIEWED_ALLOCATION_ROW_COUNT);
        expect(committedPolicy.globalUnicastAllocations.map((row) => row.cidr)).toStrictEqual([
            '0.0.0.0/1',
            '128.0.0.0/2',
            '192.0.0.0/3',
            '2000::/3',
        ]);
    });

    it.each([
        [
            'the allocation member is absent',
            (document: Record<string, unknown>) => delete document.globalUnicastAllocations,
        ],
        [
            'the allocation is widened',
            (document: Record<string, unknown>) => {
                (document.globalUnicastAllocations as unknown[]).push({
                    cidr: '4000::/3',
                    allocation: 'Global Unicast',
                    registry: 'ipv6-address-space',
                });
            },
        ],
    ])('refuses the document when %s', (_case, mutate) => {
        const verdict = validateEvidencePolicy(policyWithout(mutate));

        expect(verdict.ok).toBe(false);
        if (!verdict.ok) {
            expect(verdict.reason).toBe('range_table_unclassifiable');
        }
    });

    it.each([
        [
            'the declared count is absent',
            (document: Record<string, unknown>) => delete document.globalUnicastAllocationRowCount,
        ],
        [
            'the declared count disagrees with what is carried',
            (document: Record<string, unknown>) => {
                document.globalUnicastAllocationRowCount = REVIEWED_ALLOCATION_ROW_COUNT + 1;
            },
        ],
    ])('refuses the document when %s', (_case, mutate) => {
        const verdict = validateEvidencePolicy(policyWithout(mutate));

        expect(verdict.ok).toBe(false);
        if (!verdict.ok) {
            expect(verdict.reason).toBe('policy_invalid');
            expect(verdict.detail).toContain('allocation');
        }
    });

    it('leaves the range-table members it does not touch alone', () => {
        // The allocation is a second, separate reviewed surface: adding it must
        // not have moved the row counts or the snapshot the range table is
        // attested by.
        expect(committedPolicy.rowCount).toBe(REVIEWED_RANGE_ROW_COUNT);
        expect(committedPolicy.registryRowCount).toBe(REVIEWED_REGISTRY_ROW_COUNT);
        expect(committedPolicy.supplementalRowCount).toBe(REVIEWED_SUPPLEMENTAL_ROW_COUNT);
        expect(committedPolicy.registrySnapshot).toBe(REVIEWED_REGISTRY_SNAPSHOT);
    });
});

describe('isGloballyAllocatedUnicast', () => {
    const address = (text: string): ParsedIpAddress => parseOrThrow(text);

    it('carries a usable reviewed allocation, since a defect would refuse every address', () => {
        const families = new Set<number>();

        for (const entry of REVIEWED_GLOBAL_UNICAST_ALLOCATIONS) {
            const parsed = parseCidr(entry.cidr);
            expect(parsed).not.toBeNull();
            expect(entry.allocation.length).toBeGreaterThan(0);
            expect(entry.registry.length).toBeGreaterThan(0);
            if (parsed !== null) {
                families.add(parsed.version);
            }
        }

        expect(new Set(REVIEWED_GLOBAL_UNICAST_ALLOCATIONS.map((entry) => entry.cidr)).size).toBe(
            REVIEWED_GLOBAL_UNICAST_ALLOCATIONS.length,
        );
        expect([...families].sort()).toStrictEqual([4, 6]);
    });

    it.each([
        ['240.0.0.1', 'the base of class E'],
        ['255.255.255.254', 'the top of class E below the broadcast address'],
        ['224.0.0.1', 'the base of the multicast block'],
        ['239.255.255.255', 'the top of the multicast block'],
    ])('refuses the IPv4 address %s (%s) without consulting the table', (text) => {
        expect(isGloballyAllocatedUnicast(address(text))).toBe(false);
    });

    it.each([
        ['0.0.0.1', 'the bottom of the unicast space'],
        ['127.0.0.1', 'loopback, which is unicast space and refused by its row instead'],
        ['169.254.169.254', 'link-local, which is unicast space and refused by its row instead'],
        ['223.255.255.255', 'the top of the unicast space'],
    ])('accepts the IPv4 address %s (%s), leaving the table to judge it', (text) => {
        expect(isGloballyAllocatedUnicast(address(text))).toBe(true);
    });

    it('answers for IPv6 on the 2000::/3 boundary', () => {
        expect(isGloballyAllocatedUnicast(address('1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'))).toBe(false);
        expect(isGloballyAllocatedUnicast(address('2000::'))).toBe(true);
        expect(isGloballyAllocatedUnicast(address('3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'))).toBe(true);
        expect(isGloballyAllocatedUnicast(address('4000::'))).toBe(false);
    });

    /**
     * The gate answers "is this allocated to unicast", not "is this safe": a
     * special-purpose block carved out of unicast space satisfies it, which is
     * why the table's completeness check cannot be replaced by this one.
     */
    it('does not stand in for a table row', () => {
        expect(isGloballyAllocatedUnicast(address('10.0.0.1'))).toBe(true);
        expect(isGloballyAllocatedUnicast(address('192.168.1.1'))).toBe(true);
        expect(isGloballyAllocatedUnicast(address('2001:db8::1'))).toBe(true);

        expect(isGloballyRoutable('10.0.0.1', committedRows)).toBe(false);
        expect(isGloballyRoutable('192.168.1.1', committedRows)).toBe(false);
        expect(isGloballyRoutable('2001:db8::1', committedRows)).toBe(false);
    });
});

describe('classifyIpAddress on an address it cannot read', () => {
    it('refuses an unparsable string and reports the string it judged', () => {
        const verdict = classifyIpAddress('not-an-address', committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('address_unparsable');
            expect(verdict.address).toBe('not-an-address');
        }
    });

    it.each([
        ['too few IPv4 bytes', { version: 4, bytes: [10, 0, 0] }],
        ['too many IPv4 bytes', { version: 4, bytes: [10, 0, 0, 1, 1] }],
        ['too few IPv6 bytes', { version: 6, bytes: [0, 0, 0, 0] }],
        ['an unknown version', { version: 5, bytes: [10, 0, 0, 1] }],
        ['a byte above 255', { version: 4, bytes: [10, 0, 0, 256] }],
        ['a negative byte', { version: 4, bytes: [10, 0, 0, -1] }],
        ['a fractional byte', { version: 4, bytes: [10, 0, 0, 1.5] }],
        ['an infinite byte', { version: 4, bytes: [10, 0, 0, Number.POSITIVE_INFINITY] }],
        ['a string byte', { version: 4, bytes: ['10', 0, 0, 1] }],
        ['bytes that are not a list', { version: 4, bytes: 'ten' }],
    ])('refuses a hand-built address object with %s', (_case, address) => {
        // A wrong byte count or an out-of-range byte would make every prefix
        // comparison meaningless, so the guard runs before classification.
        const verdict = classifyIpAddress(address as unknown as ParsedIpAddress, committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('address_unparsable');
            expect(verdict.address).toBeNull();
        }
    });

    it('refuses null and undefined addresses', () => {
        expect(isGloballyRoutable(null as unknown as ParsedIpAddress, committedRows)).toBe(false);
        expect(isGloballyRoutable(undefined as unknown as ParsedIpAddress, committedRows)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Whole answer sets.
// ---------------------------------------------------------------------------

describe('classifyAddressSet and areAllAddressesRoutable', () => {
    it('accepts a set whose every member is global unicast', () => {
        const addresses = ['93.184.216.34', '203.0.112.7', '2606:2800:220:1:248:1893:25c8:1946'];

        expect(classifyAddressSet(addresses, committedRows)).toStrictEqual({ allowed: true });
        expect(areAllAddressesRoutable(addresses, committedRows)).toBe(true);
    });

    it('refuses the whole set when exactly one member is private', () => {
        // A name resolving to one public and one private address is a DNS
        // rebinding attempt, not a partial success.
        const verdict = classifyAddressSet(['93.184.216.34', '10.0.0.7', '203.0.112.7'], committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('address_not_globally_routable');
            // The member that decided it, which is what makes a mixed set
            // diagnosable rather than just refused.
            expect(verdict.address).toBe('10.0.0.7');
            expect(verdict.detail).toContain('10.0.0.0/8');
        }
        expect(areAllAddressesRoutable(['93.184.216.34', '10.0.0.7'], committedRows)).toBe(false);
    });

    it('refuses the whole set when one member is the cloud metadata address', () => {
        const verdict = classifyAddressSet(['93.184.216.34', '169.254.169.254'], committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.address).toBe('169.254.169.254');
            expect(verdict.detail).toContain('169.254.0.0/16');
        }
    });

    it('refuses an empty answer set rather than finding no objection to it', () => {
        const verdict = classifyAddressSet([], committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('unresolvable_host');
            expect(verdict.address).toBeNull();
        }
        expect(areAllAddressesRoutable([], committedRows)).toBe(false);
    });

    it('refuses a set that is not a list at all', () => {
        const verdict = classifyAddressSet(null as unknown as string[], committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('unresolvable_host');
        }
    });

    it('refuses a set carrying an unparsable member', () => {
        const verdict = classifyAddressSet(['93.184.216.34', 'localhost'], committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('address_unparsable');
            expect(verdict.address).toBe('localhost');
        }
    });

    it('accepts parsed addresses as well as text', () => {
        expect(areAllAddressesRoutable([parseOrThrow('93.184.216.34')], committedRows)).toBe(true);
        expect(areAllAddressesRoutable([parseOrThrow('10.0.0.1')], committedRows)).toBe(false);
    });

    /**
     * The transport-facing sentinel for the reserved-space gap.
     *
     * This is the function `evidence.service.ts` calls with the resolver's whole
     * answer set, before it pins an address and before any socket is opened — a
     * non-`allowed` verdict here is the no-connect decision. Covering the
     * reserved blocks only through `classifyIpAddress` would leave the path that
     * actually decides whether a request happens untested, so each
     * representative is asserted here as well.
     */
    it.each([
        ['4000::1', 'the base of the reserved 4000::/3'],
        ['fec0::1', 'the deprecated site-local fec0::/10'],
        ['fe00::1', 'the reserved fe00::/9'],
    ])('refuses a lone reserved answer %s (%s), so no address is ever pinned', (address) => {
        const verdict = classifyAddressSet([address], committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('address_not_globally_routable');
            expect(verdict.detail).toContain('no block IANA allocates to global unicast');
        }
        expect(areAllAddressesRoutable([address], committedRows)).toBe(false);
    });

    /**
     * The rebinding-shaped case: a name answering with one perfectly ordinary
     * public address and one reserved address. The set must fail as a whole, and
     * it must fail naming the reserved one — the service pins `addresses[0]`, so
     * a set that passed on its first member would connect to the public address
     * while the name stayed free to answer with the other.
     */
    it.each([
        ['4000::1', 'a reserved IPv6 block'],
        ['fec0::1', 'deprecated site-local space'],
    ])('refuses a mixed answer set whose second address is %s (%s)', (reserved) => {
        const verdict = classifyAddressSet(['93.184.216.34', reserved], committedRows);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('address_not_globally_routable');
            expect(verdict.detail).toContain('no block IANA allocates to global unicast');
        }

        // ...and in the other order, so the refusal does not depend on position.
        expect(areAllAddressesRoutable([reserved, '93.184.216.34'], committedRows)).toBe(false);
    });

    it('still accepts an answer set of ordinary public addresses', () => {
        expect(
            areAllAddressesRoutable(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'], committedRows),
        ).toBe(true);
    });

    /**
     * The same verdicts when the caller hands in the document's own allocation
     * rather than relying on the counter-signed reviewed list, which is the path
     * a policy-holding caller takes.
     */
    it('reaches the same verdicts through the document-supplied allocation', () => {
        const allocations = committedPolicy.globalUnicastAllocations;

        expect(areAllAddressesRoutable(['4000::1'], committedRows, allocations)).toBe(false);
        expect(areAllAddressesRoutable(['fec0::1'], committedRows, allocations)).toBe(false);
        expect(areAllAddressesRoutable(['93.184.216.34'], committedRows, allocations)).toBe(true);
        expect(areAllAddressesRoutable(['64:ff9b::5db8:d822'], committedRows, allocations)).toBe(true);
    });
});


// ---------------------------------------------------------------------------
// The address table as a document.
// ---------------------------------------------------------------------------

/** The committed rows as mutable records, for the corruption cases. */
const mutableRows = (): Record<string, unknown>[] =>
    cloneDocument().specialPurposeRanges as Record<string, unknown>[];

const rowIndexOf = (rows: Record<string, unknown>[], cidr: string): number => {
    const index = rows.findIndex((row) => row.cidr === cidr);
    if (index === -1) {
        throw new Error(`the committed table no longer carries "${cidr}"`);
    }
    return index;
};

/** The committed table with one row patched, replaced or removed. */
const tableWithRow = (cidr: string, patch: Record<string, unknown> | null): unknown[] => {
    const rows = mutableRows();
    const index = rowIndexOf(rows, cidr);

    if (patch === null) {
        rows.splice(index, 1);
    } else {
        rows[index] = { ...rows[index], ...patch };
    }

    return rows;
};

/** The committed table with one row replaced by a value that is not a row. */
const tableWithRawRow = (cidr: string, value: unknown): unknown[] => {
    const rows: unknown[] = mutableRows();
    rows[rowIndexOf(rows as Record<string, unknown>[], cidr)] = value;
    return rows;
};

const tableDetail = (ranges: unknown): string => {
    const verdict = validateEvidenceRangeTable(ranges);
    if (verdict.ok) {
        throw new Error('expected the address table to be refused, but it validated');
    }
    return verdict.detail;
};

describe('validateEvidenceRangeTable on the committed table', () => {
    it('accepts it and returns the normalized rows', () => {
        const verdict = validateEvidenceRangeTable(committedDocument && mutableRows());

        expect(verdict.ok).toBe(true);
        if (verdict.ok) {
            expect(verdict.rows).toHaveLength(REVIEWED_RANGE_ROW_COUNT);
            expect(verdict.rows).toStrictEqual(committedRows);
        }
    });

    it('returns rows carrying only the four reviewed members', () => {
        const verdict = validateEvidenceRangeTable(mutableRows());

        expect(verdict.ok).toBe(true);
        if (verdict.ok) {
            expect(Object.keys(verdict.rows[0]).sort()).toStrictEqual([
                'cidr',
                'globallyReachable',
                'name',
                'registry',
            ]);
        }
    });
});

describe('validateEvidenceRangeTable on a table it cannot trust', () => {
    it.each([
        ['null', null, 'the special-purpose address table is null, not a list'],
        ['undefined', undefined, 'the special-purpose address table is undefined, not a list'],
        ['an object', {}, 'the special-purpose address table is object, not a list'],
        ['a string', 'ranges', 'the special-purpose address table is "ranges", not a list'],
        ['a number', 52, 'the special-purpose address table is 52, not a list'],
        ['a boolean', true, 'the special-purpose address table is true, not a list'],
    ])('refuses %s', (_case, ranges, detail) => {
        expect(tableDetail(ranges)).toBe(detail);
    });

    it('refuses an empty table, which would otherwise permit every address', () => {
        expect(tableDetail([])).toBe('the special-purpose address table is empty');
    });

    it.each([
        ['null', null, 'special-purpose row 5 is null, not an object'],
        ['a string', 'a row', 'special-purpose row 5 is "a row", not an object'],
        ['a number', 5, 'special-purpose row 5 is 5, not an object'],
        ['a list', ['169.254.0.0/16'], 'special-purpose row 5 is a list, not an object'],
    ])('refuses a row that is %s', (_case, value, detail) => {
        expect(tableDetail(tableWithRawRow('169.254.0.0/16', value))).toBe(detail);
    });

    it.each([
        ['absent', { cidr: undefined }],
        ['an empty string', { cidr: '' }],
        ['whitespace', { cidr: '   ' }],
        ['a number', { cidr: 16 }],
    ])('refuses a row whose CIDR is %s', (_case, patch) => {
        expect(tableDetail(tableWithRow('169.254.0.0/16', patch))).toBe('special-purpose row 5 declares no CIDR');
    });

    it.each([
        ['a leading space', ' 169.254.0.0/16'],
        ['a trailing space', '169.254.0.0/16 '],
        ['upper case', '2001:DB8::/32'],
    ])('refuses a CIDR written with %s, even though it would classify the same', (_case, cidr) => {
        // Not a classification hole — it is evidence the row was hand-edited
        // rather than transcribed, and a table nobody can diff against the
        // registry page is a table nobody can review.
        expect(tableDetail(tableWithRow(cidr.trim().toLowerCase(), { cidr }))).toBe(
            `special-purpose row "${cidr}" is not written in canonical lower-case registry text`,
        );
    });

    it('refuses a CIDR that does not parse', () => {
        expect(tableDetail(tableWithRow('169.254.0.0/16', { cidr: '169.254.0.0/33' }))).toBe(
            'special-purpose row "169.254.0.0/33" is not a valid CIDR',
        );
    });

    it('refuses a row written with host bits set', () => {
        expect(tableDetail(tableWithRow('169.254.0.0/16', { cidr: '169.254.1.0/16' }))).toBe(
            'special-purpose row "169.254.1.0/16" is not written on its own network address',
        );
    });

    it.each([
        ['absent', { name: undefined }],
        ['empty', { name: '' }],
        ['whitespace', { name: '  ' }],
        ['a number', { name: 7 }],
    ])('refuses a row whose registry name is %s', (_case, patch) => {
        expect(tableDetail(tableWithRow('169.254.0.0/16', patch))).toBe(
            'special-purpose row "169.254.0.0/16" carries no registry name',
        );
    });

    it.each([
        ['absent', { registry: undefined }, 'undefined'],
        ['an unknown label', { registry: 'ipv5' }, '"ipv5"'],
        ['a number', { registry: 4 }, '4'],
    ])('refuses a row whose registry label is %s', (_case, patch, rendered) => {
        expect(tableDetail(tableWithRow('169.254.0.0/16', patch))).toBe(
            `special-purpose row "169.254.0.0/16" declares the registry ${rendered}`,
        );
    });

    it('refuses a row filed under the wrong family, as a transcription error', () => {
        // The classifier takes the family from the CIDR, so this could never
        // smuggle an IPv4 rule onto an IPv6 address — but a row whose own two
        // fields disagree is exactly what this validation exists to catch.
        expect(tableDetail(tableWithRow('169.254.0.0/16', { registry: 'ipv6' }))).toBe(
            'special-purpose row "169.254.0.0/16" is filed under the ipv6 registry but is an ipv4 block',
        );
        expect(tableDetail(tableWithRow('fe80::/10', { registry: 'ipv4' }))).toBe(
            'special-purpose row "fe80::/10" is filed under the ipv4 registry but is an ipv6 block',
        );
    });

    it.each([
        ['a string', { globallyReachable: 'yes' }, '"yes"'],
        ['the string "false"', { globallyReachable: 'false' }, '"false"'],
        ['a number', { globallyReachable: 0 }, '0'],
        ['null', { globallyReachable: null }, 'null'],
        ['absent', { globallyReachable: undefined }, 'undefined'],
        ['an object', { globallyReachable: {} }, 'object'],
    ])('refuses a globallyReachable value that is %s', (_case, patch, rendered) => {
        // `true`, `false` and the literal 'n/a' are the only three the registries
        // state, and 'n/a' is never collapsed into a boolean.
        expect(tableDetail(tableWithRow('169.254.0.0/16', patch))).toBe(
            `special-purpose row "169.254.0.0/16" declares the unrecognised globallyReachable value ${rendered}`,
        );
    });

    it('refuses a block declared twice, however the second copy is written', () => {
        const duplicated = mutableRows();
        duplicated.push({ ...duplicated[rowIndexOf(duplicated, '169.254.0.0/16')] });

        expect(tableDetail(duplicated)).toBe('the special-purpose block "169.254.0.0/16" is declared twice');
    });

    it('refuses a table with a reviewed block missing', () => {
        // The dangerous case: an address matching no row is ordinary global
        // unicast by design, so a deletion is invisible to classification.
        expect(tableDetail(tableWithRow('169.254.0.0/16', null))).toBe(
            'the address table omits the reviewed block 169.254.0.0/16',
        );
    });

    it('refuses a table carrying a block the review never saw', () => {
        const extended = mutableRows();
        extended.push({
            cidr: '203.0.114.0/24',
            name: 'Invented block',
            registry: 'ipv4',
            globallyReachable: false,
        });

        expect(tableDetail(extended)).toBe(
            `the address table carries "203.0.114.0/24", which is not part of the ${REVIEWED_REGISTRY_SNAPSHOT} reviewed snapshot`,
        );
    });

    it('refuses a same-count substitution, which a row count alone cannot catch', () => {
        const substituted = mutableRows();
        substituted[rowIndexOf(substituted, '169.254.0.0/16')] = {
            cidr: '203.0.114.0/24',
            name: 'Substituted block',
            registry: 'ipv4',
            globallyReachable: false,
        };

        expect(substituted).toHaveLength(REVIEWED_RANGE_ROW_COUNT);
        expect(tableDetail(substituted)).toBe('the address table omits the reviewed block 169.254.0.0/16');
    });

    it.each([
        ['169.254.0.0/16', true, 'true', 'false'],
        ['192.88.99.0/24', false, 'false', 'n/a'],
        ['192.0.0.9/32', false, 'false', 'true'],
    ])('refuses %s with its reachability flipped', (cidr, value, declared, reviewed) => {
        expect(tableDetail(tableWithRow(cidr, { globallyReachable: value }))).toBe(
            `the address table marks the reviewed block ${cidr} ${declared}, ` +
                `but the ${REVIEWED_REGISTRY_SNAPSHOT} snapshot states ${reviewed}`,
        );
    });
});

describe('classifyIpAddress against a table it cannot trust', () => {
    it('refuses every address rather than classifying part of the table', () => {
        // The property that makes a deletion safe: losing 169.254.0.0/16 must not
        // promote the cloud metadata address to a permitted fetch target.
        const missingLinkLocal = tableWithRow('169.254.0.0/16', null) as SpecialPurposeRange[];
        const verdict = classifyIpAddress('169.254.169.254', missingLinkLocal);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('range_table_unclassifiable');
            expect(verdict.detail).toContain('omits the reviewed block 169.254.0.0/16');
            expect(verdict.address).toBe('169.254.169.254');
        }
        // And a plainly public address is refused too, because the rules could
        // not be trusted for it either.
        expect(isGloballyRoutable('93.184.216.34', missingLinkLocal)).toBe(false);
    });

    it.each([
        ['an empty table', []],
        ['a table that is not a list', null],
        ['a table with a corrupted row', [{ cidr: 'nonsense' }]],
    ])('refuses an address against %s', (_case, ranges) => {
        const verdict = classifyIpAddress('93.184.216.34', ranges as unknown as SpecialPurposeRange[]);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.reason).toBe('range_table_unclassifiable');
        }
    });

    it('reports null as the judged address when the input was not text', () => {
        const verdict = classifyIpAddress(parseOrThrow('93.184.216.34'), [] as SpecialPurposeRange[]);

        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
            expect(verdict.address).toBeNull();
        }
    });
});

// ---------------------------------------------------------------------------
// The declared fetch limits.
// ---------------------------------------------------------------------------

describe('resolveEvidenceFetchLimits', () => {
    it('falls back to the reviewed ceilings when nothing is declared', () => {
        expect(resolveEvidenceFetchLimits()).toStrictEqual({
            schemes: [EVIDENCE_ALLOWED_SCHEME],
            allowedPorts: [EVIDENCE_ALLOWED_PORT],
            maxRedirects: EVIDENCE_MAX_REDIRECTS,
            timeoutMs: EVIDENCE_FETCH_TIMEOUT_MS,
            maxBodyBytes: EVIDENCE_MAX_BODY_BYTES,
            allowedContentTypes: EVIDENCE_ALLOWED_CONTENT_TYPES,
            maxSnippetChars: EVIDENCE_MAX_SNIPPET_CHARS,
            allowCrossHostRedirect: false,
        });
    });

    it.each([
        ['undefined', undefined],
        ['null', null],
        ['an empty object', {}],
    ])('treats %s as "declared nothing" and grants exactly the ceilings', (_case, limits) => {
        expect(resolveEvidenceFetchLimits(limits).schemes).toStrictEqual(['https']);
        expect(resolveEvidenceFetchLimits(limits).allowedContentTypes).toStrictEqual(EVIDENCE_ALLOWED_CONTENT_TYPES);
        expect(resolveEvidenceFetchLimits(limits).maxBodyBytes).toBe(EVIDENCE_MAX_BODY_BYTES);
    });

    it.each([
        ['a string', 'limits'],
        ['a number', 5],
        ['a list', []],
        ['a boolean', true],
    ])('permits nothing at all when the limits container is %s', (_case, limits) => {
        // Narrowing to nothing is the fail-closed outcome a corrupt document
        // gets: no scheme, no port and no content type is permitted, so every
        // URL and every body is refused.
        const resolved = resolveEvidenceFetchLimits(limits);

        expect(resolved.schemes).toStrictEqual([]);
        expect(resolved.allowedPorts).toStrictEqual([]);
        expect(resolved.allowedContentTypes).toStrictEqual([]);
        // The caps still fall back to the reviewed values: a zero timeout or a
        // zero-byte body would disable retrieval rather than secure it.
        expect(resolved.maxRedirects).toBe(EVIDENCE_MAX_REDIRECTS);
        expect(resolved.timeoutMs).toBe(EVIDENCE_FETCH_TIMEOUT_MS);
        expect(resolved.maxBodyBytes).toBe(EVIDENCE_MAX_BODY_BYTES);
        expect(resolved.maxSnippetChars).toBe(EVIDENCE_MAX_SNIPPET_CHARS);
    });

    it('never lets a document widen a list', () => {
        const resolved = resolveEvidenceFetchLimits({
            schemes: ['https', 'http', 'file', 'gopher'],
            allowedPorts: [443, 80, 8080],
            allowedContentTypes: ['text/html', 'application/pdf', 'text/xml'],
        });

        expect(resolved.schemes).toStrictEqual(['https']);
        expect(resolved.allowedPorts).toStrictEqual([443]);
        expect(resolved.allowedContentTypes).toStrictEqual(['text/html']);
    });

    it('lets a document narrow a list, and normalises case and padding as it does', () => {
        const resolved = resolveEvidenceFetchLimits({
            schemes: [' HTTPS '],
            allowedContentTypes: ['TEXT/PLAIN'],
        });

        expect(resolved.schemes).toStrictEqual(['https']);
        expect(resolved.allowedContentTypes).toStrictEqual(['text/plain']);
    });

    it.each([
        ['a string', 'https'],
        ['a number', 443],
        ['an object', { scheme: 'https' }],
    ])('permits no scheme when schemes is present but is %s', (_case, schemes) => {
        // Malformed is not absent: resolving it to the full reviewed list would
        // hand a corrupt document the widest policy the module allows.
        expect(resolveEvidenceFetchLimits({ schemes }).schemes).toStrictEqual([]);
    });

    it('skips list members of the wrong type rather than trusting them', () => {
        expect(resolveEvidenceFetchLimits({ schemes: [443, null, 'https'] }).schemes).toStrictEqual(['https']);
        expect(resolveEvidenceFetchLimits({ allowedPorts: ['443', {}, 443] }).allowedPorts).toStrictEqual([443]);
        expect(resolveEvidenceFetchLimits({ allowedPorts: [Number.NaN, Number.POSITIVE_INFINITY] }).allowedPorts)
            .toStrictEqual([]);
    });

    it.each([
        ['a number', 2],
        ['a string', '443'],
        ['an object', {}],
    ])('permits no port when allowedPorts is present but is %s', (_case, allowedPorts) => {
        expect(resolveEvidenceFetchLimits({ allowedPorts }).allowedPorts).toStrictEqual([]);
    });

    it('takes the smaller of a declared cap and the reviewed ceiling', () => {
        const resolved = resolveEvidenceFetchLimits({
            maxRedirects: 1,
            timeoutMs: 5_000,
            maxBodyBytes: 4_096,
            maxSnippetChars: 100,
        });

        expect(resolved.maxRedirects).toBe(1);
        expect(resolved.timeoutMs).toBe(5_000);
        expect(resolved.maxBodyBytes).toBe(4_096);
        expect(resolved.maxSnippetChars).toBe(100);
    });

    it('refuses to widen a cap past the reviewed ceiling', () => {
        const resolved = resolveEvidenceFetchLimits({
            maxRedirects: 99,
            timeoutMs: 600_000,
            maxBodyBytes: 1_073_741_824,
            maxSnippetChars: 10_000,
        });

        expect(resolved.maxRedirects).toBe(EVIDENCE_MAX_REDIRECTS);
        expect(resolved.timeoutMs).toBe(EVIDENCE_FETCH_TIMEOUT_MS);
        expect(resolved.maxBodyBytes).toBe(EVIDENCE_MAX_BODY_BYTES);
        expect(resolved.maxSnippetChars).toBe(EVIDENCE_MAX_SNIPPET_CHARS);
    });

    it('accepts a declared zero redirect budget but not a zero timeout or body cap', () => {
        // Zero redirects is a real, stricter policy. A zero timeout or a
        // zero-byte body is nonsense that would disable retrieval, so those fall
        // back to the reviewed value instead.
        expect(resolveEvidenceFetchLimits({ maxRedirects: 0 }).maxRedirects).toBe(0);
        expect(resolveEvidenceFetchLimits({ maxRedirects: -1 }).maxRedirects).toBe(EVIDENCE_MAX_REDIRECTS);
        expect(resolveEvidenceFetchLimits({ timeoutMs: 0 }).timeoutMs).toBe(EVIDENCE_FETCH_TIMEOUT_MS);
        expect(resolveEvidenceFetchLimits({ maxBodyBytes: 0 }).maxBodyBytes).toBe(EVIDENCE_MAX_BODY_BYTES);
        expect(resolveEvidenceFetchLimits({ maxBodyBytes: -1 }).maxBodyBytes).toBe(EVIDENCE_MAX_BODY_BYTES);
    });

    it.each([
        ['a string', '5000'],
        ['null', null],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['an object', {}],
    ])('falls back to the reviewed timeout when timeoutMs is %s', (_case, timeoutMs) => {
        expect(resolveEvidenceFetchLimits({ timeoutMs }).timeoutMs).toBe(EVIDENCE_FETCH_TIMEOUT_MS);
    });

    it('never reports the cross-host redirect rule as configurable', () => {
        expect(resolveEvidenceFetchLimits({ allowCrossHostRedirect: true }).allowCrossHostRedirect).toBe(false);
        expect(resolveEvidenceFetchLimits(committedPolicy.fetchLimits).allowCrossHostRedirect).toBe(false);
    });

    it('resolves the committed limits to exactly the reviewed policy', () => {
        expect(resolveEvidenceFetchLimits(committedPolicy.fetchLimits)).toStrictEqual({
            schemes: ['https'],
            allowedPorts: [443],
            maxRedirects: 2,
            timeoutMs: 10_000,
            maxBodyBytes: 1_048_576,
            allowedContentTypes: ['text/html', 'application/json', 'text/plain'],
            maxSnippetChars: 500,
            allowCrossHostRedirect: false,
        });
    });
});

describe('isAllowedContentType', () => {
    it.each(EVIDENCE_ALLOWED_CONTENT_TYPES)('permits %s', (mediaType) => {
        expect(isAllowedContentType(mediaType)).toBe(true);
    });

    it.each([
        ['a charset parameter', 'text/html; charset=utf-8'],
        ['a parameter without a space', 'application/json;charset=utf-8'],
        ['upper case', 'TEXT/HTML'],
        ['surrounding whitespace', '  text/plain  '],
        ['whitespace before the parameter', 'text/html ; charset=utf-8'],
    ])('permits a permitted media type carrying %s', (_case, headerValue) => {
        // Parameters are not part of the media type, so they cannot change what
        // the type is — nor can they be used to smuggle a type past the check.
        expect(isAllowedContentType(headerValue)).toBe(true);
    });

    it.each([
        ['a disallowed type', 'application/pdf'],
        ['a disallowed type with a parameter', 'application/pdf; charset=utf-8'],
        ['xml', 'text/xml'],
        ['an octet stream', 'application/octet-stream'],
        ['an empty string', ''],
        ['a bare parameter', '; charset=utf-8'],
        ['a type that merely starts the same way', 'text/htmlx'],
    ])('refuses %s', (_case, headerValue) => {
        expect(isAllowedContentType(headerValue)).toBe(false);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a number', 42],
        ['an object', {}],
    ])('refuses a header that is %s — an unlabelled body is not a permitted one', (_case, headerValue) => {
        expect(isAllowedContentType(headerValue as unknown as string)).toBe(false);
    });

    it('honours a narrowed declaration', () => {
        const narrowed = { allowedContentTypes: ['text/html'] };

        expect(isAllowedContentType('text/html', narrowed)).toBe(true);
        expect(isAllowedContentType('application/json', narrowed)).toBe(false);
    });

    it('permits nothing when the declaration is malformed', () => {
        expect(isAllowedContentType('text/html', 'not-an-object')).toBe(false);
    });
});

describe('isWithinBodyCap', () => {
    it('is inclusive at the cap and refuses one byte more', () => {
        expect(isWithinBodyCap(EVIDENCE_MAX_BODY_BYTES - 1)).toBe(true);
        expect(isWithinBodyCap(EVIDENCE_MAX_BODY_BYTES)).toBe(true);
        expect(isWithinBodyCap(EVIDENCE_MAX_BODY_BYTES + 1)).toBe(false);
    });

    it('accepts an empty body and refuses a negative count', () => {
        expect(isWithinBodyCap(0)).toBe(true);
        expect(isWithinBodyCap(-1)).toBe(false);
    });

    it.each([
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['a string', '100'],
        ['null', null],
        ['undefined', undefined],
    ])('refuses a byte count that is %s', (_case, count) => {
        expect(isWithinBodyCap(count as unknown as number)).toBe(false);
    });

    it('honours a narrowed cap', () => {
        expect(isWithinBodyCap(4_096, { maxBodyBytes: 4_096 })).toBe(true);
        expect(isWithinBodyCap(4_097, { maxBodyBytes: 4_096 })).toBe(false);
    });

    it('ignores a declaration that tries to widen the cap', () => {
        expect(isWithinBodyCap(EVIDENCE_MAX_BODY_BYTES + 1, { maxBodyBytes: 1_073_741_824 })).toBe(false);
    });
});


// ---------------------------------------------------------------------------
// Host normalisation and allowlist matching.
// ---------------------------------------------------------------------------

describe('classifyEvidenceHost', () => {
    it.each([
        ['a plain host', 'nal.usda.gov', 'nal.usda.gov'],
        ['an upper-case host', 'NAL.USDA.GOV', 'nal.usda.gov'],
        ['a mixed-case host', 'Nal.Usda.Gov', 'nal.usda.gov'],
        ['a single trailing dot', 'nal.usda.gov.', 'nal.usda.gov'],
        ['a unicode host', '例え.テスト', 'xn--r8jz45g.xn--zckzah'],
        ['an already-punycoded host', 'xn--r8jz45g.xn--zckzah', 'xn--r8jz45g.xn--zckzah'],
        ['a hyphenated host', 'food-nutrition.canada.ca', 'food-nutrition.canada.ca'],
        ['a deep subdomain', 'a.b.c.example.gov', 'a.b.c.example.gov'],
    ])('normalises %s to %s', (_case, host, normalized) => {
        expect(classifyEvidenceHost(host)).toStrictEqual({ ok: true, host: normalized });
        expect(normalizeEvidenceHost(host)).toBe(normalized);
    });

    it.each([
        ['a replacement character', '\uFFFD.gov'],
        ['a space', 'exam ple.gov'],
        ['a double-width space', 'exam\u3000ple.gov'],
        ['a trailing space', 'nal.usda.gov '],
        ['a port', 'nal.usda.gov:443'],
        ['a bare colon', 'nal.usda.gov:'],
        ['userinfo', 'user@nal.usda.gov'],
        ['a percent escape', 'nal.usda.gov%2f'],
    ])('reports idna_conversion_failed for a host with %s', (_case, host) => {
        expect(classifyEvidenceHost(host)).toStrictEqual({ ok: false, reason: 'idna_conversion_failed' });
        expect(normalizeEvidenceHost(host)).toBeNull();
    });

    it.each([
        ['a single label', 'localhost'],
        ['a bare TLD', 'gov'],
        ['two trailing dots', 'nal.usda.gov..'],
        ['an empty label', 'nal..gov'],
        ['a leading dot', '.usda.gov'],
        ['an underscore', 'exam_ple.gov'],
        ['an asterisk', '*.usda.gov'],
        ['an empty string', ''],
    ])('reports malformed_host for %s', (_case, host) => {
        // The two-label minimum is why a bare `localhost` never reaches a lookup.
        expect(classifyEvidenceHost(host)).toStrictEqual({ ok: false, reason: 'malformed_host' });
        expect(normalizeEvidenceHost(host)).toBeNull();
    });

    it('never derives a host from a URL-delimited string, and never accepts one as an entry', () => {
        // `url.domainToASCII` stops at a host terminator, so handed the string
        // "nal.usda.gov/fdc" it answers "nal.usda.gov" — a normalisation that
        // silently widens what counts as a host. Nothing reaches it that way:
        // parseEvidenceUrl hands it a WHATWG hostname, which cannot contain a
        // delimiter, and an allowlist entry written with one is refused because
        // it is not already in normal form. Those are the two invariants that
        // keep the laxness unreachable, so they are pinned here rather than the
        // truncation being asserted as if it were intended.
        for (const entry of ['nal.usda.gov/fdc', 'nal.usda.gov?a=1', 'nal.usda.gov#x', 'nal.usda.gov\\evil.com']) {
            expect(isValidEvidenceHostEntry(entry)).toBe(false);
        }

        const verdict = parseEvidenceUrl('https://nal.usda.gov/fdc/food.html');

        expect(verdict.allowed).toBe(true);
        if (verdict.allowed) {
            expect(verdict.host).toBe('nal.usda.gov');
        }
    });

    it('reports malformed_host for a non-string', () => {
        expect(classifyEvidenceHost(null as unknown as string)).toStrictEqual({
            ok: false,
            reason: 'malformed_host',
        });
        expect(classifyEvidenceHost(42 as unknown as string)).toStrictEqual({ ok: false, reason: 'malformed_host' });
    });

    it('normalises a host RFC 1123 would not call a hostname, and leaves the allowlist to refuse it', () => {
        // Documented, not a gap: normalisation decides what a host *is*, and the
        // hand-curated allowlist decides whether it may be fetched.
        expect(classifyEvidenceHost('-bad.gov')).toStrictEqual({ ok: true, host: '-bad.gov' });
        expect(isHostAllowed('-bad.gov', committedHostClasses, 'canonical_identity')).toBe(false);
    });

    it('is the same predicate EVIDENCE_HOST_PATTERN states', () => {
        expect(EVIDENCE_HOST_PATTERN.test('nal.usda.gov')).toBe(true);
        expect(EVIDENCE_HOST_PATTERN.test('localhost')).toBe(false);
        expect(EVIDENCE_HOST_PATTERN.test('NAL.USDA.GOV')).toBe(false);
    });
});

describe('isIpLiteralHost', () => {
    it.each([
        ['an IPv4 literal', '10.0.0.1'],
        ['a public IPv4 literal', '93.184.216.34'],
        ['an unbracketed IPv6 literal', '::1'],
        ['a bracketed IPv6 literal', '[::1]'],
        ['a bracketed IPv6 literal with a zone-like tail', '[fe80::1]'],
        ['a string that merely ends in a bracket', '2001:db8::1]'],
    ])('recognises %s as an address', (_case, host) => {
        // URL syntax brackets an IPv6 literal, so a bracketed host is an address
        // however its contents parse.
        expect(isIpLiteralHost(host)).toBe(true);
    });

    it.each([
        ['a named host', 'nal.usda.gov'],
        ['a single label', 'localhost'],
        ['a decimal integer', '2130706433'],
        ['a hexadecimal literal', '0x7f000001'],
        ['an empty string', ''],
    ])('does not treat %s as an address', (_case, host) => {
        // The decimal and hexadecimal forms are refused by parseIpAddress, and
        // the WHATWG URL parser folds them into dotted-quad form before this
        // check ever sees them — which is where they are caught.
        expect(isIpLiteralHost(host)).toBe(false);
    });

    it('does not treat a non-string as an address', () => {
        expect(isIpLiteralHost(null as unknown as string)).toBe(false);
    });
});

describe('hostMatchesEntry', () => {
    it.each([
        ['nal.usda.gov', 'nal.usda.gov'],
        ['NAL.USDA.GOV', 'nal.usda.gov'],
        ['nal.usda.gov.', 'nal.usda.gov'],
    ])('matches %s against the exact entry %s', (host, entry) => {
        expect(hostMatchesEntry(host, entry)).toBe(true);
    });

    it.each([
        ['a subdomain', 'fdc.nal.usda.gov', 'nal.usda.gov'],
        ['a parent domain', 'usda.gov', 'nal.usda.gov'],
        ['a host that merely ends the same way', 'evilnal.usda.gov', 'nal.usda.gov'],
        ['a host with the entry in the middle', 'nal.usda.gov.evil.com', 'nal.usda.gov'],
    ])('does not match %s against an exact entry', (_case, host, entry) => {
        // `host.endsWith('.example.gov')` is the bug this function exists to
        // prevent, and `host.includes(...)` is worse.
        expect(hostMatchesEntry(host, entry)).toBe(false);
    });

    it.each([
        ['one extra label', 'fdc.example.gov'],
        ['two extra labels', 'a.b.example.gov'],
        ['an upper-case host', 'FDC.EXAMPLE.GOV'],
        ['a trailing dot', 'fdc.example.gov.'],
    ])('matches a host with %s against *.example.gov', (_case, host) => {
        expect(hostMatchesEntry(host, '*.example.gov')).toBe(true);
    });

    it.each([
        ['the bare domain itself', 'example.gov'],
        ['a different leading label spelled together', 'notexample.gov'],
        ['the labels in the wrong place', 'example.gov.evil.com'],
        ['a different domain', 'example.org'],
        ['a suffix of the domain', 'gov'],
    ])('does not match %s against *.example.gov', (_case, host) => {
        expect(hostMatchesEntry(host, '*.example.gov')).toBe(false);
    });

    it('does not match when the entry itself is unusable', () => {
        expect(hostMatchesEntry('fdc.example.gov', '*.')).toBe(false);
        expect(hostMatchesEntry('fdc.example.gov', '*')).toBe(false);
        expect(hostMatchesEntry('fdc.example.gov', '')).toBe(false);
        expect(hostMatchesEntry('fdc.example.gov', 'exam ple.gov')).toBe(false);
        expect(hostMatchesEntry('fdc.example.gov', null as unknown as string)).toBe(false);
        expect(hostMatchesEntry('fdc.example.gov', 42 as unknown as string)).toBe(false);
    });

    it('does not match when the host itself is unusable', () => {
        expect(hostMatchesEntry('', 'example.gov')).toBe(false);
        expect(hostMatchesEntry('localhost', 'example.gov')).toBe(false);
        expect(hostMatchesEntry('\uFFFD.gov', '*.gov.uk')).toBe(false);
        expect(hostMatchesEntry(null as unknown as string, 'example.gov')).toBe(false);
    });
});

describe('isValidEvidenceHostEntry', () => {
    it.each([
        'nal.usda.gov',
        '*.nal.usda.gov',
        'www.ars.usda.gov',
        'food-nutrition.canada.ca',
        'nutritionsource.hsph.harvard.edu',
        'xn--r8jz45g.xn--zckzah',
    ])('accepts the entry %s', (entry) => {
        expect(isValidEvidenceHostEntry(entry)).toBe(true);
    });

    it.each(committedHostClasses.flatMap((hostClass) => hostClass.hosts))(
        'accepts the committed entry %s',
        (entry) => {
            expect(isValidEvidenceHostEntry(entry)).toBe(true);
        },
    );

    it.each([
        ['an empty string', ''],
        ['leading whitespace', ' nal.usda.gov'],
        ['trailing whitespace', 'nal.usda.gov '],
        ['upper case', 'NAL.usda.gov'],
        ['a trailing dot', 'nal.usda.gov.'],
        ['a bare label', 'localhost'],
        ['a bare TLD', 'gov'],
        ['a wildcard on a bare TLD', '*.gov'],
        ['a wildcard with no base', '*.'],
        ['a URL', 'https://nal.usda.gov'],
        ['a port', 'nal.usda.gov:443'],
        ['userinfo', 'user@nal.usda.gov'],
        ['a path', 'nal.usda.gov/fdc'],
        ['an IPv4 literal', '10.0.0.1'],
        ['a wildcarded IPv4 literal', '*.10.0.0.1'],
        ['a bracketed IPv6 literal', '[::1]'],
        ['an underscore', 'exam_ple.gov'],
        ['a double wildcard', '*.*.usda.gov'],
    ])('refuses an entry written as %s', (_case, entry) => {
        // An entry that would need repairing is an entry nobody read carefully,
        // so it is refused rather than normalised on the reviewer's behalf.
        expect(isValidEvidenceHostEntry(entry)).toBe(false);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a number', 443],
        ['an object', { host: 'nal.usda.gov' }],
        ['a list', ['nal.usda.gov']],
    ])('refuses an entry that is %s', (_case, entry) => {
        expect(isValidEvidenceHostEntry(entry)).toBe(false);
    });
});

describe('findEvidenceHostClassForHost', () => {
    it.each([
        ['nal.usda.gov', 'usda_fdc'],
        ['fdc.nal.usda.gov', 'usda_fdc'],
        ['www.ars.usda.gov', 'usda_fdc'],
        ['www.fda.gov', 'government_nutrition_reference'],
        ['nchfp.uga.edu', 'university_nutrition_reference'],
        ['www.britannica.com', 'named_culinary_reference'],
    ])('finds the class admitting %s', (host, className) => {
        expect(evidenceHostClassId(findEvidenceHostClassForHost(host, committedHostClasses))).toBe(className);
    });

    it.each([
        ['a host nobody allowlisted', 'evil.com'],
        ['a parent of an allowlisted host', 'usda.gov'],
        ['a lookalike of an allowlisted host', 'nal-usda.gov'],
        ['an allowlisted host used as a prefix', 'nal.usda.gov.evil.com'],
        ['a malformed host', 'localhost'],
    ])('answers null for %s', (_case, host) => {
        expect(findEvidenceHostClassForHost(host, committedHostClasses)).toBeNull();
    });

    it('ignores classes and entries it cannot read', () => {
        const classes = [
            null,
            'not-a-class',
            42,
            { class: 'no-hosts' },
            { class: 'hosts-not-a-list', hosts: 'nal.usda.gov' },
            { class: 'entry-not-a-string', hosts: [42, null] },
            { class: 'real', hosts: ['nal.usda.gov'], evidenceTypes: ['canonical_identity'] },
        ] as unknown as EvidenceHostClass[];

        expect(evidenceHostClassId(findEvidenceHostClassForHost('nal.usda.gov', classes))).toBe('real');
    });

    it('answers null when the class list is not a list', () => {
        expect(findEvidenceHostClassForHost('nal.usda.gov', null as unknown as EvidenceHostClass[])).toBeNull();
    });
});

describe('hostClassAuthorizesEvidenceType', () => {
    const classOf = (className: string): EvidenceHostClass => {
        const found = committedHostClasses.filter((hostClass) => hostClass.class === className);
        if (found.length !== 1) {
            throw new Error(`the committed document no longer carries exactly one "${className}" class`);
        }
        return found[0];
    };

    it.each([
        ['usda_fdc', 'nutrition_reference'],
        ['usda_fdc', 'allergen_composition'],
        ['government_nutrition_reference', 'nutrition_reference'],
        ['university_nutrition_reference', 'preparation_method'],
        ['named_culinary_reference', 'canonical_identity'],
        ['named_culinary_reference', 'preparation_method'],
        ['named_culinary_reference', 'portion_reference'],
    ])('authorizes %s for %s', (className, evidenceType) => {
        expect(hostClassAuthorizesEvidenceType(classOf(className), evidenceType as EvidenceType)).toBe(true);
    });

    it.each([
        ['named_culinary_reference', 'nutrition_reference'],
        ['named_culinary_reference', 'allergen_composition'],
        ['named_culinary_reference', 'food_classification'],
        ['university_nutrition_reference', 'allergen_composition'],
        ['government_nutrition_reference', 'preparation_method'],
    ])('does not authorize %s for %s', (className, evidenceType) => {
        // A named culinary reference may establish what a dish is without being
        // an authority on its nutrition or its allergens.
        expect(hostClassAuthorizesEvidenceType(classOf(className), evidenceType as EvidenceType)).toBe(false);
    });

    it.each([
        ['a null class', null],
        ['a class with no evidenceTypes', { class: 'x', hosts: ['a.gov'] }],
        ['a class whose evidenceTypes is not a list', { class: 'x', hosts: ['a.gov'], evidenceTypes: 'all' }],
        ['a class with an empty evidenceTypes', { class: 'x', hosts: ['a.gov'], evidenceTypes: [] }],
        ['a class declaring an invented type', { class: 'x', hosts: ['a.gov'], evidenceTypes: ['everything'] }],
        ['a class that is not an object', 'usda_fdc'],
    ])('authorizes nothing for %s', (_case, hostClass) => {
        // An unstated scope is not an unlimited one.
        expect(hostClassAuthorizesEvidenceType(hostClass as unknown as EvidenceHostClass, 'canonical_identity')).toBe(
            false,
        );
    });

    it('refuses a claim the reviewed vocabulary does not contain', () => {
        expect(hostClassAuthorizesEvidenceType(classOf('usda_fdc'), 'invented_claim' as unknown as EvidenceType)).toBe(
            false,
        );
    });
});

describe('isEvidenceType', () => {
    it.each(EVIDENCE_TYPES)('accepts the reviewed type %s', (evidenceType) => {
        expect(isEvidenceType(evidenceType)).toBe(true);
    });

    it.each([
        ['an invented type', 'nutrition'],
        ['a near miss', 'canonical-identity'],
        ['an empty string', ''],
        ['a number', 1],
        ['null', null],
        ['undefined', undefined],
        ['an object', { type: 'canonical_identity' }],
        ['a list', ['canonical_identity']],
    ])('refuses %s', (_case, value) => {
        expect(isEvidenceType(value)).toBe(false);
    });
});

describe('matchEvidenceHostClass and isHostAllowed', () => {
    it('returns the class that admits the host for the claim being made', () => {
        expect(
            evidenceHostClassId(matchEvidenceHostClass('nal.usda.gov', committedHostClasses, 'nutrition_reference')),
        ).toBe('usda_fdc');
        expect(isHostAllowed('nal.usda.gov', committedHostClasses, 'nutrition_reference')).toBe(true);
    });

    it('refuses an allowlisted host for a claim its class does not authorize', () => {
        expect(matchEvidenceHostClass('www.britannica.com', committedHostClasses, 'nutrition_reference')).toBeNull();
        expect(isHostAllowed('www.britannica.com', committedHostClasses, 'nutrition_reference')).toBe(false);
        // ...while the same host is admitted for the claims it is trusted with.
        expect(isHostAllowed('www.britannica.com', committedHostClasses, 'canonical_identity')).toBe(true);
    });

    it('refuses a host nobody allowlisted for any claim', () => {
        for (const evidenceType of EVIDENCE_TYPES) {
            expect(isHostAllowed('evil.com', committedHostClasses, evidenceType)).toBe(false);
        }
    });

    it('refuses an evidence type outside the reviewed vocabulary', () => {
        expect(
            matchEvidenceHostClass('nal.usda.gov', committedHostClasses, 'invented' as unknown as EvidenceType),
        ).toBeNull();
    });

    it('skips a class that does not authorize the claim and keeps looking', () => {
        const classes = [
            { class: 'culinary', hosts: ['shared.example.gov'], evidenceTypes: ['canonical_identity'] },
            { class: 'nutrition', hosts: ['shared.example.gov'], evidenceTypes: ['nutrition_reference'] },
        ] as unknown as EvidenceHostClass[];

        // Overlapping entries grant the union of their claims and never more.
        expect(evidenceHostClassId(matchEvidenceHostClass('shared.example.gov', classes, 'canonical_identity'))).toBe(
            'culinary',
        );
        expect(evidenceHostClassId(matchEvidenceHostClass('shared.example.gov', classes, 'nutrition_reference'))).toBe(
            'nutrition',
        );
        expect(matchEvidenceHostClass('shared.example.gov', classes, 'allergen_composition')).toBeNull();
    });

    it('ignores classes and entries it cannot read', () => {
        const classes = [
            null,
            'not-a-class',
            { class: 'hosts-not-a-list', hosts: 7, evidenceTypes: ['canonical_identity'] },
            { class: 'entry-not-a-string', hosts: [null], evidenceTypes: ['canonical_identity'] },
            { class: 'real', hosts: ['a.example.gov'], evidenceTypes: ['canonical_identity'] },
        ] as unknown as EvidenceHostClass[];

        expect(evidenceHostClassId(matchEvidenceHostClass('a.example.gov', classes, 'canonical_identity'))).toBe(
            'real',
        );
        expect(matchEvidenceHostClass('a.example.gov', null as unknown as EvidenceHostClass[], 'canonical_identity'))
            .toBeNull();
    });

    it('admits nothing at all when the allowlist is empty', () => {
        // The fail-closed shape of a truncated or over-filtered document: an
        // empty list allowlists no host, so it authorizes no claim. "No entry
        // objected" must never read as "permitted".
        for (const evidenceType of EVIDENCE_TYPES) {
            expect(matchEvidenceHostClass('nal.usda.gov', [], evidenceType)).toBeNull();
            expect(isHostAllowed('nal.usda.gov', [], evidenceType)).toBe(false);
        }
    });
});

describe('evidenceHostClassId', () => {
    it('answers the identifier of a real class', () => {
        expect(evidenceHostClassId(committedHostClasses[0])).toBe('usda_fdc');
    });

    it.each([
        ['null', null],
        ['a class with no identifier', { hosts: ['a.gov'] }],
        ['a class with an empty identifier', { class: '', hosts: ['a.gov'] }],
        ['a class with a numeric identifier', { class: 7, hosts: ['a.gov'] }],
        ['a value that is not an object', 'usda_fdc'],
        ['a list', []],
    ])('answers null for %s rather than inventing a name', (_case, hostClass) => {
        expect(evidenceHostClassId(hostClass as unknown as EvidenceHostClass)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// URL policy.
// ---------------------------------------------------------------------------

const urlRejection = (verdict: ReturnType<typeof parseEvidenceUrl>): { reason: string; detail: string } => {
    if (verdict.allowed) {
        throw new Error(`expected the URL to be refused, but it was allowed as ${verdict.url}`);
    }
    return { reason: verdict.reason, detail: verdict.detail };
};

describe('parseEvidenceUrl', () => {
    it('accepts an https URL on a named host and returns the href to fetch', () => {
        const verdict = parseEvidenceUrl('https://nal.usda.gov/fdc/food.html?id=1');

        expect(verdict).toStrictEqual({
            allowed: true,
            url: 'https://nal.usda.gov/fdc/food.html?id=1',
            host: 'nal.usda.gov',
            // parseEvidenceUrl does not consult the allowlist; evaluateEvidenceUrl does.
            hostClass: null,
        });
    });

    it.each([
        ['drops the fragment, which is never sent to the server', 'https://nal.usda.gov/a#section', 'https://nal.usda.gov/a'],
        ['normalises the default port away', 'https://nal.usda.gov:443/a', 'https://nal.usda.gov/a'],
        ['lower-cases the host but not the path', 'https://NAL.USDA.GOV/Food.HTML', 'https://nal.usda.gov/Food.HTML'],
        ['strips a single trailing dot from the host', 'https://nal.usda.gov./a', 'https://nal.usda.gov/a'],
        ['keeps the query string', 'https://nal.usda.gov/a?b=1&c=2', 'https://nal.usda.gov/a?b=1&c=2'],
        ['adds the root path', 'https://nal.usda.gov', 'https://nal.usda.gov/'],
    ])('%s', (_case, rawUrl, expected) => {
        // Judging one string and opening a socket on another is the
        // parser-confusion class of bypass; returning the exact href to fetch
        // closes it by construction.
        const verdict = parseEvidenceUrl(rawUrl);

        expect(verdict.allowed).toBe(true);
        if (verdict.allowed) {
            expect(verdict.url).toBe(expected);
        }
    });

    it('accepts a unicode host in its punycoded form', () => {
        const verdict = parseEvidenceUrl('https://例え.テスト/a');

        expect(verdict.allowed).toBe(true);
        if (verdict.allowed) {
            expect(verdict.host).toBe('xn--r8jz45g.xn--zckzah');
        }
    });

    it.each([
        ['an empty string', '', 'the URL is empty'],
        ['whitespace only', '   ', 'the URL is empty'],
        ['a bare host', 'nal.usda.gov', 'the URL could not be parsed'],
        ['nonsense', 'not a url at all', 'the URL could not be parsed'],
        ['a scheme with no host', 'https://', 'the URL could not be parsed'],
        ['an unterminated IPv6 literal', 'https://[::1', 'the URL could not be parsed'],
        ['a host that fails IDNA conversion', 'https://xn--a.gov/', 'the URL could not be parsed'],
    ])('refuses %s as unparseable', (_case, rawUrl, detail) => {
        // The WHATWG parser refuses an IDNA-failing host outright, so a whole
        // URL reports unparseable_url where a bare host reports
        // idna_conversion_failed. Both refuse; only the recorded cause differs.
        expect(urlRejection(parseEvidenceUrl(rawUrl))).toStrictEqual({ reason: 'unparseable_url', detail });
    });

    it('refuses a non-string URL', () => {
        expect(urlRejection(parseEvidenceUrl(null as unknown as string)).reason).toBe('unparseable_url');
        expect(urlRejection(parseEvidenceUrl(42 as unknown as string)).reason).toBe('unparseable_url');
    });

    it.each([
        ['http', 'http://nal.usda.gov/a'],
        ['ftp', 'ftp://nal.usda.gov/a'],
        ['file', 'file:///etc/passwd'],
        ['gopher', 'gopher://nal.usda.gov/a'],
        ['data', 'data:text/plain,hello'],
        ['javascript', 'javascript:alert(1)'],
    ])('refuses the %s scheme', (scheme, rawUrl) => {
        expect(urlRejection(parseEvidenceUrl(rawUrl))).toStrictEqual({
            reason: 'scheme_not_allowed',
            detail: `scheme "${scheme}" is not permitted`,
        });
    });

    it.each([
        ['a user and a password', 'https://user:pass@nal.usda.gov/a'],
        ['a user only', 'https://user@nal.usda.gov/a'],
        ['a password only', 'https://:pass@nal.usda.gov/a'],
        ['an allowlisted host as the username', 'https://nal.usda.gov@evil.com/a'],
    ])('refuses a URL carrying %s', (_case, rawUrl) => {
        // `https://allowed.gov@evil.com/` is the classic parser-confusion
        // payload, and credentials in a model-proposed URL are a signal in
        // themselves — so userinfo is refused outright, never stripped.
        expect(urlRejection(parseEvidenceUrl(rawUrl))).toStrictEqual({
            reason: 'credentials_present',
            detail: 'the URL carries userinfo',
        });
    });

    /**
     * The policy refuses userinfo unconditionally, and an EMPTY userinfo
     * component is the form that survives a check on the parsed fields: `URL`
     * removes it, so every one of these arrives with `username` and `password`
     * both `''` and a host of `nal.usda.gov`. The delimiter is what matters —
     * it is what makes a reader or a differing parser take the wrong side of
     * the `@` for the host — so the raw authority is what decides.
     *
     * The list walks the parser's own tolerances: a special scheme reaches its
     * authority through none, one, two or many slashes and through backslashes,
     * and WHATWG parsing strips surrounding C0 controls and spaces and removes
     * tabs and newlines from anywhere in the input before reading any structure.
     */
    it.each([
        ['an empty userinfo', 'https://@nal.usda.gov/a'],
        ['an empty user and password', 'https://:@nal.usda.gov/a'],
        ['a lone colon as userinfo', 'https://:@nal.usda.gov'],
        ['no authority slashes', 'https:@nal.usda.gov/a'],
        ['one authority slash', 'https:/@nal.usda.gov/a'],
        ['three authority slashes', 'https:///@nal.usda.gov/a'],
        ['backslashes for authority slashes', 'https:\\\\@nal.usda.gov/a'],
        ['a backslash before the delimiter', 'https://nal.usda.gov\\@evil.com/a'],
        ['surrounding whitespace', '  https://@nal.usda.gov/a  '],
        ['an embedded tab', 'https://\t@nal.usda.gov/a'],
        ['an embedded newline', 'https://\n@nal.usda.gov/a'],
        ['an embedded carriage return', 'https://@nal.usda.gov\r/a'],
    ])('refuses a URL with %s, which the parser would normalize away', (_case, rawUrl) => {
        expect(urlRejection(parseEvidenceUrl(rawUrl))).toStrictEqual({
            reason: 'credentials_present',
            detail: 'the URL carries userinfo',
        });
    });

    /**
     * An `@` is ordinary text everywhere except authority position, and a
     * reference page can perfectly well be at `/@handle`. Refusing those would
     * be a false positive, so the scan stops at the first `/`, `?` or `#`.
     */
    it.each([
        ['a path', 'https://nal.usda.gov/@handle'],
        ['deeper in a path', 'https://nal.usda.gov/food/a@b'],
        ['a query', 'https://nal.usda.gov/food?contact=a@b'],
        ['a fragment', 'https://nal.usda.gov/food#a@b'],
        ['a path containing a backslash', 'https://nal.usda.gov/food\\a@b'],
    ])('accepts a URL whose @ is in %s', (_case, rawUrl) => {
        const verdict = parseEvidenceUrl(rawUrl);

        expect(verdict.allowed).toBe(true);
        if (verdict.allowed) {
            expect(verdict.host).toBe('nal.usda.gov');
        }
    });

    it.each([
        ['8080', 'https://nal.usda.gov:8080/a'],
        ['8443', 'https://nal.usda.gov:8443/a'],
        ['80', 'https://nal.usda.gov:80/a'],
        ['22', 'https://nal.usda.gov:22/a'],
    ])('refuses port %s', (port, rawUrl) => {
        // This is what stops `https://` from being pointed at an internal
        // service on 8080.
        expect(urlRejection(parseEvidenceUrl(rawUrl))).toStrictEqual({
            reason: 'port_not_allowed',
            detail: `port ${port} is not permitted`,
        });
    });

    it.each([
        ['an IPv4 literal', 'https://10.0.0.1/a'],
        ['a public IPv4 literal', 'https://93.184.216.34/a'],
        ['a bracketed IPv6 literal', 'https://[::1]/a'],
        ['a decimal-integer host', 'https://2130706433/a'],
        ['a hexadecimal host', 'https://0x7f000001/a'],
    ])('refuses %s as an address where a name belongs', (_case, rawUrl) => {
        // The parser folds the obfuscated numeric forms into dotted-quad form,
        // where the IP-literal check refuses them.
        expect(urlRejection(parseEvidenceUrl(rawUrl))).toStrictEqual({
            reason: 'ip_literal_host',
            detail: 'evidence must come from a named host, not an address',
        });
    });

    it.each([
        ['a single-label host', 'https://localhost/a'],
        ['an underscore host', 'https://exam_ple.gov/a'],
        ['a double trailing dot', 'https://nal.usda.gov../a'],
    ])('refuses %s as a malformed host', (_case, rawUrl) => {
        expect(urlRejection(parseEvidenceUrl(rawUrl))).toStrictEqual({
            reason: 'malformed_host',
            detail: 'the host is not a dotted ASCII name',
        });
    });

    it('permits nothing when the declared limits are malformed', () => {
        // A corrupt document narrows the policy to nothing rather than raising.
        expect(urlRejection(parseEvidenceUrl('https://nal.usda.gov/a', 'not-an-object')).reason).toBe(
            'scheme_not_allowed',
        );
        expect(urlRejection(parseEvidenceUrl('https://nal.usda.gov/a', { allowedPorts: 'all' })).reason).toBe(
            'port_not_allowed',
        );
    });

    it('honours the committed limits', () => {
        expect(parseEvidenceUrl('https://nal.usda.gov/a', committedPolicy.fetchLimits).allowed).toBe(true);
        expect(parseEvidenceUrl('http://nal.usda.gov/a', committedPolicy.fetchLimits).allowed).toBe(false);
    });
});

describe('evaluateEvidenceUrl', () => {
    it.each([
        ['nal.usda.gov', 'nutrition_reference', 'usda_fdc'],
        ['fdc.nal.usda.gov', 'canonical_identity', 'usda_fdc'],
        ['www.fda.gov', 'allergen_composition', 'government_nutrition_reference'],
        ['nchfp.uga.edu', 'preparation_method', 'university_nutrition_reference'],
        ['www.britannica.com', 'canonical_identity', 'named_culinary_reference'],
    ])('allows https://%s for %s and names the class %s', (host, evidenceType, className) => {
        const verdict = evaluateEvidenceUrl(`https://${host}/page`, committedPolicy, evidenceType as EvidenceType);

        expect(verdict).toStrictEqual({
            allowed: true,
            url: `https://${host}/page`,
            host,
            hostClass: className,
        });
    });

    it('refuses a host nobody allowlisted', () => {
        expect(urlRejection(evaluateEvidenceUrl('https://evil.com/page', committedPolicy, 'canonical_identity')))
            .toStrictEqual({
                reason: 'host_not_allowlisted',
                detail: 'host "evil.com" is not on the evidence allowlist',
            });
    });

    it.each([
        ['www.britannica.com', 'nutrition_reference', 'named_culinary_reference'],
        ['www.britannica.com', 'allergen_composition', 'named_culinary_reference'],
        ['www.fns.usda.gov', 'preparation_method', 'government_nutrition_reference'],
        ['nchfp.uga.edu', 'allergen_composition', 'university_nutrition_reference'],
    ])('refuses %s as a source of %s, naming the class that does admit it', (host, evidenceType, className) => {
        // Distinct from host_not_allowlisted on purpose: the host is
        // allowlisted, for other claims, and the operator's next move differs.
        const rejection = urlRejection(
            evaluateEvidenceUrl(`https://${host}/page`, committedPolicy, evidenceType as EvidenceType),
        );

        expect(rejection.reason).toBe('evidence_type_not_authorized');
        expect(rejection.detail).toBe(
            `host "${host}" is allowlisted as ${className} but is not a source of ${evidenceType} evidence`,
        );
    });

    it('refuses a claim outside the reviewed vocabulary', () => {
        const rejection = urlRejection(
            evaluateEvidenceUrl('https://nal.usda.gov/page', committedPolicy, 'invented' as unknown as EvidenceType),
        );

        expect(rejection.reason).toBe('evidence_type_not_authorized');
        expect(rejection.detail).toBe('"invented" is not one of the reviewed evidence types');
    });

    it('applies the URL policy before the allowlist', () => {
        expect(urlRejection(evaluateEvidenceUrl('http://nal.usda.gov/a', committedPolicy, 'canonical_identity')).reason)
            .toBe('scheme_not_allowed');
        expect(
            urlRejection(evaluateEvidenceUrl('https://user@nal.usda.gov/a', committedPolicy, 'canonical_identity'))
                .reason,
        ).toBe('credentials_present');
    });

    /**
     * The entry point the service actually calls, so the empty-userinfo refusal
     * is pinned on the path a candidate URL really travels — not only on
     * `parseEvidenceUrl` in isolation. The host here is allowlisted, so nothing
     * else in the chain would have stopped it.
     */
    it.each([
        ['an empty userinfo', 'https://@nal.usda.gov/a'],
        ['an empty user and password', 'https://:@nal.usda.gov/a'],
        ['a backslash before the delimiter', 'https://nal.usda.gov\\@evil.com/a'],
    ])('refuses a candidate URL with %s', (_case, rawUrl) => {
        expect(urlRejection(evaluateEvidenceUrl(rawUrl, committedPolicy, 'canonical_identity'))).toStrictEqual({
            reason: 'credentials_present',
            detail: 'the URL carries userinfo',
        });
    });

    it('refuses the candidate when the policy document cannot be trusted', () => {
        // A different fact about the world than "the candidate is disallowed",
        // and recorded as one: the candidate was never judged.
        const stale = { ...cloneDocument(), registrySnapshot: '2020-01-01' } as unknown as EvidencePolicy;
        const rejection = urlRejection(evaluateEvidenceUrl('https://nal.usda.gov/a', stale, 'canonical_identity'));

        expect(rejection.reason).toBe('policy_invalid');
        expect(rejection.detail).toContain('not the reviewed 2026-09-08');
    });

    it('reports a corrupted address table distinctly from a corrupted document', () => {
        const flipped = {
            ...cloneDocument(),
            specialPurposeRanges: tableWithRow('169.254.0.0/16', { globallyReachable: true }),
        } as unknown as EvidencePolicy;

        expect(urlRejection(evaluateEvidenceUrl('https://nal.usda.gov/a', flipped, 'canonical_identity')).reason).toBe(
            'range_table_unclassifiable',
        );
    });
});

describe('evaluateEvidenceRedirect', () => {
    const redirect = (
        currentUrl: string,
        location: string,
        redirectCount: number,
        policy: EvidencePolicy = committedPolicy,
        evidenceType: EvidenceType = 'canonical_identity',
    ) => evaluateEvidenceRedirect(currentUrl, location, redirectCount, policy, evidenceType);

    it('follows a same-host relative redirect within the budget', () => {
        expect(redirect('https://nal.usda.gov/a', '/b', 0)).toStrictEqual({
            allowed: true,
            url: 'https://nal.usda.gov/b',
            host: 'nal.usda.gov',
            hostClass: 'usda_fdc',
        });
    });

    it('follows a same-host absolute redirect on the last permitted hop', () => {
        // redirectCount is how many have already been followed, so 1 is the
        // second and last hop under EVIDENCE_MAX_REDIRECTS = 2.
        expect(redirect('https://nal.usda.gov/a', 'https://nal.usda.gov/c', EVIDENCE_MAX_REDIRECTS - 1).allowed).toBe(
            true,
        );
    });

    it('refuses the hop after the budget is spent', () => {
        expect(urlRejection(redirect('https://nal.usda.gov/a', '/b', EVIDENCE_MAX_REDIRECTS))).toStrictEqual({
            reason: 'redirect_limit_exceeded',
            detail: `more than ${EVIDENCE_MAX_REDIRECTS} redirects were required`,
        });
        expect(urlRejection(redirect('https://nal.usda.gov/a', '/b', 99)).reason).toBe('redirect_limit_exceeded');
    });

    it.each([
        ['a negative count', -1],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('refuses %s as a redirect count', (_case, count) => {
        expect(urlRejection(redirect('https://nal.usda.gov/a', '/b', count))).toStrictEqual({
            reason: 'redirect_limit_exceeded',
            detail: 'the redirect count is not a usable number',
        });
    });

    it('refuses a non-numeric redirect count', () => {
        expect(urlRejection(redirect('https://nal.usda.gov/a', '/b', '0' as unknown as number)).detail).toBe(
            'the redirect count is not a usable number',
        );
    });

    it('honours a policy that narrows the redirect budget to zero', () => {
        const noRedirects = {
            ...cloneDocument(),
            fetchLimits: { ...(cloneDocument().fetchLimits as Record<string, unknown>), maxRedirects: 0 },
        } as unknown as EvidencePolicy;

        expect(urlRejection(redirect('https://nal.usda.gov/a', '/b', 0, noRedirects))).toStrictEqual({
            reason: 'redirect_limit_exceeded',
            detail: 'more than 0 redirects were required',
        });
    });

    it('ends the fetch on any cross-host redirect, even to another allowlisted host', () => {
        // The pinned address belongs to the original host, so following the hop
        // would abandon the pin — which is the whole defence against rebinding.
        expect(urlRejection(redirect('https://nal.usda.gov/a', 'https://www.ars.usda.gov/b', 0))).toStrictEqual({
            reason: 'cross_host_redirect',
            detail: 'a redirect from "nal.usda.gov" to "www.ars.usda.gov" is not followed',
        });
    });

    it('ends the fetch on a redirect to a subdomain of the same allowlisted domain', () => {
        expect(urlRejection(redirect('https://nal.usda.gov/a', 'https://fdc.nal.usda.gov/b', 0)).reason).toBe(
            'cross_host_redirect',
        );
    });

    it('re-validates the target from the URL step onward', () => {
        expect(urlRejection(redirect('https://nal.usda.gov/a', 'http://nal.usda.gov/b', 0)).reason).toBe(
            'scheme_not_allowed',
        );
        expect(urlRejection(redirect('https://nal.usda.gov/a', 'https://nal.usda.gov:8080/b', 0)).reason).toBe(
            'port_not_allowed',
        );
        expect(urlRejection(redirect('https://nal.usda.gov/a', 'https://user@nal.usda.gov/b', 0)).reason).toBe(
            'credentials_present',
        );
        expect(urlRejection(redirect('https://nal.usda.gov/a', 'https://10.0.0.1/b', 0)).reason).toBe(
            'ip_literal_host',
        );
        expect(urlRejection(redirect('https://nal.usda.gov/a', 'https://evil.com/b', 0)).reason).toBe(
            'host_not_allowlisted',
        );
        expect(
            urlRejection(
                redirect('https://www.britannica.com/a', 'https://www.britannica.com/b', 0, committedPolicy, 'nutrition_reference'),
            ).reason,
        ).toBe('evidence_type_not_authorized');
    });

    /**
     * The raw `Location` is the only place a hop's userinfo is still visible:
     * resolving it against the current URL normalizes an empty component away,
     * so `//@nal.usda.gov/b` becomes `https://nal.usda.gov/b` and arrives at the
     * URL checks with nothing left to refuse. The scheme-relative form is the
     * one that matters — it needs no scheme and still replaces the authority.
     */
    it.each([
        ['an absolute location with an empty userinfo', 'https://@nal.usda.gov/b'],
        ['an absolute location with an empty user and password', 'https://:@nal.usda.gov/b'],
        ['a scheme-relative location with an empty userinfo', '//@nal.usda.gov/b'],
        ['a scheme-relative location naming another host as the user', '//nal.usda.gov@evil.com/b'],
        ['a location with a backslash before the delimiter', 'https://nal.usda.gov\\@evil.com/b'],
    ])('refuses %s', (_case, location) => {
        expect(urlRejection(redirect('https://nal.usda.gov/a', location, 0))).toStrictEqual({
            reason: 'credentials_present',
            detail: 'the URL carries userinfo',
        });
    });

    /**
     * A path-relative `Location` has no authority at all, so an `@` in it is
     * ordinary path text. Refusing `/@handle` would break legitimate hops.
     */
    it.each([
        ['a path-relative location beginning with @', '/@handle'],
        ['a path-relative location containing @', '/food/a@b'],
        ['a relative location with no leading slash', '@handle'],
    ])('follows %s', (_case, location) => {
        const verdict = redirect('https://nal.usda.gov/a', location, 0);

        expect(verdict.allowed).toBe(true);
        if (verdict.allowed) {
            expect(verdict.host).toBe('nal.usda.gov');
        }
    });

    it.each([
        ['an empty location', '', 'the redirect target is empty'],
        ['a whitespace location', '   ', 'the redirect target is empty'],
    ])('refuses %s', (_case, location, detail) => {
        expect(urlRejection(redirect('https://nal.usda.gov/a', location, 0))).toStrictEqual({
            reason: 'unparseable_url',
            detail,
        });
    });

    it('refuses a non-string location', () => {
        expect(urlRejection(redirect('https://nal.usda.gov/a', null as unknown as string, 0)).detail).toBe(
            'the redirect target is empty',
        );
    });

    it.each([['a scheme with no host', 'http://'], ['an unterminated IPv6 literal', 'http://['], ['protocol-relative nonsense', '//']])(
        'refuses a location that cannot be resolved (%s)',
        (_case, location) => {
            expect(urlRejection(redirect('https://nal.usda.gov/a', location, 0))).toStrictEqual({
                reason: 'unparseable_url',
                detail: 'the redirect target could not be parsed',
            });
        },
    );

    it('refuses the hop when the URL it came from is itself not permitted', () => {
        expect(urlRejection(redirect('http://nal.usda.gov/a', '/b', 0)).reason).toBe('scheme_not_allowed');
        expect(urlRejection(redirect('https://evil.com/a', 'https://evil.com/b', 0)).reason).toBe(
            'host_not_allowlisted',
        );
    });

    it('refuses the hop when the policy document cannot be trusted', () => {
        const stale = { ...cloneDocument(), allowlistVersion: 'v2' } as unknown as EvidencePolicy;

        expect(urlRejection(redirect('https://nal.usda.gov/a', '/b', 0, stale)).reason).toBe('policy_invalid');
    });

    it('refuses the hop for a claim outside the reviewed vocabulary', () => {
        expect(
            urlRejection(
                redirect('https://nal.usda.gov/a', '/b', 0, committedPolicy, 'invented' as unknown as EvidenceType),
            ).reason,
        ).toBe('evidence_type_not_authorized');
    });
});


// ---------------------------------------------------------------------------
// The policy document as a whole.
// ---------------------------------------------------------------------------

/** The committed document with top-level members replaced. */
const policyWith = (patch: Record<string, unknown>): unknown => ({ ...cloneDocument(), ...patch });

/** The committed document with its fetchLimits members replaced. */
const limitsWith = (patch: Record<string, unknown>): unknown =>
    policyWith({ fetchLimits: { ...(cloneDocument().fetchLimits as Record<string, unknown>), ...patch } });

/** One synthetic host class, for the members the committed document never exercises. */
const hostClass = (patch: Record<string, unknown>): Record<string, unknown> => ({
    class: 'synthetic_reference',
    hosts: ['reference.example.gov'],
    evidenceTypes: ['canonical_identity'],
    ...patch,
});

const policyRefusal = (policy: unknown): { reason: string; detail: string } => {
    const verdict = validateEvidencePolicy(policy);
    if (verdict.ok) {
        throw new Error('expected the policy document to be refused, but it validated');
    }
    return { reason: verdict.reason, detail: verdict.detail };
};

const policyDetail = (policy: unknown): string => policyRefusal(policy).detail;

describe('validateEvidencePolicy on the committed document', () => {
    it('accepts it and rebuilds it from validated members only', () => {
        const verdict = validateEvidencePolicy(committedDocument);

        expect(verdict.ok).toBe(true);
        if (verdict.ok) {
            expect(Object.keys(verdict.policy).sort()).toStrictEqual([
                'allowlistVersion',
                'fetchLimits',
                'globalUnicastAllocationRowCount',
                'globalUnicastAllocations',
                'hostClasses',
                'registryRowCount',
                'registrySnapshot',
                'rowCount',
                'specialPurposeRanges',
                'supplementalCidrs',
                'supplementalRowCount',
            ]);
            expect(verdict.policy.specialPurposeRanges).toHaveLength(REVIEWED_RANGE_ROW_COUNT);
            expect(verdict.policy.hostClasses).toHaveLength(4);
        }
    });

    it('drops members the reviewed shape does not declare', () => {
        // Assembled field by field rather than cast, so nothing downstream is
        // typed as something it was merely asserted to be.
        const verdict = validateEvidencePolicy(policyWith({ extraMember: 'ignored' }));

        expect(verdict.ok).toBe(true);
        if (verdict.ok) {
            expect('extraMember' in verdict.policy).toBe(false);
        }
    });

    it('accepts a class carrying an optional description', () => {
        const verdict = validateEvidencePolicy(
            policyWith({ hostClasses: [hostClass({ description: 'A reviewed reference group' })] }),
        );

        expect(verdict.ok).toBe(true);
        if (verdict.ok) {
            expect(verdict.policy.hostClasses[0].description).toBe('A reviewed reference group');
        }
    });
});

describe('validateEvidencePolicy on a document it cannot read', () => {
    it.each([
        ['null', null, 'the evidence policy document is null, not an object'],
        ['undefined', undefined, 'the evidence policy document is undefined, not an object'],
        ['a string', 'policy', 'the evidence policy document is "policy", not an object'],
        ['a number', 1, 'the evidence policy document is 1, not an object'],
        ['a list', [], 'the evidence policy document is a list, not an object'],
    ])('refuses %s', (_case, policy, detail) => {
        expect(policyRefusal(policy)).toStrictEqual({ reason: 'policy_invalid', detail });
    });
});

describe('validateEvidencePolicy on the reviewed attestation members', () => {
    it.each([
        ['absent', { allowlistVersion: undefined }, 'undefined'],
        ['a later version', { allowlistVersion: 'v2' }, '"v2"'],
        ['a number', { allowlistVersion: 1 }, '1'],
        ['an empty string', { allowlistVersion: '' }, '""'],
    ])('refuses an allowlistVersion that is %s', (_case, patch, rendered) => {
        expect(policyDetail(policyWith(patch))).toBe(
            `the policy document declares version ${rendered}, not the reviewed "${REVIEWED_ALLOWLIST_VERSION}"`,
        );
    });

    it.each([
        ['absent', { registrySnapshot: undefined }, 'undefined'],
        ['not a date', { registrySnapshot: 'yesterday' }, '"yesterday"'],
        ['a loosely written date', { registrySnapshot: '2026-9-8' }, '"2026-9-8"'],
        ['a timestamp', { registrySnapshot: '2026-09-08T00:00:00Z' }, '"2026-09-08T00:00:00Z"'],
        ['a number', { registrySnapshot: 20260908 }, '20260908'],
    ])('refuses a registrySnapshot that is %s', (_case, patch, rendered) => {
        expect(policyDetail(policyWith(patch))).toBe(
            `the policy document declares the registry snapshot ${rendered}, which is not a YYYY-MM-DD date`,
        );
    });

    it.each(['2026-09-09', '2026-09-07', '1999-01-01'])('refuses the unreviewed snapshot date %s', (snapshot) => {
        expect(policyDetail(policyWith({ registrySnapshot: snapshot }))).toBe(
            `the address table is dated ${snapshot}, not the reviewed ${REVIEWED_REGISTRY_SNAPSHOT}`,
        );
    });

    it.each([
        ['absent', { specialPurposeRanges: undefined }, 'undefined'],
        ['an object', { specialPurposeRanges: {} }, 'object'],
        ['a string', { specialPurposeRanges: 'ranges' }, '"ranges"'],
    ])('refuses a specialPurposeRanges that is %s', (_case, patch, rendered) => {
        expect(policyDetail(policyWith(patch))).toBe(`specialPurposeRanges is ${rendered}, not a list`);
    });

    it.each([
        ['absent', { rowCount: undefined }, 'undefined'],
        ['zero', { rowCount: 0 }, '0'],
        ['negative', { rowCount: -52 }, '-52'],
        ['fractional', { rowCount: 52.5 }, '52.5'],
        ['a string', { rowCount: '52' }, '"52"'],
        ['NaN', { rowCount: Number.NaN }, 'NaN'],
    ])('refuses a rowCount that is %s', (_case, patch, rendered) => {
        expect(policyDetail(policyWith(patch))).toBe(`the policy document declares the row count ${rendered}`);
    });

    it('refuses a rowCount that disagrees with the rows carried', () => {
        expect(policyDetail(policyWith({ rowCount: 51 }))).toBe(
            `the policy document declares 51 address rows and carries ${REVIEWED_RANGE_ROW_COUNT}`,
        );
    });

    it('refuses a truncated table even when rowCount was rewritten to match', () => {
        // The reviewed count is the one the document cannot edit, which is what
        // catches a truncation that also fixed up its own header.
        const truncated = tableWithRow('169.254.0.0/16', null);

        expect(policyDetail(policyWith({ specialPurposeRanges: truncated, rowCount: truncated.length }))).toBe(
            `the address table carries ${truncated.length} rows, not the ${REVIEWED_RANGE_ROW_COUNT} reviewed at ${REVIEWED_REGISTRY_SNAPSHOT}`,
        );
    });

    it.each([
        ['absent', { registryRowCount: undefined }, 'undefined'],
        ['zero', { registryRowCount: 0 }, '0'],
        ['negative', { registryRowCount: -51 }, '-51'],
        ['fractional', { registryRowCount: 51.5 }, '51.5'],
        ['a string', { registryRowCount: '51' }, '"51"'],
        ['NaN', { registryRowCount: Number.NaN }, 'NaN'],
    ])('refuses a registryRowCount that is %s', (_case, patch, rendered) => {
        expect(policyDetail(policyWith(patch))).toBe(
            `the policy document declares the registry row count ${rendered}`,
        );
    });

    it.each([
        ['absent', { supplementalRowCount: undefined }, 'undefined'],
        ['zero', { supplementalRowCount: 0 }, '0'],
        ['negative', { supplementalRowCount: -1 }, '-1'],
        ['fractional', { supplementalRowCount: 1.5 }, '1.5'],
        ['a string', { supplementalRowCount: '1' }, '"1"'],
        ['NaN', { supplementalRowCount: Number.NaN }, 'NaN'],
    ])('refuses a supplementalRowCount that is %s', (_case, patch, rendered) => {
        expect(policyDetail(policyWith(patch))).toBe(
            `the policy document declares the supplemental row count ${rendered}`,
        );
    });

    it('refuses counts that do not add up to the rows carried', () => {
        // The half-merged document: one half was updated and the other was not,
        // so the sum stops matching what is actually in the table.
        expect(policyDetail(policyWith({ registryRowCount: REVIEWED_REGISTRY_ROW_COUNT + 1 }))).toBe(
            `the policy document declares ${REVIEWED_REGISTRY_ROW_COUNT + 1} registry rows and ` +
                `${REVIEWED_SUPPLEMENTAL_ROW_COUNT} supplemental rows, which do not add up to the ` +
                `${REVIEWED_RANGE_ROW_COUNT} rows it carries`,
        );
    });

    it('refuses a split that reclassifies a registry row as supplemental', () => {
        // The sum still holds — one row moved from one half to the other — and
        // that is exactly why the halves are compared with the review as well.
        expect(
            policyDetail(
                policyWith({
                    registryRowCount: REVIEWED_REGISTRY_ROW_COUNT - 1,
                    supplementalRowCount: REVIEWED_SUPPLEMENTAL_ROW_COUNT + 1,
                }),
            ),
        ).toBe(
            `the policy document declares ${REVIEWED_REGISTRY_ROW_COUNT - 1} registry-derived rows, not the ` +
                `${REVIEWED_REGISTRY_ROW_COUNT} reviewed at ${REVIEWED_REGISTRY_SNAPSHOT}`,
        );
    });

    it('refuses a split that reclassifies the supplemental row as a registry row', () => {
        // `::/96` is not an IANA registry entry, so a document counting all 52
        // rows as registry-derived — and declaring no supplemental rows — is
        // claiming a review that never happened. It is refused on the count
        // before the list it would have had to empty is even read.
        expect(
            policyDetail(
                policyWith({
                    registryRowCount: REVIEWED_RANGE_ROW_COUNT,
                    supplementalRowCount: 0,
                    supplementalCidrs: [],
                }),
            ),
        ).toBe('the policy document declares the supplemental row count 0');
    });

    it.each([
        ['absent', { supplementalCidrs: undefined }, 'undefined'],
        ['an empty list', { supplementalCidrs: [] }, 'a list'],
        ['a string', { supplementalCidrs: '::/96' }, '"::/96"'],
        ['an object', { supplementalCidrs: {} }, 'object'],
        ['a number', { supplementalCidrs: 1 }, '1'],
    ])('refuses a supplementalCidrs that is %s', (_case, patch, rendered) => {
        expect(policyDetail(policyWith(patch))).toBe(`supplementalCidrs is ${rendered}, not a non-empty list`);
    });

    it.each([
        ['a number', 96, '96'],
        ['null', null, 'null'],
        ['an empty string', '', '""'],
        ['whitespace', '   ', '"   "'],
        ['a nested list', [], 'a list'],
    ])('refuses a supplemental entry that is %s', (_case, entry, rendered) => {
        expect(policyDetail(policyWith({ supplementalCidrs: [entry] }))).toBe(
            `supplementalCidrs declares ${rendered}, not a CIDR`,
        );
    });

    it.each(['::', '::/', '::/129', 'not-a-block/96'])('refuses the unparsable supplemental entry %s', (entry) => {
        expect(policyDetail(policyWith({ supplementalCidrs: [entry] }))).toBe(
            `supplementalCidrs declares "${entry}", which is not a valid CIDR`,
        );
    });

    it('refuses a supplemental list that declares one block twice', () => {
        // Uniqueness is one of the three legs of the set-equality argument: a
        // list could otherwise name one reviewed block twice and omit another.
        expect(policyDetail(policyWith({ supplementalCidrs: ['::/96', '::/96'] }))).toBe(
            'supplementalCidrs declares the block "::/96" twice',
        );
        expect(policyDetail(policyWith({ supplementalCidrs: ['::/96', '0:0::/96'] }))).toBe(
            'supplementalCidrs declares the block "0:0::/96" twice',
        );
    });

    it.each(['169.254.0.0/16', 'fc00::/7', '::ffff:0:0/96'])(
        'refuses %s as supplemental, because the review does not class it so',
        (cidr) => {
            // A real registry row marked supplemental would understate the
            // registry-derived count a reviewer checks against the registries.
            expect(policyDetail(policyWith({ supplementalCidrs: [cidr] }))).toBe(
                `supplementalCidrs declares "${cidr}", which the ${REVIEWED_REGISTRY_SNAPSHOT} review ` +
                    'does not class as a supplemental block',
            );
        },
    );

    it('refuses a supplemental block the address table no longer carries', () => {
        // The substitution that keeps every count intact: `::/96` is replaced
        // by a second copy of another reviewed block, so the row count still
        // matches and the hardening rule has silently stopped applying —
        // nothing would match `::/96` and an embedded link-local address would
        // read as ordinary global unicast.
        const refusal = policyRefusal(
            policyWith({ specialPurposeRanges: tableWithRow('::/96', { cidr: '2001:db8::/32' }) }),
        );

        expect(refusal.reason).toBe('policy_invalid');
        expect(refusal.detail).toBe('the supplemental block "::/96" is not carried by the address table');
    });

    it('still refuses a table that dropped the supplemental row outright', () => {
        // The same loss with the row deleted rather than substituted, which the
        // row count sees first. Either way the document is refused; only the
        // recorded cause differs.
        const truncated = tableWithRow('::/96', null);

        expect(policyDetail(policyWith({ specialPurposeRanges: truncated, rowCount: truncated.length }))).toBe(
            `the address table carries ${truncated.length} rows, not the ` +
                `${REVIEWED_RANGE_ROW_COUNT} reviewed at ${REVIEWED_REGISTRY_SNAPSHOT}`,
        );
    });

    it('reports a corrupted table as range_table_unclassifiable rather than policy_invalid', () => {
        // The operator reading the code knows the candidate was never judged.
        const refusal = policyRefusal(
            policyWith({ specialPurposeRanges: tableWithRow('169.254.0.0/16', { globallyReachable: true }) }),
        );

        expect(refusal.reason).toBe('range_table_unclassifiable');
        expect(refusal.detail).toContain('marks the reviewed block 169.254.0.0/16 true');
    });
});

describe('validateEvidencePolicy on the host classes', () => {
    it.each([
        ['absent', { hostClasses: undefined }],
        ['an empty list', { hostClasses: [] }],
        ['an object', { hostClasses: {} }],
        ['a string', { hostClasses: 'usda_fdc' }],
    ])('refuses host classes that are %s', (_case, patch) => {
        expect(policyDetail(policyWith(patch))).toBe('the policy document declares no host classes');
    });

    it.each([
        ['null', null, 'null'],
        ['a string', 'usda_fdc', '"usda_fdc"'],
        ['a number', 7, '7'],
        ['a list', [], 'a list'],
    ])('refuses a class that is %s', (_case, value, rendered) => {
        expect(policyDetail(policyWith({ hostClasses: [value] }))).toBe(
            `host class 0 is ${rendered}, not an object`,
        );
    });

    it.each([
        ['absent', { class: undefined }],
        ['empty', { class: '' }],
        ['whitespace', { class: '   ' }],
        ['a number', { class: 7 }],
    ])('refuses a class whose identifier is %s', (_case, patch) => {
        // A group without an identifier cannot be named in a validation record.
        expect(policyDetail(policyWith({ hostClasses: [hostClass(patch)] }))).toBe(
            'host class 0 declares no class identifier',
        );
    });

    it.each([
        ['absent', { hosts: undefined }],
        ['an empty list', { hosts: [] }],
        ['a string', { hosts: 'reference.example.gov' }],
        ['an object', { hosts: {} }],
    ])('refuses a class whose hosts are %s', (_case, patch) => {
        expect(policyDetail(policyWith({ hostClasses: [hostClass(patch)] }))).toBe(
            'host class "synthetic_reference" declares no hosts',
        );
    });

    it.each([
        ['a URL', 'https://reference.example.gov', '"https://reference.example.gov"'],
        ['an upper-case host', 'Reference.Example.Gov', '"Reference.Example.Gov"'],
        ['a padded host', ' reference.example.gov', '" reference.example.gov"'],
        ['a bare TLD wildcard', '*.gov', '"*.gov"'],
        ['an IP literal', '10.0.0.1', '"10.0.0.1"'],
        ['a number', 443, '443'],
        ['null', null, 'null'],
        ['a nested list', [], 'a list'],
    ])('refuses a class declaring the host entry %s', (_case, entry, rendered) => {
        expect(policyDetail(policyWith({ hostClasses: [hostClass({ hosts: [entry] })] }))).toBe(
            `host class "synthetic_reference" declares the unusable host entry ${rendered}`,
        );
    });

    it('refuses a class declaring the same host twice', () => {
        expect(
            policyDetail(
                policyWith({
                    hostClasses: [hostClass({ hosts: ['reference.example.gov', 'reference.example.gov'] })],
                }),
            ),
        ).toBe('host class "synthetic_reference" declares "reference.example.gov" twice');
    });

    it.each([
        ['absent', { evidenceTypes: undefined }],
        ['an empty list', { evidenceTypes: [] }],
        ['a string', { evidenceTypes: 'canonical_identity' }],
        ['an object', { evidenceTypes: {} }],
    ])('refuses a class whose evidence types are %s', (_case, patch) => {
        // An unstated scope is not an unlimited one — this is the state that
        // would let a culinary reference stand in for a nutrition authority.
        expect(policyDetail(policyWith({ hostClasses: [hostClass(patch)] }))).toBe(
            'host class "synthetic_reference" authorizes no evidence type',
        );
    });

    it.each([
        ['an invented claim', 'everything', '"everything"'],
        ['a near miss', 'canonical-identity', '"canonical-identity"'],
        ['a number', 1, '1'],
        ['null', null, 'null'],
    ])('refuses a class declaring the evidence type %s', (_case, evidenceType, rendered) => {
        expect(
            policyDetail(policyWith({ hostClasses: [hostClass({ evidenceTypes: [evidenceType] })] })),
        ).toBe(`host class "synthetic_reference" declares the unknown evidence type ${rendered}`);
    });

    it('refuses a class declaring the same evidence type twice', () => {
        expect(
            policyDetail(
                policyWith({
                    hostClasses: [hostClass({ evidenceTypes: ['canonical_identity', 'canonical_identity'] })],
                }),
            ),
        ).toBe('host class "synthetic_reference" declares "canonical_identity" twice');
    });

    it.each([
        ['empty', ''],
        ['whitespace', '  '],
        ['a number', 7],
        ['a list', []],
    ])('refuses a class whose description is %s', (_case, description) => {
        expect(policyDetail(policyWith({ hostClasses: [hostClass({ description })] }))).toBe(
            'host class "synthetic_reference" declares an empty description',
        );
    });

    it('refuses two classes sharing an identifier', () => {
        expect(
            policyDetail(
                policyWith({
                    hostClasses: [hostClass({}), hostClass({ hosts: ['other.example.gov'] })],
                }),
            ),
        ).toBe('host class "synthetic_reference" is declared twice');
    });

    it('refuses the same host entry in two classes', () => {
        // Otherwise what a host may attest would depend on the order the classes
        // happen to be written in, and a security answer that depends on
        // document order is one nobody can review.
        expect(
            policyDetail(
                policyWith({
                    hostClasses: [
                        hostClass({}),
                        hostClass({ class: 'second_reference', evidenceTypes: ['nutrition_reference'] }),
                    ],
                }),
            ),
        ).toBe('host entry "reference.example.gov" appears in more than one class, so what it may attest is ambiguous');
    });
});

describe('validateEvidencePolicy on the declared transport policy', () => {
    it.each([
        ['absent', { fetchLimits: undefined }, 'undefined'],
        ['a string', { fetchLimits: 'default' }, '"default"'],
        ['a list', { fetchLimits: [] }, 'a list'],
        ['a number', { fetchLimits: 1 }, '1'],
    ])('refuses fetchLimits that are %s', (_case, patch, rendered) => {
        expect(policyDetail(policyWith(patch))).toBe(`fetchLimits is ${rendered}, not an object`);
    });

    it.each([
        ['schemes', { schemes: undefined }, 'undefined'],
        ['schemes', { schemes: [] }, 'a list'],
        ['schemes', { schemes: 'https' }, '"https"'],
    ])('refuses a %s member that is %s', (member, patch, rendered) => {
        expect(policyDetail(limitsWith(patch))).toBe(`fetchLimits.${member} is ${rendered}, not a non-empty list`);
    });

    it.each([
        ['allowedPorts', { allowedPorts: undefined }],
        ['allowedContentTypes', { allowedContentTypes: [] }],
    ])('refuses an absent or empty %s', (member, patch) => {
        expect(policyDetail(limitsWith(patch))).toContain(`fetchLimits.${member} is`);
    });

    it.each([
        ['http', { schemes: ['http'] }, 'schemes', '"http"'],
        ['both http and https', { schemes: ['https', 'http'] }, 'schemes', '"http"'],
        ['a disallowed content type', { allowedContentTypes: ['application/pdf'] }, 'allowedContentTypes', '"application/pdf"'],
    ])('refuses a document that tries to widen the policy with %s', (_case, patch, member, rendered) => {
        // Narrowing is welcome; a member outside the ceiling is an attempt to
        // widen, and the answer to that is to refuse the whole document rather
        // than silently drop the member.
        expect(policyDetail(limitsWith(patch))).toBe(
            `fetchLimits.${member} declares ${rendered}, which the reviewed policy does not permit`,
        );
    });

    it('refuses a port outside the reviewed ceiling', () => {
        expect(policyDetail(limitsWith({ allowedPorts: [8080] }))).toBe(
            'fetchLimits.allowedPorts declares 8080, which the reviewed policy does not permit',
        );
    });

    it.each([
        ['a number in schemes', { schemes: [443] }, 'schemes', '443'],
        ['null in allowedContentTypes', { allowedContentTypes: [null] }, 'allowedContentTypes', 'null'],
    ])('refuses %s', (_case, patch, member, rendered) => {
        expect(policyDetail(limitsWith(patch))).toBe(
            `fetchLimits.${member} contains ${rendered}, not a string`,
        );
    });

    it.each([
        ['a string in allowedPorts', { allowedPorts: ['443'] }, '"443"'],
        ['an object in allowedPorts', { allowedPorts: [{}] }, 'object'],
        ['NaN in allowedPorts', { allowedPorts: [Number.NaN] }, 'NaN'],
    ])('refuses %s', (_case, patch, rendered) => {
        expect(policyDetail(limitsWith(patch))).toBe(
            `fetchLimits.allowedPorts contains ${rendered}, not a number`,
        );
    });

    it('refuses a duplicated member in a declared list', () => {
        expect(policyDetail(limitsWith({ schemes: ['https', 'HTTPS'] }))).toBe(
            'fetchLimits.schemes declares "https" twice',
        );
        expect(policyDetail(limitsWith({ allowedPorts: [443, 443] }))).toBe(
            'fetchLimits.allowedPorts declares 443 twice',
        );
    });

    it('accepts a narrower content-type list and normalises its case', () => {
        const verdict = validateEvidencePolicy(limitsWith({ allowedContentTypes: [' TEXT/HTML '] }));

        expect(verdict.ok).toBe(true);
        if (verdict.ok) {
            expect(verdict.policy.fetchLimits.allowedContentTypes).toStrictEqual(['text/html']);
        }
    });

    it.each([
        ['maxRedirects', { maxRedirects: 3 }, EVIDENCE_MAX_REDIRECTS],
        ['timeoutMs', { timeoutMs: 60_000 }, EVIDENCE_FETCH_TIMEOUT_MS],
        ['maxBodyBytes', { maxBodyBytes: 10_485_760 }, EVIDENCE_MAX_BODY_BYTES],
        ['maxSnippetChars', { maxSnippetChars: 5_000 }, EVIDENCE_MAX_SNIPPET_CHARS],
    ])('refuses a %s above the reviewed ceiling', (member, patch, ceiling) => {
        const declared = (patch as Record<string, number>)[member];

        expect(policyDetail(limitsWith(patch))).toBe(
            `fetchLimits.${member} declares ${declared}, above the reviewed ceiling of ${ceiling}`,
        );
    });

    it.each([
        ['a string', { timeoutMs: '10000' }, '"10000"'],
        ['fractional', { timeoutMs: 1.5 }, '1.5'],
        ['zero', { timeoutMs: 0 }, '0'],
        ['negative', { timeoutMs: -1 }, '-1'],
        ['absent', { timeoutMs: undefined }, 'undefined'],
        ['NaN', { timeoutMs: Number.NaN }, 'NaN'],
    ])('refuses a timeoutMs that is %s', (_case, patch, rendered) => {
        expect(policyDetail(limitsWith(patch))).toBe(
            `fetchLimits.timeoutMs is ${rendered}, not a positive integer`,
        );
    });

    it('refuses a negative maxRedirects but accepts a declared zero', () => {
        expect(policyDetail(limitsWith({ maxRedirects: -1 }))).toBe(
            'fetchLimits.maxRedirects is -1, not a non-negative integer',
        );

        const verdict = validateEvidencePolicy(limitsWith({ maxRedirects: 0 }));

        expect(verdict.ok).toBe(true);
        if (verdict.ok) {
            expect(verdict.policy.fetchLimits.maxRedirects).toBe(0);
        }
    });

    it('refuses an absent maxRedirects, because the reviewed policy must be stated in data', () => {
        expect(policyDetail(limitsWith({ maxRedirects: undefined }))).toBe(
            'fetchLimits.maxRedirects is undefined, not a non-negative integer',
        );
    });

    it.each([
        ['zero', { maxBodyBytes: 0 }, '0'],
        ['a string', { maxBodyBytes: '1048576' }, '"1048576"'],
        ['absent', { maxBodyBytes: undefined }, 'undefined'],
    ])('refuses a maxBodyBytes that is %s', (_case, patch, rendered) => {
        expect(policyDetail(limitsWith(patch))).toBe(
            `fetchLimits.maxBodyBytes is ${rendered}, not a positive integer`,
        );
    });

    it('lets maxSnippetChars fall back to the reviewed ceiling when absent', () => {
        // The one member a document may leave unstated: it bounds what is
        // stored, not what is reached.
        const verdict = validateEvidencePolicy(limitsWith({ maxSnippetChars: undefined }));

        expect(verdict.ok).toBe(true);
        if (verdict.ok) {
            expect(verdict.policy.fetchLimits.maxSnippetChars).toBe(EVIDENCE_MAX_SNIPPET_CHARS);
        }
    });

    it('accepts a narrowed maxSnippetChars and refuses a malformed one', () => {
        const narrowed = validateEvidencePolicy(limitsWith({ maxSnippetChars: 120 }));

        expect(narrowed.ok).toBe(true);
        if (narrowed.ok) {
            expect(narrowed.policy.fetchLimits.maxSnippetChars).toBe(120);
        }
        expect(policyDetail(limitsWith({ maxSnippetChars: 0 }))).toBe(
            'fetchLimits.maxSnippetChars is 0, not a positive integer',
        );
    });

    it('accepts a document that narrows every cap at once', () => {
        const verdict = validateEvidencePolicy(
            limitsWith({ maxRedirects: 1, timeoutMs: 2_000, maxBodyBytes: 65_536, maxSnippetChars: 200 }),
        );

        expect(verdict.ok).toBe(true);
        if (verdict.ok) {
            expect(verdict.policy.fetchLimits).toStrictEqual({
                schemes: ['https'],
                allowedPorts: [443],
                maxRedirects: 1,
                timeoutMs: 2_000,
                maxBodyBytes: 65_536,
                allowedContentTypes: ['text/html', 'application/json', 'text/plain'],
                maxSnippetChars: 200,
            });
        }
    });
});

