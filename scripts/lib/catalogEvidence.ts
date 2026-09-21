// The publication floors every catalog stage has to apply identically, as pure
// functions over their arguments.
//
// WHY THIS MODULE EXISTS. Four stages decide, each in its own process, whether
// a `catalog_foods` row may carry `publication_status = 'published'`:
// `catalog-import-usda.ts` when it first writes the row,
// `catalog-generate-ai.ts` for a generated candidate, `catalog-validate.ts`
// when it judges the table, and `catalog-release.ts`/`catalog-load.ts` when a
// reviewed artefact is exported and applied elsewhere. They were not agreeing.
// The import held a record whose vendor retrieval carried no observed HTTP
// status and looked at nothing else about it (Agent Action Plan §0.3.2 makes
// the status one of several mandatory fields), while validation never read
// `catalog_validation_records.identity_evidence` at all and the release
// exporter and loader never looked inside the record they shipped — which is
// how 11,046 published rows whose mandatory status was null came to be frozen
// into a checksummed release that the same pipeline's import stage would have
// refused to publish.
//
// So the rule lives HERE, once. WHICH STAGES CALL WHICH PREDICATE, EXACTLY —
// this list is a statement about the code as it is, not about what every stage
// ought eventually to do, so a stage that does not call something is not listed
// as though it did:
//
//   * {@link assessIdentityEvidence} — is this row's identity evidence
//     complete enough to publish on? The AAP's §0.7.3 quarantine tier names
//     "missing identity evidence" as a hold, and §0.3.2 names the fields a
//     retrieval record states. A row that fails this may exist as a candidate
//     or a quarantined row; it may never be published. Called by the four
//     stages that write or ship a retrieval record:
//     `catalog-import-usda.ts` (`importEvidenceAssessment`, over the record it
//     is about to write), `catalog-validate.ts` (in the publication derivation,
//     which DEMOTES a published row whose record is incomplete, and again in
//     `advisoryReviewApplies`), `catalog-release.ts` (per exported row) and
//     `catalog-load.ts` (per published line of `validation-records.jsonl`).
//     Not called by `catalog-generate-ai.ts`, which writes candidates only and
//     whose reference-page evidence is assembled by `evidence.logic.ts`; those
//     records are first assessed by the validation pass that judges them.
//   * {@link assessSourceCacheBinding} — do a USDA row's stated digests
//     actually resolve? The structural predicate above can only see that a
//     digest is 64 hex characters; this one reads the `usda_api_cache` payload
//     the record cites, recomputes both digests from it and requires the record
//     it hashed to be the one belonging to this food's `usda_fdc_id`. Called by
//     `catalog-release.ts` ALONE, and that is a property of the data rather
//     than an omission: `usda_api_cache` is a database table, no release member
//     carries it, so the export is the last stage that can resolve anything.
//     The exporter therefore attests what it resolved in the manifest's
//     `evidence.source_cache_resolution`, and `catalog-load.ts` enforces that
//     attestation instead — which is strictly less, and says so where it does
//     it. {@link cacheBindingRequired} says which rows this applies to and
//     {@link identityEvidenceSourceCacheKey} reads the key out of either
//     spelling, so the key that is looked up is the key that is assessed.
//   * {@link assessComponentDerivation} — does an ingredient-derived row's
//     stored nutrition still equal what its stored composition derives to
//     (AAP §0.5.1: the composition is what `catalog.logic.ts` recomputes
//     deterministically)? A parent whose scalars have drifted from its
//     components, whose components' nutrition has moved on since the pins were
//     taken, or which claims its numbers were NOT derived from the composition
//     it carries, is publishing numbers nothing in the table derives. Called by
//     `catalog-validate.ts` (`componentDerivationFor`) and `catalog-load.ts`
//     (`firstComponentInconsistency`); `catalog-release.ts` applies the
//     provenance half of it directly, because an exporter walking published
//     rows can see the contradiction without re-deriving anything.
//   * {@link componentDerivationComponentOf} — the input builder for the
//     predicate above, because the derivation sums PER-100 G values while a
//     stored component states its nutrition on whatever basis its source used.
//     One conversion, shared, for the same reason as the rules themselves.
//
// WHAT THIS MODULE IS NOT. It is not a second validation vocabulary: the check
// NAMES and their tiers belong to `src/services/catalog.logic.ts`
// (`CATALOG_CHECK_NAMES`, `CHECK_TIERS`) and the gap codes below are reasons a
// floor held a row, reported beside the checks rather than instead of them. It
// decides nothing about reject-tier facts, identity status, duplicates or
// category bounds, which the validator already computes.
//
// It is deliberately inert on import. Its whole import graph is two pure
// modules — `src/services/catalog.logic.ts` for the derivations and
// `./catalogFoodFacts.ts` for the two digest helpers, which between them add
// only Node's `crypto` — plus two type-only imports. So a script, a stage's
// verification pass or a test can import it for one predicate without pulling
// in a CLI's startup ordering, database-origin policy or environment reads
// (Rule backend-architecture §1.1/§7.1). Nothing here opens a connection,
// reads an environment variable or performs I/O: {@link
// assessSourceCacheBinding} is handed the cache row it judges rather than
// fetching it, which is what keeps the rule testable without a database.
//
// TWO EVIDENCE SHAPES, ONE RULE. A USDA row's evidence record describes the
// vendor exchange the record was read out of and is written in the column
// vocabulary (`http_status`, `final_host`, `body_sha256`, `source_cache_key`,
// `matched_snippet`, `fetched_at`) by `catalog-import-usda.ts`. A generated
// row's evidence record describes a fetched reference page and is
// `evidence.logic.ts`'s `EvidenceRetrievalRecord`, whose fields arrive in that
// module's own camelCase (`status`, `finalHost`, `bodySha256`,
// `matchedSnippet`, `fetchedAt`). Both are read here, by accepting either
// spelling per field, because the alternative — each consumer re-deriving which
// spelling a row uses — is how two stages come to disagree about the same
// record. Neither shape is preferred: a record carrying both spellings of one
// field with different values is a malformed record and is refused as one.

import {
    deriveComponentNutrition,
    isCatalogNutritionBasis,
    normalizeToPer100g,
    parseCanonicalFdcId,
} from '../../src/services/catalog.logic';
// The two digest helpers the import stage takes `body_sha256` and
// `record_sha256` with, imported so {@link assessSourceCacheBinding} recomputes
// them identically rather than approximately (see its own contract). Both are
// pure; `catalogFoodFacts.ts` is deliberately inert on import for the same
// reasons this module is, adding only Node's `crypto` to the graph.
import { canonicalJsonString, sha256Hex } from './catalogFoodFacts';

