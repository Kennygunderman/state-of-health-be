/**
 * The publication floors the catalog stages share.
 *
 * WHAT THIS FILE IS FOR. `scripts/lib/catalogEvidence.ts` is the one place the
 * import, validation, release and load stages read the same two rules from:
 * whether a row's identity evidence may be published on, and whether an
 * ingredient-derived row's stored nutrition still equals what its composition
 * derives to. Before it existed each stage answered the first question
 * differently — the import quarantined a retrieval with no observed HTTP
 * status while validation never read the evidence column at all and the
 * exporter and loader never looked inside the record they shipped — which is
 * how a checksummed release came to carry 11,046 published rows whose
 * mandatory status was null. These cases pin the rule itself, so a stage that
 * calls it cannot drift from the others.
 *
 * WHY IT NEEDS NO DATABASE (Rule backend-architecture §1.2/§11). Both
 * predicates are pure functions of the rows a caller is already holding: they
 * open no connection, read no environment variable and make no vendor call.
 * The stages' own behaviour — validation holding a row, the exporter refusing a
 * release, the loader refusing before it writes — is asserted against
 * PostgreSQL in `catalog-validate.test.ts`, `catalog-release.test.ts` and
 * `catalog-load.test.ts`; what belongs here is the decision those three share.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. The check vocabulary, the tiers, the
 * category bounds and the derivation arithmetic itself are
 * `src/services/__tests__/catalog.logic.test.ts`'s: this module supplies
 * `deriveComponentNutrition`'s inputs and compares its output with the parent
 * row, and the cases below assert exactly that seam rather than re-testing the
 * sum.
 */

import {
    COMPONENT_DERIVED_PROVENANCE,
    assessComponentDerivation,
    assessIdentityEvidence,
    assessSourceCacheBinding,
    cacheBindingGapCodes,
    cacheBindingRequired,
    componentDerivationComponentOf,
    componentFloorAssumption,
    componentGapCodes,
    describeCacheBindingGaps,
    describeComponentGaps,
    describeEvidenceGaps,
    evidenceFloorAssumption,
    evidenceGapCodes,
    identityEvidenceSourceCacheKey,
} from '../../../scripts/lib/catalogEvidence';
import type {
    ComponentDerivationComponent,
    ComponentDerivationParent,
    ComponentFoodFacts,
    SourceCacheRow,
} from '../../../scripts/lib/catalogEvidence';
// The two helpers the import stage takes its digests with, so these cases
// reproduce them rather than re-deriving a canonicalisation of their own.
import { canonicalJsonString, sha256Hex } from '../../../scripts/lib/catalogFoodFacts';
import type { CatalogNutrientValues } from '../../services/catalog.logic';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

/** A complete USDA retrieval record, as `catalog-import-usda.ts` writes one. */
const usdaEvidence = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    url: 'https://api.nal.usda.gov/fdc/v1/foods',
    method: 'POST',
    request_body: { fdcIds: [321358], format: 'full' },
    final_host: 'api.nal.usda.gov',
    http_status: 200,
    http_status_source: "this run's own POST /foods exchange",
    source_cache_key: 'POST /foods?#{"fdcIds":[321358],"format":"full"}',
    retrieval_source: 'import_run',
    body_sha256: DIGEST_A,
    record_sha256: DIGEST_B,
    matched_snippet: 'Garlic, raw',
    fetched_at: '2026-09-17T05:10:41.151Z',
    ...overrides,
});

/** A complete reference-page retrieval record, as `evidence.service.ts` returns one. */
const pageEvidence = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    url: 'https://fdc.nal.usda.gov/food-details/1234/nutrients',
    finalHost: 'fdc.nal.usda.gov',
    status: 200,
    bodySha256: DIGEST_A,
    matchedSnippet: 'black bean soup, prepared',
    fetchedAt: '2026-09-17T05:10:41.151Z',
    ...overrides,
});

