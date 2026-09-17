/**
 * The evidence stage's judgements: `scripts/catalog-report.ts`, plus the
 * duplicate-identity accounting `scripts/catalog-validate.ts` publishes.
 *
 * WHAT THIS SUITE SETTLES. Three claims in the committed evidence artefacts
 * were asserted rather than measured, and each is now computed by a pure
 * function this suite pins:
 *
 *   * WHAT WAS WITHHELD AND WHY — `buildWithheldIdentityAudit` and
 *     `perCategoryByStatus`: per-status totals, a per-category breakdown in
 *     which a zero is visibly measured, the identity lists with their failing
 *     checks, and the cap accounting that stops a truncated list from reading
 *     as a complete one.
 *   * WHETHER EVERY ITEM ACCOUNTS FOR EVERY CHECK —
 *     `notApplicableChecksForItem` and `publishedItemFacts`: for each
 *     vocabulary name an item does not record, either a reason derived from
 *     THAT ITEM's measured facts, or an unexplained gap. The boundary cases are
 *     the point: an item that DOES meet a check's precondition and still lacks
 *     the check must come back unexplained, because that is the honest answer
 *     and the one the old `everyItemCarriesEveryCheck: true` hid.
 *   * THAT A REGENERATED REPORT CANNOT CARRY A CONTRADICTED CLAIM —
 *     `pruneSupersededKeys`: the named keys go, and every other key —
 *     especially another stage's counters — survives untouched.
 *
 * Plus the per-category coverage verdict (`buildCoverageRows`,
 * `buildRequirementBlock`), which must state `unmet` per category and never
 * smooth a deficit against a surplus, and
 * `buildDuplicateIdentityAccounting`, which must keep lost IDENTITIES, alias
 * ROWS and validation RECORDS apart and classify the residue rather than
 * subtract it.
 *
 * WHY IT IS DATABASE-FREE. Everything asserted here is a pure function taking
 * its measurement as an argument (Rule backend-architecture §7, §11): the
 * scan, the file writes and the reconciliation are the stage's I/O and are
 * exercised by running the real producer against a database, which is not
 * something a unit test may do. Nothing is mocked, because there is nothing to
 * mock — the inputs are plain data.
 *
 * WHY THE `catalog-validate` HELPER IS PINNED HERE. `buildDuplicateIdentityAccounting`
 * belongs to the validate stage but is evidence-shaping code, and
 * `src/__tests__/scripts/catalog-validate.test.ts` is owned by a different
 * work unit at this checkpoint. Its import is the same relative import
 * `catalog-import.test.ts` already uses for that module.
 *
 * Jest's `roots` is `<rootDir>/src` (jest.config.ts), so a test under
 * `scripts/` would never be collected; the relative imports into `scripts/` are
 * the consequence of that, not a choice.
 */
import {
    CATALOG_CHECK_NAMES,
    CATALOG_QUARANTINE_CHECK_NAMES,
    CATALOG_REJECT_CHECK_NAMES,
    CATALOG_REVIEW_CHECK_NAMES,
    computeCoverageShortfall,
    dedupeIdentity,
} from '../../services/catalog.logic';
import type { CatalogIdentityCandidate, CatalogValidationPolicy } from '../../services/catalog.logic';
import {
    buildCoverageRows,
    buildRequirementBlock,
    buildWithheldIdentityAudit,
    generatedContentPresence,
    notApplicableChecksForItem,
    perCategoryByStatus,
    pruneSupersededKeys,
    publishedItemFacts,
    supersededKeyPaths,
    toItemRecord,
    toQuarantinedIdentity,
} from '../../../scripts/catalog-report';
import type {
    CatalogMeasurement,
    CategoryMeasurement,
    PublishedItemFacts,
    ReportFoodRow,
    ValidationRecordRow,
    WithheldIdentity,
} from '../../../scripts/catalog-report';
import {
    buildDuplicateIdentityAccounting,
    partitionAliasMerges,
    recordedChecks,
    validationRecordPatch,
} from '../../../scripts/catalog-validate';
import type { AliasMergePartition } from '../../../scripts/catalog-validate';
import type { CatalogValidationVerdict } from '../../../src/services/catalog.logic';
import type { CatalogValidationCheck } from '../../../src/types/catalog';
import type { CoveragePlan } from '../../../scripts/lib/manifest';

/* ---------------------------------------------------------------------------
 * Fixtures. Every field is stated so a test reads as the row it describes, and
 * so a new measurement field is a compile error here rather than an
 * `undefined` reaching an assertion.
 * ------------------------------------------------------------------------- */

const emptyCategory = (overrides: Partial<CategoryMeasurement> = {}): CategoryMeasurement => ({
    byPublicationStatus: {},
    publishedFoodStates: {},
    publishedReviewFailuresByCheck: {},
    publishedItemsWithRejectFailure: 0,
    publishedItemsWithQuarantineFailure: 0,
    publishedItemsWithReviewFailure: 0,
    quarantinedByCheck: {},
    ...overrides,
});

const measurement = (overrides: Partial<CatalogMeasurement> = {}): CatalogMeasurement => ({
    rowsScanned: 0,
    byPublicationStatus: {},
    categories: {},
    publishedByCategory: {},
    publishedByIdentitySource: {},
    publishedByIdentityStatus: {},
    publishedByNutritionProvenance: {},
    publishedByNutritionMethod: {},
    publishedByNutritionBasis: {},
    publishedByUsdaDataType: {},
    publishedByOutcome: {},
    publishedByFoodState: {},
    publishedChecks: {},
    publishedCheckEntries: 0,
    publishedItemsWithNoFailingCheck: 0,
    publishedItemsWithBothReviewFlags: 0,
    unrecognisedCheckNames: {},
    publishedRecordedChecksPerItem: {},
    publishedNotApplicableByName: {},
    publishedNotApplicableByReasonCode: {},
    publishedItemsWithCompleteVocabulary: 0,
    publishedItemsWithUnexplainedGap: 0,
    publishedUnexplainedByName: {},
    publishedUnexplainedExamples: [],
    publishedUnexplainedExamplesOmitted: 0,
    quarantinedByCheck: {},
    quarantinedByCategory: {},
    rejectedByCheck: {},
    candidateByCheck: {},
    quarantinedIdentities: [],
    withheldIdentities: [],
    withheldIdentitiesOmitted: {},
    withheldByIdentitySourceAndStatus: {},
    publishedWithoutValidationRecord: [],
    publishedAliasRecords: 0,
    publishedEvidenceRecords: 0,
    publishedEvidenceRecordsPerItem: {},
    publishedItemsWithoutEvidence: 0,
    publishedItemsWithAdvisoryReview: 0,
    publishedIdentityCollisions: [],
    recordFieldMismatchCount: 0,
    recordFieldMismatches: [],
    rowsWithValidationRecord: 0,
    ...overrides,
});

/**
 * A withheld identity as the measurement emits one.
 *
 * `failingCheckEvidence` is DERIVED from `failingChecks` unless a test states it
 * explicitly, because that is the invariant the audit asserts: the evidence
 * states exactly the names the identity lists. A fixture that let the two drift
 * would make every test of that invariant pass for the wrong reason.
 */
const withheld = (overrides: Partial<WithheldIdentity> = {}): WithheldIdentity => {
    // Sorted, as the measurement sorts both lists before it emits an identity.
    const failingChecks = [...(overrides.failingChecks ?? ['missing_core_nutrient'])].sort();
    return {
        sourceKey: 'usda:1',
        category: 'produce_vegetable',
        foodState: 'raw',
        displayName: 'Broccoli, raw',
        identitySource: 'usda',
        outcome: 'quarantined',
        publicationStatus: 'quarantined',
        ...overrides,
        failingChecks,
        // Stated evidence wins, so a test can deliberately construct a
        // disagreement; otherwise it is derived from the names above.
        failingCheckEvidence:
            overrides.failingCheckEvidence ??
            failingChecks.map((name) => ({
                name,
                tier: 'quarantine',
                pass: false as const,
                observed: `observed value for ${name}`,
                bound: `bound for ${name}`,
            })),
    };
};

/**
 * The names every published item in the release records.
 *
 * `default_portion_count` is recorded by `presenceChecks`; `invalid_basis_amount`
 * and `non_finite_computed_value` are the two the normalisation evaluates on
 * every candidate and which `catalog-validate.ts::recordedChecks` writes down as
 * passes — see the CHECKS A SUCCESSFUL NORMALISATION EXECUTED block there.
 *
 * `unknown_tag_code` and `inconsistent_tag_set` are here for the same reason and
 * not because a USDA food is special: `catalog-validate.ts::candidateFromRow`
 * hands the checks BOTH tag lists off the stored row — its `selection` names
 * `allergen_tags` and `diet_tags`, and both columns are NOT NULL with a `[]`
 * default — so the stage that judges a row for publication always supplies the
 * inputs both checks need, and every record it writes carries both. That is what
 * makes them ruleless in `CHECK_APPLICABILITY_RULES`: no fact about a PUBLISHED
 * item can make either inapplicable to it.
 */
const RECORDED_IN_V1: readonly string[] = [
    'allergens_unknown',
    'default_portion_count',
    'duplicate_identity',
    'energy_macro_mismatch',
    'inconsistent_tag_set',
    'invalid_basis_amount',
    'kcal_ceiling',
    'macro_mass_ceiling',
    'missing_core_nutrient',
    'missing_gram_weight',
    'non_finite_computed_value',
    'nutrient_negative',
    'nutrient_not_finite',
    'out_of_category_range',
    'unknown_category',
    'unknown_tag_code',
    'unsourced',
    'unsupported_portion',
];

/**
 * The same item as a record written BEFORE the two tag checks existed carries
 * it — which is what the committed release artefact holds, and the case below
 * pins what the report says about one.
 */
const RECORDED_BEFORE_THE_TAG_CHECKS: readonly string[] = RECORDED_IN_V1.filter(
    (name) => name !== 'unknown_tag_code' && name !== 'inconsistent_tag_set',
);

/** A published USDA food exactly as release v1 stores one. */
const v1Facts = (overrides: Partial<PublishedItemFacts> = {}): PublishedItemFacts => ({
    sourceKey: 'usda:169967',
    category: 'produce_vegetable',
    foodState: 'raw',
    identitySource: 'usda',
    nutritionProvenance: 'source_backed',
    nutritionBasis: 'per_100g',
    basisAmount: 100,
    componentRows: 0,
    portionUnits: 3,
    portionUnitsStatingNutrients: 0,
    recordedCheckNames: RECORDED_IN_V1,
    ...overrides,
});

const nameOf = (entries: readonly { readonly name: string }[]): string[] => entries.map((entry) => entry.name).sort();