import type { CatalogComponentNutritionInput, CatalogNutrientValues } from '../../src/services/catalog.logic';
import type { CatalogValidationCheck } from '../../src/types/catalog';

/* ---------------------------------------------------------------------------
 * Identity evidence
 * ------------------------------------------------------------------------- */

/**
 * Why a row's identity evidence cannot be published on.
 *
 * One code per repairable cause, because the repair differs: an absent record
 * needs the stage that owns the row to retrieve evidence, a null status needs
 * the retrieval to be re-made against the vendor (the status is observed, never
 * reconstructed), and a missing digest needs the export that dropped it to be
 * re-cut. A single `incomplete` code would collapse all three into one
 * unactionable sentence.
 */
export type EvidenceGapCode =
    | 'evidence_absent'
    | 'evidence_malformed'
    | 'retrieval_url_missing'
    | 'retrieval_host_missing'
    | 'retrieval_status_missing'
    | 'retrieval_status_invalid'
    | 'retrieval_body_digest_missing'
    | 'retrieval_record_digest_missing'
    | 'retrieval_source_cache_key_missing'
    | 'retrieval_snippet_missing'
    | 'retrieval_time_missing'
    | 'retrieval_time_invalid';

/** One unmet requirement of one evidence record. */
export interface EvidenceGap {
    readonly code: EvidenceGapCode;
    /** The field as the record spells it, or the container when there is no field. */
    readonly field: string;
    /** What the record actually carries, rendered for a log line or a refusal. */
    readonly observed: string;
    /** What a publishable record must carry instead. */
    readonly requirement: string;
}

export interface EvidenceAssessment {
    /** True only when every mandatory field of the assessed record is present and usable. */
    readonly complete: boolean;
    readonly gaps: readonly EvidenceGap[];
    /** The observed HTTP status, or `null` when none was recorded. */
    readonly status: number | null;
    /** The host the bytes came from, for the log line that reports a gap. */
    readonly finalHost: string | null;
}

/** Which vocabulary of mandatory fields a row's evidence is read under. */
export type EvidenceIdentitySource = 'usda' | 'ai_generated';

/** The identity source whose evidence is a cached vendor exchange rather than a fetched page. */
const USDA_IDENTITY_SOURCE = 'usda';

/**
 * The successful status range. A retrieval record exists to say that a specific
 * exchange returned the bytes the digest was taken over, so a 3xx (the bytes
 * are elsewhere), a 4xx or a 5xx is not evidence of anything about the food —
 * and a stage that published on one would be citing a failure as a source.
 */
const HTTP_STATUS_OK_MIN = 200;
const HTTP_STATUS_OK_MAX = 299;

/** A sha256 as the records write it: 64 lower-case hex characters. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const MAX_OBSERVED_LENGTH = 120;

const forDisplay = (value: unknown): string => {
    if (value === undefined) {
        return 'absent';
    }
    if (typeof value === 'string') {
        return value.length > MAX_OBSERVED_LENGTH ? `${value.slice(0, MAX_OBSERVED_LENGTH)}…` : JSON.stringify(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        return String(value);
    }
    return Array.isArray(value) ? `array(${value.length})` : typeof value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One field of a retrieval record, read under either spelling.
 *
 * `conflict` is its own outcome rather than a precedence rule: a record
 * carrying `http_status: 200` and `status: 404` states two different things
 * about one exchange, and choosing either would publish a row on a value the
 * record itself contradicts.
 */
type FieldRead =
    | { readonly kind: 'value'; readonly field: string; readonly value: unknown }
    | { readonly kind: 'absent'; readonly field: string }
    | { readonly kind: 'conflict'; readonly field: string; readonly observed: string };

const readField = (record: Record<string, unknown>, spellings: readonly string[]): FieldRead => {
    const present = spellings.filter((spelling) => record[spelling] !== undefined);

    if (present.length === 0) {
        return { kind: 'absent', field: spellings[0] };
    }
    if (present.length > 1) {
        const values = present.map((spelling) => `${spelling}=${forDisplay(record[spelling])}`);
        const distinct = new Set(present.map((spelling) => JSON.stringify(record[spelling] ?? null)));
        if (distinct.size > 1) {
            return { kind: 'conflict', field: present.join('/'), observed: values.join(' ') };
        }
    }

    const field = present[0];
    return { kind: 'value', field, value: record[field] };
};

const nonEmptyStringGap = (
    read: FieldRead,
    code: EvidenceGapCode,
    requirement: string,
): { readonly gap: EvidenceGap | null; readonly value: string | null } => {
    if (read.kind === 'absent') {
        return { gap: { code, field: read.field, observed: 'absent', requirement }, value: null };
    }
    if (read.kind === 'conflict') {
        return {
            gap: { code: 'evidence_malformed', field: read.field, observed: read.observed, requirement },
            value: null,
        };
    }
    if (typeof read.value !== 'string' || read.value.trim().length === 0) {
        return { gap: { code, field: read.field, observed: forDisplay(read.value), requirement }, value: null };
    }
    return { gap: null, value: read.value };
};

/**
 * Whether a string is an ISO-8601 instant this process can actually read back.
 *
 * `Date.parse` alone is too permissive — it accepts `"2026"` and a range of
 * vendor-specific spellings — so the shape is pinned first and the value is
 * then required to be a real calendar instant. The round-trip comparison is
 * what rejects `"2026-02-31T00:00:00Z"`, which matches the shape and parses,
 * but to a different day than it names.
 */
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const isIsoInstant = (value: string): boolean => {
    if (!ISO_INSTANT_PATTERN.test(value)) {
        return false;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return false;
    }
    // A shape-valid string naming a day that does not exist parses to a
    // different instant than it spells, which the day-of-month comparison
    // catches without re-implementing the calendar.
    return parsed.getUTCDate() === Number(value.slice(8, 10));
};

const digestGap = (read: FieldRead, code: EvidenceGapCode, subject: string): EvidenceGap | null => {
    const requirement = `${subject}: 64 lower-case hex characters`;
    const { gap, value } = nonEmptyStringGap(read, code, requirement);
    if (gap !== null) {
        return gap;
    }
    return value !== null && SHA256_HEX_PATTERN.test(value)
        ? null
        : { code, field: read.field, observed: forDisplay(value), requirement };
};