describe('assessIdentityEvidence', () => {
    it('accepts a complete USDA retrieval record', () => {
        const assessment = assessIdentityEvidence([usdaEvidence()], { identitySource: 'usda' });

        expect(assessment.complete).toBe(true);
        expect(assessment.gaps).toEqual([]);
        expect(assessment.status).toBe(200);
        expect(assessment.finalHost).toBe('api.nal.usda.gov');
        expect(describeEvidenceGaps(assessment)).toBe('');
    });

    it('accepts a complete reference-page record for a generated food, which carries no cache key', () => {
        const assessment = assessIdentityEvidence([pageEvidence()], { identitySource: 'ai_generated' });

        expect(assessment.complete).toBe(true);
        expect(evidenceGapCodes(assessment)).toEqual([]);
        expect(assessment.status).toBe(200);
    });

    it('holds a record whose observed status is null — the release v1 defect', () => {
        const assessment = assessIdentityEvidence([usdaEvidence({ http_status: null })], {
            identitySource: 'usda',
        });

        expect(assessment.complete).toBe(false);
        expect(evidenceGapCodes(assessment)).toEqual(['retrieval_status_missing']);
        expect(assessment.status).toBeNull();
        // The sentence a held row records has to name the field and the repair,
        // because a curator reads it without the code.
        expect(evidenceFloorAssumption(assessment)).toContain('http_status');
        expect(evidenceFloorAssumption(assessment)).toContain('catalog:import');
    });

    it('holds a record with no status field at all', () => {
        const { http_status: _omitted, ...withoutStatus } = usdaEvidence();

        const assessment = assessIdentityEvidence([withoutStatus], { identitySource: 'usda' });

        expect(evidenceGapCodes(assessment)).toEqual(['retrieval_status_missing']);
        expect(assessment.gaps[0].observed).toBe('absent');
    });

    it.each([
        ['a redirect', 301],
        ['a client error', 404],
        ['a server error', 502],
        ['a status below the range', 199],
        ['a status above the range', 300],
    ])('holds %s: a failed exchange is not evidence of a food', (_label, status) => {
        const assessment = assessIdentityEvidence([usdaEvidence({ http_status: status })], {
            identitySource: 'usda',
        });

        expect(assessment.complete).toBe(false);
        expect(evidenceGapCodes(assessment)).toEqual(['retrieval_status_invalid']);
        expect(assessment.status).toBe(status);
    });

    it.each([
        ['a string', '200'],
        ['a float', 200.5],
        ['a boolean', true],
    ])('holds a status that is %s rather than an integer', (_label, status) => {
        const assessment = assessIdentityEvidence([usdaEvidence({ http_status: status })], {
            identitySource: 'usda',
        });

        expect(evidenceGapCodes(assessment)).toEqual(['retrieval_status_invalid']);
        expect(assessment.status).toBeNull();
    });

    it('refuses a record that states two different statuses under the two spellings', () => {
        const assessment = assessIdentityEvidence([usdaEvidence({ status: 404 })], { identitySource: 'usda' });

        expect(assessment.complete).toBe(false);
        expect(evidenceGapCodes(assessment)).toEqual(['evidence_malformed']);
        expect(assessment.gaps[0].field).toBe('http_status/status');
    });

    it('accepts one status written under both spellings with the same value', () => {
        const assessment = assessIdentityEvidence([usdaEvidence({ status: 200 })], { identitySource: 'usda' });

        expect(assessment.complete).toBe(true);
        expect(assessment.status).toBe(200);
    });

    it.each([
        ['url', 'url', 'retrieval_url_missing'],
        ['final host', 'final_host', 'retrieval_host_missing'],
        ['body digest', 'body_sha256', 'retrieval_body_digest_missing'],
        ['record digest', 'record_sha256', 'retrieval_record_digest_missing'],
        ['cache key', 'source_cache_key', 'retrieval_source_cache_key_missing'],
        ['matched snippet', 'matched_snippet', 'retrieval_snippet_missing'],
        ['retrieval time', 'fetched_at', 'retrieval_time_missing'],
    ])('holds a USDA record missing its %s', (_label, field, code) => {
        const record = usdaEvidence();
        delete record[field];

        const assessment = assessIdentityEvidence([record], { identitySource: 'usda' });

        expect(assessment.complete).toBe(false);
        expect(evidenceGapCodes(assessment)).toEqual([code]);
    });

    it.each([
        ['blank', '   '],
        ['empty', ''],
        ['not a string', 42],
    ])('holds a record whose snippet is %s', (_label, snippet) => {
        const assessment = assessIdentityEvidence([usdaEvidence({ matched_snippet: snippet })], {
            identitySource: 'usda',
        });

        expect(evidenceGapCodes(assessment)).toEqual(['retrieval_snippet_missing']);
    });

    it.each([
        ['upper case', 'A'.repeat(64)],
        ['too short', 'a'.repeat(63)],
        ['not hex', 'z'.repeat(64)],
    ])('holds a body digest that is %s', (_label, digest) => {
        const assessment = assessIdentityEvidence([usdaEvidence({ body_sha256: digest })], {
            identitySource: 'usda',
        });

        expect(evidenceGapCodes(assessment)).toEqual(['retrieval_body_digest_missing']);
    });

    it('does not require a cache key or a record digest of a generated food', () => {
        const assessment = assessIdentityEvidence([pageEvidence()], { identitySource: 'ai_generated' });

        expect(assessment.complete).toBe(true);
    });

    it.each([
        ['an empty array', []],
        ['null', null],
        ['undefined', undefined],
        ['an object', { url: 'https://example.gov' }],
        ['a string', 'https://example.gov'],
    ])('reports %s as absent evidence', (_label, value) => {
        const assessment = assessIdentityEvidence(value, { identitySource: 'usda' });

        expect(assessment.complete).toBe(false);
        expect(evidenceGapCodes(assessment)).toEqual(['evidence_absent']);
        expect(assessment.status).toBeNull();
        expect(assessment.finalHost).toBeNull();
    });

    it.each([
        ['null', null],
        ['a string', 'https://example.gov'],
        ['an array', []],
    ])('reports a first entry that is %s as malformed', (_label, entry) => {
        const assessment = assessIdentityEvidence([entry], { identitySource: 'usda' });

        expect(evidenceGapCodes(assessment)).toEqual(['evidence_malformed']);
        expect(assessment.gaps[0].field).toBe('identity_evidence[0]');
    });

    it('judges the first record and ignores a later one that would repair it', () => {
        const assessment = assessIdentityEvidence([usdaEvidence({ http_status: null }), usdaEvidence()], {
            identitySource: 'usda',
        });

        expect(assessment.complete).toBe(false);
        expect(evidenceGapCodes(assessment)).toEqual(['retrieval_status_missing']);
    });

    /**
     * PRESENT IS NOT THE SAME AS USABLE.
     *
     * `fetched_at` is mandatory so a stale retrieval is visible as one, which a
     * non-blank check alone does not deliver: `"soon"` and `"2026-13-01"`
     * satisfy it and say nothing about when the bytes were obtained. The shape
     * is pinned first and the value is then required to be a real calendar
     * instant, which is what rejects a day that does not exist.
     */
    it.each([
        ['prose', 'soon'],
        ['a bare year', '2026'],
        ['a date with no time', '2026-09-17'],
        ['a month that does not exist', '2026-13-01T00:00:00Z'],
        ['a day that does not exist', '2026-02-31T00:00:00Z'],
        ['a local time with no zone', '2026-09-17T05:10:41'],
    ])('holds a retrieval time that is %s', (_label, fetchedAt) => {
        const assessment = assessIdentityEvidence([usdaEvidence({ fetched_at: fetchedAt })], {
            identitySource: 'usda',
        });

        expect(assessment.complete).toBe(false);
        expect(evidenceGapCodes(assessment)).toEqual(['retrieval_time_invalid']);
        expect(assessment.gaps[0].field).toBe('identity_evidence[0].fetched_at');
        expect(assessment.gaps[0].requirement).toContain('ISO-8601 instant');
    });

    it.each([
        ['a UTC instant', '2026-09-17T05:10:41.151Z'],
        ['an instant with whole seconds', '2026-09-17T05:10:41Z'],
        ['an offset form', '2026-09-17T01:10:41.151-04:00'],
        ['a leap day that exists', '2028-02-29T00:00:00Z'],
    ])('accepts a retrieval time written as %s', (_label, fetchedAt) => {
        const assessment = assessIdentityEvidence([usdaEvidence({ fetched_at: fetchedAt })], {
            identitySource: 'usda',
        });

        expect(assessment.complete).toBe(true);
        expect(assessment.gaps).toEqual([]);
    });

    it('distinguishes an absent retrieval time from an unusable one', () => {
        // Two codes because the repairs differ: nobody recorded a time, versus
        // a time was recorded that cannot be read back.
        const { fetched_at: _omitted, ...withoutTime } = usdaEvidence();

        expect(evidenceGapCodes(assessIdentityEvidence([withoutTime], { identitySource: 'usda' }))).toEqual([
            'retrieval_time_missing',
        ]);
        expect(
            evidenceGapCodes(assessIdentityEvidence([usdaEvidence({ fetched_at: '   ' })], { identitySource: 'usda' })),
        ).toEqual(['retrieval_time_missing']);
    });

    it('applies the retrieval-time rule to the camelCase spelling a generated record uses', () => {
        const assessment = assessIdentityEvidence([pageEvidence({ fetchedAt: '2026' })], {
            identitySource: 'ai_generated',
        });

        expect(evidenceGapCodes(assessment)).toEqual(['retrieval_time_invalid']);
    });

    it('reports every gap of a record missing several fields, de-duplicated and sorted', () => {
        const assessment = assessIdentityEvidence(
            [{ url: 'https://api.nal.usda.gov/fdc/v1/foods', matched_snippet: 'Garlic, raw' }],
            { identitySource: 'usda' },
        );

        expect(evidenceGapCodes(assessment)).toEqual([
            'retrieval_body_digest_missing',
            'retrieval_host_missing',
            'retrieval_record_digest_missing',
            'retrieval_source_cache_key_missing',
            'retrieval_status_missing',
            'retrieval_time_missing',
        ]);
        expect(describeEvidenceGaps(assessment)).toContain('retrieval_status_missing');
    });
});

