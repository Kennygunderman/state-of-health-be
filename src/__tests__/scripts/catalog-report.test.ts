/**
 * The evidence stage's judgements: `scripts/catalog-report.ts`, plus the
 * duplicate-identity accounting `scripts/catalog-validate.ts` publishes and the
 * stored-assumptions decoder both stages read that column through
 * (`scripts/lib/nutritionAssumptions.ts`).
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
 * `parseStoredAssumptions` is pinned here for the same reason: it is the one
 * rule the validate and report stages both decode
 * `catalog_validation_records.nutrition_assumptions` with, and `toItemRecord`
 * puts its result on every published item's record — so the assumptions a
 * report states and the assumptions a row carries can only agree if this
 * decoder answers to the encoder. Its cases are the values the column can
 * actually hold: absent, empty, a written array, and text no writer here would
 * have produced.
 *
 * WHY IT IS DATABASE-FREE. Everything asserted here is a pure function taking
 * its measurement as an argument (Rule backend-architecture §7, §11): the
 * scan, the file writes and the reconciliation are the stage's I/O and are
 * exercised by running the real producer against a database, which is not
 * something a unit test may do. Nothing is mocked, because there is nothing to
 * mock — the inputs are plain data.
 *
 * WHY THE `catalog-validate` HELPER IS PINNED HERE. `buildDuplicateIdentityAccounting`
 * belongs to the validate stage but is pure evidence-shaping code, and this
 * file is the database-free home for the evidence artefacts' pure judgements.
 * `src/__tests__/scripts/catalog-validate.test.ts` is the PostgreSQL-backed
 * suite for that stage's unit of work, its resume accounting and its log
 * volume — a rolled-back transaction is its mechanism, and an accounting
 * function that takes its figures as arguments would pay for a database it
 * never reaches. Its import is the same relative import
 * `catalog-import.test.ts` already uses for that module.
 *
 * Jest's `roots` is `<rootDir>/src` (jest.config.ts), so a test under
 * `scripts/` would never be collected; the relative imports into `scripts/` are
 * the consequence of that, not a choice.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

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
    CatalogReportError,
    assertRecognisedStoredValues,
    buildCoverageRows,
    buildImportReportEntries,
    buildRequirementBlock,
    buildWithheldIdentityAudit,
    canonicalReportDirectory,
    defaultReportIo,
    generatedContentPresence,
    measureCatalog,
    notApplicableChecksForItem,
    perCategoryByStatus,
    pruneSupersededKeys,
    publicationDirectoryDriftRefusal,
    publicationDirectoryReplacedRefusal,
    publishedItemFacts,
    quoteStoredValue,
    resolveReportOutputDirectory,
    runReport,
    supersededKeyPaths,
    toItemRecord,
    toQuarantinedIdentity,
    unrecognisedStoredValuesOfRow,
} from '../../../scripts/catalog-report';
import type {
    CatalogMeasurement,
    CategoryMeasurement,
    PublishedItemFacts,
    ReportDb,
    ReportFoodRow,
    ReportIo,
    ReportOutcome,
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
import { parseStoredAssumptions } from '../../../scripts/lib/nutritionAssumptions';
import type { CatalogValidationVerdict } from '../../../src/services/catalog.logic';
import type { CatalogValidationCheck } from '../../../src/types/catalog';
import {
    AGGREGATE_ASSERTIONS_NO_STAGE_WRITES,
    AGGREGATE_ASSERTIONS_THE_OWNER_REWRITES,
    AGGREGATE_OWNED_ASSERTION_KEYS,
    AGGREGATE_OWNED_ASSERTION_SUB_KEYS,
    ManifestError,
    loadCoveragePlan,
    loadEvidenceAllowlist,
    mergeStageReport,
    physicalPathIdentity,
    withArtifactPublicationLock,
} from '../../../scripts/lib/manifest';
import type { CoveragePlan } from '../../../scripts/lib/manifest';
import type { ScriptLogger } from '../../../scripts/lib/logger';

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
    unrecognisedStoredValues: [],
    unrecognisedStoredValueCount: 0,
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

describe('parseStoredAssumptions', () => {
    describe('a record that states no assumptions', () => {
        it('reads a null column as an empty list', () => {
            expect(parseStoredAssumptions(null)).toEqual([]);
        });

        it('reads an unselected column as an empty list', () => {
            expect(parseStoredAssumptions(undefined)).toEqual([]);
        });

        it('reads an empty string as an empty list', () => {
            expect(parseStoredAssumptions('')).toEqual([]);
        });

        it('reads a whitespace-only value as an empty list', () => {
            expect(parseStoredAssumptions('   \n\t ')).toEqual([]);
        });
    });

    describe('a record that states assumptions', () => {
        it('returns the stored strings in the order the writing stage encoded them', () => {
            const written = ['density assumed from a like food', 'portion estimated'];

            expect(parseStoredAssumptions(JSON.stringify(written))).toEqual(written);
        });

        it('returns an empty list for a written array that holds nothing', () => {
            expect(parseStoredAssumptions('[]')).toEqual([]);
        });

        it('drops the entries that are not strings rather than carrying them forward', () => {
            const encoded = '["density assumed",7,null,{"assumption":"nested"},["nested"],"portion estimated"]';

            expect(parseStoredAssumptions(encoded)).toEqual(['density assumed', 'portion estimated']);
        });

        it('returns an empty list for an array in which no entry is a string', () => {
            expect(parseStoredAssumptions('[1,2,null]')).toEqual([]);
        });
    });

    describe('a value no writer of the column would have produced', () => {
        it('drops JSON that parses to an object', () => {
            expect(parseStoredAssumptions('{"assumption":"density assumed"}')).toEqual([]);
        });

        it('drops JSON that parses to a number', () => {
            expect(parseStoredAssumptions('7')).toEqual([]);
        });

        it('drops a quoted string rather than reading the text as one assumption', () => {
            expect(parseStoredAssumptions('"density assumed from a like food"')).toEqual([]);
        });

        it('drops JSON that parses to null', () => {
            expect(parseStoredAssumptions('null')).toEqual([]);
        });

        it('drops malformed JSON rather than carrying the raw text forward', () => {
            expect(parseStoredAssumptions('["density assumed"')).toEqual([]);
            expect(parseStoredAssumptions('density assumed from a like food')).toEqual([]);
        });
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

    it('states the stored assumptions as the list they were encoded from', () => {
        const encoded = JSON.stringify(['density assumed from a like food']);
        const item = toItemRecord(row, { ...record, nutrition_assumptions: encoded });

        expect(item.nutritionAssumptions).toEqual(['density assumed from a like food']);
        expect(toItemRecord(row, record).nutritionAssumptions).toEqual([]);
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

    // A withheld identity that states only the NAME of what failed cannot be
    // triaged from committed evidence. These pin the judgement data beside it,
    // and the per-entry agreement between the two.
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

    // assertionSubKeysArePruned: the two removal lists have to agree.
    //
    // `mergeStageReport` drops an aggregate-owned SUB-KEY from any write that
    // does not supply it, but `mergeProducedBy` merges the existing block into
    // this stage's payload — so a sub-key this stage did not prune arrives as
    // one it supplies and is exempted from that drop. Pinning every path in
    // AGGREGATE_OWNED_ASSERTION_SUB_KEYS onto this stage's own prune list is
    // what stops the aggregate stage from being the one writer that keeps a
    // claim nothing measures alive.
    it('prunes every aggregate-owned sub-key the stage merge would otherwise let it re-supply', () => {
        const assertionSubKeyPaths = Object.entries(AGGREGATE_OWNED_ASSERTION_SUB_KEYS).flatMap(([block, keys]) =>
            keys.map((key) => `${block}.${key}`),
        );

        expect(assertionSubKeyPaths.length).toBeGreaterThan(0);
        for (const path of assertionSubKeyPaths) {
            expect(supersededKeyPaths()).toContain(path);
        }
    });
});

/* ---------------------------------------------------------------------------
 * AGGREGATE-OWNED ASSERTIONS ACROSS A STAGE MERGE.
 *
 * THE DEFECT THESE PIN. `mergeStageReport` preserves every top-level key the
 * writing stage does not write, which is right for another stage's COUNTER and
 * wrong for a key that asserts something about the whole document. The
 * committed v1 import report carried three such keys that had outlived the
 * write that produced them and contradicted the figures beside them: an
 * `aggregatedRunKinds` entry saying the generation run never ran, in a document
 * whose own `stage` was that run with 502 processed batches and 159 metered
 * calls; a `measurementGaps` entry saying the USDA counters were unmeasured and
 * citing two keys that no longer exist, beside a block measuring 478 attempts
 * and 426 pauses; and another saying the per-category quarantine split was
 * unrecoverable, beside the measured split.
 *
 * `pruneSupersededKeys` above is the aggregate stage's mechanism for a claim it
 * supersedes inside a block it rewrites. These cases are the other half: the
 * merge itself must not carry an aggregate assertion past the write that
 * produced it, whichever stage lands next.
 * ------------------------------------------------------------------------- */