/**
 * Assesses one row's `catalog_validation_records.identity_evidence` against the
 * fields a publishable record must state.
 *
 * WHAT IS MANDATORY, AND WHY EACH ONE. The first record is the one every
 * consumer reads (the exporter writes the array in retrieval order and the
 * import writes exactly one), so it is the record assessed — a second record is
 * additional corroboration and cannot repair the first.
 *
 *   * `url` and `final_host` — where the bytes came from, so a reviewer can
 *     re-fetch them. Without them the digest below is unverifiable.
 *   * `http_status` — the observed upstream status, an integer in the 2xx
 *     range. AAP §0.3.2 makes it a field of the record; `null` means nobody
 *     observed it, and the one repair is to make the retrieval again. It is
 *     never defaulted to 200: a substituted status is the fabricated evidence
 *     this floor exists to keep out of a published row.
 *   * a body digest — what was retrieved, so the payload behind the claim can
 *     be recomputed and compared.
 *   * `matched_snippet` — the text that names this food in those bytes. A page
 *     that was fetched but does not mention the food is not evidence of it.
 *   * `fetched_at` — when, so a stale retrieval is visible as one.
 *   * for a USDA row additionally `source_cache_key` and `record_sha256` — the
 *     `usda_api_cache` row the payload is recorded under and the digest of this
 *     food's own record inside it, which is what makes one batch response
 *     evidence for one specific food rather than for the twenty it carried.
 *
 * Returns the gaps rather than throwing: each caller turns them into its own
 * consequence — validation holds the row, the exporter refuses the release, the
 * loader refuses before writing anything — and a thrown error would force the
 * per-row callers to catch one.
 */
export const assessIdentityEvidence = (
    identityEvidence: unknown,
    input: { readonly identitySource: string },
): EvidenceAssessment => {
    const gaps: EvidenceGap[] = [];

    if (!Array.isArray(identityEvidence) || identityEvidence.length === 0) {
        return {
            complete: false,
            gaps: [
                {
                    code: 'evidence_absent',
                    field: 'identity_evidence',
                    observed: forDisplay(identityEvidence),
                    requirement: 'at least one retrieval record',
                },
            ],
            status: null,
            finalHost: null,
        };
    }

    const first: unknown = identityEvidence[0];
    if (!isRecord(first)) {
        return {
            complete: false,
            gaps: [
                {
                    code: 'evidence_malformed',
                    field: 'identity_evidence[0]',
                    observed: forDisplay(first),
                    requirement: 'a retrieval record object',
                },
            ],
            status: null,
            finalHost: null,
        };
    }

    const usda = input.identitySource === USDA_IDENTITY_SOURCE;

    const url = nonEmptyStringGap(readField(first, ['url']), 'retrieval_url_missing', 'the URL that served the bytes');
    if (url.gap !== null) {
        gaps.push(url.gap);
    }

    const host = nonEmptyStringGap(
        readField(first, ['final_host', 'finalHost']),
        'retrieval_host_missing',
        'the host the bytes came from',
    );
    if (host.gap !== null) {
        gaps.push(host.gap);
    }

    const statusRead = readField(first, ['http_status', 'status']);
    let status: number | null = null;
    const statusRequirement = `an observed HTTP status in ${HTTP_STATUS_OK_MIN}..${HTTP_STATUS_OK_MAX}`;
    if (statusRead.kind === 'absent' || (statusRead.kind === 'value' && statusRead.value === null)) {
        gaps.push({
            code: 'retrieval_status_missing',
            field: statusRead.field,
            observed: statusRead.kind === 'absent' ? 'absent' : 'null',
            requirement: statusRequirement,
        });
    } else if (statusRead.kind === 'conflict') {
        gaps.push({
            code: 'evidence_malformed',
            field: statusRead.field,
            observed: statusRead.observed,
            requirement: statusRequirement,
        });
    } else if (
        typeof statusRead.value !== 'number' ||
        !Number.isInteger(statusRead.value) ||
        statusRead.value < HTTP_STATUS_OK_MIN ||
        statusRead.value > HTTP_STATUS_OK_MAX
    ) {
        gaps.push({
            code: 'retrieval_status_invalid',
            field: statusRead.field,
            observed: forDisplay(statusRead.value),
            requirement: statusRequirement,
        });
        status = typeof statusRead.value === 'number' && Number.isInteger(statusRead.value) ? statusRead.value : null;
    } else {
        status = statusRead.value;
    }

    const bodyDigest = digestGap(
        readField(first, ['body_sha256', 'bodySha256']),
        'retrieval_body_digest_missing',
        'the digest of the retrieved payload',
    );
    if (bodyDigest !== null) {
        gaps.push(bodyDigest);
    }

    const snippet = nonEmptyStringGap(
        readField(first, ['matched_snippet', 'matchedSnippet']),
        'retrieval_snippet_missing',
        'the text in those bytes that names this food',
    );
    if (snippet.gap !== null) {
        gaps.push(snippet.gap);
    }

    const fetchedAt = nonEmptyStringGap(
        readField(first, ['fetched_at', 'fetchedAt']),
        'retrieval_time_missing',
        'when the retrieval happened, as an ISO-8601 instant',
    );
    if (fetchedAt.gap !== null) {
        gaps.push(fetchedAt.gap);
    } else if (fetchedAt.value !== null && !isIsoInstant(fetchedAt.value)) {
        // PRESENT IS NOT THE SAME AS USABLE. The requirement above says
        // "ISO-8601 instant", and a record whose `fetched_at` is `"soon"` or
        // `"2026-13-45"` satisfies a non-blank check while telling a reader
        // nothing about when the retrieval happened — which is the whole point
        // of keeping it. Every field this predicate describes is validated as
        // the thing it is described as, so the description and the check cannot
        // drift apart.
        gaps.push({
            code: 'retrieval_time_invalid',
            field: 'identity_evidence[0].fetched_at',
            observed: forDisplay(fetchedAt.value),
            requirement: 'an ISO-8601 instant, which is what a retrieval time is recorded as',
        });
    }

    if (usda) {
        const cacheKey = nonEmptyStringGap(
            readField(first, ['source_cache_key', 'sourceCacheKey']),
            'retrieval_source_cache_key_missing',
            'the usda_api_cache key the payload is recorded under',
        );
        if (cacheKey.gap !== null) {
            gaps.push(cacheKey.gap);
        }

        const recordDigest = digestGap(
            readField(first, ['record_sha256', 'recordSha256']),
            'retrieval_record_digest_missing',
            "the digest of this food's own record inside that payload",
        );
        if (recordDigest !== null) {
            gaps.push(recordDigest);
        }
    }

    return { complete: gaps.length === 0, gaps, status, finalHost: host.value };
};