/**
 * The source cache a USDA record's digests are taken over.
 *
 * WHY THESE CASES MATTER SEPARATELY FROM THE FLOOR ABOVE. That predicate asks
 * whether a record STATES a cache key and two 64-hex digests; every case here
 * starts from a record that passes it completely. What is asked instead is
 * whether those fields stand for anything — and the failing forms are the ones
 * a release could carry while looking impeccable: a key nothing answers to, a
 * digest of a payload that has since changed, and one food's digest on another
 * food's evidence.
 *
 * The digests are built here the way `catalog-import-usda.ts` builds them — the
 * sha256 of the key-sorted JSON of the whole payload, and of this food's own
 * record inside it — through the very helpers that stage uses, because a test
 * that recomputed them with its own canonicalisation would prove only that two
 * pieces of this suite agree.
 */
describe('assessSourceCacheBinding', () => {
    const FDC_ID = 321358;
    const OTHER_FDC_ID = 323121;
    const CACHE_KEY = 'POST /foods?#{"fdcIds":[321358,323121],"format":"full"}';

    const record = (fdcId: number, description: string): Record<string, unknown> => ({
        fdcId,
        description,
        dataType: 'SR Legacy',
        foodNutrients: [{ nutrient: { number: '208' }, amount: 149 }],
    });

    const payload = (): Record<string, unknown>[] => [
        record(FDC_ID, 'Garlic, raw'),
        record(OTHER_FDC_ID, 'Onion, raw'),
    ];

    const bodyDigest = (value: unknown = payload()): string => sha256Hex(canonicalJsonString(value));

    const recordDigest = (fdcId: number = FDC_ID): string =>
        sha256Hex(canonicalJsonString(payload().find((entry) => entry.fdcId === fdcId)));

    const boundEvidence = (overrides: Record<string, unknown> = {}): Record<string, unknown>[] => [
        usdaEvidence({
            source_cache_key: CACHE_KEY,
            body_sha256: bodyDigest(),
            record_sha256: recordDigest(),
            ...overrides,
        }),
    ];

    const cacheRow = (overrides: Partial<SourceCacheRow> = {}): SourceCacheRow => ({
        cache_key: CACHE_KEY,
        payload: payload(),
        http_status: 200,
        ...overrides,
    });

    const assess = (
        identityEvidence: unknown,
        cacheRowValue: SourceCacheRow | null,
        usdaFdcId: number | null = FDC_ID,
    ): ReturnType<typeof assessSourceCacheBinding> =>
        assessSourceCacheBinding({ identityEvidence, usdaFdcId, cacheRow: cacheRowValue });

    it('resolves a record whose digests recompute from the cached payload', () => {
        const assessment = assess(boundEvidence(), cacheRow());

        expect(assessment.resolved).toBe(true);
        expect(assessment.gaps).toEqual([]);
        expect(assessment.cacheKey).toBe(CACHE_KEY);
        expect(describeCacheBindingGaps(assessment)).toBe('');
    });

    it('resolves the structurally identical record the floor above also accepts', () => {
        // The two predicates agree on this record, which is what makes the
        // cases below meaningful: each one is complete evidence by shape and
        // unresolvable in fact.
        const evidence = boundEvidence();

        expect(assessIdentityEvidence(evidence, { identitySource: 'usda' }).complete).toBe(true);
        expect(assess(evidence, cacheRow()).resolved).toBe(true);
    });

    it('refuses a cache key no usda_api_cache row answers to', () => {
        const assessment = assess(boundEvidence(), null);

        expect(assessment.resolved).toBe(false);
        expect(cacheBindingGapCodes(assessment)).toEqual(['cache_row_absent']);
        expect(assessment.gaps[0].observed).toBe(CACHE_KEY);
        expect(assessment.cacheKey).toBe(CACHE_KEY);
    });

    it('refuses a record that states no cache key at all', () => {
        const withoutKey = usdaEvidence({ body_sha256: bodyDigest(), record_sha256: recordDigest() });
        delete withoutKey.source_cache_key;

        const assessment = assess([withoutKey], cacheRow());

        expect(cacheBindingGapCodes(assessment)).toEqual(['cache_key_missing']);
        expect(assessment.cacheKey).toBeNull();
    });

    it.each([
        ['a different successful status', 201],
        ['a failure', 500],
    ])('refuses a cache row whose status is %s where the record states 200', (_label, httpStatus) => {
        const assessment = assess(boundEvidence(), cacheRow({ http_status: httpStatus }));

        expect(assessment.resolved).toBe(false);
        expect(cacheBindingGapCodes(assessment)).toEqual(['cache_status_disagrees']);
        expect(assessment.gaps[0].observed).toContain(`cache row ${httpStatus}`);
        expect(assessment.gaps[0].observed).toContain('evidence record 200');
    });

    it('refuses a cache row recorded before the status ledger existed', () => {
        // The v1 release's own defect seen from the other side: a null on the
        // cache row means nobody observed the exchange, so a record quoting 200
        // beside it is quoting a status that was never observed.
        const assessment = assess(boundEvidence(), cacheRow({ http_status: null }));

        expect(cacheBindingGapCodes(assessment)).toEqual(['cache_status_missing']);
    });

    it('refuses a body digest that is not the digest of the cached payload', () => {
        const assessment = assess(boundEvidence({ body_sha256: 'c'.repeat(64) }), cacheRow());

        expect(assessment.resolved).toBe(false);
        expect(cacheBindingGapCodes(assessment)).toEqual(['cache_body_digest_disagrees']);
        expect(assessment.gaps[0].observed).toContain(bodyDigest());
    });

    it('refuses a body digest taken over a payload that has since changed', () => {
        // Same record, same key; one nutrient value moved in the stored
        // response. The digest exists precisely to make that visible.
        const moved = payload();
        moved[0] = { ...moved[0], description: 'Garlic, raw, trimmed' };

        const assessment = assess(boundEvidence(), cacheRow({ payload: moved }));

        // Both digests move, and both are reported: the payload behind the
        // record changed AND the record itself did, which is two facts an
        // operator needs rather than one.
        expect(cacheBindingGapCodes(assessment)).toEqual([
            'cache_body_digest_disagrees',
            'cache_record_digest_disagrees',
        ]);
    });

    it("refuses a record digest that is not this food's own", () => {
        const assessment = assess(boundEvidence({ record_sha256: 'd'.repeat(64) }), cacheRow());

        expect(cacheBindingGapCodes(assessment)).toEqual(['cache_record_digest_disagrees']);
        expect(assessment.gaps[0].observed).toContain(`fdcId ${FDC_ID}`);
    });

    it("refuses a record digest that is valid but belongs to a different food's record", () => {
        // THE CASE A SHAPE CHECK CANNOT SEE. The digest is real, it is the
        // digest of a record in this very payload, and it is not this food's —
        // so it evidences the batch rather than the row citing it, which is the
        // whole reason `record_sha256` exists beside `body_sha256`.
        const assessment = assess(boundEvidence({ record_sha256: recordDigest(OTHER_FDC_ID) }), cacheRow());

        expect(assessment.resolved).toBe(false);
        expect(cacheBindingGapCodes(assessment)).toEqual(['cache_record_digest_disagrees']);
        expect(assessment.gaps[0].observed).toContain(recordDigest(OTHER_FDC_ID));
        expect(assessment.gaps[0].requirement).toContain("another food's record does not evidence this one");
    });

    it('refuses a payload that carries no record for this food', () => {
        const assessment = assess(
            boundEvidence({ body_sha256: bodyDigest([record(OTHER_FDC_ID, 'Onion, raw')]) }),
            cacheRow({ payload: [record(OTHER_FDC_ID, 'Onion, raw')] }),
        );

        expect(cacheBindingGapCodes(assessment)).toEqual(['cache_record_absent']);
        expect(assessment.gaps[0].observed).toContain(`no record for fdcId ${FDC_ID}`);
    });

    it('refuses a row whose FDC id the catalog does not hold', () => {
        // Without the id nothing can say which of the payload's records is this
        // food's, so the binding is unresolvable rather than satisfied.
        const assessment = assess(boundEvidence(), cacheRow(), null);

        expect(cacheBindingGapCodes(assessment)).toEqual(['cache_subject_missing']);
    });

    it('refuses a cached payload that is not a list of records', () => {
        const objectPayload = { foods: payload() };

        const assessment = assess(
            boundEvidence({ body_sha256: bodyDigest(objectPayload) }),
            cacheRow({ payload: objectPayload }),
        );

        expect(cacheBindingGapCodes(assessment)).toEqual(['cache_payload_not_records']);
    });

    it('matches the record whose stringified fdcId the vendor sent, as the import does', () => {
        // `usda.service.ts` replaces `fdcId` with its canonical number before
        // the record is ever digested, so a dataset that stringifies the id
        // still produces the digest the import wrote. Reproducing that
        // normalisation is what makes this check usable on real payloads.
        const stringified = [{ ...record(FDC_ID, 'Garlic, raw'), fdcId: String(FDC_ID) }];
        const assessment = assess(
            boundEvidence({
                body_sha256: bodyDigest(stringified),
                record_sha256: sha256Hex(canonicalJsonString({ ...stringified[0], fdcId: FDC_ID })),
            }),
            cacheRow({ payload: stringified }),
        );

        expect(assessment.resolved).toBe(true);
    });

    it('reads the cache key a caller looks the row up by', () => {
        expect(identityEvidenceSourceCacheKey(boundEvidence())).toBe(CACHE_KEY);
        expect(identityEvidenceSourceCacheKey([pageEvidence()])).toBeNull();
        expect(identityEvidenceSourceCacheKey([])).toBeNull();
        expect(identityEvidenceSourceCacheKey(null)).toBeNull();
    });

    it('asks a cache binding of a USDA row and of nothing else', () => {
        // The same predicate both stages count their rows with: a generated
        // row's evidence is a fetched page nothing cached here, so there is no
        // row to look up and none is required.
        expect(cacheBindingRequired('usda')).toBe(true);
        expect(cacheBindingRequired('ai_generated')).toBe(false);
        expect(cacheBindingRequired('')).toBe(false);
    });
});