describe('aggregate-owned assertions do not outlive the write that produced them', () => {
    /** The five keys the committed artefact carried, in their real shapes. */
    const aggregateAssertions = (): Record<string, unknown> => ({
        producedBy: {
            stageFieldsCommand: 'npm run catalog:import',
            aggregateFieldsCommand: 'npm run catalog:report',
            aggregatedRunKinds: [
                { kind: 'catalog-import-usda', ran: true, runId: '914bb617' },
                { kind: 'catalog-generate-ai', ran: false, runId: null, reason: 'No generation run exists.' },
            ],
        },
        measurementGaps: [{ field: 'categories[].quarantined', value: null, reason: 'not recoverable' }],
        aggregateMeasurementGaps: [{ field: 'per-run counters', value: null, reason: 'a run in progress' }],
        // The two the regenerated pipeline surfaced: an aggregation timestamp
        // no stage writes, and a data-type census contradicted by the very file
        // it names as its source.
        aggregatedAt: '2026-09-15T04:16:12.000Z',
        usdaDataTypes: {
            Foundation: 231,
            'SR Legacy': 6246,
            'Survey (FNDDS)': 4569,
            Branded: 0,
            measuredFrom: 'catalog/releases/v1/foods.jsonl usda_data_type',
        },
        counts: { planned: 10003, inserted: 10003 },
        usdaRequests: { attempts: 478, pauses: 426 },
    });

    /** Every dropped path, in the sorted order the merge reports them. */
    const everyAssertionPath = [
        'aggregateMeasurementGaps',
        'aggregatedAt',
        'measurementGaps',
        'producedBy.aggregatedRunKinds',
        'usdaDataTypes',
    ];

    it('declares the keys it will not preserve, and names no counter among them', () => {
        expect(AGGREGATE_OWNED_ASSERTION_KEYS).toEqual([
            'aggregateMeasurementGaps',
            'aggregatedAt',
            'measurementGaps',
            'usdaDataTypes',
        ]);
        expect(AGGREGATE_OWNED_ASSERTION_SUB_KEYS).toEqual({ producedBy: ['aggregatedRunKinds'] });

        // The same guarantee `supersededKeyPaths` gives: a measurement no other
        // stage can reproduce is never on a removal list.
        const named = [
            ...AGGREGATE_OWNED_ASSERTION_KEYS,
            ...Object.entries(AGGREGATE_OWNED_ASSERTION_SUB_KEYS).flatMap(([block, keys]) =>
                keys.map((key) => `${block}.${key}`),
            ),
        ];
        for (const path of named) {
            expect(path).not.toContain('counts');
            expect(path).not.toContain('usdaRequests');
            expect(path).not.toContain('modelSpend');
            expect(path).not.toContain('aiGenerationCounts');
        }
    });

    it('drops them on a generation write, which is the merge that stranded them', () => {
        // The exact sequence that produced the committed artefact: the report
        // stage ran, then the generation stage wrote its own stage fields and
        // carried the aggregates forward verbatim.
        const merge = mergeStageReport(
            aggregateAssertions(),
            { stage: 'catalog-generate-ai', processedBatches: 502, aiGenerationCounts: { modelCallsUsed: 159 } },
            { noteKey: 'generationStageWrite', stage: 'catalog-generate-ai' },
        );

        expect(merge.document).not.toHaveProperty('measurementGaps');
        expect(merge.document).not.toHaveProperty('aggregateMeasurementGaps');
        expect(merge.document).not.toHaveProperty('aggregatedAt');
        expect(merge.document).not.toHaveProperty('usdaDataTypes');
        expect(merge.document.producedBy).not.toHaveProperty('aggregatedRunKinds');
        expect(merge.droppedAggregateAssertions).toEqual(everyAssertionPath);

        // Every other key survives byte for byte — the point of a named list
        // rather than a wipe.
        expect(merge.document.counts).toEqual({ planned: 10003, inserted: 10003 });
        expect(merge.document.usdaRequests).toEqual({ attempts: 478, pauses: 426 });
        expect(merge.document.producedBy).toEqual({
            stageFieldsCommand: 'npm run catalog:import',
            aggregateFieldsCommand: 'npm run catalog:report',
        });
        // And they are not also claimed as preserved: a key cannot be both.
        expect(merge.preservedKeys).not.toContain('measurementGaps');
        expect(merge.preservedKeys).not.toContain('aggregateMeasurementGaps');
    });

    it('drops them on an import write too, so the next report starts from measured ground', () => {
        const merge = mergeStageReport(
            aggregateAssertions(),
            { stage: 'catalog-import-usda', counts: { planned: 11300 } },
            { noteKey: 'importStageWrite', stage: 'catalog-import-usda' },
        );

        expect(merge.document).not.toHaveProperty('measurementGaps');
        expect(merge.document.producedBy).not.toHaveProperty('aggregatedRunKinds');
        // An import changes the very rows the aggregates describe, so the
        // claim cannot survive it whatever it said.
        expect(merge.document.counts).toEqual({ planned: 11300 });
    });

    it('records the removal and the one command that puts it back', () => {
        const merge = mergeStageReport(
            aggregateAssertions(),
            { counts: { planned: 11300 } },
            { noteKey: 'importStageWrite', stage: 'catalog-import-usda' },
        );
        const note = merge.document.importStageWrite as Record<string, unknown>;

        expect(note.droppedAggregateAssertions).toEqual(everyAssertionPath);
        expect(String(note.droppedAggregateAssertionsReason)).toContain('npm run catalog:report');
        expect(String(note.basis)).toContain('aggregate assertion');
    });

    it('keeps the aggregate assertions the landing write supplies itself', () => {
        // The report stage's own write: it measures these keys, so they are
        // replaced by the fresh values and nothing is dropped. This is what
        // makes the rule "only as of the write that produced it" rather than
        // "the report stage may never state them".
        const merge = mergeStageReport(
            aggregateAssertions(),
            {
                aggregateMeasurementGaps: [{ field: 'the cause of any per-category shortfall', value: null }],
                requirement: { publishedItems: 10461 },
            },
            { noteKey: 'reportStageWrite', stage: 'catalog-report' },
        );

        expect(merge.document.aggregateMeasurementGaps).toEqual([
            { field: 'the cause of any per-category shortfall', value: null },
        ]);
        // The two it did not write are still gone: an unwritten aggregate
        // assertion is unbacked whoever the writer is.
        expect(merge.document).not.toHaveProperty('measurementGaps');
        expect(merge.document.producedBy).not.toHaveProperty('aggregatedRunKinds');
        expect(merge.droppedAggregateAssertions).toEqual([
            'aggregatedAt',
            'measurementGaps',
            'producedBy.aggregatedRunKinds',
            'usdaDataTypes',
        ]);
    });

    it('says nothing about a document that never carried one', () => {
        const merge = mergeStageReport(
            { counts: { planned: 1 }, producedBy: { stageFieldsCommand: 'npm run catalog:import' } },
            { counts: { planned: 2 } },
            { noteKey: 'importStageWrite', stage: 'catalog-import-usda' },
        );

        expect(merge.droppedAggregateAssertions).toEqual([]);
        const note = merge.document.importStageWrite as Record<string, unknown>;
        expect(note.droppedAggregateAssertionsReason).toBeNull();
        // The block is untouched, not rebuilt: a rerun still diffs as
        // unchanged.
        expect(merge.document.producedBy).toEqual({ stageFieldsCommand: 'npm run catalog:import' });
        expect(merge.preservedKeys).toEqual(['producedBy']);
    });

    it('removes the two assertions no stage writes, because nothing can refresh them', () => {
        // `aggregatedAt` and `usdaDataTypes` are not merely stale: no current
        // stage emits either, so a merge that preserved them would carry a
        // claim that can never be re-measured. The regenerated pipeline
        // measured both contradictions directly — an aggregation timestamp
        // three days older than the stage write beside it, and a data-type
        // census of 11,046 rows naming a foods.jsonl that holds 10,928.
        const merge = mergeStageReport(
            aggregateAssertions(),
            {
                stage: 'catalog-import-usda',
                generatedAt: '2026-09-18T16:56:31.888Z',
                counts: { planned: 12057, inserted: 12057 },
            },
            { noteKey: 'importStageWrite', stage: 'catalog-import-usda' },
        );

        expect(merge.document).not.toHaveProperty('aggregatedAt');
        expect(merge.document).not.toHaveProperty('usdaDataTypes');
        expect(merge.droppedAggregateAssertions).toContain('aggregatedAt');
        expect(merge.droppedAggregateAssertions).toContain('usdaDataTypes');
        expect(merge.preservedKeys).not.toContain('aggregatedAt');
        expect(merge.preservedKeys).not.toContain('usdaDataTypes');
        // The write's own fields land, and the counters another stage measured
        // are still untouched: removal is scoped to the named assertions.
        expect(merge.document.generatedAt).toBe('2026-09-18T16:56:31.888Z');
        expect(merge.document.usdaRequests).toEqual({ attempts: 478, pauses: 426 });
    });

    it('hands a removed assertion back to the stage that starts measuring it', () => {
        // The rule is about a claim outliving its write, not about which stage
        // may make it: a write that SUPPLIES `usdaDataTypes` keeps it, so a
        // later revision can adopt the key by measuring it and nothing here
        // has to change.
        const merge = mergeStageReport(
            aggregateAssertions(),
            {
                stage: 'catalog-import-usda',
                usdaDataTypes: { Foundation: 231, 'SR Legacy': 6237, 'Survey (FNDDS)': 4460, Branded: 0 },
            },
            { noteKey: 'importStageWrite', stage: 'catalog-import-usda' },
        );

        expect(merge.document.usdaDataTypes).toEqual({
            Foundation: 231,
            'SR Legacy': 6237,
            'Survey (FNDDS)': 4460,
            Branded: 0,
        });
        expect(merge.droppedAggregateAssertions).not.toContain('usdaDataTypes');
        // And the ones it did not supply are still removed.
        expect(merge.droppedAggregateAssertions).toContain('aggregatedAt');
    });

    it('leaves a producedBy that is not an object alone rather than guessing at it', () => {
        const merge = mergeStageReport(
            { producedBy: 'npm run catalog:report', measurementGaps: [] },
            { counts: { planned: 2 } },
            { noteKey: 'importStageWrite', stage: 'catalog-import-usda' },
        );

        expect(merge.document.producedBy).toBe('npm run catalog:report');
        expect(merge.droppedAggregateAssertions).toEqual(['measurementGaps']);
    });

    /**
     * THE CLASSIFICATION IS MEASURED, NOT DECLARED.
     *
     * The note's sentence promises that `npm run catalog:report` puts the keys
     * in `AGGREGATE_ASSERTIONS_THE_OWNER_REWRITES` back and that the ones in
     * `AGGREGATE_ASSERTIONS_NO_STAGE_WRITES` stay absent. That promise is only
     * true if the report stage's REAL write matches it, so the payload here is
     * the one `buildImportReportEntries` produces rather than a hand-authored
     * object: a key on the wrong list fails this case instead of shipping as a
     * false promise inside the committed artefact. It was on the wrong list
     * once — `measurementGaps` is written into `validation-report.json` and
     * `producedBy.aggregatedRunKinds` into nothing at all, while the note
     * claimed both were re-derived into this document.
     */
    it('puts back exactly the assertions its classification says it owns', () => {
        const existing = aggregateAssertions();
        const published = { produce_vegetable: 1400, spice_herb: 49 };
        const shortfall = computeCoverageShortfall(policy(), published);
        const measured = measurement({
            publishedByCategory: published,
            byPublicationStatus: { published: 1449 },
        });
        const rows = buildCoverageRows(policy(), plan(), measured, shortfall);
        const written = Object.fromEntries(
            buildImportReportEntries({
                measurement: measured,
                shortfall,
                rows,
                requirement: buildRequirementBlock({
                    plan: plan(),
                    measurement: measured,
                    shortfall,
                    rows,
                    scopedTo: null,
                }),
                quarantine: { total: 0, perCategory: {} },
                itemRecords: 1449,
                publishedRowsMeasured: 1449,
                validationReportRelativePath: 'data/meal-planning/reports/latest/validation-report.json',
                scopedTo: null,
                existing,
            }),
        );

        const merge = mergeStageReport(existing, written, { noteKey: 'reportStageWrite', stage: 'catalog-report' });
        const note = merge.document.reportStageWrite as Record<string, unknown>;

        // Every key the note credits to the owner command survives the owner
        // command's own write, because that write supplies it.
        for (const key of AGGREGATE_ASSERTIONS_THE_OWNER_REWRITES) {
            expect(merge.document).toHaveProperty(key);
            expect(merge.droppedAggregateAssertions).not.toContain(key);
        }
        // Every key the note says nothing writes here is gone after it —
        // including the sub-key, which `mergeProducedBy` would otherwise carry
        // into this write's payload and so exempt from removal.
        // `toHaveProperty` reads the dotted entries as paths, which is exactly
        // the shape a sub-key assertion is recorded under.
        for (const key of AGGREGATE_ASSERTIONS_NO_STAGE_WRITES) {
            expect(merge.document).not.toHaveProperty(key);
        }
        // And each removal is recorded, in whichever of the two audit trails
        // performed it: the merge note for the top-level keys, and this
        // stage's own aggregateFieldsSuperseded list for a sub-key it prunes
        // out of a block it rewrites.
        for (const key of AGGREGATE_ASSERTIONS_NO_STAGE_WRITES.filter((name) => !name.includes('.'))) {
            expect(merge.droppedAggregateAssertions).toContain(key);
        }
        const producedBy = merge.document.producedBy as Record<string, unknown>;
        expect(producedBy.aggregateFieldsSuperseded).toContain('producedBy.aggregatedRunKinds');
        // Between them the two lists account for every assertion the merge can
        // remove, so a sixth key cannot be added to the removal lists and left
        // out of the sentence.
        expect([...AGGREGATE_ASSERTIONS_THE_OWNER_REWRITES, ...AGGREGATE_ASSERTIONS_NO_STAGE_WRITES].sort()).toEqual(
            everyAssertionPath,
        );
        // And the sentence states the one reason that is not "no stage writes
        // it": the document that does own `measurementGaps`.
        expect(String(note.droppedAggregateAssertionsReason)).toContain('npm run catalog:report');
        expect(String(note.droppedAggregateAssertionsReason)).toContain(
            'measurementGaps is written by npm run catalog:report into validation-report.json',
        );
    });

    /**
     * A PARENT WHOSE CHILD WAS PRUNED IS NOT PRESERVED.
     *
     * `preservedKeys` is "top-level keys this write left exactly as it found
     * them", and a sub-key drop is recorded as `producedBy.aggregatedRunKinds`,
     * which never equals the top-level `producedBy`. The committed v1 artefact
     * shows the consequence: `importStageWrite.preservedKeys` named
     * `producedBy` in the same note whose `droppedAggregateAssertions` named
     * its sub-key.
     */
    it('names a block it pruned as modified instead of claiming it preserved', () => {
        const policy = { noteKey: 'importStageWrite', stage: 'catalog-import-usda' } as const;
        const written = { stage: 'catalog-import-usda', counts: { planned: 12057 } };
        const merge = mergeStageReport(aggregateAssertions(), written, policy);
        const note = merge.document.importStageWrite as Record<string, unknown>;

        expect(merge.droppedAggregateAssertions).toContain('producedBy.aggregatedRunKinds');
        expect(merge.blocksModifiedByAssertionRemoval).toEqual(['producedBy']);
        expect(note.blocksModifiedByAssertionRemoval).toEqual(['producedBy']);
        expect(merge.preservedKeys).not.toContain('producedBy');
        expect(note.preservedKeys).not.toContain('producedBy');
        // The block is modified, not dropped: every sub-key another stage owns
        // is still there, which is why the block-level name is needed at all.
        expect(merge.document.producedBy).toEqual({
            stageFieldsCommand: 'npm run catalog:import',
            aggregateFieldsCommand: 'npm run catalog:report',
        });

        // A block with nothing to prune is still preserved, so the new
        // exclusion narrows only what it should.
        const untouched = mergeStageReport(
            { producedBy: { stageFieldsCommand: 'npm run catalog:import' }, counts: { planned: 1 } },
            { counts: { planned: 2 } },
            policy,
        );
        expect(untouched.blocksModifiedByAssertionRemoval).toEqual([]);
        expect(untouched.preservedKeys).toEqual(['producedBy']);

        // And the property the removal rests on: once the prune has happened
        // there is nothing left to remove, so a rerun of the same write
        // produces a byte-identical document.
        const rerun = mergeStageReport(merge.document, written, policy);
        const again = mergeStageReport(rerun.document, written, policy);
        expect(JSON.stringify(again.document, null, 2)).toBe(JSON.stringify(rerun.document, null, 2));
        expect(rerun.blocksModifiedByAssertionRemoval).toEqual([]);
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

    // A shortfall number alone does not say whether the gap can be closed by
    // triaging withheld rows or only by obtaining more input, and that is the
    // first thing an operator needs.
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

/* ---------------------------------------------------------------------------
 * ONE PHYSICAL OUTPUT DIRECTORY, FROM THE GUARD TO THE RENAME
 * (SEC3-report-outdir-symlink, CWE-59 + CWE-367).
 *
 * The stage used to resolve `--out` twice: the scoped-report guard was
 * evaluated against the symlink-resolved directory while the publication lock
 * and both artefact writes used the operator's spelling. A symlink on that
 * spelling could therefore name a harmless directory while the guard ran and
 * name data/meal-planning/reports/latest by the time the renames happened —
 * replacing whole-catalog acceptance evidence with one category's figures under
 * the same file names, with the lock serialising a directory nobody was
 * writing to.
 *
 * WHY THESE CASES TOUCH A FILESYSTEM while the rest of this suite does not:
 * what is under test IS a filesystem identity. A symlink alias, a retarget
 * between two moments and "the lock and the writes agree on one directory" are
 * not statements about data, and a fake path layer would only assert the
 * assumption the bug was made of. The pure half of the decision
 * (`publicationDirectoryDriftRefusal`) is pinned without a filesystem, exactly
 * as Rule backend-architecture §1.2 and §11 ask.
 *
 * WHY NO CASE HERE CAN DAMAGE THE COMMITTED PAIR: the hostile destinations aim
 * at a fresh, randomly named SUBDIRECTORY of the committed report directory —
 * `writesIntoCanonicalReportDirectory` is true for it, so it exercises the same
 * refusal — and every case asserts the committed `validation-report.json` and
 * `import-report.json` are byte-for-byte the files they were, by size and
 * modification time, rather than trusting that they were left alone.
 * ------------------------------------------------------------------------- */

describe('the report stage publishes into one physical directory (SEC3-report-outdir-symlink)', () => {
    const committedPlan = loadCoveragePlan();
    const committedAllowlist = loadEvidenceAllowlist();
    const reportedCategory = committedPlan.categories[0].category;

    const silentLogger: ScriptLogger = {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        child: () => silentLogger,
    };

    const VALIDATION_REPORT = 'validation-report.json';
    const IMPORT_REPORT = 'import-report.json';

    const publishedRecord: ValidationRecordRow = {
        canonical_identity: { canonicalName: 'reported food', foodState: 'raw' },
        aliases: ['reported'],
        category: reportedCategory,
        food_state: 'raw',
        identity_source: 'usda',
        identity_status: 'verified',
        nutrition_provenance: 'source_backed',
        nutrition_method: 'usda_record',
        nutrition_assumptions: null,
        portion_units: [{ description: '1 cup', gramWeight: 100 }],
        identity_evidence: [],
        checks: [{ name: 'energy_vs_macros', pass: true, observed: 1, bound: 30 }],
        llm_review: null,
        outcome: 'accepted',
        reviewed_at: new Date('2026-09-14T09:00:00.000Z'),
        publication_status: 'published',
        source_versions: { usda: 'sr-legacy' },
    };

    /** A published row as the release stores one, annotated rather than cast so
     * a column the stage starts selecting is a compile error here. */
    const publishedRow = (sourceKey: string): ReportFoodRow => ({
        source_key: sourceKey,
        canonical_name: `name ${sourceKey}`,
        display_name: `Display ${sourceKey}`,
        category: reportedCategory,
        food_state: 'raw',
        identity_source: 'usda',
        identity_status: 'verified',
        nutrition_provenance: 'source_backed',
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        publication_status: 'published',
        food_group: 'other',
        usda_data_type: 'SR Legacy',
        catalog_validation_records: publishedRecord,
        _count: { catalog_food_components: 0 },
    });

    const PUBLISHED_ROWS: readonly ReportFoodRow[] = [publishedRow('usda:1'), publishedRow('usda:2')];

    /** A keyset-paging `catalog_foods.findMany` over a fixed row set. */
    const reportDb = (rows: readonly ReportFoodRow[]): ReportDb => ({
        catalog_foods: {
            findMany: async (args: unknown): Promise<ReportFoodRow[]> => {
                const query = args as {
                    where?: Record<string, unknown>;
                    cursor?: { source_key: string };
                    take?: number;
                };
                const wantedStatus = query.where?.publication_status as string | undefined;
                const wantedCategory = query.where?.category as string | undefined;
                let scoped = [...rows]
                    .filter((row) => wantedStatus === undefined || row.publication_status === wantedStatus)
                    .filter((row) => wantedCategory === undefined || row.category === wantedCategory)
                    .sort((left, right) => (left.source_key < right.source_key ? -1 : 1));
                if (query.cursor !== undefined) {
                    const at = scoped.findIndex((row) => row.source_key === query.cursor?.source_key);
                    scoped = scoped.slice(at + 1);
                }
                return query.take === undefined ? scoped : scoped.slice(0, query.take);
            },
        },
    });

    /**
     * A reader that fails the test if it is consulted at all.
     *
     * Every refusal below must be decided from the destination alone, before
     * the catalog is measured: a run that scanned first and refused afterwards
     * would already have held a snapshot open and, worse, would prove nothing
     * about the order the real guard runs in.
     */
    const unreadableDb: ReportDb = {
        catalog_foods: {
            findMany: async (): Promise<ReportFoodRow[]> => {
                throw new Error('the catalog must not be read by a run whose destination is refused');
            },
        },
    };

    const run = async (
        outDir: string,
        db: ReportDb,
        overrides: { readonly category?: string | null; readonly io?: ReportIo } = {},
    ): Promise<ReportOutcome> =>
        runReport({
            db,
            plan: committedPlan,
            allowlistVersion: committedAllowlist.allowlistVersion,
            evidenceRegistrySnapshot: committedAllowlist.registrySnapshot,
            options: { help: false, category: overrides.category ?? null, out: outDir },
            outDir,
            logger: silentLogger,
            io: overrides.io ?? defaultReportIo(),
        });

    const failureOf = async (attempt: Promise<unknown>): Promise<unknown> =>
        attempt.then(
            () => null,
            (error: unknown) => error,
        );

    /** Size and mtime of the two committed artefacts, so "untouched" is
     * measured rather than assumed. */
    const committedPairState = (): readonly string[] =>
        [VALIDATION_REPORT, IMPORT_REPORT].map((name) => {
            const stats = fs.statSync(path.join(canonicalReportDirectory(), name));
            return `${name}:${stats.size}:${stats.mtimeMs}`;
        });

    let workspace: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-report-identity-'));
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    describe('publicationDirectoryDriftRefusal', () => {
        it('accepts the run when both later observations still name the resolved directory', () => {
            expect(
                publicationDirectoryDriftRefusal({
                    named: '/tmp/link-to-reports',
                    expected: '/real/reports',
                    observedFromNamedPath: '/real/reports',
                    observedFromIdentity: '/real/reports',
                }),
            ).toBeNull();
        });

        it('refuses when the path the operator named now resolves somewhere else', () => {
            const refusal = publicationDirectoryDriftRefusal({
                named: '/tmp/link-to-reports',
                expected: '/real/reports',
                observedFromNamedPath: '/real/elsewhere',
                observedFromIdentity: '/real/reports',
            });

            // The operator has to be able to see BOTH places to act on this:
            // the one they pointed at and the one the run was about.
            expect(String(refusal)).toContain('/tmp/link-to-reports');
            expect(String(refusal)).toContain('/real/elsewhere');
            expect(String(refusal)).toContain('/real/reports');
            expect(String(refusal)).toContain('Nothing was written');
        });

        it('refuses when the resolved directory itself has been replaced', () => {
            const refusal = publicationDirectoryDriftRefusal({
                named: '/real/reports',
                expected: '/real/reports',
                observedFromNamedPath: '/real/reports',
                observedFromIdentity: '/real/swapped',
            });

            expect(String(refusal)).toContain('the resolved output directory itself');
            expect(String(refusal)).toContain('/real/swapped');
        });
    });

    describe('the destination main() decides', () => {
        it('refuses a --category run whose --out reaches the committed directory through a symlinked parent', () => {
            // The alias names the committed report directory's PARENT, so the
            // `--out` value spells a path that contains no committed component
            // at all — which is exactly the walk-around a lexical comparison
            // waves through.
            const aliasParent = path.join(workspace, 'reports-alias');
            fs.symlinkSync(path.dirname(canonicalReportDirectory()), aliasParent, 'dir');
            const aliasedCommittedDir = path.join(aliasParent, path.basename(canonicalReportDirectory()));
            const before = committedPairState();

            const failure = (() => {
                try {
                    resolveReportOutputDirectory({
                        options: { help: false, category: reportedCategory, out: aliasedCommittedDir },
                        logger: silentLogger,
                    });
                    return null;
                } catch (error: unknown) {
                    return error;
                }
            })();

            expect(failure).toBeInstanceOf(CatalogReportError);
            expect((failure as CatalogReportError).code).toBe('scoped_report_needs_out_dir');
            // The refusal names the place it is protecting, by its real path,
            // not by the alias the operator typed.
            expect((failure as CatalogReportError).message).toContain(physicalPathIdentity(canonicalReportDirectory()));
            expect((failure as CatalogReportError).message).toContain(aliasedCommittedDir);
            expect(committedPairState()).toEqual(before);
        });

        it('creates nothing at a destination it refuses', () => {
            const refused = path.join(workspace, 'scoped-out');

            expect(() =>
                resolveReportOutputDirectory({
                    options: { help: false, category: reportedCategory, out: path.join(canonicalReportDirectory(), 'scoped') },
                    logger: silentLogger,
                }),
            ).toThrow(CatalogReportError);
            // And the refusal above is about the destination, not about the
            // flag: the same category with a destination outside the committed
            // directory resolves and is created.
            const accepted = resolveReportOutputDirectory({
                options: { help: false, category: reportedCategory, out: refused },
                logger: silentLogger,
            });

            expect(fs.existsSync(path.join(canonicalReportDirectory(), 'scoped'))).toBe(false);
            expect(accepted.directory).toBe(fs.realpathSync(refused));
            expect(fs.statSync(accepted.directory).isDirectory()).toBe(true);
        });

        it('hands downstream the physical identity, so a later retarget has nothing left to redirect', async () => {
            const real = path.join(workspace, 'real-a');
            const decoy = path.join(workspace, 'real-b');
            const alias = path.join(workspace, 'alias');
            fs.mkdirSync(real);
            fs.mkdirSync(decoy);
            fs.symlinkSync(real, alias, 'dir');

            const destination = resolveReportOutputDirectory({
                options: { help: false, category: null, out: alias },
                logger: silentLogger,
            });

            // The attacker's move, after the destination was decided and the
            // guard ran on it.
            fs.unlinkSync(alias);
            fs.symlinkSync(decoy, alias, 'dir');

            expect(destination.named).toBe(alias);
            expect(destination.directory).toBe(fs.realpathSync(real));
            expect(physicalPathIdentity(alias)).not.toBe(destination.directory);

            const outcome = await run(destination.directory, reportDb(PUBLISHED_ROWS));

            expect(fs.readdirSync(fs.realpathSync(real)).sort()).toEqual([IMPORT_REPORT, VALIDATION_REPORT]);
            expect(fs.readdirSync(fs.realpathSync(decoy))).toEqual([]);
            expect(outcome.validationReportPath).toBe(path.join(fs.realpathSync(real), VALIDATION_REPORT));
            expect(outcome.importReportPath).toBe(path.join(fs.realpathSync(real), IMPORT_REPORT));
        });

        it('states the committed-artefact verdict for the identity, not for the spelling', () => {
            const alias = path.join(workspace, 'committed-alias');
            fs.symlinkSync(canonicalReportDirectory(), alias, 'dir');

            const destination = resolveReportOutputDirectory({
                options: { help: false, category: null, out: alias },
                logger: silentLogger,
            });

            // A whole-catalog run into the committed directory is legitimate —
            // it is the default — but the log has to say so however the
            // operator spelled it.
            expect(destination.writesCommittedArtefacts).toBe(true);
            expect(destination.directory).toBe(physicalPathIdentity(canonicalReportDirectory()));
        });
    });

    describe('runReport under the publication lock', () => {
        it('refuses a scoped run aimed inside the committed directory through an alias, without reading the catalog', async () => {
            // A destination INSIDE the committed directory, reached through an
            // alias on its parent: `writesIntoCanonicalReportDirectory` is true
            // for it, so it earns the same refusal the committed pair does —
            // and a regression cannot overwrite either artefact, because this
            // name has never existed.
            const aliasParent = path.join(workspace, 'reports-alias');
            fs.symlinkSync(path.dirname(canonicalReportDirectory()), aliasParent, 'dir');
            const scopedInsideCommitted = path.join(
                aliasParent,
                path.basename(canonicalReportDirectory()),
                `scoped-${path.basename(workspace)}`,
            );
            const before = committedPairState();

            try {
                const failure = await failureOf(
                    run(scopedInsideCommitted, unreadableDb, { category: reportedCategory }),
                );

                expect(failure).toBeInstanceOf(CatalogReportError);
                expect((failure as CatalogReportError).code).toBe('scoped_report_needs_out_dir');
                expect((failure as CatalogReportError).message).toContain(
                    physicalPathIdentity(canonicalReportDirectory()),
                );
                // Nothing of this run reached the committed directory: neither
                // the pair nor the subdirectory it was aimed at.
                expect(fs.existsSync(path.join(canonicalReportDirectory(), path.basename(scopedInsideCommitted)))).toBe(
                    false,
                );
                expect(committedPairState()).toEqual(before);
            } finally {
                // A regression would have created it; the committed tree must
                // not carry a stray directory out of a failed test run.
                fs.rmSync(path.join(canonicalReportDirectory(), path.basename(scopedInsideCommitted)), {
                    recursive: true,
                    force: true,
                });
            }
        });

        it('refuses when the path it was given is retargeted between resolving the destination and the lock', async () => {
            const real = path.join(workspace, 'real-a');
            const decoy = path.join(workspace, 'real-b');
            const alias = path.join(workspace, 'alias');
            fs.mkdirSync(real);
            fs.mkdirSync(decoy);
            fs.symlinkSync(real, alias, 'dir');

            // The race the finding names: the retarget lands after the run has
            // resolved its destination and before it publishes. Taking the lock
            // is that instant, so the fake lock is where it is staged.
            const racingIo: ReportIo = {
                ...defaultReportIo(),
                withPublicationLock: async (directory, holder, publish) => {
                    fs.unlinkSync(alias);
                    fs.symlinkSync(decoy, alias, 'dir');
                    return withArtifactPublicationLock(directory, holder, publish);
                },
            };

            const failure = await failureOf(run(alias, reportDb(PUBLISHED_ROWS), { io: racingIo }));

            expect(failure).toBeInstanceOf(CatalogReportError);
            expect((failure as CatalogReportError).code).toBe('output_directory_changed');
            expect((failure as CatalogReportError).message).toContain(alias);
            // Neither directory holds an artefact: the run refused instead of
            // publishing into the place it had not checked, and left no
            // staging file behind either.
            expect(fs.readdirSync(fs.realpathSync(real))).toEqual([]);
            expect(fs.readdirSync(fs.realpathSync(decoy))).toEqual([]);
        });

        it('refuses when the resolved directory itself is replaced by a symlink under the lock', async () => {
            const real = path.join(workspace, 'real-a');
            const decoy = path.join(workspace, 'real-b');
            fs.mkdirSync(real);
            fs.mkdirSync(decoy);
            const identity = fs.realpathSync(real);

            const racingIo: ReportIo = {
                ...defaultReportIo(),
                withPublicationLock: async (directory, holder, publish) => {
                    // The other half of the attack: the identity carries no
                    // symlink, so the only way to redirect a write through it
                    // is to replace the directory it names.
                    fs.rmdirSync(identity);
                    fs.symlinkSync(decoy, identity, 'dir');
                    return withArtifactPublicationLock(directory, holder, publish);
                },
            };

            const failure = await failureOf(run(identity, reportDb(PUBLISHED_ROWS), { io: racingIo }));

            expect(failure).toBeInstanceOf(CatalogReportError);
            expect((failure as CatalogReportError).code).toBe('output_directory_changed');
            expect(fs.readdirSync(fs.realpathSync(decoy))).toEqual([]);
        });

        it('locks the same directory the artefacts appear in, whatever the caller spelled', async () => {
            const real = path.join(workspace, 'real');
            const alias = path.join(workspace, 'alias');
            fs.mkdirSync(real);
            fs.symlinkSync(real, alias, 'dir');

            const locked: string[] = [];
            const recordingIo: ReportIo = {
                ...defaultReportIo(),
                withPublicationLock: async (directory, holder, publish) => {
                    locked.push(directory);
                    return withArtifactPublicationLock(directory, holder, publish);
                },
            };

            const outcome = await run(alias, reportDb(PUBLISHED_ROWS), { io: recordingIo });

            // Mutual exclusion and the writes have to be about one place. The
            // spelling would have serialised `<workspace>/alias` while the
            // artefacts landed in `<workspace>/real`.
            expect(locked).toEqual([fs.realpathSync(real)]);
            expect(path.dirname(outcome.validationReportPath)).toBe(fs.realpathSync(real));
            expect(fs.readdirSync(fs.realpathSync(real)).sort()).toEqual([IMPORT_REPORT, VALIDATION_REPORT]);
        });

        it('still publishes both artefacts, and nothing else, into an ordinary output directory', async () => {
            const outcome = await run(workspace, reportDb(PUBLISHED_ROWS));

            // The unremarkable run has to stay unremarkable: the pair appears
            // together, no staging or backup file survives, and the outcome
            // names the directory it was given.
            expect(fs.readdirSync(workspace).sort()).toEqual([IMPORT_REPORT, VALIDATION_REPORT]);
            expect(outcome.validationReportPath).toBe(path.join(workspace, VALIDATION_REPORT));
            expect(outcome.importReportPath).toBe(path.join(workspace, IMPORT_REPORT));
            expect(outcome.itemRecords).toBe(PUBLISHED_ROWS.length);
            expect(outcome.publishedRows).toBe(PUBLISHED_ROWS.length);

            const validationReport = JSON.parse(
                fs.readFileSync(path.join(workspace, VALIDATION_REPORT), 'utf-8'),
            ) as Record<string, unknown>;
            expect(Object.keys(validationReport.items as Record<string, unknown>).sort()).toEqual(['usda:1', 'usda:2']);
        });

        it('publishes a scoped report into a directory outside the committed one', async () => {
            const outcome = await run(workspace, reportDb(PUBLISHED_ROWS), { category: reportedCategory });

            // The guard is about the destination, not about the flag: a scoped
            // run with somewhere else to write still produces its evidence.
            expect(fs.readdirSync(workspace).sort()).toEqual([IMPORT_REPORT, VALIDATION_REPORT]);
            expect(outcome.itemRecords).toBe(PUBLISHED_ROWS.length);
        });
    });

    /* ----------------------------------------------------------------------
     * THE WINDOW AFTER THE UNDER-LOCK CHECK.
     *
     * The cases above cover a retarget that lands BEFORE the run reads the
     * catalog: the drift check under the publication lock refuses it. What they
     * cannot cover is the interval the check opens onto — the catalog
     * measurement is two awaited scans, minutes long on a full catalog, and the
     * staging writes, the read-back and the promotion that follow it are
     * path-based. A directory replaced during the scan would be followed by
     * every one of them while the lock was still keyed to the directory that
     * had gone.
     *
     * Each case below therefore mutates the filesystem from inside an awaited
     * database call, after every check the run makes before its first scan has
     * already passed, and asserts the two things that matter: the replacement
     * receives nothing, and the committed pair is byte-identical.
     * -------------------------------------------------------------------- */
    describe('the window after the under-lock check', () => {
        /** The two committed artefacts' bytes, so "byte-identical" is compared
         * rather than inferred from a size and a timestamp. */
        const committedPairBytes = (): readonly Buffer[] =>
            [VALIDATION_REPORT, IMPORT_REPORT].map((name) =>
                fs.readFileSync(path.join(canonicalReportDirectory(), name)),
            );

        const expectBytesEqual = (actual: readonly Buffer[], expected: readonly Buffer[]): void => {
            expect(actual.length).toBe(expected.length);
            actual.forEach((buffer, index) => {
                expect(buffer.equals(expected[index])).toBe(true);
            });
        };

        /**
         * A reader that runs `mutate` inside the FIRST awaited page of the
         * chosen pass, then answers normally.
         *
         * `publication_status` is what separates the two passes: the aggregate
         * pass scans the whole catalog and the item pass scans published rows
         * only. Mutating from inside the call is what puts the change after the
         * drift check, the parent check and the identity capture — which is the
         * moment the earlier cases cannot reach.
         */
        const mutatingDb = (
            rows: readonly ReportFoodRow[],
            pass: 'aggregate' | 'items',
            mutate: () => void,
        ): ReportDb => {
            const underlying = reportDb(rows);
            let mutated = false;
            return {
                catalog_foods: {
                    findMany: async (args: unknown): Promise<ReportFoodRow[]> => {
                        const scoped = (args as { where?: Record<string, unknown> }).where?.publication_status;
                        const thisPass = scoped === undefined ? 'aggregate' : 'items';
                        if (!mutated && thisPass === pass) {
                            mutated = true;
                            mutate();
                        }
                        return underlying.catalog_foods.findMany(args);
                    },
                },
            };
        };

        /**
         * The real IO with both staging files redirected OUTSIDE the publication
         * directory, and a hook fired after the import document is staged.
         *
         * Needed to reach the read-back and promotion checks at all: a staging
         * file inside the publication directory makes that directory
         * non-empty, so an attacker who replaced it would have to destroy this
         * run's own open descriptor first and the run would fail on its own
         * write instead of on the check being exercised. Redirecting the
         * staging files leaves the directory empty and replaceable, which is
         * the state those two checks exist for. `finalPath` is untouched, so
         * the promotion still targets the real artefact paths.
         */
        const stagingOutside = (elsewhere: string, afterImportStaged: () => void = () => undefined): ReportIo => {
            const real = defaultReportIo();
            return {
                ...real,
                openStagedSink: (absolutePath) => {
                    const opened = real.openStagedSink(path.join(elsewhere, path.basename(absolutePath)));
                    return {
                        sink: opened.sink,
                        staged: { finalPath: absolutePath, stagingPath: opened.staged.stagingPath },
                    };
                },
                stageJsonObject: (absolutePath, value) => {
                    const staged = real.stageJsonObject(path.join(elsewhere, path.basename(absolutePath)), value);
                    afterImportStaged();
                    return { finalPath: absolutePath, stagingPath: staged.stagingPath };
                },
            };
        };

        describe('publicationDirectoryReplacedRefusal', () => {
            const expected = { device: 66306, inode: 4211 };

            it('accepts the run while the directory is the same object it captured', () => {
                expect(
                    publicationDirectoryReplacedRefusal({
                        directory: '/real/reports',
                        operation: 'publishing both artefacts',
                        expected,
                        observed: { device: 66306, inode: 4211 },
                    }),
                ).toBeNull();
            });

            it('refuses a directory replaced by another one at the same path, naming both inodes', () => {
                // The case a re-resolution cannot see: the path still resolves
                // to itself, and it is not the same directory.
                const refusal = publicationDirectoryReplacedRefusal({
                    directory: '/real/reports',
                    operation: 'publishing both artefacts',
                    expected,
                    observed: { device: 66306, inode: 9999 },
                });

                expect(String(refusal)).toContain('/real/reports');
                expect(String(refusal)).toContain('inode 9999');
                expect(String(refusal)).toContain('inode 4211');
                expect(String(refusal)).toContain('publishing both artefacts');
                // The operator has to know where to look: the right to replace
                // that name belongs to whoever can write to its parent.
                expect(String(refusal)).toContain('/real');
                expect(String(refusal)).toContain('are intact');
            });

            it('refuses a directory on a different device even when the inode matches', () => {
                expect(
                    publicationDirectoryReplacedRefusal({
                        directory: '/real/reports',
                        operation: `staging ${VALIDATION_REPORT}`,
                        expected,
                        observed: { device: 1, inode: 4211 },
                    }),
                ).not.toBeNull();
            });

            it('refuses when the name holds no directory at all, and says so', () => {
                const refusal = publicationDirectoryReplacedRefusal({
                    directory: '/real/reports',
                    operation: `staging ${IMPORT_REPORT}`,
                    expected,
                    observed: null,
                });

                expect(String(refusal)).toContain('no directory at all');
                expect(String(refusal)).toContain(`staging ${IMPORT_REPORT}`);
            });
        });

        it('refuses when the directory is replaced during the first awaited catalog scan', async () => {
            const real = path.join(workspace, 'real-a');
            const decoy = path.join(workspace, 'real-b');
            fs.mkdirSync(real);
            fs.mkdirSync(decoy);
            const identity = fs.realpathSync(real);
            const committedBefore = committedPairBytes();

            // The attack this case exists for: the run has already passed the
            // under-lock drift check, the parent check and the identity
            // capture, and is inside its first scan — which on a real catalog
            // is minutes of wall time.
            const db = mutatingDb(PUBLISHED_ROWS, 'aggregate', () => {
                fs.rmdirSync(identity);
                fs.symlinkSync(decoy, identity, 'dir');
            });

            const failure = await failureOf(run(identity, db));

            expect(failure).toBeInstanceOf(CatalogReportError);
            expect((failure as CatalogReportError).code).toBe('output_directory_changed');
            expect((failure as CatalogReportError).message).toContain(identity);
            // The replacement received no bytes: not an artefact, not a staging
            // file, not a partial stream.
            expect(fs.readdirSync(decoy)).toEqual([]);
            // And the artefacts a reviewer reads are the ones that were there
            // before this run started.
            expectBytesEqual(committedPairBytes(), committedBefore);
        });

        it('refuses before reading the staged report back when the directory is replaced during the item pass', async () => {
            const real = path.join(workspace, 'real-a');
            const decoy = path.join(workspace, 'real-b');
            const elsewhere = path.join(workspace, 'staging');
            [real, decoy, elsewhere].forEach((directory) => fs.mkdirSync(directory));
            const identity = fs.realpathSync(real);
            const committedBefore = committedPairBytes();

            const db = mutatingDb(PUBLISHED_ROWS, 'items', () => {
                fs.rmdirSync(identity);
                fs.symlinkSync(decoy, identity, 'dir');
            });

            const failure = await failureOf(run(identity, db, { io: stagingOutside(elsewhere) }));

            // The read-back is what gates the second artefact on the first, so
            // reading it through a replaced directory would gate the pair on a
            // document this run never wrote.
            expect(failure).toBeInstanceOf(CatalogReportError);
            expect((failure as CatalogReportError).code).toBe('output_directory_changed');
            expect((failure as CatalogReportError).message).toContain(`reading the staged ${VALIDATION_REPORT} back`);
            expect(fs.readdirSync(decoy)).toEqual([]);
            // The staging files this run opened are removed on the failure
            // path, so a refused run leaves no debris behind either.
            expect(fs.readdirSync(elsewhere)).toEqual([]);
            expectBytesEqual(committedPairBytes(), committedBefore);
        });

        it('refuses to promote when the directory is replaced after both documents are staged', async () => {
            const real = path.join(workspace, 'real-a');
            const decoy = path.join(workspace, 'real-b');
            const elsewhere = path.join(workspace, 'staging');
            [real, decoy, elsewhere].forEach((directory) => fs.mkdirSync(directory));
            const identity = fs.realpathSync(real);
            const committedBefore = committedPairBytes();

            const io = stagingOutside(elsewhere, () => {
                // The last window there is: both documents are complete and
                // reconciled, and the only step left is the pair of renames
                // onto the artefact pathnames.
                fs.rmdirSync(identity);
                fs.symlinkSync(decoy, identity, 'dir');
            });

            const failure = await failureOf(run(identity, reportDb(PUBLISHED_ROWS), { io }));

            expect(failure).toBeInstanceOf(CatalogReportError);
            expect((failure as CatalogReportError).code).toBe('output_directory_changed');
            expect((failure as CatalogReportError).message).toContain(
                `publishing ${VALIDATION_REPORT} and ${IMPORT_REPORT}`,
            );
            // Nothing was renamed into the replacement, and nothing was left in
            // the staging directory.
            expect(fs.readdirSync(decoy)).toEqual([]);
            expect(fs.readdirSync(elsewhere)).toEqual([]);
            expectBytesEqual(committedPairBytes(), committedBefore);
        });

        it('refuses a publication directory another local principal can plant a name in, without reading the catalog', async () => {
            const shared = path.join(workspace, 'shared-out');
            fs.mkdirSync(shared);
            // `mkdir` masks its mode with the umask, so the hostile mode is set
            // explicitly: world-writable and NOT sticky, which is the state in
            // which any local principal can pre-place or replace either
            // artefact name — and replace the directory's own contents.
            fs.chmodSync(shared, 0o777);
            const committedBefore = committedPairBytes();

            const failure = await failureOf(run(shared, unreadableDb));

            expect(failure).toBeInstanceOf(ManifestError);
            expect((failure as ManifestError).code).toBe('unsafe_artifact_directory');
            expect(fs.readdirSync(shared)).toEqual([]);
            expectBytesEqual(committedPairBytes(), committedBefore);
        });

        it('publishes into a shared directory whose sticky bit protects the names it creates', async () => {
            const sticky = path.join(workspace, 'sticky-out');
            fs.mkdirSync(sticky);
            fs.chmodSync(sticky, 0o1777);

            // The rule is "no other principal can plant a name here", not "no
            // shared directory ever": in a sticky directory a name can only be
            // renamed or deleted by its owner, so the run proceeds — which is
            // what keeps `/tmp`-rooted output usable.
            const outcome = await run(sticky, reportDb(PUBLISHED_ROWS));

            expect(fs.readdirSync(sticky).sort()).toEqual([IMPORT_REPORT, VALIDATION_REPORT]);
            expect(outcome.itemRecords).toBe(PUBLISHED_ROWS.length);
        });

        it('refuses a destination whose parent another local principal can plant a name in, creating nothing', () => {
            const sharedParent = path.join(workspace, 'shared-parent');
            fs.mkdirSync(sharedParent);
            fs.chmodSync(sharedParent, 0o777);
            const destination = path.join(sharedParent, 'out');

            const failure = (() => {
                try {
                    resolveReportOutputDirectory({
                        options: { help: false, category: null, out: destination },
                        logger: silentLogger,
                    });
                    return null;
                } catch (error: unknown) {
                    return error;
                }
            })();

            expect(failure).toBeInstanceOf(ManifestError);
            expect((failure as ManifestError).code).toBe('unsafe_artifact_directory');
            // The refusal comes before the destination is created, so a refused
            // run leaves nothing at the name it refused to publish into.
            expect(fs.existsSync(destination)).toBe(false);
        });

        it('reads a report header without following a symbolic link planted at the artefact name', async () => {
            const outDir = path.join(workspace, 'out');
            const outside = path.join(workspace, 'outside.json');
            fs.mkdirSync(outDir);
            fs.writeFileSync(outside, '{"secret":"untouched"}\n', 'utf-8');
            // The canonical read is how another stage's fields are preserved, so
            // a link at that name would have this run preserve — and then
            // replace — a document it never wrote.
            fs.symlinkSync(outside, path.join(outDir, VALIDATION_REPORT));

            const failure = await failureOf(run(outDir, reportDb(PUBLISHED_ROWS)));

            expect(failure).toBeInstanceOf(CatalogReportError);
            expect((failure as CatalogReportError).code).toBe('report_unreadable');
            expect((failure as CatalogReportError).message).toContain('symbolic link');
            // The link's target was neither read into the artefact nor written
            // through, and no half of the pair was published.
            expect(fs.readFileSync(outside, 'utf-8')).toBe('{"secret":"untouched"}\n');
            expect(fs.readdirSync(outDir)).toEqual([VALIDATION_REPORT]);
            expect(fs.lstatSync(path.join(outDir, VALIDATION_REPORT)).isSymbolicLink()).toBe(true);
        });

        it('refuses a symbolic link planted at the import report name after the validation report is staged', async () => {
            const outDir = path.join(workspace, 'out');
            const outside = path.join(workspace, 'outside-import.json');
            fs.mkdirSync(outDir);
            fs.writeFileSync(outside, '{"counts":{"inserted":1}}\n', 'utf-8');
            fs.symlinkSync(outside, path.join(outDir, IMPORT_REPORT));

            const failure = await failureOf(run(outDir, reportDb(PUBLISHED_ROWS)));

            // The second read happens after the validation report has been
            // staged, which is why this case also proves the staging file is
            // discarded and neither artefact is promoted.
            expect(failure).toBeInstanceOf(CatalogReportError);
            expect((failure as CatalogReportError).code).toBe('report_unreadable');
            expect(fs.readFileSync(outside, 'utf-8')).toBe('{"counts":{"inserted":1}}\n');
            expect(fs.readdirSync(outDir)).toEqual([IMPORT_REPORT]);
            expect(fs.lstatSync(path.join(outDir, IMPORT_REPORT)).isSymbolicLink()).toBe(true);
        });
    });
});

/* ---------------------------------------------------------------------------
 * KEYS THAT COME FROM THE DATA.
 *
 * WHAT THESE CASES PIN. Almost every figure in the two artefacts is a counter
 * keyed by a string read out of `catalog_foods` or
 * `catalog_validation_records`, and three of those strings are not ordinary
 * data: `__proto__`, `constructor` and `prototype` reach `Object.prototype`
 * through a plain object. `publishedChecks[check.name] ?? { evaluated: 0, … }`
 * answered a row whose check was named `__proto__` with `Object.prototype`
 * itself, so the `??` did not fire and the `tally.evaluated += 1` that followed
 * wrote three counters onto the prototype every object in the process inherits
 * from — and `counts['__proto__'] = n` on a plain object drops the count
 * instead of recording it, leaving a report that omits rows it scanned while
 * reading as a complete measurement.
 *
 * So each case below asserts BOTH halves: that `Object.prototype` is exactly as
 * it was before the run, and that the count the scan made is present in the
 * measurement and in the JSON the artefact carries. The first assertion is the
 * one that fails loudly if the defect returns; the second is what stops the
 * "fix" being to silently drop the row.
 *
 * WHY THIS BLOCK DRIVES `measureCatalog` AND NOT A PURE FUNCTION. The
 * accumulation IS the aggregate pass, so a fixture handed to a builder cannot
 * exercise it. `ReportDb` is the seam the stage was given for exactly this —
 * `findMany` and nothing else — and the reader below is plain data over a fixed
 * row set, with no database and nothing mocked, like the rest of this suite.
 * ------------------------------------------------------------------------- */

/** The three names a data key must not be trusted to be. */
const RESERVED_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/**
 * A lookup by a name TypeScript resolves against `Object` rather than against
 * the index signature: `measurement.categories.constructor` is typed `Function`
 * even where the value is a measurement, so the key is passed as a value.
 */
const at = <T>(record: Readonly<Record<string, T>>, key: string): T => record[key];

/**
 * One row and the validation record that mirrors it.
 *
 * The record repeats the food's five mirrored columns, so a case about keys
 * cannot accidentally also be a case about `recordFieldMismatches`.
 */
const scannedRow = (
    sourceKey: string,
    overrides: Partial<ReportFoodRow>,
    checkNames: readonly string[],
): ReportFoodRow => {
    const food: ReportFoodRow = {
        source_key: sourceKey,
        canonical_name: `name ${sourceKey}`,
        display_name: `Display ${sourceKey}`,
        category: 'produce_vegetable',
        food_state: 'raw',
        identity_source: 'usda',
        identity_status: 'verified',
        nutrition_provenance: 'source_backed',
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        publication_status: 'published',
        food_group: 'other',
        usda_data_type: 'SR Legacy',
        catalog_validation_records: null,
        _count: { catalog_food_components: 0 },
        ...overrides,
    };

    return {
        ...food,
        catalog_validation_records: {
            canonical_identity: { canonicalName: food.canonical_name, foodState: food.food_state },
            aliases: [],
            category: food.category,
            food_state: food.food_state,
            identity_source: food.identity_source,
            identity_status: food.identity_status,
            nutrition_provenance: food.nutrition_provenance,
            nutrition_method: 'read per 100 g from the USDA record',
            nutrition_assumptions: null,
            portion_units: [{ description: '1 cup', gram_weight: 91, is_default: true }],
            identity_evidence: [],
            checks: checkNames.map((name) => ({ name, pass: false, observed: 1, bound: 2 })),
            llm_review: null,
            outcome: 'accepted',
            reviewed_at: '2026-09-14T09:00:00.000Z',
            publication_status: food.publication_status,
            source_versions: { coverage_plan_version: 'v1' },
        },
    };
};

/** A keyset-paging `catalog_foods.findMany` over a fixed row set. */
const reportDbOver = (rows: readonly ReportFoodRow[]): ReportDb => ({
    catalog_foods: {
        findMany: async (args: unknown): Promise<ReportFoodRow[]> => {
            const query = args as {
                where?: { publication_status?: string };
                cursor?: { source_key: string };
                take?: number;
            };
            const wantedStatus = query.where?.publication_status;
            let scoped = [...rows]
                .filter((row) => wantedStatus === undefined || row.publication_status === wantedStatus)
                .sort((left, right) => (left.source_key < right.source_key ? -1 : 1));
            if (query.cursor !== undefined) {
                scoped = scoped.slice(scoped.findIndex((row) => row.source_key === query.cursor?.source_key) + 1);
            }
            return query.take === undefined ? scoped : scoped.slice(0, query.take);
        },
    },
});

describe('the aggregate pass over rows whose values are reserved keys', () => {
    /**
     * Four rows, each aiming one reserved name at a different accumulator: the
     * check tally the finding quoted, the per-category map, the withheld
     * identity-source map, and the publication-status counter.
     */
    const ROWS: readonly ReportFoodRow[] = [
        scannedRow('usda:1', {}, [...RESERVED_KEYS, 'kcal_ceiling']),
        scannedRow('usda:2', { category: '__proto__' }, ['kcal_ceiling']),
        scannedRow(
            'usda:3',
            { category: 'constructor', publication_status: 'quarantined', identity_source: 'prototype' },
            ['__proto__'],
        ),
        scannedRow('usda:4', { publication_status: '__proto__' }, ['kcal_ceiling']),
    ];

    it('leaves Object.prototype exactly as it found it', async () => {
        const before = Object.getOwnPropertyNames(Object.prototype).sort();

        await measureCatalog(reportDbOver(ROWS), {});

        expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);

        // The four counters the defect wrote onto the prototype, asked of an
        // object that never went anywhere near this stage. `toBeUndefined`
        // rather than a key check, because an inherited value is exactly what
        // this reads out if the pollution returns.
        const probe = {} as Record<string, unknown>;
        expect(probe.evaluated).toBeUndefined();
        expect(probe.passed).toBeUndefined();
        expect(probe.failed).toBeUndefined();
        expect(probe.tier).toBeUndefined();
        expect(Object.getPrototypeOf(probe)).toBe(Object.prototype);

        // `constructor` as a check name reached the `Object` function itself by
        // the same route, so it is asked separately.
        expect((Object as unknown as Record<string, unknown>).evaluated).toBeUndefined();
    });

    it('records every count it scanned rather than dropping the reserved keys', async () => {
        const measurement = await measureCatalog(reportDbOver(ROWS), {});

        expect(measurement.rowsScanned).toBe(4);
        expect(Object.keys(measurement.byPublicationStatus).sort()).toEqual([
            '__proto__',
            'published',
            'quarantined',
        ]);
        expect(measurement.byPublicationStatus['__proto__']).toBe(1);
        expect(measurement.byPublicationStatus.published).toBe(2);
        expect(measurement.byPublicationStatus.quarantined).toBe(1);
    });

    it('tallies a check named after a reserved key under the unrecognised tier', async () => {
        const measurement = await measureCatalog(reportDbOver(ROWS), {});

        expect(Object.keys(measurement.publishedChecks).sort()).toEqual([
            '__proto__',
            'constructor',
            'kcal_ceiling',
            'prototype',
        ]);
        // The site the finding named, measured: one evaluation, one failure,
        // and no tier invented for a name the vocabulary does not declare.
        expect(measurement.publishedChecks['__proto__']).toEqual({
            tier: 'unrecognised',
            evaluated: 1,
            passed: 0,
            failed: 1,
        });
        expect(at(measurement.publishedChecks, 'constructor')).toEqual({
            tier: 'unrecognised',
            evaluated: 1,
            passed: 0,
            failed: 1,
        });
        // And named, with its count, in the block the artefact publishes for
        // exactly this purpose. `__proto__` is counted twice because two rows
        // record it — the published one and the quarantined one — which is what
        // this counter measures: recorded entries, not distinct names.
        expect(measurement.unrecognisedCheckNames['__proto__']).toBe(2);
        expect(measurement.unrecognisedCheckNames.prototype).toBe(1);
    });

    it('keeps a category named after a reserved key as a measurement, not a prototype', async () => {
        const measurement = await measureCatalog(reportDbOver(ROWS), {});

        expect(Object.keys(measurement.categories).sort()).toEqual(['__proto__', 'constructor', 'produce_vegetable']);
        expect(at(measurement.categories, '__proto__').byPublicationStatus).toEqual({ published: 1 });
        expect(measurement.publishedByCategory['__proto__']).toBe(1);
        expect(at(measurement.quarantinedByCategory, 'constructor')).toBe(1);
        expect(Object.keys(at(measurement.categories, 'constructor').quarantinedByCheck)).toEqual(['__proto__']);
    });

    it('counts a withheld row under the identity source and status the row states', async () => {
        const measurement = await measureCatalog(reportDbOver(ROWS), {});

        expect(Object.keys(measurement.withheldByIdentitySourceAndStatus)).toEqual(['prototype']);
        expect(measurement.withheldByIdentitySourceAndStatus.prototype).toEqual({ quarantined: 1 });
        expect(measurement.withheldIdentities.map((identity) => identity.sourceKey)).toEqual(['usda:3']);
        expect(measurement.quarantinedByCheck['__proto__']).toBe(1);
    });

    it('serialises to the JSON a plain object would have produced, keys and all', async () => {
        const measurement = await measureCatalog(reportDbOver(ROWS), {});

        // The artefact boundary: insertion order, no `Map` that would serialise
        // to `{}`, and the reserved key present rather than silently absent.
        const text = JSON.stringify(measurement.byPublicationStatus);
        expect(text).toBe('{"published":2,"quarantined":1,"__proto__":1}');

        // What the next reader of the artefact gets: `JSON.parse` makes it an
        // ordinary own property, so carrying the key discloses no hazard.
        const parsed = JSON.parse(text) as Record<string, number>;
        expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    });

    it('carries the reserved keys into the blocks the artefacts publish', async () => {
        const measurement = await measureCatalog(reportDbOver(ROWS), {});
        const shortfall = computeCoverageShortfall(policy(), measurement.publishedByCategory);
        const rows = buildCoverageRows(policy(), plan(), measurement, shortfall);
        const audit = buildWithheldIdentityAudit(rows, measurement);

        // The category vocabulary's own explicit bucket, which is why this
        // stage counts an undeclared category instead of refusing it.
        expect(shortfall.unknownCategories).toEqual(['__proto__']);
        expect(JSON.stringify(audit.byCheck.quarantined)).toBe('{"__proto__":1}');
        expect(audit.identities.quarantined.map((identity) => identity.sourceKey)).toEqual(['usda:3']);
        expect(audit.totals.quarantined).toBe(1);
    });

    it('collects the values no closed set declares so the run can refuse to publish', async () => {
        const measurement = await measureCatalog(reportDbOver(ROWS), {});

        expect(measurement.unrecognisedStoredValueCount).toBe(2);
        expect(measurement.unrecognisedStoredValues).toEqual([
            { sourceKey: 'usda:3', field: 'identity_source', value: '"prototype"' },
            { sourceKey: 'usda:4', field: 'publication_status', value: '"__proto__"' },
        ]);
        expect(() => assertRecognisedStoredValues(measurement)).toThrow(/outside the closed set/);
    });
});

/* ---------------------------------------------------------------------------
 * The closed value sets the counters are keyed by.
 * ------------------------------------------------------------------------- */

describe('unrecognisedStoredValuesOfRow', () => {
    it('finds nothing in a row every closed set declares', () => {
        expect(unrecognisedStoredValuesOfRow(scannedRow('usda:1', {}, ['kcal_ceiling']))).toEqual([]);
    });

    it('names the column and quotes the value for each set that does not declare it', () => {
        const row = scannedRow(
            'usda:9',
            { publication_status: 'Published', identity_status: 'trusted', nutrition_basis: 'per_ounce' },
            [],
        );

        expect(unrecognisedStoredValuesOfRow(row)).toEqual([
            { sourceKey: 'usda:9', field: 'publication_status', value: '"Published"' },
            { sourceKey: 'usda:9', field: 'identity_status', value: '"trusted"' },
            { sourceKey: 'usda:9', field: 'nutrition_basis', value: '"per_ounce"' },
        ]);
    });

    it('judges the validation record\u2019s outcome as well as the food\u2019s own columns', () => {
        const row = scannedRow('usda:9', {}, []);
        const judged: ReportFoodRow = {
            ...row,
            catalog_validation_records: { ...(row.catalog_validation_records as ValidationRecordRow), outcome: 'ok' },
        };

        expect(unrecognisedStoredValuesOfRow(judged)).toEqual([
            { sourceKey: 'usda:9', field: 'catalog_validation_records.outcome', value: '"ok"' },
        ]);
    });

    it('says nothing about an outcome for a row that carries no validation record', () => {
        const row: ReportFoodRow = { ...scannedRow('usda:9', {}, []), catalog_validation_records: null };

        expect(unrecognisedStoredValuesOfRow(row)).toEqual([]);
    });

    it('judges a null in a NOT NULL column as the defect it is', () => {
        const row = scannedRow('usda:9', { food_state: null as unknown as string }, []);

        expect(unrecognisedStoredValuesOfRow(row)).toEqual([
            { sourceKey: 'usda:9', field: 'food_state', value: '"null"' },
        ]);
    });
});

describe('assertRecognisedStoredValues', () => {
    it('says nothing about a measurement whose every value its set declares', () => {
        expect(() => assertRecognisedStoredValues(measurement())).not.toThrow();
    });

    it('names the rows, the columns and where the sets live', () => {
        const measured = measurement({
            unrecognisedStoredValueCount: 1,
            unrecognisedStoredValues: [{ sourceKey: 'usda:9', field: 'publication_status', value: '"Published"' }],
        });

        expect(() => assertRecognisedStoredValues(measured)).toThrow(/usda:9 publication_status="Published"/);
        expect(() => assertRecognisedStoredValues(measured)).toThrow(/src\/services\/catalog\.logic\.ts/);
    });

    it('states how many it did not name once the cap bites, so a capped list is never read as the whole set', () => {
        const measured = measurement({
            unrecognisedStoredValueCount: 25,
            unrecognisedStoredValues: [{ sourceKey: 'usda:9', field: 'food_state', value: '"frozen"' }],
        });

        expect(() => assertRecognisedStoredValues(measured)).toThrow(/and 24 more/);
    });
});

describe('quoteStoredValue', () => {
    it('escapes a control character so it cannot reach a terminal as an escape sequence', () => {
        expect(quoteStoredValue('pub\u001blished\n')).toBe('"pub\\u001blished\\n"');
    });

    it('bounds a long value and states the length it truncated', () => {
        const quoted = quoteStoredValue('x'.repeat(5000));

        expect(quoted).toContain('(5,000 characters)');
        expect(quoted.length).toBeLessThan(120);
    });

    it('names a null column rather than printing nothing', () => {
        expect(quoteStoredValue(null)).toBe('"null"');
    });
});

/* ---------------------------------------------------------------------------
 * The exported figures read what a record STATES, never what it inherits.
 *
 * Every one of these functions is handed a record built somewhere else — by a
 * sibling stage, by the JSON already on disk, by a fixture in this file — so a
 * plain `{}` reaching them must not answer a lookup of an inherited name with
 * the inherited value. A count derived that way is not a measurement.
 * ------------------------------------------------------------------------- */

describe('reading a counter block by a name Object.prototype also carries', () => {
    it('reports a measured zero for a status named after an inherited property', () => {
        const measured = measurement({
            categories: {
                produce_vegetable: emptyCategory({ byPublicationStatus: { published: 2 } }),
                spice_herb: emptyCategory({ byPublicationStatus: { published: 1 } }),
            },
            publishedByCategory: { produce_vegetable: 2, spice_herb: 1 },
        });
        const rows = buildCoverageRows(
            policy(),
            plan(),
            measured,
            computeCoverageShortfall(policy(), { produce_vegetable: 2, spice_herb: 1 }),
        );

        expect(perCategoryByStatus(rows, measured, 'constructor')).toEqual({
            produce_vegetable: 0,
            spice_herb: 0,
        });
    });

    it('measures a plan category named after an inherited property instead of reading the Object function', () => {
        // The cast is exactly what the loader does at runtime
        // (`assertCoveragePlanModelShape` returns `value as CoveragePlan`
        // without checking the category codes), so a plan file naming an
        // inherited property reaches this function typed as any other.
        const inheritedPlan: CoveragePlan = {
            ...plan(),
            publishedTargetTotal: 10,
            categories: [
                {
                    category: 'constructor' as CoveragePlan['categories'][number]['category'],
                    publishedTarget: 10,
                    candidateVolume: 12,
                    kcalReviewRange: { min: 0, max: 400 },
                    energyMacroTolerancePercent: 30,
                },
            ],
        };
        const inheritedPolicy: CatalogValidationPolicy = {
            categories: inheritedPlan.categories,
            validationBounds: inheritedPlan.validationBounds,
        };

        const rows = buildCoverageRows(
            inheritedPolicy,
            inheritedPlan,
            measurement(),
            computeCoverageShortfall(inheritedPolicy, {}),
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].category).toBe('constructor');
        expect(rows[0].published).toBe(0);
        expect(rows[0].quarantined).toBe(0);
        expect(rows[0].shortfall).toBe(10);
        expect(rows[0].unmet).toBe(true);
    });

    it('prunes nothing for a block name that is only an inherited property', () => {
        expect(pruneSupersededKeys('constructor', { checksPerItem: 13 })).toEqual({ checksPerItem: 13 });
    });

    it('carries a withheld status named after a reserved key into the generated-content statement', () => {
        // `JSON.parse` is how a `__proto__` key legitimately arrives as an own
        // property — from a stored document — which is exactly the case a plain
        // accumulator dropped.
        const withheldByStatus = JSON.parse('{"quarantined": 2, "__proto__": 3}') as Record<string, number>;

        const presence = generatedContentPresence({ ai_generated: 1 }, { ai_generated: withheldByStatus });

        expect(presence.withheldGeneratedRowsTotal).toBe(5);
        expect(presence.withheldGeneratedRowsByStatus['__proto__']).toBe(3);
        expect(presence.statement).toContain('__proto__ 3, quarantined 2');
    });
});