/** The gap codes, sorted and de-duplicated: the machine-readable half of a refusal. */
export const evidenceGapCodes = (assessment: EvidenceAssessment): readonly EvidenceGapCode[] =>
    Array.from(new Set(assessment.gaps.map((gap) => gap.code))).sort();

/**
 * One sentence naming every gap, for a log field, a refusal message or the
 * `nutrition_assumptions` entry a held row records.
 *
 * Deterministic in gap order, because it ends up in a stored record and in a
 * release refusal an operator diffs.
 */
export const describeEvidenceGaps = (assessment: EvidenceAssessment): string =>
    assessment.gaps
        .map((gap) => `${gap.field} ${gap.observed} (${gap.code}); required: ${gap.requirement}`)
        .join('; ');

/**
 * The sentence a validation record carries when this floor held the row.
 *
 * Written as prose rather than as a code because it lands in
 * `catalog_validation_records.nutrition_assumptions`, which is what a curator
 * reads: it has to say what is missing and what the repair is without a lookup
 * table.
 */
export const evidenceFloorAssumption = (assessment: EvidenceAssessment): string =>
    `identity evidence is incomplete, so the food is held rather than published: ${describeEvidenceGaps(
        assessment,
    )}. The retrieval must be made again by the stage that owns the row (catalog:import for a USDA record, catalog:generate for a generated one); no field of a retrieval record may be reconstructed after the fact.`;

/* ---------------------------------------------------------------------------
 * The source cache a USDA record's digests are taken over
 * ------------------------------------------------------------------------- */

/**
 * Why a USDA row's evidence record cannot be RESOLVED against the payload it
 * cites.
 *
 * WHAT THIS ADDS TO {@link assessIdentityEvidence}, AND WHY IT IS NOT THE SAME
 * QUESTION. That predicate is structural: it asks whether the record STATES a
 * cache key and two digests of the right shape. Both halves can be present and
 * well-formed while standing for nothing — an unresolvable
 * `usda_api_cache.cache_key`, or 64 hex characters that are not the digest of
 * anything — and a release cut from such records carries evidence that cannot
 * be re-derived by anyone. The whole point of storing a cache key beside a
 * digest is that a reader can look the payload up and recompute; until
 * something does, the digest is a claim about itself.
 *
 * One code per repairable cause, on the same principle as
 * {@link EvidenceGapCode}: a missing cache row needs the batch re-imported, a
 * status disagreement means the record and the ledger describe two different
 * exchanges, a body-digest mismatch means the payload changed under the record
 * (or the record was copied from another response), and a record-digest
 * mismatch means the digest does not belong to this food.
 */
export type CacheBindingGapCode =
    | 'cache_key_missing'
    | 'cache_row_absent'
    | 'cache_payload_not_records'
    | 'cache_status_missing'
    | 'cache_status_disagrees'
    | 'cache_record_absent'
    | 'cache_subject_missing'
    | 'cache_body_digest_disagrees'
    | 'cache_record_digest_disagrees';

/** One unmet requirement of one record's binding to its cached payload. */
export interface CacheBindingGap {
    readonly code: CacheBindingGapCode;
    readonly field: string;
    readonly observed: string;
    readonly requirement: string;
}

export interface CacheBindingAssessment {
    /** True only when the payload was found and both digests recompute to what the record states. */
    readonly resolved: boolean;
    readonly gaps: readonly CacheBindingGap[];
    /** The `usda_api_cache` key that was looked up, or `null` when the record states none. */
    readonly cacheKey: string | null;
}

/** One `usda_api_cache` row, in the column vocabulary the table holds it in. */
export interface SourceCacheRow {
    readonly cache_key: string;
    readonly payload: unknown;
    readonly http_status: number | null;
}

/**
 * How the two digests are reproduced, restated where the comparison happens.
 *
 * `catalog-import-usda.ts` writes `body_sha256` as
 * `sha256Hex(canonicalJsonString(<the whole cached response payload>))` and
 * `record_sha256` as `sha256Hex(canonicalJsonString(<this food's own record
 * within it>))`, both through `./catalogFoodFacts`. Recomputing them any other
 * way — a different canonicalisation, a different subject — would make this
 * check answer a question nobody asked, so the SAME two helpers are called
 * here, and the one transformation the import applies to a record on its way
 * out of the payload is applied too: `usda.service.ts::toIdentifiedRecord`
 * replaces `fdcId` with its canonical number (`{...record, fdcId}`) before the
 * record is ever digested, because the datasets that stringify the id would
 * otherwise produce a different digest for the same food.
 */
const identifiedCacheRecord = (record: Record<string, unknown>, fdcId: number): Record<string, unknown> => ({
    ...record,
    fdcId,
});

/**
 * Resolves one published USDA row's identity evidence against the
 * `usda_api_cache` row it cites, and recomputes both digests from the stored
 * payload.
 *
 * WHERE THIS CAN BE APPLIED, AND WHERE IT CANNOT. It needs the cache row, so it
 * belongs to a stage that has the database the import wrote: the exporter runs
 * it over every published USDA row as it walks them, which is the last point at
 * which the record and the payload behind it are both reachable. After that the
 * release is bytes behind a digest and `catalog-load.ts` cannot perform it at
 * all — no release member carries `usda_api_cache`, and inventing a check there
 * would be theatre. What the loader enforces instead is the structural
 * predicate plus the manifest's attestation that this resolution happened, and
 * its own comments say exactly that rather than implying more.
 *
 * THE RECORD MUST BE THIS FOOD'S. A batch response carries up to twenty foods,
 * so a `record_sha256` that matches SOME record in the payload proves nothing
 * about the row citing it — one food's digest lifted onto another's evidence
 * would pass. The subject is therefore selected by the row's own
 * `usda_fdc_id` and the digest is compared against that record alone; a row
 * whose fdcId the catalog does not hold cannot be bound at all, which is its
 * own gap rather than a pass.
 *
 * Returns gaps rather than throwing, on the same terms as the two predicates
 * above: the caller — the exporter, refusing a release — turns them into its
 * own refusal, and a per-row caller is never forced to catch.
 */