const nutrition = (values: Partial<CatalogNutrientValues>): CatalogNutrientValues => ({
    calories: null,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    fiber_g: null,
    ...values,
});

const component = (
    overrides: Partial<ComponentDerivationComponent> = {},
): ComponentDerivationComponent => ({
    componentKey: 'usda:1',
    quantityGrams: 100,
    yieldFactor: 1,
    pinnedNutritionVersion: 1,
    currentNutritionVersion: 1,
    sortOrder: 0,
    nutrition: nutrition({ calories: 100, protein_g: 10, carbs_g: 20, fat_g: 1, fiber_g: 2 }),
    ...overrides,
});

const parent = (values: Partial<ComponentDerivationParent> = {}): ComponentDerivationParent => ({
    sourceKey: 'ai:prepared_meal:black bean soup:prepared',
    nutritionBasis: 'per_100g',
    basisAmount: 100,
    // The provenance a composition derives to. It is the DEFAULT here rather
    // than a per-case value because the ordinary parent agrees with its own
    // composition; the cases that vary it are the contradiction cases below.
    nutritionProvenance: COMPONENT_DERIVED_PROVENANCE,
    nutrition: nutrition({ calories: 100, protein_g: 10, carbs_g: 20, fat_g: 1, fiber_g: 2 }),
    ...values,
});