const reasonCodeFor = (
    entries: readonly { readonly name: string; readonly reasonCode: string }[],
    name: string,
): string | undefined => entries.find((entry) => entry.name === name)?.reasonCode;

const reasonFor = (
    entries: readonly { readonly name: string; readonly reason: string }[],
    name: string,
): string => entries.find((entry) => entry.name === name)?.reason ?? '';

/* ---------------------------------------------------------------------------
 * The check vocabulary itself — the denominator every completeness claim is
 * measured against.
 * ------------------------------------------------------------------------- */

describe('the check vocabulary', () => {
    it('holds 23 names across the three tiers', () => {
        const names = new Set([
            ...CATALOG_REJECT_CHECK_NAMES,
            ...CATALOG_QUARANTINE_CHECK_NAMES,
            ...CATALOG_REVIEW_CHECK_NAMES,
        ]);

        expect(names.size).toBe(23);
        expect(Object.values(CATALOG_CHECK_NAMES).length).toBe(23);
    });
});

/* ---------------------------------------------------------------------------
 * Per-item check completeness.
 * ------------------------------------------------------------------------- */

describe('notApplicableChecksForItem', () => {
    describe('a published USDA food as the release stores it', () => {
        it('explains the five absent names from the item\u2019s own facts', () => {
            const result = notApplicableChecksForItem(v1Facts());

            expect(nameOf(result.notApplicable)).toEqual([
                'brand_pattern_name',
                'empty_component_set',
                'invalid_component_quantity',
                'missing_density',
                'portion_conversion_drift',
            ]);
        });

        it('covers the whole vocabulary with nothing unexplained', () => {
            const result = notApplicableChecksForItem(v1Facts());

            expect(result.unexplained).toEqual([]);
            expect(result.complete).toBe(true);
            expect(result.recorded.length + result.notApplicable.length).toBe(23);
        });

        // THE MISCLASSIFICATION THIS REPLACES. `normalizeToPer100g` evaluates
        // both of these on every candidate it converts and records nothing on
        // success, so an earlier version of the applicability map filed them as
        // `applicable: false` on all 11,046 published items \u2014 an assertion
        // that two checks could not apply to rows they had in fact run and
        // passed on. They now reach the record as passes
        // (catalog-validate.ts::recordedChecks), and a record LACKING them is an
        // unexplained gap rather than an explained absence.
        it('never explains away invalid_basis_amount or non_finite_computed_value', () => {
            const withoutThem = RECORDED_IN_V1.filter(
                (name) => name !== 'invalid_basis_amount' && name !== 'non_finite_computed_value',
            );
            const result = notApplicableChecksForItem(v1Facts({ recordedCheckNames: withoutThem }));

            expect(nameOf(result.notApplicable)).not.toContain('invalid_basis_amount');
            expect(nameOf(result.notApplicable)).not.toContain('non_finite_computed_value');
            expect(result.unexplained).toEqual(['invalid_basis_amount', 'non_finite_computed_value']);
            expect(result.complete).toBe(false);
        });

        // THE SAME DISTINCTION, for the two tag checks. The stage that judges a
        // row for publication reads `allergen_tags` and `diet_tags` off the row
        // and hands both to the checks, so a published item's record carries
        // both — `unknown_tag_code` because at least one list was supplied and
        // `inconsistent_tag_set` because both were. A record LACKING them was
        // written before the checks existed (the committed release artefact is
        // one), and the honest report of it is a gap to re-validate rather than
        // an absence explained by a fact about the item, because there is no
        // such fact.
        it('never explains away unknown_tag_code or inconsistent_tag_set', () => {
            const result = notApplicableChecksForItem(
                v1Facts({ recordedCheckNames: RECORDED_BEFORE_THE_TAG_CHECKS }),
            );

            expect(nameOf(result.notApplicable)).not.toContain('unknown_tag_code');
            expect(nameOf(result.notApplicable)).not.toContain('inconsistent_tag_set');
            expect(result.unexplained).toEqual(['inconsistent_tag_set', 'unknown_tag_code']);
            expect(result.complete).toBe(false);
        });

        it('reports default_portion_count as an UNEXPLAINED gap when the item states portions without it', () => {
            const result = notApplicableChecksForItem(
                v1Facts({ recordedCheckNames: RECORDED_IN_V1.filter((name) => name !== 'default_portion_count') }),
            );

            expect(result.unexplained).toEqual(['default_portion_count']);
            expect(result.complete).toBe(false);
        });

        it('never carries a pass, an observed value or a bound for a check that was not evaluated', () => {
            for (const entry of notApplicableChecksForItem(v1Facts()).notApplicable) {
                expect(entry.applicable).toBe(false);
                expect(Object.keys(entry).sort()).toEqual(['applicable', 'name', 'reason', 'reasonCode', 'tier']);
            }
        });

        it('files each not-applicable entry under the tier the vocabulary gives it', () => {
            const entries = notApplicableChecksForItem(v1Facts()).notApplicable;

            expect(entries.find((entry) => entry.name === 'missing_density')?.tier).toBe('quarantine');
            expect(entries.find((entry) => entry.name === 'brand_pattern_name')?.tier).toBe('reject');
        });
    });

    describe('the reason is derived from the item, not from the catalog', () => {
        it('names the item\u2019s own identity source for brand_pattern_name', () => {
            const reason = reasonFor(notApplicableChecksForItem(v1Facts()).notApplicable, 'brand_pattern_name');

            expect(reason).toContain('"usda"');
            expect(reason).toContain('ai_generated');
        });

        it('names the item\u2019s own component count and provenance for the component checks', () => {
            const reason = reasonFor(notApplicableChecksForItem(v1Facts()).notApplicable, 'empty_component_set');

            expect(reason).toContain('0 component row(s)');
            expect(reason).toContain('"source_backed"');
        });

        it('names how many portion units stated no per-serving values for portion_conversion_drift', () => {
            const reason = reasonFor(
                notApplicableChecksForItem(v1Facts({ portionUnits: 4 })).notApplicable,
                'portion_conversion_drift',
            );

            expect(reason).toContain('4 portion unit(s)');
        });
    });

    describe('an item that DOES meet a precondition', () => {
        it('reports brand_pattern_name as unexplained for an ai_generated item that lacks it', () => {
            const result = notApplicableChecksForItem(v1Facts({ identitySource: 'ai_generated' }));

            expect(result.unexplained).toContain('brand_pattern_name');
            expect(nameOf(result.notApplicable)).not.toContain('brand_pattern_name');
        });

        it('reports the component checks as unexplained for an ingredient-derived item', () => {
            const result = notApplicableChecksForItem(v1Facts({ nutritionProvenance: 'ingredient_derived' }));

            expect(result.unexplained).toEqual(['empty_component_set', 'invalid_component_quantity']);
        });

        it('reports the component checks as unexplained for an item with component rows, whatever its provenance label', () => {
            const result = notApplicableChecksForItem(v1Facts({ componentRows: 2 }));

            expect(result.unexplained).toContain('empty_component_set');
            expect(result.unexplained).toContain('invalid_component_quantity');
        });

        it('reports missing_density as unexplained for a volume basis', () => {
            const result = notApplicableChecksForItem(v1Facts({ nutritionBasis: 'per_100ml' }));

            expect(result.unexplained).toEqual(['missing_density']);
        });

        // The stored basis no longer decides anything for these two: both are
        // evaluated on every candidate, so whatever the basis, a record that
        // carries them is complete and one that does not has a gap. Neither is
        // ever an explained absence.
        it('classifies the two normalisation checks by the RECORD, never by the stored basis', () => {
            for (const basisAmount of [100, 50, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
                const recorded = notApplicableChecksForItem(v1Facts({ basisAmount }));

                expect(recorded.unexplained).toEqual([]);
                expect(nameOf(recorded.notApplicable)).not.toContain('invalid_basis_amount');
                expect(nameOf(recorded.notApplicable)).not.toContain('non_finite_computed_value');

                const absent = notApplicableChecksForItem(
                    v1Facts({
                        basisAmount,
                        recordedCheckNames: RECORDED_IN_V1.filter(
                            (name) => name !== 'invalid_basis_amount' && name !== 'non_finite_computed_value',
                        ),
                    }),
                );

                expect(absent.unexplained).toEqual(['invalid_basis_amount', 'non_finite_computed_value']);
                expect(nameOf(absent.notApplicable)).not.toContain('invalid_basis_amount');
                expect(nameOf(absent.notApplicable)).not.toContain('non_finite_computed_value');
            }
        });

        it('reports portion_conversion_drift as unexplained when the record states per-serving values', () => {
            const result = notApplicableChecksForItem(v1Facts({ portionUnitsStatingNutrients: 1 }));

            expect(result.unexplained).toContain('portion_conversion_drift');
        });
    });

    describe('an item stating no portion at all', () => {
        it('explains both portion checks and names the same reason code for each', () => {
            const result = notApplicableChecksForItem(
                v1Facts({
                    portionUnits: 0,
                    recordedCheckNames: RECORDED_IN_V1.filter(
                        (name) => name !== 'unsupported_portion' && name !== 'default_portion_count',
                    ),
                }),
            );

            expect(reasonCodeFor(result.notApplicable, 'default_portion_count')).toBe('no_portions_stated');
            expect(reasonCodeFor(result.notApplicable, 'unsupported_portion')).toBe('no_portions_stated');
            expect(result.unexplained).toEqual([]);
            expect(result.complete).toBe(true);
        });
    });

    describe('a recorded name the vocabulary does not declare', () => {
        it('is reported separately and never counts toward vocabulary coverage', () => {
            const result = notApplicableChecksForItem(
                v1Facts({ recordedCheckNames: [...RECORDED_IN_V1, 'made_up_check'] }),
            );

            expect(result.recordedOutsideVocabulary).toEqual(['made_up_check']);
            expect(result.recorded).not.toContain('made_up_check');
            expect(result.recorded.length + result.notApplicable.length).toBe(23);
        });
    });

    describe('an item recording nothing at all', () => {
        it('reports every name the facts cannot explain rather than an empty verdict', () => {
            const result = notApplicableChecksForItem(v1Facts({ recordedCheckNames: [] }));

            expect(result.recorded).toEqual([]);
            expect(result.unexplained).toContain('missing_core_nutrient');
            expect(result.unexplained).toContain('unsourced');
            expect(result.unexplained).toContain('default_portion_count');
            expect(result.complete).toBe(false);
            expect(result.notApplicable.length + result.unexplained.length).toBe(23);
        });
    });

    it('is deterministic and sorted, so two runs over unchanged data agree byte for byte', () => {
        const first = notApplicableChecksForItem(v1Facts());
        const second = notApplicableChecksForItem(v1Facts());

        expect(second).toEqual(first);
        expect(nameOf(first.notApplicable)).toEqual(first.notApplicable.map((entry) => entry.name));
    });
});

describe('publishedItemFacts', () => {
    const row = (overrides: Partial<ReportFoodRow> = {}): ReportFoodRow => ({
        source_key: 'usda:169967',
        canonical_name: 'broccoli raw',
        display_name: 'Broccoli, raw',
        category: 'produce_vegetable',
        food_state: 'raw',
        identity_source: 'usda',
        identity_status: 'verified',
        nutrition_provenance: 'source_backed',
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        publication_status: 'published',
        food_group: 'brassica',
        usda_data_type: 'SR Legacy',
        catalog_validation_records: null,
        _count: { catalog_food_components: 0 },
        ...overrides,
    });

    const record = (overrides: Partial<ValidationRecordRow> = {}): ValidationRecordRow => ({
        canonical_identity: { source_key: 'usda:169967' },
        aliases: [],
        category: 'produce_vegetable',
        food_state: 'raw',
        identity_source: 'usda',
        identity_status: 'verified',
        nutrition_provenance: 'source_backed',
        nutrition_method: 'read per 100 g from the USDA record',
        nutrition_assumptions: null,
        portion_units: [],
        identity_evidence: [],
        checks: [],
        llm_review: null,
        outcome: 'accepted',
        reviewed_at: '2026-09-13T11:36:52.694Z',
        publication_status: 'published',
        source_versions: {},
        ...overrides,
    });

    it('counts the record\u2019s portion units and finds none stating per-serving nutrients', () => {
        const facts = publishedItemFacts(
            row(),
            record({
                portion_units: [
                    { description: '1 cup', amount: 1, unit: 'cup', gram_weight: 91, is_default: true },
                    { description: '1 spear', amount: 1, unit: 'each', gram_weight: 31, is_default: false },
                ],
            }),
        );

        expect(facts.portionUnits).toBe(2);
        expect(facts.portionUnitsStatingNutrients).toBe(0);
    });

    it('detects a portion entry that carries its own nutrient values, whatever the key casing', () => {
        const facts = publishedItemFacts(
            row(),
            record({
                portion_units: [
                    { description: '1 cup', amount: 1, unit: 'cup', gram_weight: 91, is_default: true, calories: 31 },
                    { description: '1 spear', amount: 1, unit: 'each', gram_weight: 31, proteinG: 1.1 },
                    { description: '1 floret', amount: 1, unit: 'each', gram_weight: 11 },
                ],
            }),
        );

        expect(facts.portionUnits).toBe(3);
        expect(facts.portionUnitsStatingNutrients).toBe(2);
    });

    it('reads the component count off the row rather than inferring it from the provenance label', () => {
        expect(publishedItemFacts(row({ _count: { catalog_food_components: 4 } }), record()).componentRows).toBe(4);
    });

    it('carries the recorded check names and drops an entry with no name', () => {
        const facts = publishedItemFacts(
            row(),
            record({
                checks: [
                    { name: 'kcal_ceiling', pass: true, observed: 34, bound: 900 },
                    { pass: false },
                    { name: 'unsourced', pass: true, observed: 'verified', bound: 'verified or ambiguous' },
                ],
            }),
        );

        expect(facts.recordedCheckNames).toEqual(['kcal_ceiling', 'unsourced']);
    });

    it('treats a non-array portion_units as no portions rather than throwing', () => {
        expect(publishedItemFacts(row(), record({ portion_units: null })).portionUnits).toBe(0);
    });
});

describe('toItemRecord', () => {
    const row: ReportFoodRow = {
        source_key: 'usda:169967',
        canonical_name: 'broccoli raw',
        display_name: 'Broccoli, raw',
        category: 'produce_vegetable',
        food_state: 'raw',
        identity_source: 'usda',
        identity_status: 'verified',
        nutrition_provenance: 'source_backed',
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        publication_status: 'published',
        food_group: 'brassica',
        usda_data_type: 'SR Legacy',
        catalog_validation_records: null,
        _count: { catalog_food_components: 0 },
    };

    const record: ValidationRecordRow = {
        canonical_identity: { source_key: 'usda:169967' },
        aliases: ['broccoli'],
        category: 'produce_vegetable',
        food_state: 'raw',
        identity_source: 'usda',
        identity_status: 'verified',
        nutrition_provenance: 'source_backed',
        nutrition_method: 'read per 100 g from the USDA record',
        nutrition_assumptions: null,
        portion_units: [{ description: '1 cup', amount: 1, unit: 'cup', gram_weight: 91, is_default: true }],
        identity_evidence: [],
        checks: [
            { name: 'unsourced', pass: true, observed: 'verified', bound: 'verified or ambiguous' },
            { name: 'kcal_ceiling', pass: true, observed: 34, bound: 900 },
        ],
        llm_review: null,
        outcome: 'accepted',
        reviewed_at: '2026-09-13T11:36:52.694Z',
        publication_status: 'published',
        source_versions: { coverage_plan_version: 'v1' },
    };

    it('carries the not-applicable entries beside the checks', () => {
        const item = toItemRecord(row, record);

        expect(nameOf(item.notApplicableChecks as { name: string }[])).toContain('missing_density');
    });

    it('leaves the checks array exactly as the validator wrote it', () => {
        const item = toItemRecord(row, record);
        const checks = item.checks as Record<string, unknown>[];

        expect(checks).toHaveLength(2);
        expect(checks.map((check) => check.name)).toEqual(['kcal_ceiling', 'unsourced']);
        for (const check of checks) {
            expect(check).not.toHaveProperty('applicable');
            expect(check).not.toHaveProperty('reason');
        }
        expect(checks[0]).toEqual({ name: 'kcal_ceiling', pass: true, observed: 34, bound: 900 });
    });
});

/* ---------------------------------------------------------------------------
 * The withheld-identity audit.
 * ------------------------------------------------------------------------- */

describe('perCategoryByStatus', () => {
    const rows = () =>
        buildCoverageRows(
            policy(),
            plan(),
            measurement({
                categories: {
                    produce_vegetable: emptyCategory({ byPublicationStatus: { published: 2, quarantined: 3 } }),
                    spice_herb: emptyCategory({ byPublicationStatus: { published: 1 } }),
                },
                publishedByCategory: { produce_vegetable: 2, spice_herb: 1 },
            }),
            computeCoverageShortfall(policy(), { produce_vegetable: 2, spice_herb: 1 }),
        );

    it('states a measured zero for a plan category holding none of that status', () => {
        const measured = measurement({
            categories: {
                produce_vegetable: emptyCategory({ byPublicationStatus: { published: 2, quarantined: 3 } }),
                spice_herb: emptyCategory({ byPublicationStatus: { published: 1 } }),
            },
        });

        expect(perCategoryByStatus(rows(), measured, 'quarantined')).toEqual({
            produce_vegetable: 3,
            spice_herb: 0,
        });
    });

    it('includes a category the plan does not declare when it holds rows of that status', () => {
        const measured = measurement({
            categories: {
                produce_vegetable: emptyCategory({ byPublicationStatus: { published: 2 } }),
                spice_herb: emptyCategory({ byPublicationStatus: { published: 1 } }),
                not_in_the_plan: emptyCategory({ byPublicationStatus: { rejected: 4 } }),
            },
        });

        expect(perCategoryByStatus(rows(), measured, 'rejected')).toEqual({
            produce_vegetable: 0,
            spice_herb: 0,
            not_in_the_plan: 4,
        });
    });

    it('emits its keys in sorted order, so a rerun over unchanged data is byte-identical', () => {
        const measured = measurement({
            categories: {
                spice_herb: emptyCategory({ byPublicationStatus: { candidate: 1 } }),
                produce_vegetable: emptyCategory({ byPublicationStatus: { candidate: 2 } }),
            },
        });

        expect(Object.keys(perCategoryByStatus(rows(), measured, 'candidate'))).toEqual([
            'produce_vegetable',
            'spice_herb',
        ]);
    });
});

describe('buildWithheldIdentityAudit', () => {
    const measured = (overrides: Partial<CatalogMeasurement> = {}): CatalogMeasurement =>
        measurement({
            byPublicationStatus: { published: 11046, candidate: 2, quarantined: 5, rejected: 1 },
            categories: {
                produce_vegetable: emptyCategory({
                    byPublicationStatus: { published: 11046, quarantined: 4, candidate: 2 },
                }),
                spice_herb: emptyCategory({ byPublicationStatus: { quarantined: 1, rejected: 1 } }),
            },
            quarantinedByCheck: { unsourced: 5 },
            rejectedByCheck: { brand_pattern_name: 1 },
            candidateByCheck: {},
            withheldIdentities: [
                withheld({ sourceKey: 'ai:spice_herb:a:prepared', category: 'spice_herb', failingChecks: ['unsourced'] }),
                withheld({ sourceKey: 'ai:produce_vegetable:b:raw', failingChecks: ['unsourced'] }),
                withheld({
                    sourceKey: 'ai:produce_vegetable:c:raw',
                    publicationStatus: 'candidate',
                    outcome: null,
                    failingChecks: [],
                }),
                withheld({
                    sourceKey: 'ai:spice_herb:d:prepared',
                    category: 'spice_herb',
                    publicationStatus: 'rejected',
                    outcome: 'rejected',
                    failingChecks: ['brand_pattern_name'],
                }),
            ],
            ...overrides,
        });

    const coverage = () =>
        buildCoverageRows(policy(), plan(), measured(), computeCoverageShortfall(policy(), { produce_vegetable: 11046 }));

    it('states a total per withholding status, measured over every scanned row', () => {
        const audit = buildWithheldIdentityAudit(coverage(), measured());

        expect(audit.totals).toEqual({ candidate: 2, quarantined: 5, rejected: 1, withheldTotal: 8 });
    });

    it('breaks every status down per category with the plan\u2019s categories always present', () => {
        const audit = buildWithheldIdentityAudit(coverage(), measured());

        expect(audit.perCategory.quarantined).toEqual({ produce_vegetable: 4, spice_herb: 1 });
        expect(audit.perCategory.rejected).toEqual({ produce_vegetable: 0, spice_herb: 1 });
    });

    it('lists each status\u2019s identities with the checks that failed on them', () => {
        const audit = buildWithheldIdentityAudit(coverage(), measured());

        expect(audit.identities.quarantined.map((entry) => entry.sourceKey)).toEqual([
            'ai:spice_herb:a:prepared',
            'ai:produce_vegetable:b:raw',
        ]);
        expect(audit.identities.rejected[0].failingChecks).toEqual(['brand_pattern_name']);
        expect(audit.identities.candidate[0].failingChecks).toEqual([]);
    });

    it('counts the failing checks of each status separately', () => {
        const audit = buildWithheldIdentityAudit(coverage(), measured());

        expect(audit.byCheck.quarantined).toEqual({ unsourced: 5 });
        expect(audit.byCheck.rejected).toEqual({ brand_pattern_name: 1 });
        expect(audit.byCheck.candidate).toEqual({});
    });

    it('counts the listed identities that carry no failing check, which a candidate legitimately does not', () => {
        const audit = buildWithheldIdentityAudit(coverage(), measured());

        expect(audit.listedIdentitiesWithNoFailingCheck).toEqual({ candidate: 1, quarantined: 0, rejected: 0 });
    });

    it('does not claim every identity is listed when the totals and the lists disagree', () => {
        const audit = buildWithheldIdentityAudit(coverage(), measured());

        expect(audit.identitiesListed).toEqual({ candidate: 1, quarantined: 2, rejected: 1 });
        expect(audit.everyWithheldIdentityListed).toBe(false);
    });

    it('claims completeness only when every withheld row is listed and nothing was capped', () => {
        const complete = measured({ byPublicationStatus: { published: 3, candidate: 1, quarantined: 2, rejected: 1 } });
        const audit = buildWithheldIdentityAudit(coverage(), complete);

        expect(audit.everyWithheldIdentityListed).toBe(true);
    });

    it('states the cap and the omitted count in the same block rather than truncating silently', () => {
        const audit = buildWithheldIdentityAudit(coverage(), measured({ withheldIdentitiesOmitted: { quarantined: 7 } }));

        expect(audit.identityCap).toBe(5000);
        expect(audit.identitiesOmittedByCap).toEqual({ candidate: 0, quarantined: 7, rejected: 0 });
        expect(audit.everyWithheldIdentityListed).toBe(false);
        expect(audit.note).toContain('7 were left out');
    });

    it('generates its note from the measured figures', () => {
        const audit = buildWithheldIdentityAudit(coverage(), measured());

        expect(audit.note).toContain('8 row(s) are withheld');
        expect(audit.note).toContain('2 candidate, 5 quarantined, 1 rejected');
        expect(audit.note).toContain('4 identity(ies) are listed');
    });

    // F06: a withheld identity that states only the NAME of what failed cannot
    // be triaged from committed evidence. These pin the judgement data beside
    // it, and the per-entry agreement between the two.
    it('states every failing check with its observed value and bound', () => {
        const audit = buildWithheldIdentityAudit(coverage(), measured());

        expect(audit.identityFields).toContain('failingCheckEvidence');
        expect(audit.failingChecksListed).toEqual({ candidate: 0, quarantined: 2, rejected: 1 });
        expect(audit.failingCheckEvidenceEntries).toEqual({ candidate: 0, quarantined: 2, rejected: 1 });
        expect(audit.everyFailingCheckStatesItsEvidence).toBe(true);

        for (const status of ['candidate', 'quarantined', 'rejected']) {
            for (const identity of audit.identities[status] ?? []) {
                expect(identity.failingCheckEvidence.map((check) => check.name)).toEqual(identity.failingChecks);
                for (const check of identity.failingCheckEvidence) {
                    expect(check.pass).toBe(false);
                    expect(check.observed).not.toBeUndefined();
                    expect(check.bound).not.toBeUndefined();
                }
            }
        }
    });

    it('names the evidence figures in its own note', () => {
        const audit = buildWithheldIdentityAudit(coverage(), measured());

        expect(audit.note).toContain('3 failing check(s) are stated with the observed value and bound');
        expect(audit.note).toContain('against 3 failing check name(s) listed');
        expect(audit.note).toContain('states exactly the names it lists: yes');
        expect(audit.measuredFrom).toContain('observed values and bounds');
    });

    // Per entry, never by comparing the two totals: a name lost on one row and
    // gained on another would cancel out in a total and hide both.
    it('reports a disagreement between an identity\u2019s names and its evidence', () => {
        const audit = buildWithheldIdentityAudit(
            coverage(),
            measured({
                withheldIdentities: [
                    withheld({
                        sourceKey: 'usda:x',
                        failingChecks: ['kcal_ceiling'],
                        failingCheckEvidence: [
                            { name: 'nutrient_negative', tier: 'reject', pass: false, observed: -1, bound: 0 },
                        ],
                    }),
                    withheld({
                        sourceKey: 'usda:y',
                        failingChecks: ['nutrient_negative'],
                        failingCheckEvidence: [
                            { name: 'kcal_ceiling', tier: 'reject', pass: false, observed: 947, bound: 900 },
                        ],
                    }),
                ],
            }),
        );

        expect(audit.failingChecksListed.quarantined).toBe(2);
        expect(audit.failingCheckEvidenceEntries.quarantined).toBe(2);
        expect(audit.everyFailingCheckStatesItsEvidence).toBe(false);
        expect(audit.note).toContain('see everyFailingCheckStatesItsEvidence');
    });

    it('passes each identity\u2019s measured evidence through in the sorted order it arrived in', () => {
        const audit = buildWithheldIdentityAudit(
            coverage(),
            measured({
                withheldIdentities: [
                    withheld({ sourceKey: 'usda:z', failingChecks: ['unsourced', 'kcal_ceiling'] }),
                ],
            }),
        );

        expect(audit.identities.quarantined[0].failingChecks).toEqual(['kcal_ceiling', 'unsourced']);
        expect(audit.identities.quarantined[0].failingCheckEvidence.map((check) => check.name)).toEqual([
            'kcal_ceiling',
            'unsourced',
        ]);
    });

    it('reports zeros rather than absence for a catalog that withheld nothing', () => {
        const audit = buildWithheldIdentityAudit(coverage(), measurement({ byPublicationStatus: { published: 10 } }));

        expect(audit.totals).toEqual({ candidate: 0, quarantined: 0, rejected: 0, withheldTotal: 0 });
        expect(audit.everyWithheldIdentityListed).toBe(true);
        expect(audit.note).toContain('0 row(s) are withheld');
    });
});

describe('generatedContentPresence', () => {
    it('states zero published generated identities beside the rows that were withheld', () => {
        const presence = generatedContentPresence(
            { usda: 11046 },
            { ai_generated: { quarantined: 2, rejected: 1 }, usda: { candidate: 1 } },
        );

        expect(presence.publishedGeneratedFoods).toBe(0);
        expect(presence.withheldGeneratedRowsByStatus).toEqual({ quarantined: 2, rejected: 1 });
        expect(presence.withheldGeneratedRowsTotal).toBe(3);
        expect(presence.statement).toBe(
            '0 generated identity(ies) published; 3 generated row(s) withheld (quarantined 2, rejected 1). ' +
                'A withheld row is in the database and counted here, but it is absent from the release, from ' +
                'search and from recipe eligibility.',
        );
        expect(presence.labellingConsequence).toContain('No generated identity is published');
    });

    it('demands the estimate label the moment a generated identity is published', () => {
        const presence = generatedContentPresence({ usda: 10, ai_generated: 4 }, {});

        expect(presence.publishedGeneratedFoods).toBe(4);
        expect(presence.withheldGeneratedRowsTotal).toBe(0);
        expect(presence.labellingConsequence).toContain('4 generated identity(ies) are published');
        expect(presence.labellingConsequence).toContain('estimate label');
        expect(presence.statement).toContain('0 generated row(s) withheld');
    });

    it('never claims generation did not run \u2014 it counts rows, not runs', () => {
        const presence = generatedContentPresence({ usda: 1 }, {});

        expect(presence.statement).not.toContain('no generation ran');
        expect(presence.statement).not.toContain('No generation ran');
        expect(presence.measuredFrom).toContain('Not read from a generation counter');
    });

    it('omits a status a run withheld nothing under rather than stating a zero for it', () => {
        const presence = generatedContentPresence({}, { ai_generated: { quarantined: 5, rejected: 0 } });

        expect(presence.withheldGeneratedRowsByStatus).toEqual({ quarantined: 5 });
        expect(presence.withheldGeneratedRowsTotal).toBe(5);
    });

    it('counts a retired generated row as withheld \u2014 it is in the database and absent from the release', () => {
        const presence = generatedContentPresence({}, { ai_generated: { retired: 3, quarantined: 1 } });

        expect(presence.withheldGeneratedRowsByStatus).toEqual({ quarantined: 1, retired: 3 });
        expect(presence.withheldGeneratedRowsTotal).toBe(4);
    });

    // THE CAP REGRESSION. This figure was previously derived by walking the
    // withheld IDENTITY list, which stops at 5,000 entries per status. A
    // population above the cap therefore under-reported itself while the
    // measuredFrom sentence claimed to have counted every withheld row \u2014
    // and only on a catalog too large to check by hand.
    it('counts the whole withheld population, not the capped identity list', () => {
        const presence = generatedContentPresence(
            { usda: 11046 },
            { ai_generated: { quarantined: 7331, rejected: 12 }, usda: { candidate: 6002 } },
        );

        expect(presence.withheldGeneratedRowsByStatus).toEqual({ quarantined: 7331, rejected: 12 });
        expect(presence.withheldGeneratedRowsTotal).toBe(7343);
        expect(presence.statement).toContain('7,343 generated row(s) withheld');
        expect(presence.measuredFrom).toContain('before the per-status cap on the listed identities');
    });
});

describe('toQuarantinedIdentity', () => {
    it('drops the status the quarantine block carries by construction and keeps every other fact', () => {
        expect(toQuarantinedIdentity(withheld())).toEqual({
            sourceKey: 'usda:1',
            category: 'produce_vegetable',
            foodState: 'raw',
            displayName: 'Broccoli, raw',
            identitySource: 'usda',
            outcome: 'quarantined',
            failingChecks: ['missing_core_nutrient'],
            failingCheckEvidence: [
                {
                    name: 'missing_core_nutrient',
                    tier: 'quarantine',
                    pass: false,
                    observed: 'observed value for missing_core_nutrient',
                    bound: 'bound for missing_core_nutrient',
                },
            ],
        });
    });

    // The quarantine block is the one an operator triaging quarantined rows
    // reads, so it must carry the judgement data and not just the names.
    it('carries the observed value and bound of every failing check into the quarantine block', () => {
        const projected = toQuarantinedIdentity(
            withheld({
                failingChecks: ['kcal_ceiling', 'out_of_category_range'],
                failingCheckEvidence: [
                    { name: 'kcal_ceiling', tier: 'reject', pass: false, observed: 947.2, bound: 900 },
                    {
                        name: 'out_of_category_range',
                        tier: 'review',
                        pass: false,
                        observed: 947.2,
                        bound: '5\u2013150 kcal/100 g for produce_vegetable',
                    },
                ],
            }),
        );

        expect(projected.failingCheckEvidence.map((check) => check.name)).toEqual(projected.failingChecks);
        expect(projected.failingCheckEvidence[0].observed).toBe(947.2);
        expect(projected.failingCheckEvidence[0].bound).toBe(900);
        expect(projected.failingCheckEvidence[1].bound).toContain('produce_vegetable');
    });
});

/* ---------------------------------------------------------------------------
 * The checks a successful normalisation executed.
 *
 * `normalizeToPer100g` evaluates `invalid_basis_amount` on every candidate and
 * `non_finite_computed_value` on the basis mass, the rescale factor and every
 * rescaled nutrient, and records NEITHER on success \u2014 contradicting
 * `CatalogValidationVerdict.checks`'s own contract ("Every check that was
 * EVALUATED, passing and failing alike"). These pin the derivation that closes
 * the gap at the point the record is written.
 * ------------------------------------------------------------------------- */

describe('recordedChecks', () => {
    const nutrients = { calories: 34, protein_g: 2.8, carbs_g: 6.6, fat_g: 0.4, fiber_g: 2.6 };

    const verdict = (overrides: Partial<CatalogValidationVerdict> = {}): CatalogValidationVerdict => ({
        publicationStatus: 'published',
        outcome: 'accepted',
        reviewFlags: [],
        decidingCheckNames: [],
        countsTowardPublishedTarget: true,
        checks: [
            { name: 'missing_core_nutrient', pass: true, observed: 'all four present', bound: null, tier: 'quarantine' },
        ],
        normalizedNutrition: nutrients,
        ...overrides,
    });

    const named = (checks: readonly CatalogValidationCheck[]): string[] => checks.map((check) => check.name);

    it('records both normalisation checks as passes once the conversion succeeded', () => {
        const checks = recordedChecks(verdict(), { nutritionBasis: 'per_100g', basisAmount: 100 });

        expect(named(checks)).toEqual([
            'missing_core_nutrient',
            'invalid_basis_amount',
            'non_finite_computed_value',
        ]);
        for (const check of checks) {
            expect(check.pass).toBe(true);
        }
    });

    it('states the bound its own failure path states, and the observed value that met it', () => {
        const checks = recordedChecks(verdict(), { nutritionBasis: 'per_100ml', basisAmount: 240 });
        const basis = checks.find((check) => check.name === 'invalid_basis_amount');
        const finite = checks.find((check) => check.name === 'non_finite_computed_value');

        expect(basis?.bound).toBe('a finite basis_amount greater than 0');
        expect(basis?.observed).toBe('basis_amount 240 on a per_100ml basis');
        expect(basis?.tier).toBe('reject');
        expect(finite?.bound).toBe('finite per-100g values');
        expect(finite?.observed).toContain('rescale factor and every rescaled nutrient were finite');
        expect(finite?.observed).toContain('per_100ml basis of 240');
        expect(finite?.tier).toBe('reject');
    });

    // The one thing this must never do: claim a check passed on a row whose
    // conversion never reached it. A per_100ml row held for missing_density
    // failed BEFORE the finiteness guards ran.
    it('appends nothing when the conversion failed, so no unreached check is claimed as a pass', () => {
        const failed = verdict({
            publicationStatus: 'quarantined',
            outcome: 'quarantined',
            decidingCheckNames: ['missing_density'],
            checks: [
                { name: 'missing_density', pass: false, observed: null, bound: 'a positive density_g_per_ml', tier: 'quarantine' },
            ],
            normalizedNutrition: null,
        });

        expect(named(recordedChecks(failed, { nutritionBasis: 'per_100ml', basisAmount: 100 }))).toEqual([
            'missing_density',
        ]);
    });

    it('appends nothing when the caller states no basis, rather than inventing one', () => {
        expect(named(recordedChecks(verdict(), null))).toEqual(['missing_core_nutrient']);
    });

    it('never duplicates a name the verdict already carries', () => {
        const already = verdict({
            checks: [
                { name: 'invalid_basis_amount', pass: false, observed: 0, bound: 'a finite basis_amount greater than 0', tier: 'reject' },
            ],
        });
        const checks = recordedChecks(already, { nutritionBasis: 'per_100g', basisAmount: 0 });

        expect(named(checks)).toEqual(['invalid_basis_amount', 'non_finite_computed_value']);
        expect(checks[0].pass).toBe(false);
    });

    it('leaves the verdict it was handed untouched', () => {
        const original = verdict();
        recordedChecks(original, { nutritionBasis: 'per_100g', basisAmount: 100 });

        expect(original.checks).toHaveLength(1);
    });

    it('is what the validation record stores, so a published record carries both', () => {
        const patch = validationRecordPatch(verdict(), 'published', [], new Date('2026-09-08T00:00:00.000Z'), [], null, {
            nutritionBasis: 'per_100g',
            basisAmount: 100,
        });

        expect(named(patch.checks as CatalogValidationCheck[])).toContain('invalid_basis_amount');
        expect(named(patch.checks as CatalogValidationCheck[])).toContain('non_finite_computed_value');
    });

    it('is byte-stable across calls, so re-validating a row rewrites the same array', () => {
        const first = recordedChecks(verdict(), { nutritionBasis: 'per_100g', basisAmount: 100 });
        const second = recordedChecks(verdict(), { nutritionBasis: 'per_100g', basisAmount: 100 });

        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });
});

/* ---------------------------------------------------------------------------
 * Superseded keys.
 * ------------------------------------------------------------------------- */

describe('pruneSupersededKeys', () => {
    it('removes the stale quarantine claims a regenerated report would otherwise carry', () => {
        const pruned = pruneSupersededKeys('quarantined', {
            total: 181,
            identities: null,
            identitiesUnavailableReason: 'the release carries published rows only',
            perCategoryUnmeasuredReason: 'quarantine is not broken down by category',
            duplicateIdentityNote: '2 lost identities were merged as aliases of the surviving food',
        });

        expect(pruned).toEqual({ total: 181, identities: null });
    });

    it('removes the contradicted per-item claims', () => {
        expect(pruneSupersededKeys('checksOverPublishedItems', { everyItemCarriesEveryCheck: true, byCheck: {} })).toEqual(
            { byCheck: {} },
        );
        expect(pruneSupersededKeys('itemRecords', { checksPerItem: 13, count: 11046 })).toEqual({ count: 11046 });
        expect(pruneSupersededKeys('checkVocabulary', { evaluatedCount: 13, source: 'catalog.logic.ts' })).toEqual({
            source: 'catalog.logic.ts',
        });
    });

    it('removes the producedBy claims that the aggregate came from files rather than a database', () => {
        const pruned = pruneSupersededKeys('producedBy', {
            stageFieldsCommand: 'npm run catalog:import',
            stageFields: ['counts'],
            databaseIndependence: 'derived from the committed release artefacts, not from a live database',
            itemRecordSource: 'data/meal-planning/catalog/releases/v1/validation-records.jsonl',
            regenerability: 're-derivable by anyone from the committed artefacts',
        });

        expect(pruned).toEqual({ stageFieldsCommand: 'npm run catalog:import', stageFields: ['counts'] });
    });

    it('preserves every other stage\u2019s counters exactly, including the per-stage quarantine attribution', () => {
        const existing = {
            total: 181,
            atImport: 74,
            atValidate: 107,
            byCheck: { missing_core_nutrient: 74, duplicate_identity: 107 },
            identitiesUnavailableReason: 'stale',
        };

        expect(pruneSupersededKeys('quarantined', existing)).toEqual({
            total: 181,
            atImport: 74,
            atValidate: 107,
            byCheck: { missing_core_nutrient: 74, duplicate_identity: 107 },
        });
    });

    it('leaves a block it names no keys for completely untouched', () => {
        const usdaRequests = { attempts: 615, pauses: 3, windowStartedAt: '2026-09-13T11:35:00.000Z' };

        expect(pruneSupersededKeys('usdaRequests', usdaRequests)).toEqual(usdaRequests);
        expect(pruneSupersededKeys('modelSpend', { reserved: 0, used: 0 })).toEqual({ reserved: 0, used: 0 });
    });

    it('does not mutate the block it was handed', () => {
        const block = { checksPerItem: 13, count: 2 };
        pruneSupersededKeys('itemRecords', block);

        expect(block).toEqual({ checksPerItem: 13, count: 2 });
    });
});

describe('supersededKeyPaths', () => {
    it('names every removal as <block>.<key>, sorted, so the prune is auditable from the artefact', () => {
        const paths = supersededKeyPaths();

        expect(paths).toContain('quarantine.identitiesUnavailableReason');
        expect(paths).toContain('checksOverPublishedItems.everyItemCarriesEveryCheck');
        expect(paths).toContain('itemRecords.checksPerItem');
        expect(paths).toContain('producedBy.databaseIndependence');
        expect(paths).toContain('dataProvenance.aiGeneratedContentPresent');
        expect(paths).toContain('dataProvenance.aiGenerationPolicy');
        expect([...paths].sort()).toEqual([...paths]);
    });

    it('leaves the legal determination in dataProvenance alone', () => {
        const preserved = pruneSupersededKeys('dataProvenance', {
            usdaPublicDomain: true,
            legalBasisForCommitting: 'the determination',
            citations: [{ path: 'src/services/usda.service.ts' }],
            sourceDatasets: [{ name: 'Foundation' }],
            aiGeneratedContentPresent: false,
            aiGenerationPolicy: 'No generation ran for this catalog.',
        });

        expect(preserved).toEqual({
            usdaPublicDomain: true,
            legalBasisForCommitting: 'the determination',
            citations: [{ path: 'src/services/usda.service.ts' }],
            sourceDatasets: [{ name: 'Foundation' }],
        });
    });

    it('names no counter belonging to another stage', () => {
        for (const path of supersededKeyPaths()) {
            expect(path).not.toContain('usdaRequests');
            expect(path).not.toContain('modelSpend');
            expect(path).not.toContain('counts.');
            expect(path).not.toContain('atImport');
            expect(path).not.toContain('atValidate');
        }
    });
});

/* ---------------------------------------------------------------------------
 * The per-category coverage verdict.
 * ------------------------------------------------------------------------- */

const plan = (): CoveragePlan => ({
    coveragePlanVersion: 'v1',
    promptVersion: 'catalog-generate-v1',
    reviewPromptVersion: 'catalog-review-v1',
    modelCallsPerBatch: 2,
    defaultBatchSize: 25,
    publishedTargetTotal: 1500,
    candidateVolumeTotal: 1875,
    categories: [
        {
            category: 'produce_vegetable',
            publishedTarget: 1200,
            candidateVolume: 1500,
            kcalReviewRange: { min: 0, max: 400 },
            energyMacroTolerancePercent: 30,
        },
        {
            category: 'spice_herb',
            publishedTarget: 300,
            candidateVolume: 375,
            kcalReviewRange: { min: 0, max: 500 },
            energyMacroTolerancePercent: 30,
        },
    ],
    foodGroups: [],
    validationBounds: {
        maxKcalPer100g: 900,
        macroMassToleranceFactor: 1.02,
        energyMacroAbsoluteToleranceKcal: 30,
        portionConversionTolerancePercent: 5,
    },
    quarantineChecks: [...CATALOG_QUARANTINE_CHECK_NAMES],
    costClassScale: [],
});

const policy = (): CatalogValidationPolicy => ({
    categories: plan().categories,
    validationBounds: plan().validationBounds,
});

describe('buildCoverageRows', () => {
    it('states unmet per category from the exact shortfall', () => {
        const published = { produce_vegetable: 1400, spice_herb: 49 };
        const rows = buildCoverageRows(
            policy(),
            plan(),
            measurement({ publishedByCategory: published }),
            computeCoverageShortfall(policy(), published),
        );

        expect(rows.map((row) => [row.category, row.published, row.shortfall, row.unmet])).toEqual([
            ['produce_vegetable', 1400, 0, false],
            ['spice_herb', 49, 251, true],
        ]);
    });

    // CMPBE-F01 / DOCSMOB-F08: a shortfall number alone does not say whether
    // the gap can be closed by triaging withheld rows or only by obtaining
    // more input, and that is the first thing an operator needs.
    it('divides the gap into rows that exist and rows that were never obtained', () => {
        const published = { produce_vegetable: 1400, spice_herb: 49 };
        const rows = buildCoverageRows(
            policy(),
            plan(),
            measurement({
                publishedByCategory: published,
                categories: {
                    spice_herb: emptyCategory({
                        byPublicationStatus: { published: 49, candidate: 30, quarantined: 20, rejected: 900 },
                    }),
                },
            }),
            computeCoverageShortfall(policy(), published),
        );
        const herb = rows.find((row) => row.category === 'spice_herb');

        // 49 published + 30 candidate + 20 quarantined = 99 rows that could
        // reach the published set; the 900 rejected never can.
        expect(herb?.reachableCeiling).toBe(99);
        expect(herb?.shortfall).toBe(251);
        expect(herb?.shortfallBeyondEveryRowObtained).toBe(201);
    });

    it('reports nothing beyond the obtained rows when the withheld rows alone could close the gap', () => {
        const published = { produce_vegetable: 1400, spice_herb: 200 };
        const rows = buildCoverageRows(
            policy(),
            plan(),
            measurement({
                publishedByCategory: published,
                categories: {
                    spice_herb: emptyCategory({
                        byPublicationStatus: { published: 200, quarantined: 150 },
                    }),
                },
            }),
            computeCoverageShortfall(policy(), published),
        );
        const herb = rows.find((row) => row.category === 'spice_herb');

        expect(herb?.shortfall).toBe(100);
        expect(herb?.reachableCeiling).toBe(350);
        expect(herb?.shortfallBeyondEveryRowObtained).toBe(0);
    });

    it('excludes retired rows from the ceiling, because re-publishing one is a load-time decision', () => {
        const published = { produce_vegetable: 1400, spice_herb: 49 };
        const rows = buildCoverageRows(
            policy(),
            plan(),
            measurement({
                publishedByCategory: published,
                categories: {
                    spice_herb: emptyCategory({ byPublicationStatus: { published: 49, retired: 500 } }),
                },
            }),
            computeCoverageShortfall(policy(), published),
        );

        expect(rows.find((row) => row.category === 'spice_herb')?.reachableCeiling).toBe(49);
    });

    it('never smooths a deficit against a surplus in another category', () => {
        const published = { produce_vegetable: 1600, spice_herb: 0 };
        const shortfall = computeCoverageShortfall(policy(), published);
        const rows = buildCoverageRows(policy(), plan(), measurement({ publishedByCategory: published }), shortfall);

        expect(shortfall.shortfallTotal).toBe(300);
        expect(rows.find((row) => row.category === 'spice_herb')?.shortfall).toBe(300);
        expect(rows.find((row) => row.category === 'spice_herb')?.unmet).toBe(true);
    });
});

describe('buildRequirementBlock', () => {
    const block = (published: Record<string, number>) => {
        const shortfall = computeCoverageShortfall(policy(), published);
        const measured = measurement({
            publishedByCategory: published,
            byPublicationStatus: { published: Object.values(published).reduce((sum, count) => sum + count, 0) },
        });

        return buildRequirementBlock({
            plan: plan(),
            measurement: measured,
            shortfall,
            rows: buildCoverageRows(policy(), plan(), measured, shortfall),
            scopedTo: null,
        });
    };

    it('states the whole-catalog per-category verdict and the categories that miss their target', () => {
        const requirement = block({ produce_vegetable: 1400, spice_herb: 49 });

        expect(requirement.everyCategoryMeetsItsTarget).toBe(false);
        expect(requirement.categoriesUnmet).toEqual([
            {
                category: 'spice_herb',
                shortfall: 251,
                reachableCeiling: 49,
                shortfallBeyondEveryRowObtained: 251,
            },
        ]);
        expect(requirement.perCategoryShortfallTotal).toBe(251);
        expect(requirement.unmetRequirements.map((entry) => entry.code)).toContain(
            'categories_below_published_target',
        );
    });

    it('composes the shortfall from the per-category division and says what each part means', () => {
        const published = { produce_vegetable: 1400, spice_herb: 49 };
        const shortfall = computeCoverageShortfall(policy(), published);
        const measured = measurement({
            publishedByCategory: published,
            byPublicationStatus: { published: 1449, candidate: 30, quarantined: 20 },
            categories: {
                spice_herb: emptyCategory({
                    byPublicationStatus: { published: 49, candidate: 30, quarantined: 20, rejected: 900 },
                }),
            },
        });
        const requirement = buildRequirementBlock({
            plan: plan(),
            measurement: measured,
            shortfall,
            rows: buildCoverageRows(policy(), plan(), measured, shortfall),
            scopedTo: null,
        });

        expect(requirement.shortfallComposition.total).toBe(251);
        expect(requirement.shortfallComposition.closableByResolvingWithheldRows).toBe(50);
        expect(requirement.shortfallComposition.beyondEveryRowObtained).toBe(201);
        expect(
            requirement.shortfallComposition.closableByResolvingWithheldRows +
                requirement.shortfallComposition.beyondEveryRowObtained,
        ).toBe(requirement.shortfallComposition.total);
        expect(requirement.shortfallComposition.note).toContain('asserts no cause');
        expect(
            requirement.unmetRequirements.find((entry) => entry.code === 'categories_below_published_target')?.detail,
        ).toContain('201 of those items exceed every row obtained');
    });

    it('states a zero composition when nothing is short', () => {
        const requirement = block({ produce_vegetable: 1200, spice_herb: 300 });

        expect(requirement.shortfallComposition).toEqual({
            total: 0,
            closableByResolvingWithheldRows: 0,
            beyondEveryRowObtained: 0,
            note: expect.stringContaining('0 item(s) short'),
        });
    });

    it('keeps the per-category verdict unmet even when the aggregate item requirement passes', () => {
        const requirement = block({ produce_vegetable: 11000, spice_herb: 49 });

        expect(requirement.requirementMet).toBe(true);
        expect(requirement.everyCategoryMeetsItsTarget).toBe(false);
        expect(requirement.categoriesUnmet).toHaveLength(1);
    });

    it('claims every category met only when none is short', () => {
        const requirement = block({ produce_vegetable: 1200, spice_herb: 300 });

        expect(requirement.everyCategoryMeetsItsTarget).toBe(true);
        expect(requirement.categoriesUnmet).toEqual([]);
        expect(requirement.unmetRequirements.map((entry) => entry.code)).not.toContain(
            'categories_below_published_target',
        );
    });
});

/* ---------------------------------------------------------------------------
 * The alias-merge policy (scripts/catalog-validate.ts).
 *
 * WHY THIS IS PINNED HERE RATHER THAN OBSERVED IN A RELEASE. The policy decides
 * which names reach a PUBLISHED food, and `catalog_food_aliases` carries no
 * provenance column — so once a model-proposed synonym is on a source-backed
 * food, no artefact can say it does not belong there. The only place the rule
 * is legible is a test that states it.
 * ------------------------------------------------------------------------- */

describe('partitionAliasMerges', () => {
    /** The two plans the script derives, from one set of identity candidates. */
    const plansFor = (
        candidates: readonly (CatalogIdentityCandidate & { identity_status: string })[],
    ): AliasMergePartition => {
        const identityStatusBySourceKey = new Map(
            candidates.map((candidate) => [candidate.source_key, candidate.identity_status]),
        );

        return partitionAliasMerges({
            mergesOverEveryIdentity: dedupeIdentity(candidates).merges,
            mergesOverSourcedIdentities: dedupeIdentity(
                candidates.filter((candidate) => candidate.identity_status !== 'unsourced'),
            ).merges,
            identityStatusBySourceKey,
        });
    };

    it('offers a sourced loser\u2019s names and withholds an unsourced one\u2019s', () => {
        const partition = plansFor([
            {
                source_key: 'usda:1',
                canonical_name: 'tomato paste',
                display_name: 'Tomato paste',
                food_state: 'prepared',
                identity_source: 'usda',
                identity_status: 'verified',
                aliases: [],
            },
            {
                source_key: 'usda:2',
                canonical_name: 'tomato paste',
                display_name: 'Tomato concentrate',
                food_state: 'prepared',
                identity_source: 'usda',
                identity_status: 'verified',
                aliases: [],
            },
            {
                source_key: 'ai:tomato',
                canonical_name: 'tomato paste',
                display_name: 'Nightshade spread',
                food_state: 'prepared',
                identity_source: 'ai_generated',
                identity_status: 'unsourced',
                aliases: ['umami gel'],
            },
        ]);

        expect(partition.mergeable.map((merge) => merge.duplicateSourceKey)).toEqual(['usda:2']);
        expect(partition.withheld).toEqual([
            {
                loserSourceKey: 'ai:tomato',
                survivorSourceKey: 'usda:1',
                reason: 'no_retrieval_record',
                loserIdentityStatus: 'unsourced',
                aliasNamesWithheld: 2,
            },
        ]);
        expect(partition.offeredLoserIdentities).toBe(1);
        expect(partition.withheldLoserIdentities).toBe(1);
        expect(partition.withheldAliasNames).toBe(2);
    });

    /**
     * The reason a skip in the write loop would be wrong. `dedupeIdentity`
     * attributes a shared name to whichever loser it processes first, and an
     * `ai:` key sorts before a `usda:` one — so skipping the generated loser at
     * write time would drop a name the vendor loser also carried.
     */
    it('still merges a name the unsourced loser would have claimed first', () => {
        const candidates: readonly (CatalogIdentityCandidate & { identity_status: string })[] = [
            {
                source_key: 'usda:1',
                canonical_name: 'tomato paste',
                display_name: 'Tomato paste',
                food_state: 'prepared',
                identity_source: 'usda',
                identity_status: 'verified',
                aliases: [],
            },
            {
                source_key: 'usda:2',
                canonical_name: 'tomato paste',
                display_name: 'Tomato puree',
                food_state: 'prepared',
                identity_source: 'usda',
                identity_status: 'verified',
                aliases: ['tomato concentrate'],
            },
            {
                source_key: 'ai:tomato',
                canonical_name: 'tomato paste',
                display_name: 'Tomato puree',
                food_state: 'prepared',
                identity_source: 'ai_generated',
                identity_status: 'unsourced',
                aliases: ['tomato concentrate'],
            },
        ];

        // The full plan hands both shared names to the generated loser, which
        // sorts first, leaving the vendor loser with nothing to contribute.
        const fullPlan = dedupeIdentity(candidates).merges;
        expect(fullPlan.find((merge) => merge.duplicateSourceKey === 'ai:tomato')?.aliases).toEqual([
            'Tomato puree',
            'tomato concentrate',
        ]);
        expect(fullPlan.find((merge) => merge.duplicateSourceKey === 'usda:2')?.aliases).toEqual([]);

        // Planning over the sourced identities alone gives them back to the
        // vendor loser, so enabling generation changes no published alias.
        const partition = plansFor(candidates);
        expect(partition.mergeable).toEqual([
            {
                survivorSourceKey: 'usda:1',
                duplicateSourceKey: 'usda:2',
                aliases: ['Tomato puree', 'tomato concentrate'],
            },
        ]);
        expect(partition.withheldLoserIdentities).toBe(1);
    });

    it('leaves a group with no sourced member to the full plan', () => {
        const partition = plansFor([
            {
                source_key: 'ai:a',
                canonical_name: 'seitan cutlet',
                display_name: 'Seitan cutlet',
                food_state: 'prepared',
                identity_source: 'ai_generated',
                identity_status: 'unsourced',
                aliases: [],
            },
            {
                source_key: 'ai:b',
                canonical_name: 'seitan cutlet',
                display_name: 'Seitan cutlet',
                food_state: 'prepared',
                identity_source: 'ai_generated',
                identity_status: 'unsourced',
                aliases: ['gluten cutlet'],
            },
        ]);

        expect(partition.mergeable.map((merge) => merge.duplicateSourceKey)).toEqual(['ai:b']);
        expect(partition.withheld).toEqual([]);
    });

    it('withholds fail-closed when the two plans name different survivors', () => {
        const partition = plansFor([
            {
                source_key: 'usda:1',
                canonical_name: 'kelp noodle',
                display_name: 'Kelp noodle',
                food_state: 'prepared',
                identity_source: 'usda',
                identity_status: 'unsourced',
                aliases: [],
            },
            {
                source_key: 'usda:2',
                canonical_name: 'kelp noodle',
                display_name: 'Sea noodle',
                food_state: 'prepared',
                identity_source: 'usda',
                identity_status: 'verified',
                aliases: [],
            },
            {
                source_key: 'usda:3',
                canonical_name: 'kelp noodle',
                display_name: 'Ocean noodle',
                food_state: 'prepared',
                identity_source: 'usda',
                identity_status: 'verified',
                aliases: [],
            },
        ]);

        // usda:3's sourced-only survivor is usda:2, while the full plan kept
        // usda:1 — merging there would put the alias write and the
        // duplicate_identity check on different foods.
        expect(partition.withheld).toEqual([
            {
                loserSourceKey: 'usda:3',
                survivorSourceKey: 'usda:1',
                reason: 'survivor_disagreement',
                loserIdentityStatus: 'verified',
                aliasNamesWithheld: 1,
            },
        ]);
        expect(partition.mergeable.map((merge) => merge.duplicateSourceKey)).toEqual(['usda:2']);
        expect(partition.offeredLoserIdentities + partition.withheldLoserIdentities).toBe(2);
    });

    it('withholds a loser the pass\u2019s read did not return, and says that is why', () => {
        const partition = partitionAliasMerges({
            mergesOverEveryIdentity: [
                { survivorSourceKey: 'usda:1', duplicateSourceKey: 'usda:9', aliases: ['ninth name'] },
            ],
            mergesOverSourcedIdentities: [],
            identityStatusBySourceKey: new Map([['usda:1', 'verified']]),
        });

        expect(partition.withheld).toEqual([
            {
                loserSourceKey: 'usda:9',
                survivorSourceKey: 'usda:1',
                reason: 'loser_not_in_this_pass_read',
                loserIdentityStatus: null,
                aliasNamesWithheld: 1,
            },
        ]);
        expect(partition.mergeable).toEqual([]);
    });

    it('never labels a withholding an evidence judgement the pass did not make', () => {
        // A sourced loser the sourced-only plan somehow omits: the partition
        // withholds it, and names the fact (it was not planned) rather than
        // asserting the loser has no retrieval record.
        const partition = partitionAliasMerges({
            mergesOverEveryIdentity: [
                { survivorSourceKey: 'usda:1', duplicateSourceKey: 'usda:2', aliases: ['second name'] },
            ],
            mergesOverSourcedIdentities: [],
            identityStatusBySourceKey: new Map([
                ['usda:1', 'verified'],
                ['usda:2', 'verified'],
            ]),
        });

        expect(partition.withheld[0]?.reason).toBe('not_planned_over_sourced_identities');
        expect(partition.withheldByReason.no_retrieval_record).toBe(0);
    });

    it('emits the offered merges on the losing source key, so a rerun is byte-identical', () => {
        const partition = partitionAliasMerges({
            mergesOverEveryIdentity: [],
            mergesOverSourcedIdentities: [
                { survivorSourceKey: 'usda:1', duplicateSourceKey: 'usda:9', aliases: [] },
                { survivorSourceKey: 'usda:1', duplicateSourceKey: 'usda:3', aliases: [] },
            ],
            identityStatusBySourceKey: new Map(),
        });

        // Neither is in the full plan, so both disagree with it and neither is
        // offered: the fail-closed rule, and the sort is still stated below.
        expect(partition.mergeable).toEqual([]);

        const offered = partitionAliasMerges({
            mergesOverEveryIdentity: [
                { survivorSourceKey: 'usda:1', duplicateSourceKey: 'usda:9', aliases: [] },
                { survivorSourceKey: 'usda:1', duplicateSourceKey: 'usda:3', aliases: [] },
            ],
            mergesOverSourcedIdentities: [
                { survivorSourceKey: 'usda:1', duplicateSourceKey: 'usda:9', aliases: [] },
                { survivorSourceKey: 'usda:1', duplicateSourceKey: 'usda:3', aliases: [] },
            ],
            identityStatusBySourceKey: new Map([['usda:1', 'verified']]),
        });
        expect(offered.mergeable.map((merge) => merge.duplicateSourceKey)).toEqual(['usda:3', 'usda:9']);
    });

    it('generates a policy note from the figures and claims nothing beyond them', () => {
        const partition = partitionAliasMerges({
            mergesOverEveryIdentity: [
                { survivorSourceKey: 'usda:1', duplicateSourceKey: 'usda:2', aliases: ['a', 'b'] },
                { survivorSourceKey: 'usda:1', duplicateSourceKey: 'ai:z', aliases: ['c', 'd', 'e'] },
            ],
            mergesOverSourcedIdentities: [
                { survivorSourceKey: 'usda:1', duplicateSourceKey: 'usda:2', aliases: ['a', 'b'] },
            ],
            identityStatusBySourceKey: new Map([
                ['usda:1', 'verified'],
                ['usda:2', 'verified'],
                ['ai:z', 'unsourced'],
            ]),
        });

        expect(partition.policyNote).toContain('1 losing identity(ies) were offered to the merge and 1 withheld');
        expect(partition.policyNote).toContain('no_retrieval_record 1');
        expect(partition.policyNote).toContain('holding back 3 alias NAME(s)');
    });

    it('reports zeros for a catalog with no duplicate at all', () => {
        const partition = partitionAliasMerges({
            mergesOverEveryIdentity: [],
            mergesOverSourcedIdentities: [],
            identityStatusBySourceKey: new Map(),
        });

        expect(partition.mergeable).toEqual([]);
        expect(partition.withheld).toEqual([]);
        expect(partition.withheldByReason).toEqual({
            loser_not_in_this_pass_read: 0,
            no_retrieval_record: 0,
            not_planned_over_sourced_identities: 0,
            survivor_disagreement: 0,
        });
        expect(partition.policyNote).toContain('0 losing identity(ies) were offered to the merge and 0 withheld');
    });
});

/* ---------------------------------------------------------------------------
 * The duplicate-identity accounting (scripts/catalog-validate.ts).
 * ------------------------------------------------------------------------- */

/**
 * A partition of `offered` sourced losers and `withheld` unsourced ones, built
 * by the real policy rather than hand-written, so the accounting fixtures below
 * consume the same object the script passes it.
 */
const aliasMergeFor = (offered: number, withheld: number, aliasNamesEach = 1): AliasMergePartition => {
    const names = (label: string, index: number): string[] =>
        Array.from({ length: aliasNamesEach }, (_unused, name) => `${label} ${String(index)} ${String(name)}`);
    const mergesOverEveryIdentity = [
        ...Array.from({ length: offered }, (_unused, index) => ({
            survivorSourceKey: 'usda:survivor',
            duplicateSourceKey: `usda:offered-${String(index)}`,
            aliases: names('offered', index),
        })),
        ...Array.from({ length: withheld }, (_unused, index) => ({
            survivorSourceKey: 'usda:survivor',
            duplicateSourceKey: `ai:withheld-${String(index)}`,
            aliases: names('withheld', index),
        })),
    ];
    const identityStatusBySourceKey = new Map<string, string>([['usda:survivor', 'verified']]);
    for (const merge of mergesOverEveryIdentity) {
        identityStatusBySourceKey.set(
            merge.duplicateSourceKey,
            merge.duplicateSourceKey.startsWith('ai:') ? 'unsourced' : 'verified',
        );
    }

    return partitionAliasMerges({
        mergesOverEveryIdentity,
        mergesOverSourcedIdentities: mergesOverEveryIdentity.filter(
            (merge) => identityStatusBySourceKey.get(merge.duplicateSourceKey) !== 'unsourced',
        ),
        identityStatusBySourceKey,
    });
};

describe('buildDuplicateIdentityAccounting', () => {
    /**
     * The release-v1 shape the review found conflated: 117 losing identities,
     * 107 of them newly quarantined, ten already quarantined before the pass,
     * and two alias ROWS inserted from two losing identities.
     */
    const releaseShape = () => {
        const loserSourceKeys = Array.from({ length: 117 }, (_unused, index) => `usda:${String(index)}`);
        const statusBefore = new Map<string, string>();
        loserSourceKeys.forEach((sourceKey, index) => {
            statusBefore.set(sourceKey, index < 10 ? 'quarantined' : 'candidate');
        });

        return buildDuplicateIdentityAccounting({
            loserSourceKeys,
            statusBeforeThisRunBySourceKey: statusBefore,
            consideredSourceKeys: new Set(loserSourceKeys),
            judgedByStatus: { quarantined: 117 },
            quarantinedForDuplicateIdentity: 107,
            losersContributingAliasRows: 2,
            survivorsReceivingAliasRows: 2,
            aliasRowsInserted: 2,
            survivorValidationRecordsRestated: 2,
            aliasMerge: aliasMergeFor(117, 0),
            dryRun: false,
        });
    };

    it('keeps the three units apart instead of mixing them into one figure', () => {
        const accounting = releaseShape();

        expect(accounting.lostIdentitiesTotal).toBe(117);
        expect(accounting.lostIdentitiesNewlyQuarantinedForDuplicateIdentity).toBe(107);
        expect(accounting.aliasRowsInserted).toBe(2);
        expect(accounting.lostIdentitiesContributingAliasRows).toBe(2);
        expect(accounting.survivorValidationRecordsRestated).toBe(2);
    });

    it('classifies the residue by the status it already held rather than leaving it to subtraction', () => {
        const accounting = releaseShape();

        expect(accounting.lostIdentitiesByStatusBeforeThisRun).toEqual({ quarantined: 10, candidate: 107 });
        expect(accounting.lostIdentitiesAlreadyWithheldBeforeThisRun).toBe(10);
    });

    it('states what the alias policy offered and what it withheld, in identities and in names', () => {
        const accounting = buildDuplicateIdentityAccounting({
            loserSourceKeys: ['usda:offered-0', 'ai:withheld-0', 'ai:withheld-1'],
            statusBeforeThisRunBySourceKey: new Map([
                ['usda:offered-0', 'candidate'],
                ['ai:withheld-0', 'candidate'],
                ['ai:withheld-1', 'candidate'],
            ]),
            consideredSourceKeys: new Set(['usda:offered-0', 'ai:withheld-0', 'ai:withheld-1']),
            judgedByStatus: { quarantined: 3 },
            quarantinedForDuplicateIdentity: 3,
            losersContributingAliasRows: 1,
            survivorsReceivingAliasRows: 1,
            aliasRowsInserted: 1,
            survivorValidationRecordsRestated: 1,
            aliasMerge: aliasMergeFor(1, 2, 3),
            dryRun: false,
        });

        expect(accounting.lostIdentitiesOfferedToAliasMerge).toBe(1);
        expect(accounting.lostIdentitiesWithheldFromAliasMerge).toBe(2);
        expect(accounting.lostIdentitiesWithheldFromAliasMergeByReason).toEqual({
            loser_not_in_this_pass_read: 0,
            no_retrieval_record: 2,
            not_planned_over_sourced_identities: 0,
            survivor_disagreement: 0,
        });
        // NAMES, not rows: two withheld identities carrying three names each.
        expect(accounting.aliasNamesWithheldFromMerge).toBe(6);
        expect(accounting.aliasMergeWithheldIdentities.map((entry) => entry.loserSourceKey)).toEqual([
            'ai:withheld-0',
            'ai:withheld-1',
        ]);
        expect(accounting.aliasMergeWithheldIdentitiesOmittedByCap).toBe(0);
        expect(accounting.reconciliation.aliasMergeOfferedPlusWithheldEqualsTotal).toBe(true);
        expect(accounting.reconciliation.aliasContributorsNoMoreThanOffered).toBe(true);
        expect(accounting.reconciliation.everyCheckHolds).toBe(true);
        expect(accounting.unitsNote).toContain('a NAME is one alias the dedupe planned to offer');
        expect(accounting.note).toContain('1 losing identity(ies) were offered to the merge and 2 withheld');
    });

    it('fails reconciliation when the offered and withheld halves do not cover the loser set', () => {
        const accounting = buildDuplicateIdentityAccounting({
            loserSourceKeys: ['usda:1', 'usda:2', 'usda:3'],
            statusBeforeThisRunBySourceKey: new Map([
                ['usda:1', 'candidate'],
                ['usda:2', 'candidate'],
                ['usda:3', 'candidate'],
            ]),
            consideredSourceKeys: new Set(['usda:1', 'usda:2', 'usda:3']),
            judgedByStatus: { quarantined: 3 },
            quarantinedForDuplicateIdentity: 3,
            losersContributingAliasRows: 0,
            survivorsReceivingAliasRows: 0,
            aliasRowsInserted: 0,
            survivorValidationRecordsRestated: 0,
            aliasMerge: aliasMergeFor(1, 0),
            dryRun: false,
        });

        expect(accounting.reconciliation.aliasMergeOfferedPlusWithheldEqualsTotal).toBe(false);
        expect(accounting.reconciliation.everyCheckHolds).toBe(false);
    });

    it('reconciles: the statuses sum to the total and every check holds', () => {
        const accounting = releaseShape();

        expect(accounting.reconciliation.statusesBeforeThisRunSumToTotal).toBe(true);
        expect(accounting.reconciliation.consideredPlusNotConsideredEqualsTotal).toBe(true);
        expect(accounting.reconciliation.everyCheckHolds).toBe(true);
        expect(accounting.reconciliation.statement).toContain('117 lost identity(ies)');
    });

    it('generates a note stating each figure in its own unit', () => {
        const note = releaseShape().note;

        expect(note).toContain('117 identity(ies) lost the identity dedupe');
        expect(note).toContain('107 of them were quarantined by this pass with a failing duplicate_identity check');
        expect(note).toContain('10 were already being withheld');
        expect(note).toContain('2 alias row(s) were inserted from 2 losing identity(ies)');
        expect(note).not.toContain('lost identities were merged as aliases');
    });

    it('files a loser this pass never read under its own bucket rather than a guessed status', () => {
        const accounting = buildDuplicateIdentityAccounting({
            loserSourceKeys: ['usda:1', 'usda:2'],
            statusBeforeThisRunBySourceKey: new Map([['usda:1', 'candidate']]),
            consideredSourceKeys: new Set(['usda:1']),
            judgedByStatus: { quarantined: 1 },
            quarantinedForDuplicateIdentity: 1,
            losersContributingAliasRows: 0,
            survivorsReceivingAliasRows: 0,
            aliasRowsInserted: 0,
            survivorValidationRecordsRestated: 0,
            aliasMerge: aliasMergeFor(1, 1),
            dryRun: false,
        });

        expect(accounting.lostIdentitiesByStatusBeforeThisRun).toEqual({
            candidate: 1,
            not_in_this_pass_read: 1,
        });
        expect(accounting.lostIdentitiesConsideredByThisRun).toBe(1);
        expect(accounting.lostIdentitiesNotConsideredByThisRun).toBe(1);
        expect(accounting.reconciliation.everyCheckHolds).toBe(true);
    });

    it('reports a loser this pass quarantined for another reason without counting it as a duplicate quarantine', () => {
        const accounting = buildDuplicateIdentityAccounting({
            loserSourceKeys: ['usda:1', 'usda:2'],
            statusBeforeThisRunBySourceKey: new Map([
                ['usda:1', 'candidate'],
                ['usda:2', 'candidate'],
            ]),
            consideredSourceKeys: new Set(['usda:1', 'usda:2']),
            judgedByStatus: { quarantined: 2 },
            quarantinedForDuplicateIdentity: 1,
            losersContributingAliasRows: 0,
            survivorsReceivingAliasRows: 0,
            aliasRowsInserted: 0,
            survivorValidationRecordsRestated: 0,
            aliasMerge: aliasMergeFor(2, 0),
            dryRun: false,
        });

        expect(accounting.lostIdentitiesJudgedByThisRunByStatus).toEqual({ quarantined: 2 });
        expect(accounting.lostIdentitiesNewlyQuarantinedForDuplicateIdentity).toBe(1);
        expect(accounting.reconciliation.quarantinedForDuplicateIdentityNoMoreThanQuarantined).toBe(true);
    });

    it('fails its own reconciliation rather than hiding a figure that cannot be right', () => {
        const accounting = buildDuplicateIdentityAccounting({
            loserSourceKeys: ['usda:1'],
            statusBeforeThisRunBySourceKey: new Map([['usda:1', 'candidate']]),
            consideredSourceKeys: new Set(['usda:1']),
            judgedByStatus: { quarantined: 1 },
            quarantinedForDuplicateIdentity: 2,
            losersContributingAliasRows: 4,
            survivorsReceivingAliasRows: 1,
            aliasRowsInserted: 9,
            survivorValidationRecordsRestated: 1,
            aliasMerge: aliasMergeFor(1, 0),
            dryRun: false,
        });

        expect(accounting.reconciliation.quarantinedForDuplicateIdentityNoMoreThanQuarantined).toBe(false);
        expect(accounting.reconciliation.aliasContributorsNoMoreThanTotal).toBe(false);
        expect(accounting.reconciliation.everyCheckHolds).toBe(false);
    });

    it('says plainly that a dry run\u2019s write-side figures are zero by construction', () => {
        const accounting = buildDuplicateIdentityAccounting({
            loserSourceKeys: ['usda:1'],
            statusBeforeThisRunBySourceKey: new Map([['usda:1', 'candidate']]),
            consideredSourceKeys: new Set(['usda:1']),
            judgedByStatus: {},
            quarantinedForDuplicateIdentity: 0,
            losersContributingAliasRows: 0,
            survivorsReceivingAliasRows: 0,
            aliasRowsInserted: 0,
            survivorValidationRecordsRestated: 0,
            aliasMerge: aliasMergeFor(1, 0),
            dryRun: true,
        });

        expect(accounting.note).toContain('dry run');
        expect(accounting.lostIdentitiesJudgedByThisRun).toBe(0);
        expect(accounting.reconciliation.everyCheckHolds).toBe(true);
    });

    it('reports zeros for a catalog with no duplicate at all', () => {
        const accounting = buildDuplicateIdentityAccounting({
            loserSourceKeys: [],
            statusBeforeThisRunBySourceKey: new Map(),
            consideredSourceKeys: new Set(),
            judgedByStatus: {},
            quarantinedForDuplicateIdentity: 0,
            losersContributingAliasRows: 0,
            survivorsReceivingAliasRows: 0,
            aliasRowsInserted: 0,
            survivorValidationRecordsRestated: 0,
            aliasMerge: aliasMergeFor(0, 0),
            dryRun: false,
        });

        expect(accounting.lostIdentitiesTotal).toBe(0);
        expect(accounting.lostIdentitiesByStatusBeforeThisRun).toEqual({});
        expect(accounting.reconciliation.everyCheckHolds).toBe(true);
        expect(accounting.note).toContain('0 identity(ies) lost the identity dedupe');
    });
});