export const assessSourceCacheBinding = (input: {
    readonly identityEvidence: unknown;
    /** `catalog_foods.usda_fdc_id`: which record inside the payload is this food's. */
    readonly usdaFdcId: number | null;
    /** The `usda_api_cache` row found under the record's cache key, or `null` when there is none. */
    readonly cacheRow: SourceCacheRow | null;
}): CacheBindingAssessment => {
    const gaps: CacheBindingGap[] = [];
    const first: unknown = Array.isArray(input.identityEvidence) ? input.identityEvidence[0] : null;

    if (!isRecord(first)) {
        // Structurally absent evidence is `assessIdentityEvidence`'s refusal and
        // is already reported there; naming it again as a binding gap would
        // report one defect twice, so this answers only what it can see.
        return {
            resolved: false,
            gaps: [
                {
                    code: 'cache_key_missing',
                    field: 'identity_evidence[0]',
                    observed: forDisplay(first),
                    requirement: 'a retrieval record stating the usda_api_cache key its payload is recorded under',
                },
            ],
            cacheKey: null,
        };
    }

    const keyRead = nonEmptyStringGap(
        readField(first, ['source_cache_key', 'sourceCacheKey']),
        'retrieval_source_cache_key_missing',
        'the usda_api_cache key the payload is recorded under',
    );
    if (keyRead.value === null) {
        return {
            resolved: false,
            gaps: [
                {
                    code: 'cache_key_missing',
                    field: 'identity_evidence[0].source_cache_key',
                    observed: keyRead.gap === null ? 'absent' : keyRead.gap.observed,
                    requirement: 'the usda_api_cache key the payload is recorded under',
                },
            ],
            cacheKey: null,
        };
    }
    const cacheKey = keyRead.value;

    if (input.cacheRow === null) {
        return {
            resolved: false,
            gaps: [
                {
                    code: 'cache_row_absent',
                    field: 'usda_api_cache.cache_key',
                    observed: cacheKey,
                    requirement:
                        'a usda_api_cache row under this key, so the payload the digests were taken over can be read back',
                },
            ],
            cacheKey,
        };
    }

    // The status on the record has to be the status of the exchange the cache
    // row holds. Two different numbers mean the record describes an exchange
    // other than the one behind the payload it cites, whichever of them is
    // right — and the import copies this field from the retrieval, so they
    // agree in every row it wrote.
    const statedStatus = readField(first, ['http_status', 'status']);
    const recordStatus =
        statedStatus.kind === 'value' && typeof statedStatus.value === 'number' && Number.isInteger(statedStatus.value)
            ? statedStatus.value
            : null;
    if (input.cacheRow.http_status === null) {
        gaps.push({
            code: 'cache_status_missing',
            field: 'usda_api_cache.http_status',
            observed: 'null',
            requirement: `an observed HTTP status in ${HTTP_STATUS_OK_MIN}..${HTTP_STATUS_OK_MAX} on the cache row this record cites`,
        });
    } else if (
        input.cacheRow.http_status < HTTP_STATUS_OK_MIN ||
        input.cacheRow.http_status > HTTP_STATUS_OK_MAX ||
        recordStatus === null ||
        recordStatus !== input.cacheRow.http_status
    ) {
        gaps.push({
            code: 'cache_status_disagrees',
            field: 'usda_api_cache.http_status',
            observed: `cache row ${forDisplay(input.cacheRow.http_status)}, evidence record ${forDisplay(
                recordStatus === null ? statedStatus.kind === 'value' ? statedStatus.value : null : recordStatus,
            )}`,
            requirement: `one successful status in ${HTTP_STATUS_OK_MIN}..${HTTP_STATUS_OK_MAX}, stated identically by the record and the cache row it cites`,
        });
    }

    const bodyDigest = digestGap(
        readField(first, ['body_sha256', 'bodySha256']),
        'retrieval_body_digest_missing',
        'the digest of the retrieved payload',
    );
    if (bodyDigest === null) {
        const recomputed = sha256Hex(canonicalJsonString(input.cacheRow.payload));
        const stated = readField(first, ['body_sha256', 'bodySha256']);
        if (stated.kind === 'value' && stated.value !== recomputed) {
            gaps.push({
                code: 'cache_body_digest_disagrees',
                field: 'identity_evidence[0].body_sha256',
                observed: `states ${forDisplay(stated.value)}, the cached payload digests to ${recomputed}`,
                requirement:
                    'the digest of the key-sorted JSON of the whole cached response payload, as catalog-import-usda.ts takes it',
            });
        }
    }

    // The record inside the payload that belongs to THIS food, selected by the
    // row's own fdcId rather than by position: a batch response is unordered and
    // carries up to twenty foods.
    if (input.usdaFdcId === null) {
        gaps.push({
            code: 'cache_subject_missing',
            field: 'catalog_foods.usda_fdc_id',
            observed: 'null',
            requirement:
                "the FDC id of this food, without which no record inside the payload can be identified as its own",
        });
        return { resolved: false, gaps, cacheKey };
    }

    if (!Array.isArray(input.cacheRow.payload)) {
        gaps.push({
            code: 'cache_payload_not_records',
            field: 'usda_api_cache.payload',
            observed: forDisplay(input.cacheRow.payload),
            requirement: "an array of USDA records, which is what POST /foods answers and what this food's record lives in",
        });
        return { resolved: false, gaps, cacheKey };
    }

    const subject = input.cacheRow.payload.find(
        (entry): entry is Record<string, unknown> =>
            isRecord(entry) && parseCanonicalFdcId(entry.fdcId) === input.usdaFdcId,
    );
    if (subject === undefined) {
        gaps.push({
            code: 'cache_record_absent',
            field: 'usda_api_cache.payload',
            observed: `no record for fdcId ${input.usdaFdcId} among ${input.cacheRow.payload.length}`,
            requirement:
                "the cached payload to carry this food's own record, which is what makes it evidence for this food rather than for the batch",
        });
        return { resolved: false, gaps, cacheKey };
    }

    const recordDigest = digestGap(
        readField(first, ['record_sha256', 'recordSha256']),
        'retrieval_record_digest_missing',
        "the digest of this food's own record inside that payload",
    );
    if (recordDigest === null) {
        const recomputed = sha256Hex(canonicalJsonString(identifiedCacheRecord(subject, input.usdaFdcId)));
        const stated = readField(first, ['record_sha256', 'recordSha256']);
        if (stated.kind === 'value' && stated.value !== recomputed) {
            gaps.push({
                code: 'cache_record_digest_disagrees',
                field: 'identity_evidence[0].record_sha256',
                observed: `states ${forDisplay(stated.value)}, the cached record for fdcId ${
                    input.usdaFdcId
                } digests to ${recomputed}`,
                requirement:
                    "the digest of the key-sorted JSON of this food's own record inside the cached payload — a digest of another food's record does not evidence this one",
            });
        }
    }

    return { resolved: gaps.length === 0, gaps, cacheKey };
};