describe('assessComponentDerivation', () => {
    it('accepts a parent whose stored nutrition equals the recomputation', () => {
        const assessment = assessComponentDerivation({ parent: parent(), components: [component()] });

        expect(assessment.consistent).toBe(true);
        expect(assessment.gaps).toEqual([]);
        expect(assessment.derivedNutrition).toEqual(
            nutrition({ calories: 100, protein_g: 10, carbs_g: 20, fat_g: 1, fiber_g: 2 }),
        );
        expect(describeComponentGaps(assessment)).toBe('');
    });

    it('accepts agreement within floating-point tolerance rather than exact equality', () => {
        const assessment = assessComponentDerivation({
            parent: parent({ nutrition: nutrition({ calories: 100.0000000001, protein_g: 10, carbs_g: 20, fat_g: 1, fiber_g: 2 }) }),
            components: [component()],
        });

        expect(assessment.consistent).toBe(true);
    });

    it('applies the yield factor: half the water lost doubles the energy density', () => {
        const assessment = assessComponentDerivation({
            parent: parent({ nutrition: nutrition({ calories: 200, protein_g: 20, carbs_g: 40, fat_g: 2, fiber_g: 4 }) }),
            components: [component({ yieldFactor: 0.5 })],
        });

        expect(assessment.consistent).toBe(true);
        expect(assessment.derivedNutrition?.calories).toBeCloseTo(200, 9);
    });

    it('holds a parent whose stored calories drifted from its composition', () => {
        const assessment = assessComponentDerivation({
            parent: parent({ nutrition: nutrition({ calories: 250, protein_g: 10, carbs_g: 20, fat_g: 1, fiber_g: 2 }) }),
            components: [component()],
        });

        expect(assessment.consistent).toBe(false);
        expect(componentGapCodes(assessment)).toEqual(['parent_nutrition_disagrees']);
        expect(assessment.gaps[0].field).toBe('catalog_foods.calories');
        expect(assessment.gaps[0].observed).toContain('stored 250');
        expect(componentFloorAssumption(assessment)).toContain('catalog_food_components');
    });

    it('holds a parent that states a nutrient its composition leaves unknown', () => {
        const assessment = assessComponentDerivation({
            parent: parent(),
            components: [component({ nutrition: nutrition({ calories: 100, protein_g: 10, carbs_g: 20, fat_g: 1 }) })],
        });

        expect(componentGapCodes(assessment)).toEqual(['component_nutrition_unknown']);
        expect(assessment.gaps[0].field).toBe('catalog_foods.fiber_g');
    });

    it('holds a parent whose component pin is behind the component food', () => {
        const assessment = assessComponentDerivation({
            parent: parent(),
            components: [component({ pinnedNutritionVersion: 1, currentNutritionVersion: 2 })],
        });

        expect(assessment.consistent).toBe(false);
        expect(componentGapCodes(assessment)).toEqual(['component_version_stale']);
        expect(assessment.gaps[0].observed).toBe('pinned 1, component now at 2');
    });

    it('names every stale component, not just the first', () => {
        const assessment = assessComponentDerivation({
            parent: parent({ nutrition: nutrition({ calories: 100, protein_g: 10, carbs_g: 20, fat_g: 1, fiber_g: 2 }) }),
            components: [
                component({ componentKey: 'usda:1', quantityGrams: 50, pinnedNutritionVersion: 1, currentNutritionVersion: 3 }),
                component({ componentKey: 'usda:2', quantityGrams: 50, sortOrder: 1, pinnedNutritionVersion: 2, currentNutritionVersion: 4 }),
            ],
        });

        const stale = assessment.gaps.filter((gap) => gap.code === 'component_version_stale');
        expect(stale).toHaveLength(2);
        expect(stale.map((gap) => gap.field)).toEqual([
            'catalog_food_components.component_nutrition_version (usda:1)',
            'catalog_food_components.component_nutrition_version (usda:2)',
        ]);
    });

    it('holds a parent whose basis is not the one a derivation produces', () => {
        const assessment = assessComponentDerivation({
            parent: parent({ nutritionBasis: 'per_serving', basisAmount: 1 }),
            components: [component()],
        });

        expect(componentGapCodes(assessment)).toEqual(['parent_basis_disagrees']);
        expect(assessment.gaps[0].observed).toBe('per_serving / 1');
    });

    it('reports an ingredient-derived food with no composition at all', () => {
        // The parent CLAIMS `ingredient_derived` (the default above) and there
        // is nothing in the table its numbers could have been derived from, so
        // the claim itself is what makes the absence a gap — a row that claims
        // no derivation and carries no components is not assessed at all, which
        // is the callers' decision and is pinned in their own suites.
        const assessment = assessComponentDerivation({
            parent: parent({ nutritionProvenance: COMPONENT_DERIVED_PROVENANCE }),
            components: [],
        });

        expect(assessment.consistent).toBe(false);
        expect(componentGapCodes(assessment)).toEqual(['components_absent']);
        expect(assessment.derivedNutrition).toBeNull();
        expect(assessment.derivationCheck).toBeNull();
        expect(componentFloorAssumption(assessment)).toContain('at least one component row');
    });

    /**
     * THE PROVENANCE A COMPOSITION-BEARING ROW CLAIMS IS CHECKED, NOT TRUSTED.
     *
     * `deriveComponentNutrition` calls everything it derives
     * `ingredient_derived`, so a row carrying component lines while claiming
     * another provenance states two incompatible things about where its numbers
     * came from. The cases below are why the assessment is applied from what
     * the row CARRIES rather than from what it claims: keyed off the claim, a
     * parent with wrong scalars could be excused by relabelling it
     * `source_backed`, which is exactly the bypass both stages shipped.
     */
    it.each([['source_backed'], ['ai_estimated'], ['']])(
        'reports a component-bearing parent that claims %s',
        (provenance) => {
            const assessment = assessComponentDerivation({
                parent: parent({ nutritionProvenance: provenance }),
                components: [component()],
            });

            expect(assessment.consistent).toBe(false);
            expect(componentGapCodes(assessment)).toEqual(['parent_provenance_disagrees']);
            expect(assessment.gaps[0].field).toBe('catalog_foods.nutrition_provenance');
            expect(assessment.gaps[0].observed).toContain('on a food carrying 1 component row(s)');
            expect(assessment.gaps[0].requirement).toContain(COMPONENT_DERIVED_PROVENANCE);
        },
    );

    it('reports the contradiction AND the arithmetic when a relabelled parent also has wrong scalars', () => {
        // THE LOAD-BEARING CASE. The derivation still runs underneath the
        // provenance gap, so one refusal names both facts: the row is not what
        // it says it is, and its numbers are not what its ingredients produce.
        // A predicate that returned early on the contradiction would hide the
        // second half and leave the repair half-described.
        const assessment = assessComponentDerivation({
            parent: parent({
                nutritionProvenance: 'source_backed',
                nutrition: nutrition({ calories: 219, protein_g: 10, carbs_g: 20, fat_g: 1, fiber_g: 2 }),
            }),
            components: [component()],
        });

        expect(assessment.consistent).toBe(false);
        expect(componentGapCodes(assessment)).toEqual(['parent_nutrition_disagrees', 'parent_provenance_disagrees']);
        expect(assessment.derivedNutrition?.calories).toBe(100);
        const described = describeComponentGaps(assessment);
        expect(described).toContain('catalog_foods.nutrition_provenance');
        expect(described).toContain('stored 219, components derive 100');
    });

    it('reports staleness and the contradiction together, each once', () => {
        const assessment = assessComponentDerivation({
            parent: parent({ nutritionProvenance: 'source_backed' }),
            components: [component({ pinnedNutritionVersion: 1, currentNutritionVersion: 4 })],
        });

        expect(componentGapCodes(assessment)).toEqual(['component_version_stale', 'parent_provenance_disagrees']);
        // The contradiction is reported before the per-component facts, so the
        // sentence a curator reads opens with what the row is claiming.
        expect(assessment.gaps[0].code).toBe('parent_provenance_disagrees');
    });

    it('carries the derivation refusal through when the composition itself is unusable', () => {
        const assessment = assessComponentDerivation({
            parent: parent(),
            components: [component({ quantityGrams: 0 })],
        });

        expect(assessment.consistent).toBe(false);
        expect(componentGapCodes(assessment)).toEqual(['derivation_failed']);
        expect(assessment.derivationCheck?.name).toBe('invalid_component_quantity');
        expect(assessment.derivedNutrition).toBeNull();
    });

    it('reports staleness and disagreement together when a refresh moved the values', () => {
        const assessment = assessComponentDerivation({
            parent: parent({ nutrition: nutrition({ calories: 90, protein_g: 10, carbs_g: 20, fat_g: 1, fiber_g: 2 }) }),
            components: [component({ pinnedNutritionVersion: 1, currentNutritionVersion: 2 })],
        });

        expect(componentGapCodes(assessment)).toEqual(['component_version_stale', 'parent_nutrition_disagrees']);
    });
});