/**
 * Whether a row of this identity source binds a `usda_api_cache` payload, and
 * therefore has a source-cache binding to resolve.
 *
 * WHY IT LIVES HERE WITH THE RULE IT FOLLOWS FROM. A USDA row's evidence is the
 * vendor exchange its record was read out of, and that response is recorded in
 * `usda_api_cache` — which is why {@link assessIdentityEvidence} demands a
 * cache key and a per-food digest of exactly those rows, and why
 * {@link assessSourceCacheBinding} can resolve them. A generated row's evidence
 * is a fetched reference page: nothing cached it here, so there is no row to
 * look up and no digest to recompute.
 *
 * It is exported because two stages have to count the SAME set of rows and must
 * not each decide what it is: `catalog-release.ts` resolves every such row and
 * attests how many there were, and `catalog-load.ts` re-measures that count
 * from `foods.jsonl` to check the attestation covers the release it is loading.
 * The two entry points share no module graph, so this is the only place the
 * answer can be stated once.
 */
export const cacheBindingRequired = (identitySource: string): boolean => identitySource === USDA_IDENTITY_SOURCE;

/**
 * The `usda_api_cache` key one record cites, read under either spelling.
 *
 * Exported because a caller has to LOOK THE ROW UP before it can be assessed,
 * and reading the key itself would put a second reader of this record shape in
 * a script — the exact duplication this module exists to prevent. `null` means
 * the record states none, which {@link assessSourceCacheBinding} then reports
 * as `cache_key_missing` when it is handed the same record.
 */
export const identityEvidenceSourceCacheKey = (identityEvidence: unknown): string | null => {
    const first: unknown = Array.isArray(identityEvidence) ? identityEvidence[0] : null;
    if (!isRecord(first)) {
        return null;
    }
    const read = readField(first, ['source_cache_key', 'sourceCacheKey']);
    return read.kind === 'value' && typeof read.value === 'string' && read.value.trim().length > 0
        ? read.value
        : null;
};

/** The cache-binding gap codes, sorted and de-duplicated. */
export const cacheBindingGapCodes = (assessment: CacheBindingAssessment): readonly CacheBindingGapCode[] =>
    Array.from(new Set(assessment.gaps.map((gap) => gap.code))).sort();

/** One sentence naming every binding gap, in gap order. */
export const describeCacheBindingGaps = (assessment: CacheBindingAssessment): string =>
    assessment.gaps
        .map((gap) => `${gap.field} ${gap.observed} (${gap.code}); required: ${gap.requirement}`)
        .join('; ');

/* ---------------------------------------------------------------------------
 * Component-derived nutrition
 * ------------------------------------------------------------------------- */

/** Why an ingredient-derived row's stored nutrition cannot be published. */
export type ComponentGapCode =
    | 'components_absent'
    | 'component_version_stale'
    | 'component_nutrition_unknown'
    | 'derivation_failed'
    | 'parent_nutrition_disagrees'
    | 'parent_basis_disagrees'
    | 'parent_provenance_disagrees';

export interface ComponentGap {
    readonly code: ComponentGapCode;
    readonly field: string;
    readonly observed: string;
    readonly requirement: string;
}

/**
 * One component row as the stages hold it: the pinned quantities from
 * `catalog_food_components`, the component food's CURRENT per-100 g nutrition
 * and its CURRENT `nutrition_version`.
 *
 * The current version is what makes staleness observable: the pin
 * (`component_nutrition_version`) states which version the parent's stored
 * totals were computed from, so a component whose nutrition has since been
 * re-imported has moved out from under them.
 */
export interface ComponentDerivationComponent {
    /** The portable identity used in messages — a source key, or an id where no key is held. */
    readonly componentKey: string;
    readonly quantityGrams: number;
    readonly yieldFactor: number;
    readonly pinnedNutritionVersion: number;
    readonly currentNutritionVersion: number;
    readonly sortOrder: number;
    readonly nutrition: CatalogNutrientValues;
}

/** The parent's stored facts, as the row states them. */
export interface ComponentDerivationParent {
    readonly sourceKey: string;
    readonly nutritionBasis: string;
    readonly basisAmount: number | null;
    readonly nutrition: CatalogNutrientValues;
    /**
     * The provenance the row CLAIMS, which this assessment checks rather than
     * trusts.
     *
     * WHY IT IS AN INPUT AND NOT A PRECONDITION. `deriveComponentNutrition`
     * fixes the provenance of anything derived from a composition to
     * `ingredient_derived` (`catalog.logic.ts`), so a row that carries
     * component rows and claims any other provenance is stating two
     * incompatible things about where its numbers came from. Deciding whether
     * to run this assessment FROM that claim would make the claim
     * self-certifying: flipping a component-bearing row to `source_backed`
     * would switch off the very check that detects the contradiction. So the
     * caller passes the claim in, the assessment applies whenever a
     * composition is present, and a disagreement is reported as
     * `parent_provenance_disagrees` instead of silently excusing the row.
     */
    readonly nutritionProvenance: string;
}

export interface ComponentDerivationAssessment {
    /** True when the stored parent facts equal what its composition derives to. */
    readonly consistent: boolean;
    readonly gaps: readonly ComponentGap[];
    /** The recomputed per-100 g values, or `null` when the derivation itself failed. */
    readonly derivedNutrition: CatalogNutrientValues | null;
    /** The check `deriveComponentNutrition` produced when it refused, for the record. */
    readonly derivationCheck: CatalogValidationCheck | null;
}

/**
 * One component FOOD's own stored nutrition facts, in the column vocabulary
 * every stage holds them in — `catalog_foods` columns for validation, the
 * identically-named `foods.jsonl` fields for the loader.
 *
 * Read as a whole rather than as five nutrients, because the nutrients alone do
 * not say what they are per: a published catalog food may legitimately be
 * stored `per_100ml` with a density (the coverage plan's `publishableBases` are
 * `per_100g` and `per_100ml`), and 22 kcal per 100 ml of lemon juice is not 22
 * kcal per 100 g of it.
 */
export interface ComponentFoodFacts {
    /** The component's CURRENT counter, which is what makes a pin's staleness observable. */
    readonly nutrition_version: number;
    readonly nutrition_basis: string;
    readonly basis_amount: number;
    readonly calories: number | null;
    readonly protein_g: number | null;
    readonly carbs_g: number | null;
    readonly fat_g: number | null;
    readonly fiber_g: number | null;
    readonly density_g_per_ml: number | null;
}

/**
 * One component row, as {@link assessComponentDerivation} needs it, from the
 * pinned quantities and the component food's own stored facts.
 *
 * WHY THIS EXISTS AND IS NOT INLINED AT EACH CALL SITE. The derivation sums
 * PER-100 G values ({@link ComponentDerivationComponent.nutrition}, and
 * `catalog.logic.ts::deriveComponentNutrition` says so in its own contract),
 * while `catalog_foods` and `foods.jsonl` state a food's nutrition on whatever
 * basis its source used. Getting from the second to the first is a conversion
 * with a failure mode, and two stages deciding it separately is precisely how
 * the pipeline came to hold four disagreeing answers to one question (see WHY
 * THIS MODULE EXISTS). So it is decided once, here, and both the validator and
 * the loader call it.
 *
 * NO ARITHMETIC OF ITS OWN. The conversion is `normalizeToPer100g` — the same
 * exported function validation already brings a PARENT row onto that basis with
 * — so the millilitre-to-gram density rule, the per-serving gram weight rule and
 * the overflow guards all stay in `catalog.logic.ts` under its unit tests. This
 * function screens the basis, calls it, and translates the two outcomes.
 *
 * A BASIS THE CONVERSION CANNOT USE MAKES THE NUTRITION UNKNOWN, NOT ZERO AND
 * NOT ASSUMED PER-100 G. A `per_100ml` component with no stored density, a
 * `per_serving` one with no sourced gram weight, or a basis outside the three
 * declared values does not state per-100 g nutrition at all, so every nutrient
 * is supplied as `null` — this module's own encoding of unknown — and the
 * derivation reports it as such rather than summing numbers that mean something
 * else. Passing the stored scalars through regardless would be the quiet
 * mis-derivation this whole floor exists to catch: it would publish a parent
 * whose totals were computed from millilitres and grams added together.
 *
 * The basis is screened with `isCatalogNutritionBasis` BEFORE the call because
 * `normalizeToPer100g` throws `CatalogIdentityError` on a fourth basis value,
 * and this module never throws — every caller turns a returned gap into its own
 * consequence, and a per-row caller forced to catch would be exactly the
 * control flow the no-throw property removes.
 */
export const componentDerivationComponentOf = (input: {
    readonly componentKey: string;
    readonly quantityGrams: number;
    readonly yieldFactor: number;
    /** `catalog_food_components.component_nutrition_version` — the version the parent's totals were taken from. */
    readonly pinnedNutritionVersion: number;
    readonly sortOrder: number;
    readonly componentFood: ComponentFoodFacts;
}): ComponentDerivationComponent => {
    const facts = input.componentFood;
    const unknownNutrition: CatalogNutrientValues = {
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
    };

    // `serving_gram_weight` is deliberately not supplied: a `per_serving`
    // component's weight lives on its default portion, which is a different
    // row from the one a stage holds here, and a per-serving basis is not
    // publishable in the first place (the plan's `publishableBases`). So such a
    // component normalises to `missing_gram_weight` and its nutrition is
    // reported unknown, which is the truthful answer rather than a weight
    // invented to make the sum work.
    const normalized = isCatalogNutritionBasis(facts.nutrition_basis)
        ? normalizeToPer100g({
              nutrition_basis: facts.nutrition_basis,
              basis_amount: facts.basis_amount,
              calories: facts.calories,
              protein_g: facts.protein_g,
              carbs_g: facts.carbs_g,
              fat_g: facts.fat_g,
              fiber_g: facts.fiber_g,
              density_g_per_ml: facts.density_g_per_ml,
          })
        : null;

    return {
        componentKey: input.componentKey,
        quantityGrams: input.quantityGrams,
        yieldFactor: input.yieldFactor,
        pinnedNutritionVersion: input.pinnedNutritionVersion,
        currentNutritionVersion: facts.nutrition_version,
        sortOrder: input.sortOrder,
        // A `per_100g` record of 100 g converts at a factor of exactly 1, so an
        // already-per-100 g component round-trips bit for bit and the parent's
        // stored scalars are compared against the same doubles the pipeline
        // wrote — the tolerance below is never spent on this conversion.
        nutrition: normalized === null || normalized.kind === 'error' ? unknownNutrition : normalized.normalized.nutrition,
    };
};

/** The basis an ingredient-derived food is recomputed on; `deriveComponentNutrition` states it. */
const DERIVED_BASIS = 'per_100g';
const DERIVED_BASIS_AMOUNT = 100;

/**
 * How far a stored nutrient may sit from the recomputation before the two are
 * different numbers.
 *
 * Relative, with an absolute floor for values near zero: the stored scalar and
 * the recomputation are both doubles produced by the same sum in a different
 * process, so they agree to the last few bits rather than exactly, and a strict
 * equality test would hold every derived row in the catalog. A drift larger
 * than this is not floating-point noise — it is a parent whose numbers were
 * written from a composition the table no longer holds.
 */
const NUTRIENT_RELATIVE_TOLERANCE = 1e-6;
const NUTRIENT_ABSOLUTE_TOLERANCE = 1e-6;

const nutrientFields: readonly (keyof CatalogNutrientValues)[] = [
    'calories',
    'protein_g',
    'carbs_g',
    'fat_g',
    'fiber_g',
];

const nutrientsAgree = (stored: number | null, derived: number | null): boolean => {
    if (stored === null || derived === null) {
        // Both unknown is agreement — a nutrient no component states is unknown
        // in the derivation too. One known and the other not is a disagreement,
        // which is the case this returns false for.
        return stored === derived;
    }
    if (!Number.isFinite(stored) || !Number.isFinite(derived)) {
        return false;
    }
    const difference = Math.abs(stored - derived);
    return difference <= Math.max(NUTRIENT_ABSOLUTE_TOLERANCE, Math.abs(derived) * NUTRIENT_RELATIVE_TOLERANCE);
};

/**
 * The one provenance a composition can derive to.
 *
 * `deriveComponentNutrition` returns `nutrition_provenance: 'ingredient_derived'`
 * unconditionally for every successful derivation (`catalog.logic.ts`), so this
 * is that function's own output value restated where the comparison happens
 * rather than an independent policy choice. It is declared here, beside the
 * assessment, because `catalog.logic.ts` exports the provenance VOCABULARY
 * (`CATALOG_NUTRITION_PROVENANCES`) but not this single member, and a string
 * literal inline in the comparison would leave the tie to the derivation
 * unstated.
 */