/**
 * The input builder both stages share.
 *
 * WHAT THESE CASES ARE ABOUT. `assessComponentDerivation` sums PER-100 G
 * values, while `catalog_foods` and `foods.jsonl` state a food's nutrition on
 * whatever basis its source used — and the coverage plan publishes two of them
 * (`per_100g` and `per_100ml`). So the conversion between the two is a real
 * step with a real failure mode, and it is decided HERE rather than in the
 * validator and the loader separately. The conversion itself belongs to
 * `catalog.logic.ts::normalizeToPer100g` and is tested there; what these cases
 * pin is the translation of its two outcomes, because the failing one is the
 * dangerous side: a component whose per-100 g nutrition nobody can compute must
 * arrive UNKNOWN, never as the stored scalars passed through on a basis they
 * were not stated on.
 */
describe('componentDerivationComponentOf', () => {
    const facts = (overrides: Partial<ComponentFoodFacts> = {}): ComponentFoodFacts => ({
        nutrition_version: 3,
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        calories: 59,
        protein_g: 10.19,
        carbs_g: 3.6,
        fat_g: 0.39,
        fiber_g: 0,
        density_g_per_ml: null,
        ...overrides,
    });

    const componentOf = (overrides: Partial<ComponentFoodFacts> = {}): ComponentDerivationComponent =>
        componentDerivationComponentOf({
            componentKey: 'usda:9200115',
            quantityGrams: 150,
            yieldFactor: 0.9,
            pinnedNutritionVersion: 1,
            sortOrder: 2,
            componentFood: facts(overrides),
        });

    it('passes a per-100 g record through unchanged and carries the current version', () => {
        // The factor is exactly 100/100, so the doubles the pipeline wrote are
        // the doubles the parent's scalars are compared against and the 1e-6
        // tolerance is never spent on this conversion.
        const mapped = componentOf();

        expect(mapped.nutrition).toEqual({
            calories: 59,
            protein_g: 10.19,
            carbs_g: 3.6,
            fat_g: 0.39,
            fiber_g: 0,
        });
        // The pin and the current counter are DIFFERENT facts and both survive:
        // the pin is what the parent's totals were taken from, the current one
        // is what the component says now, and comparing them is the only way a
        // stale derivation is visible.
        expect(mapped.pinnedNutritionVersion).toBe(1);
        expect(mapped.currentNutritionVersion).toBe(3);
        expect(mapped.componentKey).toBe('usda:9200115');
        expect(mapped.quantityGrams).toBe(150);
        expect(mapped.yieldFactor).toBe(0.9);
        expect(mapped.sortOrder).toBe(2);
    });

    it('converts a per-100 ml record through its own stored density', () => {
        // 100 ml at 1.03 g/ml weighs 103 g, so the stated values describe 103 g
        // of food and the per-100 g figures are 100/103 of them. Treating
        // millilitres as grams would overstate every nutrient by 3 %.
        const mapped = componentOf({ nutrition_basis: 'per_100ml', density_g_per_ml: 1.03 });

        expect(mapped.nutrition.calories).toBeCloseTo((59 * 100) / 103, 12);
        expect(mapped.nutrition.protein_g).toBeCloseTo((10.19 * 100) / 103, 12);
        expect(mapped.nutrition.fiber_g).toBe(0);
    });

    it('reports the nutrition unknown when a volume basis has no density to convert it', () => {
        // The one case that must not pass the scalars through: nothing here can
        // say what 59 kcal per 100 ml is per 100 g, so the derivation is told it
        // does not know rather than told a number.
        const mapped = componentOf({ nutrition_basis: 'per_100ml', density_g_per_ml: null });

        expect(mapped.nutrition).toEqual({
            calories: null,
            protein_g: null,
            carbs_g: null,
            fat_g: null,
            fiber_g: null,
        });
        expect(mapped.currentNutritionVersion).toBe(3);
    });

    it('reports the nutrition unknown for a per-serving record, whose gram weight is not on this row', () => {
        const mapped = componentOf({ nutrition_basis: 'per_serving', basis_amount: 1 });

        expect(mapped.nutrition.calories).toBeNull();
    });

    it('reports the nutrition unknown for a basis outside the three declared values, without throwing', () => {
        // The no-throw property, from the one direction that could break it:
        // `normalizeToPer100g` raises `CatalogIdentityError` on a fourth basis,
        // so the value is screened before the call and a caller judging one row
        // of eleven thousand never has to catch.
        const mapped = componentOf({ nutrition_basis: 'per_pound' });

        expect(mapped.nutrition.calories).toBeNull();
        expect(mapped.nutrition.fat_g).toBeNull();
    });

    it('reports the nutrition unknown for a basis amount the conversion cannot use', () => {
        const mapped = componentOf({ basis_amount: 0 });

        expect(mapped.nutrition.calories).toBeNull();
    });

    it('keeps an unknown nutrient unknown rather than converting it to zero', () => {
        const mapped = componentOf({ fiber_g: null });

        expect(mapped.nutrition.fiber_g).toBeNull();
        expect(mapped.nutrition.calories).toBe(59);
    });

    it('feeds the predicate, so a per-100 ml component still agrees with a correctly derived parent', () => {
        // The seam end to end: the parent's stored scalars were computed from
        // the component's per-100 g equivalent, and the two agree only because
        // the density conversion happened. Asserted through
        // `assessComponentDerivation` because that is how both stages use it.
        const mapped = componentDerivationComponentOf({
            componentKey: 'usda:9200114',
            quantityGrams: 100,
            yieldFactor: 1,
            pinnedNutritionVersion: 1,
            sortOrder: 0,
            componentFood: facts({
                nutrition_version: 1,
                nutrition_basis: 'per_100ml',
                density_g_per_ml: 1.03,
                calories: 22,
                protein_g: 0.35,
                carbs_g: 6.9,
                fat_g: 0.24,
                fiber_g: 0.3,
            }),
        });

        const assessment = assessComponentDerivation({
            parent: parent({ nutrition: mapped.nutrition }),
            components: [mapped],
        });

        expect(assessment.consistent).toBe(true);
        expect(assessment.gaps).toEqual([]);
    });
});