export const COMPONENT_DERIVED_PROVENANCE = 'ingredient_derived';

/**
 * Recomputes a composition-bearing row's nutrition from its stored composition
 * and compares the result with what the row says.
 *
 * WHY A PUBLISHED ROW HAS TO PASS THIS. An `ingredient_derived` food's nutrient
 * columns are not a source's statement — they are the output of
 * `deriveComponentNutrition` over `catalog_food_components` (AAP §0.5.1), and
 * `recipe_ingredients` snapshots them with the version counters that say which
 * component values they came from. If the parent's scalars and its composition
 * disagree, the catalog is publishing numbers nothing in it derives, and a
 * recipe built on them cites a composition that never produced them.
 *
 * The derivation itself is NOT re-implemented here: the arithmetic, the
 * `yield_factor` mass model, the summation order and the unknown-nutrient rule
 * all belong to `catalog.logic.ts` and are unit-tested there. This function
 * supplies that function's inputs from the rows a stage is holding, adds the
 * two facts the pure derivation cannot see — whether a component's pinned
 * version is still its current one, and whether the parent's stored basis and
 * scalars match the result — and returns the gaps.
 */
export const assessComponentDerivation = (input: {
    readonly parent: ComponentDerivationParent;
    readonly components: readonly ComponentDerivationComponent[];
}): ComponentDerivationAssessment => {
    const gaps: ComponentGap[] = [];

    if (input.components.length === 0) {
        return {
            consistent: false,
            gaps: [
                {
                    code: 'components_absent',
                    field: 'catalog_food_components',
                    observed: '0 rows',
                    requirement:
                        'at least one component row, because an ingredient-derived food states nutrition derived from one',
                },
            ],
            derivedNutrition: null,
            derivationCheck: null,
        };
    }

    // THE PROVENANCE THE ROW CLAIMS, CHECKED RATHER THAN TRUSTED. A composition
    // is present, so these numbers are derivable from it, and
    // `deriveComponentNutrition` calls anything it derives `ingredient_derived`.
    // A row claiming another provenance while carrying component rows is
    // therefore self-contradictory, and reporting it here is what stops the
    // claim from deciding whether it is examined (see
    // `ComponentDerivationParent.nutritionProvenance`). The gap is added and the
    // derivation still runs, so one refusal names both the contradiction and
    // any arithmetic disagreement beneath it.
    if (input.parent.nutritionProvenance !== COMPONENT_DERIVED_PROVENANCE) {
        gaps.push({
            code: 'parent_provenance_disagrees',
            field: 'catalog_foods.nutrition_provenance',
            observed: `${input.parent.nutritionProvenance}, on a food carrying ${input.components.length} component row(s)`,
            requirement: `${COMPONENT_DERIVED_PROVENANCE}, which is the provenance a composition derives to`,
        });
    }

    // Staleness is reported for EVERY stale component rather than the first, so
    // one refusal names the whole repair.
    for (const component of input.components) {
        if (component.pinnedNutritionVersion !== component.currentNutritionVersion) {
            gaps.push({
                code: 'component_version_stale',
                field: `catalog_food_components.component_nutrition_version (${component.componentKey})`,
                observed: `pinned ${component.pinnedNutritionVersion}, component now at ${component.currentNutritionVersion}`,
                requirement:
                    'the pinned component nutrition version to equal the component food\'s current nutrition_version',
            });
        }
    }

    const derivation = deriveComponentNutrition(
        input.components.map(
            (component): CatalogComponentNutritionInput => ({
                component_catalog_food_id: component.componentKey,
                quantity_grams: component.quantityGrams,
                yield_factor: component.yieldFactor,
                component_nutrition_version: component.pinnedNutritionVersion,
                sort_order: component.sortOrder,
                nutrition: component.nutrition,
            }),
        ),
    );

    if (derivation.kind === 'error') {
        gaps.push({
            code: 'derivation_failed',
            field: 'catalog_food_components',
            observed: `${derivation.check.name}: ${forDisplay(derivation.check.observed)}`,
            requirement: String(derivation.check.bound),
        });
        return { consistent: false, gaps, derivedNutrition: null, derivationCheck: derivation.check };
    }

    const derived = derivation.derived.nutrition;

    if (input.parent.nutritionBasis !== DERIVED_BASIS || input.parent.basisAmount !== DERIVED_BASIS_AMOUNT) {
        gaps.push({
            code: 'parent_basis_disagrees',
            field: 'catalog_foods.nutrition_basis/basis_amount',
            observed: `${input.parent.nutritionBasis} / ${forDisplay(input.parent.basisAmount)}`,
            requirement: `${DERIVED_BASIS} / ${DERIVED_BASIS_AMOUNT}, which is the basis a component derivation produces`,
        });
    }

    for (const field of nutrientFields) {
        const stored = input.parent.nutrition[field];
        const recomputed = derived[field];
        if (nutrientsAgree(stored, recomputed)) {
            continue;
        }
        gaps.push({
            code: stored === null || recomputed === null ? 'component_nutrition_unknown' : 'parent_nutrition_disagrees',
            field: `catalog_foods.${field}`,
            observed: `stored ${forDisplay(stored)}, components derive ${forDisplay(recomputed)}`,
            requirement: 'the stored value to equal the recomputation from catalog_food_components',
        });
    }

    return { consistent: gaps.length === 0, gaps, derivedNutrition: derived, derivationCheck: null };
};

/** The component gap codes, sorted and de-duplicated. */
export const componentGapCodes = (assessment: ComponentDerivationAssessment): readonly ComponentGapCode[] =>
    Array.from(new Set(assessment.gaps.map((gap) => gap.code))).sort();

/** One sentence naming every component gap, in gap order. */
export const describeComponentGaps = (assessment: ComponentDerivationAssessment): string =>
    assessment.gaps
        .map((gap) => `${gap.field} ${gap.observed} (${gap.code}); required: ${gap.requirement}`)
        .join('; ');

/**
 * The sentence a validation record carries when the component floor held the
 * row, in the same voice as {@link evidenceFloorAssumption}.
 */
export const componentFloorAssumption = (assessment: ComponentDerivationAssessment): string =>
    `the stored nutrition does not agree with the food's own composition, so it is held rather than published: ${describeComponentGaps(
        assessment,
    )}. Re-derive the food from catalog_food_components, or correct the composition, before it can be published.`;
